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
  type DiscordGatewayAdapterCreator,
  type DiscordGatewayAdapterLibraryMethods,
} from '@discordjs/voice';
import { Client, ChannelType, type VoiceBasedChannel } from 'discord.js';
import { setVoiceConnected, setVoiceDisconnected, setVoiceIdle } from '../shared/statusStore';

const log = createLogger('AudioPlayer');
import { isPermanentVoiceMisconfigurationError } from '../discord/discordUtils';
import {
  type ConnectionHandlerDeps,
  setupConnectionHandlers,
  releasePreviousConnection,
  cleanupFailedConnect,
} from './audioConnectionHandlers';
import type { GuildAudioContext } from './audioTypes';

// ─── Per-guild session state ──────────────────────────────────────────────────

interface AudioSession {
  connection: VoiceConnection | null;
  player: DjsAudioPlayer;
  playing: boolean;
  adapterCleanup: (() => void) | null;
  reconnectTimer: NodeJS.Timeout | null;
  reconnectAttempts: number;
  shouldAutoReconnect: boolean;
  currentAttemptId: number;
  currentChannelId: string | null;
  targetChannelId: string | undefined;
}

const sessions = new Map<string, AudioSession>();
let activeClient: Client | null = null;

function getOrCreateSession(guildId: string): AudioSession {
  const existing = sessions.get(guildId);
  if (existing) return existing;

  const player = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
  });
  player.on(AudioPlayerStatus.Idle, () => {
    const s = sessions.get(guildId);
    if (s) {
      s.playing = false;
      setVoiceIdle();
    }
  });
  player.on('error', (err) => {
    log.error(`[${guildId}] Error: ${err.message}`, err);
    const s = sessions.get(guildId);
    if (s) s.playing = false;
  });

  const session: AudioSession = {
    connection: null,
    player,
    playing: false,
    adapterCleanup: null,
    reconnectTimer: null,
    reconnectAttempts: 0,
    shouldAutoReconnect: false,
    currentAttemptId: 0,
    currentChannelId: null,
    targetChannelId: undefined,
  };
  sessions.set(guildId, session);
  return session;
}

// ─── Voice adapter ────────────────────────────────────────────────────────────
// Bypasses discord.js's built-in voiceAdapterCreator to avoid type/version
// incompatibilities with discord.js v14. Listens to raw gateway events instead.

type RawPacket = { t: string; d: Record<string, unknown> };

function makeOnRaw(methods: DiscordGatewayAdapterLibraryMethods): (packet: RawPacket) => void {
  return function onRaw(packet: RawPacket): void {
    if (packet.t === 'VOICE_STATE_UPDATE') {
      methods.onVoiceStateUpdate(packet.d as unknown as Parameters<typeof methods.onVoiceStateUpdate>[0]);
    }
    if (packet.t === 'VOICE_SERVER_UPDATE') {
      methods.onVoiceServerUpdate(packet.d as unknown as Parameters<typeof methods.onVoiceServerUpdate>[0]);
    }
  };
}

function makeAdapterCleanup(
  channel: VoiceBasedChannel,
  onRaw: (packet: RawPacket) => void,
  originalMax: number,
  session: AudioSession,
): () => void {
  let cleanedUp = false;
  return function cleanup(): void {
    if (cleanedUp) return;
    cleanedUp = true;
    channel.client.off('raw', onRaw);
    if (originalMax !== 0) channel.client.setMaxListeners(originalMax);
    session.adapterCleanup = null;
  };
}

function buildAdapter(channel: VoiceBasedChannel, session: AudioSession): DiscordGatewayAdapterCreator {
  return (methods: DiscordGatewayAdapterLibraryMethods) => {
    if (session.adapterCleanup) session.adapterCleanup();

    const onRaw = makeOnRaw(methods);
    const originalMax = channel.client.getMaxListeners();
    // 0 means unlimited — don't touch it.
    if (originalMax !== 0) channel.client.setMaxListeners(originalMax + 1);
    channel.client.on('raw', onRaw);

    const cleanup = makeAdapterCleanup(channel, onRaw, originalMax, session);
    session.adapterCleanup = cleanup;

    return {
      sendPayload: (payload: unknown) => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          channel.guild.shard.send(payload as any);
          return true;
        } catch {
          return false;
        }
      },
      destroy: cleanup,
    };
  };
}

// ─── Reconnect ────────────────────────────────────────────────────────────────

const RECONNECT_BASE_DELAY_MS = 5_000;
const RECONNECT_MAX_DELAY_MS = 60_000;
const VOICE_CONNECT_TIMEOUT_MS = 30_000;

function clearReconnectTimer(session: AudioSession): void {
  if (session.reconnectTimer) {
    clearTimeout(session.reconnectTimer);
    session.reconnectTimer = null;
  }
}

function scheduleReconnect(guildId: string, reason: string): void {
  const session = sessions.get(guildId);
  if (!session) return;
  if (!session.shouldAutoReconnect || !activeClient || session.reconnectTimer || session.connection) return;

  const scheduledAttemptId = session.currentAttemptId;
  const delay = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** session.reconnectAttempts, RECONNECT_MAX_DELAY_MS);
  session.reconnectAttempts += 1;

  log.warn(`[${guildId}] Scheduling voice rejoin in ${delay}ms (${reason}).`);
  session.reconnectTimer = setTimeout(() => {
    session.reconnectTimer = null;
    if (scheduledAttemptId !== session.currentAttemptId) return;
    if (!session.shouldAutoReconnect || !activeClient || session.connection) return;
    if (!session.targetChannelId) return;
    connect(activeClient, { guildId, voiceChannelId: session.targetChannelId }).catch((err) => {
      log.error(`[${guildId}] Voice rejoin failed:`, err);
    });
  }, delay);
}

