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
import { Client, ChannelType, type Guild, type VoiceChannel } from 'discord.js';
import { setVoiceConnected, setVoiceDisconnected, setVoiceIdle } from '../shared/statusStore';

const log = createLogger('AudioPlayer');
import { isPermanentVoiceMisconfigurationError } from '../discord/discordUtils';
import { getOrCreate } from '../shared/mapUtils';
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
// Each guild also gets its own @discordjs/voice AudioPlayer, subscribed only to
// that guild's connection, so two guilds can play independent audio
// concurrently — playing a sound in one guild is never heard in another.

interface GuildVoiceState {
  guildId: string;
  connection: VoiceConnection | null;
  // The connection the newest in-flight connect() attempt has joined, until it promotes or fails
  // (null before it joins).
  // @discordjs/voice returns the same VoiceConnection for every join in a guild while one is
  // alive, so a superseded attempt can hold the very object a newer attempt is still using —
  // see releaseStaleConnection.
  pendingConnection: VoiceConnection | null;
  currentChannelId: string | null;
  targetChannelId: string | undefined;
  client: Client | null;
  reconnectTimer: NodeJS.Timeout | null;
  reconnectAttempts: number;
  shouldAutoReconnect: boolean;
  currentAttemptId: number;
  // Builds this guild's raw-gateway voice adapters and tracks their cleanup.
  adapterFactory: VoiceAdapterFactory;
  player: DjsAudioPlayer | null;
  playing: boolean;
  // When the current connection became Ready (Date.now()), for the playback-start log's connection age.
  connectedAt: number | null;
  // When startPlayback last handed the player a resource, until the player reports Playing.
  playRequestedAt: number | null;
}

const states = new Map<string, GuildVoiceState>();

/**
 * Returns the voice state for a guild, creating an empty record on first use.
 * @param guildId - Discord snowflake of the guild.
 * @returns The existing or newly created voice state record for that guild.
 */
function getState(guildId: string): GuildVoiceState {
  return getOrCreate(states, guildId, () => ({
    guildId,
    connection: null,
    pendingConnection: null,
    currentChannelId: null,
    targetChannelId: undefined,
    client: null,
    reconnectTimer: null,
    reconnectAttempts: 0,
    shouldAutoReconnect: false,
    currentAttemptId: 0,
    adapterFactory: createVoiceAdapterFactory(),
    player: null,
    playing: false,
    connectedAt: null,
    playRequestedAt: null,
  }));
}

/**
 * True if any guild currently holds a live voice connection.
 * @returns True if at least one guild has a non-null connection.
 */
function anyConnected(): boolean {
  for (const state of states.values()) {
    if (state.connection) return true;
  }
  return false;
}

// ─── Reconnect ────────────────────────────────────────────────────────────────

const RECONNECT_BASE_DELAY_MS = 5_000;
const RECONNECT_MAX_DELAY_MS = 60_000;
const VOICE_CONNECT_TIMEOUT_MS = 30_000;

/**
 * A sound that takes longer than this from {@link startPlayback} to its first audio frame is
 * logged as a warning instead of at debug level, so a growing SFX delay shows up in the logs.
 */
const SLOW_PLAYBACK_START_MS = 500;

/**
 * Cancels and nulls any pending reconnect timer for the given guild state.
 * @param state - The guild voice state whose reconnect timer to clear.
 */
function clearReconnectTimer(state: GuildVoiceState): void {
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
}

/**
 * Schedules an exponential-backoff voice reconnect for a guild, skipping if one is already pending.
 * @param state - The guild voice state to reconnect.
 * @param reason - Why the rejoin is needed, included in the warning log.
 */
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
    connect(state.client, state.guildId, state.targetChannelId).catch((err: unknown) => {
      log.error(`Voice rejoin failed for guild ${state.guildId}:`, err);
    });
  }, delay);
}

/**
 * Returns this guild's audio player, lazily creating it with playing, idle and error handlers on first use.
 * @param state - The guild voice state that owns the player.
 * @returns The guild's audio player.
 */
function getPlayer(state: GuildVoiceState): DjsAudioPlayer {
  if (!state.player) {
    const guildPlayer = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
    });
    guildPlayer.on(AudioPlayerStatus.Playing, () => logPlaybackStart(state));
    guildPlayer.on(AudioPlayerStatus.Idle, () => {
      state.playing = false;
      state.playRequestedAt = null;
      setVoiceIdle(state.guildId);
    });
    guildPlayer.on('error', (err) => {
      log.error(`Error: ${err.message}`, err);
      state.playing = false;
      state.playRequestedAt = null;
      setVoiceIdle(state.guildId);
    });
    state.player = guildPlayer;
  }
  return state.player;
}

/**
 * Logs how long the sound handed to {@link startPlayback} took to reach its first audio frame
 * (ffmpeg spawn and decode), with the voice connection's age and gateway/UDP ping, so a growing
 * SFX delay can be traced to the audio pipeline, the voice connection or neither. A no-op when no
 * start is pending, e.g. when the player resumes from auto-pause mid-sound.
 * @param state - The guild's voice state.
 */
