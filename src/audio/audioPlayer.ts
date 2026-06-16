import { createLogger } from '../shared/logger';
import {
  createAudioPlayer,
  joinVoiceChannel,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
  NoSubscriberBehavior,
  type AudioResource,
  type VoiceConnection,
  type AudioPlayer as DjsAudioPlayer,
} from '@discordjs/voice';
import { Client, ChannelType } from 'discord.js';
import { setVoiceConnected, setVoiceDisconnected, setVoiceIdle } from '../shared/statusStore';

const log = createLogger('AudioPlayer');
import { isPermanentVoiceMisconfigurationError } from '../discord/discordUtils';
import { createVoiceAdapterFactory, type VoiceAdapterFactory } from './voiceAdapter';
import {
  type ConnectionHandlerDeps,
  setupConnectionHandlers,
  releasePreviousConnection,
  cleanupFailedConnect,
} from './audioConnectionHandlers';

// ─── Per-guild voice state ──────────────────────────────────────────────────
//
// The bot can hold one voice connection per guild, so every connection-related
// field that used to be a module singleton now lives in a per-guild record keyed
// by guild ID. The reconnect state machine (attempt IDs, timers, backoff) runs
// independently per guild so a drop in one guild never disturbs another.
//
// The @discordjs/voice AudioPlayer below is intentionally a single shared
// instance (Pitfall #7 in the plan): only one guild can play audio at a time,
// and a resource sent to the player is heard on every connection currently
// subscribed. That is acceptable for the single-guild deployment (one
// connection) and is documented as an MVP limitation; true concurrency needs a
// per-guild player.

interface GuildVoiceState {
  guildId: string;
  connection: VoiceConnection | null;
  currentChannelId: string | null;
  targetChannelId: string | undefined;
  client: Client | null;
  reconnectTimer: NodeJS.Timeout | null;
  reconnectAttempts: number;
  shouldAutoReconnect: boolean;
  currentAttemptId: number;
  // Builds this guild's raw-gateway voice adapters and tracks their cleanup.
  adapterFactory: VoiceAdapterFactory;
}

const states = new Map<string, GuildVoiceState>();

/** Returns the voice state for a guild, creating an empty record on first use. */
function getState(guildId: string): GuildVoiceState {
  let state = states.get(guildId);
  if (!state) {
    state = {
      guildId,
      connection: null,
      currentChannelId: null,
      targetChannelId: undefined,
      client: null,
      reconnectTimer: null,
      reconnectAttempts: 0,
      shouldAutoReconnect: false,
      currentAttemptId: 0,
      adapterFactory: createVoiceAdapterFactory(),
    };
    states.set(guildId, state);
  }
  return state;
}

/** True if any guild currently holds a live voice connection. */
function anyConnected(): boolean {
  for (const state of states.values()) {
    if (state.connection) return true;
  }
  return false;
}

// Single shared audio player (see note above).
let player: DjsAudioPlayer;
let playing = false;

// ─── Reconnect ────────────────────────────────────────────────────────────────

const RECONNECT_BASE_DELAY_MS = 5_000;
const RECONNECT_MAX_DELAY_MS = 60_000;
const VOICE_CONNECT_TIMEOUT_MS = 30_000;

/** Cancels and nulls any pending reconnect timer for the given guild state. */
function clearReconnectTimer(state: GuildVoiceState): void {
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
}

/** Schedules an exponential-backoff voice reconnect for a guild, skipping if one is already pending. */
function scheduleReconnect(state: GuildVoiceState, reason: string): void {
  if (!state.shouldAutoReconnect || !state.client || state.reconnectTimer || state.connection) return;

  const scheduledAttemptId = state.currentAttemptId;
  const delay = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** state.reconnectAttempts, RECONNECT_MAX_DELAY_MS);
  state.reconnectAttempts += 1;

  log.warn(`Scheduling voice rejoin for guild ${state.guildId} in ${delay}ms (${reason}).`);
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    if (scheduledAttemptId !== state.currentAttemptId) return;
    if (!state.shouldAutoReconnect || !state.client || state.connection || !state.targetChannelId) return;
    connect(state.client, state.guildId, state.targetChannelId).catch((err) => {
      log.error(`Voice rejoin failed for guild ${state.guildId}:`, err);
    });
  }, delay);
}

/** Returns the shared audio player, lazily creating it with idle and error handlers on first use. */
function getPlayer(): DjsAudioPlayer {
  if (!player) {
    player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
    });
    player.on(AudioPlayerStatus.Idle, () => {
      playing = false;
      setVoiceIdle();
    });
    player.on('error', (err) => {
      log.error(`Error: ${err.message}`, err);
      playing = false;
    });
  }
  return player;
}

/**
 * Releases a guild's playback footprint after its connection is gone. Only stops
 * the shared player / clears the global playing status once no guild remains
 * connected, so tearing down one guild never silences another.
 */
function tearDownGuild(state: GuildVoiceState): void {
  state.currentChannelId = null;
  if (!anyConnected()) {
    try {
      getPlayer().stop(true);
    } catch {
      // Ignore audio stop errors during disconnect cleanup.
    }
    playing = false;
    setVoiceDisconnected();
  }
}

/** Builds the ConnectionHandlerDeps callbacks bound to a specific guild's mutable voice state. */
function makeDeps(state: GuildVoiceState): ConnectionHandlerDeps {
  return {
    getAttemptId: () => state.currentAttemptId,
    getConnection: () => state.connection,
    setConnection: (c) => { state.connection = c; },
    tearDown: () => tearDownGuild(state),
    scheduleReconnect: (reason) => scheduleReconnect(state, reason),
  };
}

