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
import { DISCORD_GUILD_ID, DISCORD_VOICE_CHANNEL_ID } from './config';
import { setVoiceConnected, setVoiceDisconnected, setVoiceIdle } from './statusStore';
import { buildAdapter } from './voiceAdapter';

let connection: VoiceConnection | null = null;
let player: DjsAudioPlayer;
let playing = false;
let activeClient: Client | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let reconnectAttempts = 0;
let shouldAutoReconnect = false;
let currentAttemptId = 0;

const RECONNECT_BASE_DELAY_MS = 5_000;
const RECONNECT_MAX_DELAY_MS = 60_000;


function isPermanentMisconfigurationError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }

  const { message } = err;
  const apiErr = err as Error & { status?: number; code?: number | string; rawError?: { message?: string } };
  const status = apiErr.status;
  const code = typeof apiErr.code === 'string' ? Number(apiErr.code) : apiErr.code;
  const rawMessage = apiErr.rawError?.message ?? '';

  const isConfigError =
    message.includes('Missing DISCORD_GUILD_ID or DISCORD_VOICE_CHANNEL_ID') ||
    message.includes('is not a voice channel');
  const isForbiddenOrMissing = status === 403 || status === 404;
  const isKnownApiCode = code === 10003 || code === 10004 || code === 50001;
  const isUnknownResource =
    rawMessage.includes('Unknown Guild') || rawMessage.includes('Unknown Channel');

  return isConfigError || isForbiddenOrMissing || isKnownApiCode || isUnknownResource;
}

function clearReconnectTimer(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleReconnect(reason: string): void {
  if (!shouldAutoReconnect || !activeClient || reconnectTimer || connection) {
    return;
  }

  const scheduledAttemptId = currentAttemptId;

  const delay = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** reconnectAttempts, RECONNECT_MAX_DELAY_MS);
  reconnectAttempts += 1;

  console.warn(`[AudioPlayer] Scheduling voice rejoin in ${delay}ms (${reason}).`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (scheduledAttemptId !== currentAttemptId) {
      return;
    }

    if (!shouldAutoReconnect || !activeClient || connection) {
      return;
    }

    connect(activeClient)
      .catch((err) => {
        console.error('[AudioPlayer] Voice rejoin failed:', err);
      });
  }, delay);
}

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
      console.error('[AudioPlayer] Error:', err.message, err);
      playing = false;
    });
  }
  return player;
}

function tearDownPlayer(): void {
  try {
    getPlayer().stop(true);
  } catch {
    // Ignore audio stop errors during disconnect cleanup.
  }
  playing = false;
  setVoiceDisconnected();
}

// Reconnect scheduling is handled by the Disconnected state handler.
function handleConnectionError(err: Error, attemptId: number): void {
  if (attemptId !== currentAttemptId) return;

  const netErr = err as NodeJS.ErrnoException & { hostname?: string };
  if (netErr.code === 'EAI_AGAIN') {
    const host = netErr.hostname ? ` (${netErr.hostname})` : '';
    console.warn(`[AudioPlayer] Voice DNS lookup failed temporarily${host}; connection will retry via state handler.`);
    return;
  }
  console.error('[AudioPlayer] Voice connection error:', err);
}

async function handleDisconnected(joinedConnection: VoiceConnection, attemptId: number): Promise<void> {
  if (attemptId !== currentAttemptId || (connection !== null && connection !== joinedConnection)) {
    return;
  }

  try {
    await Promise.race([
      entersState(joinedConnection, VoiceConnectionStatus.Signalling, 5_000),
      entersState(joinedConnection, VoiceConnectionStatus.Connecting, 5_000),
    ]);
    // Reconnecting
  } catch {
    if (attemptId !== currentAttemptId || (connection !== null && connection !== joinedConnection)) {
      return;
    }

    // Truly disconnected - clean up
    joinedConnection.destroy();
    if (connection === joinedConnection) {
      connection = null;
    }
    tearDownPlayer();
    console.warn('[AudioPlayer] Voice connection lost.');
    scheduleReconnect('disconnected');
  }
}

function releasePreviousConnection(
  previousConnection: VoiceConnection | null,
  joinedConnection: VoiceConnection,
): void {
  if (!previousConnection || previousConnection === joinedConnection) return;
  previousConnection.destroy();
  if (connection === previousConnection) {
    connection = null;
  }
}