function logPlaybackStart(state: GuildVoiceState): void {
  if (state.playRequestedAt === null) return;
  const now = Date.now();
  const startupMs = now - state.playRequestedAt;
  state.playRequestedAt = null;
  const ping = state.connection?.ping;
  const ageMin = state.connectedAt === null ? '?' : Math.round((now - state.connectedAt) / 60_000);
  const message = `Playback started in guild ${state.guildId} after ${startupMs}ms`
    + ` (voice connected ${ageMin}min, ping ws ${ping?.ws ?? '?'}ms / udp ${ping?.udp ?? '?'}ms)`;
  if (startupMs > SLOW_PLAYBACK_START_MS) log.warn(message);
  else log.debug(message);
}

/**
 * Stops this guild's audio player (if any) and marks it not-playing, ignoring stop errors.
 * @param state - The guild voice state whose player to stop.
 */
function stopGuildPlayer(state: GuildVoiceState): void {
  try {
    state.player?.stop(true);
  } catch {
    // Ignore audio stop errors during disconnect cleanup.
  }
  state.playing = false;
}

/**
 * Releases a guild's playback footprint after its connection is gone. Always
 * stops this guild's own player and clears this guild's own voice status —
 * status is scoped per guild, so tearing down one guild's connection never
 * affects another guild's reported state.
 * @param state - The guild voice state to tear down.
 */
function tearDownGuild(state: GuildVoiceState): void {
  state.currentChannelId = null;
  stopGuildPlayer(state);
  setVoiceDisconnected(state.guildId);
}

/**
 * Builds the ConnectionHandlerDeps callbacks bound to a specific guild's mutable voice state.
 * @param state - The guild voice state the callbacks read and mutate.
 * @returns Connection-handler dependencies scoped to that guild.
 */
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
  // Only a connection this (now newest) attempt has actually joined is protected from stale cleanup.
  state.pendingConnection = null;
  let nextConnection: VoiceConnection | null = null;

  state.client = client;
  state.targetChannelId = channelId;
  state.shouldAutoReconnect = true;

  const previousConnection = state.connection;
  const deps = makeDeps(state);
  const isStale = () => attemptId !== state.currentAttemptId;

  try {
    const resolved = await resolveVoiceChannel(client, guildId, channelId, isStale);
    if (!resolved) return;
    const { guild, channel } = resolved;

    nextConnection = joinVoiceChannel({
      channelId: channel.id,
      guildId: guild.id,
      adapterCreator: state.adapterFactory.build(channel),
      selfDeaf: false,
      selfMute: false,
    });

    // Defensive: unreachable today. joinVoiceChannel is synchronous, and the only things that make
    // this attempt stale (a newer connect() or disconnectGuild(), both driven by HTTP routes,
    // guildDelete or shutdown) can't run inside it. Kept so a future synchronous path out of
    // joinVoiceChannel (an adapter or stateChange listener that disconnects) still can't leave a
    // stale attempt waiting on Ready with handlers attached.
    if (isStale()) {
      releaseStaleConnection(state, nextConnection);
      return;
    }
    state.pendingConnection = nextConnection;

    const joinedConnection = nextConnection;
    setupConnectionHandlers(joinedConnection, attemptId, deps);

    await entersState(joinedConnection, VoiceConnectionStatus.Ready, VOICE_CONNECT_TIMEOUT_MS);

    if (isStale()) {
      releaseStaleConnection(state, joinedConnection);
      return;
    }

    releasePreviousConnection(previousConnection, joinedConnection, deps);
    state.pendingConnection = null;
    state.connection = joinedConnection;
    // @discordjs/voice hands back the live connection when this guild is already joined, so keep
    // its original Ready time for a reused connection; only a new one restarts the age.
    if (joinedConnection !== previousConnection || state.connectedAt === null) state.connectedAt = Date.now();
    state.currentChannelId = channel.id;

    clearReconnectTimer(state);
    log.info(`Voice connection ready for guild ${guildId}.`);
    state.reconnectAttempts = 0;

    joinedConnection.subscribe(getPlayer(state));
    setVoiceConnected(guildId, channel.name);
    log.info(`Joined voice channel: ${channel.name}`);
  } catch (err) {
    handleConnectFailure(state, isStale(), { previousConnection, nextConnection }, err);
    throw err;
  }
}

/**
 * Fetches and validates the target guild and voice channel for {@link connect}. Fetching the
 * channel from the target guild also validates that the channel belongs to that guild — a
 * channel from another guild resolves to null here.
 * @param client - The ready Discord client.
 * @param guildId - The guild to fetch.
 * @param channelId - The voice channel to fetch within that guild.
 * @param isStale - Returns true once a newer connect/disconnect has superseded this attempt;
 *   checked after each fetch.
 * @returns The guild and voice channel, or null if the attempt went stale mid-fetch.
 * @throws If either ID is missing, or the channel isn't a voice channel in that guild.
 */