/**
 * Join a voice channel in the given guild and subscribe the audio player.
 * Should be called once the Discord client is ready.
 *
 * @param client - The ready Discord client.
 * @param guildId - The guild whose voice channel to join (BIGINT snowflake string).
 * @param channelId - Target voice channel ID (required).
 * @returns Resolves once the connection is ready, or rejects if the join fails.
 */
export async function connect(client: Client, guildId: string, channelId: string): Promise<void> {
  const state = getState(guildId);
  clearReconnectTimer(state);
  const attemptId = ++state.currentAttemptId;
  let nextConnection: VoiceConnection | null = null;

  state.client = client;
  state.targetChannelId = channelId;
  state.shouldAutoReconnect = true;

  const previousConnection = state.connection;
  const deps = makeDeps(state);

  try {
    if (!guildId || !channelId) {
      // Message text must stay in sync with isPermanentVoiceMisconfigurationError
      // so this is classified as permanent (not retried).
      throw new Error('Missing guild ID or voice channel ID');
    }

    // Fetching the channel from the target guild also validates that the channel
    // belongs to that guild — a channel from another guild resolves to null here.
    const guild = await client.guilds.fetch(guildId);
    if (attemptId !== state.currentAttemptId) return;

    const channel = await guild.channels.fetch(channelId);
    if (attemptId !== state.currentAttemptId) return;

    if (!channel || channel.type !== ChannelType.GuildVoice) {
      throw new Error(`Channel ${channelId} is not a voice channel in guild ${guildId}`);
    }

    nextConnection = joinVoiceChannel({
      channelId: channel.id,
      guildId: guild.id,
      adapterCreator: state.adapterFactory.build(channel),
      selfDeaf: false,
      selfMute: false,
    });

    if (attemptId !== state.currentAttemptId) {
      nextConnection.destroy();
      return;
    }

    const joinedConnection = nextConnection;
    setupConnectionHandlers(joinedConnection, attemptId, deps);

    await entersState(joinedConnection, VoiceConnectionStatus.Ready, VOICE_CONNECT_TIMEOUT_MS);

    if (attemptId !== state.currentAttemptId) {
      joinedConnection.destroy();
      return;
    }

    releasePreviousConnection(previousConnection, joinedConnection, deps);
    state.connection = joinedConnection;
    state.currentChannelId = channel.id;

    clearReconnectTimer(state);
    log.info(`Voice connection ready for guild ${guildId}.`);
    state.reconnectAttempts = 0;

    joinedConnection.subscribe(getPlayer());
    setVoiceConnected(channel.name);
    log.info(`Joined voice channel: ${channel.name}`);
  } catch (err) {
    if (attemptId === state.currentAttemptId) {
      cleanupFailedConnect(previousConnection, nextConnection, deps);
    } else {
      nextConnection?.destroy();
    }

    if (attemptId === state.currentAttemptId && state.shouldAutoReconnect && !isPermanentVoiceMisconfigurationError(err)) {
      scheduleReconnect(state, 'connect failed');
    }

    throw err;
  }
}

/** Tears down a single guild's voice connection and reconnect state. */
function disconnectGuild(state: GuildVoiceState): void {
  state.currentAttemptId += 1;
  state.shouldAutoReconnect = false;
  state.client = null;
  state.targetChannelId = undefined;
  clearReconnectTimer(state);
  state.reconnectAttempts = 0;
  state.currentChannelId = null;

  const existingConnection = state.connection;
  if (existingConnection) {
    existingConnection.destroy();
    state.connection = null;
    if (!anyConnected()) {
      try {
        getPlayer().stop(true);
      } catch {
        // Ignore audio stop errors during disconnect cleanup.
      }
      playing = false;
      setVoiceDisconnected();
    }
    log.info(`Disconnected from voice channel for guild ${state.guildId}.`);
  }
}

/**
 * Disconnect from a guild's voice channel, or from every guild when no guild is
 * given. Safe to call when already disconnected.
 *
 * @param guildId - Guild to disconnect; omit to disconnect all guilds (e.g. on shutdown).
 */
export function disconnect(guildId?: string): void {
  if (guildId === undefined) {
    for (const state of states.values()) disconnectGuild(state);
    return;
  }
  const state = states.get(guildId);
  if (state) disconnectGuild(state);
}

/** Returns true if a sound is currently being played (shared across guilds). */
export function isPlaying(): boolean {
  return playing;
}

/**
 * Returns true if the bot is joined to a voice channel.
 *
 * @param guildId - Restrict the check to one guild; omit to test whether any guild is connected.
 */
export function isConnected(guildId?: string): boolean {
  if (guildId === undefined) return anyConnected();
  return states.get(guildId)?.connection != null;
}

/**
 * Returns the current voice channel ID for a guild, or null if not connected there.
 *
 * @param guildId - Guild to read the current channel for.
 */
export function getCurrentChannelId(guildId: string): string | null {
  return states.get(guildId)?.currentChannelId ?? null;
}

/**
 * Marks playback as active and sends the resource to the shared audio player.
 *
 * @param resource - The audio resource to play.
 */
export function startPlayback(resource: AudioResource): void {
  playing = true;
  getPlayer().play(resource);
}