function cleanupFailedConnect(
  previousConnection: VoiceConnection | null,
  nextConnection: VoiceConnection | null,
): void {
  nextConnection?.destroy();
  // If the new attempt failed before promoting, previousConnection was never torn down.
  // Destroy it now so scheduleReconnect is not blocked by a stale non-null connection.
  if (previousConnection && connection === previousConnection) {
    previousConnection.destroy();
    connection = null;
    tearDownPlayer();
  }
}

function setupConnectionHandlers(joinedConnection: VoiceConnection, attemptId: number): void {
  joinedConnection.on('error', (err) => handleConnectionError(err, attemptId));
  joinedConnection.on(VoiceConnectionStatus.Disconnected, () => handleDisconnected(joinedConnection, attemptId));
}

/**
 * Join the configured voice channel and subscribe the audio player.
 * Should be called once the Discord client is ready.
 */
export async function connect(client: Client): Promise<void> {
  clearReconnectTimer();
  const attemptId = ++currentAttemptId;
  let nextConnection: VoiceConnection | null = null;

  activeClient = client;
  shouldAutoReconnect = true;

  const previousConnection = connection;

  try {
    if (!DISCORD_GUILD_ID || !DISCORD_VOICE_CHANNEL_ID) {
      throw new Error('Missing DISCORD_GUILD_ID or DISCORD_VOICE_CHANNEL_ID');
    }

    const guild = await client.guilds.fetch(DISCORD_GUILD_ID);
    if (attemptId !== currentAttemptId) return;

    const channel = await guild.channels.fetch(DISCORD_VOICE_CHANNEL_ID);
    if (attemptId !== currentAttemptId) return;

    if (!channel || channel.type !== ChannelType.GuildVoice) {
      throw new Error(`Channel ${DISCORD_VOICE_CHANNEL_ID} is not a voice channel`);
    }

    nextConnection = joinVoiceChannel({
      channelId: channel.id,
      guildId: guild.id,
      adapterCreator: buildAdapter(channel),
      selfDeaf: false,
      selfMute: false,
    });

    if (attemptId !== currentAttemptId) {
      nextConnection.destroy();
      return;
    }

    const joinedConnection = nextConnection;
    setupConnectionHandlers(joinedConnection, attemptId);

    await entersState(joinedConnection, VoiceConnectionStatus.Ready, 30_000);

    if (attemptId !== currentAttemptId) {
      joinedConnection.destroy();
      return;
    }

    releasePreviousConnection(previousConnection, joinedConnection);
    connection = joinedConnection;

    clearReconnectTimer();
    console.log('[AudioPlayer] Voice connection ready.');
    reconnectAttempts = 0;

    joinedConnection.subscribe(getPlayer());
    setVoiceConnected(channel.name);
    console.log(`[AudioPlayer] Joined voice channel: ${channel.name}`);
  } catch (err) {
    cleanupFailedConnect(previousConnection, nextConnection);

    if (attemptId === currentAttemptId && shouldAutoReconnect && !isPermanentMisconfigurationError(err)) {
      scheduleReconnect('connect failed');
    }

    throw err;
  }
}

/**
 * Disconnect from the current voice channel, if connected.
 * Safe to call when already disconnected.
 */
export function disconnect(): void {
  currentAttemptId += 1;
  shouldAutoReconnect = false;
  activeClient = null;
  clearReconnectTimer();
  reconnectAttempts = 0;

  const existingConnection = connection;
  if (existingConnection) {
    existingConnection.destroy();
    connection = null;
    try {
      getPlayer().stop(true);
    } catch {
      // Ignore audio stop errors during disconnect cleanup.
    }
    playing = false;
    setVoiceDisconnected();
    console.log('[AudioPlayer] Disconnected from voice channel.');
  }
}

/** Returns true if a sound is currently being played. */
export function isPlaying(): boolean {
  return playing;
}

/** Returns true if the bot is currently joined to a voice channel. */
export function isConnected(): boolean {
  return connection !== null;
}

/** Marks playback as active and sends the resource to the audio player. */
export function startPlayback(resource: AudioResource): void {
  playing = true;
  getPlayer().play(resource);
}