async function resolveVoiceChannel(
  client: Client, guildId: string, channelId: string, isStale: () => boolean,
): Promise<{ guild: Guild; channel: VoiceChannel } | null> {
  if (!guildId || !channelId) {
    // Message text must stay in sync with isPermanentVoiceMisconfigurationError
    // so this is classified as permanent (not retried).
    throw new Error('Missing guild ID or voice channel ID');
  }

  const guild = await client.guilds.fetch(guildId);
  if (isStale()) return null;

  const channel = await guild.channels.fetch(channelId);
  if (isStale()) return null;

  if (channel?.type !== ChannelType.GuildVoice) {
    throw new Error(`Channel ${channelId} is not a voice channel in guild ${guildId}`);
  }
  return { guild, channel };
}

/**
 * Destroys the connection a superseded {@link connect} attempt joined, unless something newer still
 * uses it. @discordjs/voice hands back the existing VoiceConnection for every join in a guild while
 * one is alive, so the stale attempt's connection may be the live one (`state.connection`) or the
 * one the newest in-flight attempt is waiting on (`state.pendingConnection`); destroying it would
 * kill that session. An already-destroyed connection is skipped, since destroying it again throws.
 * @param state - The guild's voice state.
 * @param connection - The connection the stale attempt joined, or null if it never got that far.
 */
function releaseStaleConnection(state: GuildVoiceState, connection: VoiceConnection | null): void {
  if (!connection || connection === state.connection || connection === state.pendingConnection) return;
  if (connection.state.status === VoiceConnectionStatus.Destroyed) return;
  connection.destroy();
}

/**
 * Cleans up after a failed {@link connect} attempt. The current attempt restores/tears down
 * connection state and, unless the error is a permanent misconfiguration, schedules a reconnect;
 * a superseded attempt only releases its own connection (see {@link releaseStaleConnection}).
 * @param state - The guild's voice state.
 * @param stale - Whether this attempt has been superseded by a newer one.
 * @param connections - `previousConnection`: the connection that was active before this attempt
 *   started; `nextConnection`: the connection this attempt created, if it got that far.
 * @param err - The error the attempt failed with.
 */
function handleConnectFailure(
  state: GuildVoiceState,
  stale: boolean,
  { previousConnection, nextConnection }: { previousConnection: VoiceConnection | null; nextConnection: VoiceConnection | null },
  err: unknown,
): void {
  if (stale) {
    releaseStaleConnection(state, nextConnection);
    return;
  }
  state.pendingConnection = null;
  cleanupFailedConnect(previousConnection, nextConnection, makeDeps(state));
  if (state.shouldAutoReconnect && !isPermanentVoiceMisconfigurationError(err)) {
    scheduleReconnect(state, 'connect failed');
  }
}

/**
 * Tears down a single guild's voice connection and reconnect state.
 * @param state - The guild voice state to disconnect.
 */
function disconnectGuild(state: GuildVoiceState): void {
  state.currentAttemptId += 1;
  // Any in-flight attempt is now stale; clearing this lets it destroy its connection when it notices.
  state.pendingConnection = null;
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
    stopGuildPlayer(state);
    setVoiceDisconnected(state.guildId);
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

/**
 * Returns true if a sound is currently being played in the given guild.
 *
 * @param guildId - Guild to check.
 * @returns True while the guild's player has a sound in progress; false for unknown guilds.
 */
export function isPlaying(guildId: string): boolean {
  return states.get(guildId)?.playing ?? false;
}

/**
 * Returns true if the bot is joined to a voice channel.
 *
 * @param guildId - Restrict the check to one guild; omit to test whether any guild is connected.
 * @returns True if the given guild (or, with no guild, any guild) has a live voice connection.
 */
export function isConnected(guildId?: string): boolean {
  if (guildId === undefined) return anyConnected();
  return states.get(guildId)?.connection != null;
}

/**
 * Returns the current voice channel ID for a guild, or null if not connected there.
 *
 * @param guildId - Guild to read the current channel for.
 * @returns Discord snowflake of the joined voice channel, or null when not connected in that guild.
 */
export function getCurrentChannelId(guildId: string): string | null {
  return states.get(guildId)?.currentChannelId ?? null;
}

/**
 * Fully forgets a guild's voice state — disconnecting first if still
 * connected — so it stops occupying memory once the bot is no longer in
 * that guild. Safe to call for a guild with no state (no-op). Called from
 * the `guildDelete` handler; a guild the bot rejoins later starts fresh via
 * {@link getState}'s lazy creation.
 *
 * @param guildId - Guild to forget.
 */
export function forgetGuild(guildId: string): void {
  const state = states.get(guildId);
  if (state) {
    disconnectGuild(state);
  }
  states.delete(guildId);
}

/**
 * Marks playback as active for the given guild and sends the resource to that
 * guild's own audio player.
 *
 * @param resource - The audio resource to play.
 * @param guildId - Guild to play the resource in.
 */
export function startPlayback(resource: AudioResource, guildId: string): void {
  const state = getState(guildId);
  state.playing = true;
  state.playRequestedAt = Date.now();
  getPlayer(state).play(resource);
}