function tearDownSession(guildId: string): void {
  const session = sessions.get(guildId);
  if (!session) return;
  try {
    session.player.stop(true);
  } catch {
    // Ignore audio stop errors during disconnect cleanup.
  }
  session.playing = false;
  session.currentChannelId = null;
  setVoiceDisconnected();
}

function makeDeps(guildId: string): ConnectionHandlerDeps {
  const session = getOrCreateSession(guildId);
  return {
    getAttemptId: () => session.currentAttemptId,
    getConnection: () => session.connection,
    setConnection: (c) => { session.connection = c; },
    tearDown: () => tearDownSession(guildId),
    scheduleReconnect: (reason) => scheduleReconnect(guildId, reason),
  };
}

/**
 * Join the specified voice channel in the given guild and subscribe the audio player.
 * Creates a new per-guild session if one does not already exist.
 */
export async function connect(client: Client, ctx: GuildAudioContext): Promise<void> {
  const { guildId, voiceChannelId } = ctx;
  const session = getOrCreateSession(guildId);

  clearReconnectTimer(session);
  const attemptId = ++session.currentAttemptId;
  let nextConnection: VoiceConnection | null = null;

  activeClient = client;
  session.targetChannelId = voiceChannelId;
  session.shouldAutoReconnect = true;

  const previousConnection = session.connection;
  const deps = makeDeps(guildId);

  try {
    if (!guildId || !voiceChannelId) {
      throw new Error('Missing guildId or voiceChannelId');
    }

    const guild = await client.guilds.fetch(guildId);
    if (attemptId !== session.currentAttemptId) return;

    const channel = await guild.channels.fetch(voiceChannelId);
    if (attemptId !== session.currentAttemptId) return;

    if (!channel || channel.type !== ChannelType.GuildVoice) {
      throw new Error(`Channel ${voiceChannelId} is not a voice channel`);
    }

    nextConnection = joinVoiceChannel({
      channelId: channel.id,
      guildId: guild.id,
      adapterCreator: buildAdapter(channel, session),
      selfDeaf: false,
      selfMute: false,
    });

    if (attemptId !== session.currentAttemptId) {
      nextConnection.destroy();
      return;
    }

    const joinedConnection = nextConnection;
    setupConnectionHandlers(joinedConnection, attemptId, deps);

    await entersState(joinedConnection, VoiceConnectionStatus.Ready, VOICE_CONNECT_TIMEOUT_MS);

    if (attemptId !== session.currentAttemptId) {
      joinedConnection.destroy();
      return;
    }

    releasePreviousConnection(previousConnection, joinedConnection, deps);
    session.connection = joinedConnection;
    session.currentChannelId = channel.id;

    clearReconnectTimer(session);
    log.info(`[${guildId}] Voice connection ready.`);
    session.reconnectAttempts = 0;

    joinedConnection.subscribe(session.player);
    setVoiceConnected(channel.name);
    log.info(`[${guildId}] Joined voice channel: ${channel.name}`);
  } catch (err) {
    if (attemptId === session.currentAttemptId) {
      cleanupFailedConnect(previousConnection, nextConnection, deps);
    } else {
      nextConnection?.destroy();
    }

    if (attemptId === session.currentAttemptId && session.shouldAutoReconnect && !isPermanentVoiceMisconfigurationError(err)) {
      scheduleReconnect(guildId, 'connect failed');
    }

    throw err;
  }
}

/**
 * Disconnect from the voice channel for a specific guild.
 * Safe to call when already disconnected.
 */
export function disconnect(guildId: string): void {
  const session = sessions.get(guildId);
  if (!session) return;

  session.currentAttemptId += 1;
  session.shouldAutoReconnect = false;
  session.targetChannelId = undefined;
  clearReconnectTimer(session);
  session.reconnectAttempts = 0;
  session.currentChannelId = null;

  const existingConnection = session.connection;
  if (existingConnection) {
    existingConnection.destroy();
    session.connection = null;
    try {
      session.player.stop(true);
    } catch {
      // Ignore audio stop errors during disconnect cleanup.
    }
    session.playing = false;
    setVoiceDisconnected();
    log.info(`[${guildId}] Disconnected from voice channel.`);
  }
}

/**
 * Disconnect all active guild voice sessions. Called during process shutdown.
 */
export function disconnectAll(): void {
  for (const guildId of sessions.keys()) {
    disconnect(guildId);
  }
  sessions.clear();
  activeClient = null;
}

/**
 * Returns true if a sound is currently being played in the given guild.
 * If guildId is omitted, returns true if any guild is playing.
 */
export function isPlaying(guildId?: string): boolean {
  if (guildId !== undefined) {
    return sessions.get(guildId)?.playing ?? false;
  }
  for (const s of sessions.values()) {
    if (s.playing) return true;
  }
  return false;
}

/**
 * Returns true if the bot is currently joined to a voice channel in the given guild.
 */
export function isConnected(guildId: string): boolean {
  return (sessions.get(guildId)?.connection ?? null) !== null;
}

/**
 * Returns the current voice channel ID for the given guild if connected, null otherwise.
 */
export function getCurrentChannelId(guildId: string): string | null {
  return sessions.get(guildId)?.currentChannelId ?? null;
}

/**
 * Marks playback as active and sends the resource to the audio player for the given guild.
 */
export function startPlayback(resource: AudioResource, guildId: string): void {
  const session = sessions.get(guildId);
  if (!session) throw new Error(`No audio session for guild ${guildId}`);
  session.playing = true;
  session.player.play(resource);
}
