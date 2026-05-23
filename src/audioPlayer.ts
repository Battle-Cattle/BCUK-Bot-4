import { createLogger } from './logger';
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

const log = createLogger('AudioPlayer');
import { buildAdapter } from './voiceAdapter';
import { isPermanentVoiceMisconfigurationError } from './discordUtils';
import {
  type ConnectionHandlerDeps,
  setupConnectionHandlers,
  releasePreviousConnection,
  cleanupFailedConnect,
} from './audioConnectionHandlers';

let connection: VoiceConnection | null = null;
let player: DjsAudioPlayer;
let playing = false;
let activeClient: Client | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let reconnectAttempts = 0;
let shouldAutoReconnect = false;
let currentAttemptId = 0;
let currentChannelId: string | null = null;
let targetChannelId: string | undefined = undefined;

const RECONNECT_BASE_DELAY_MS = 5_000;
const RECONNECT_MAX_DELAY_MS = 60_000;
const VOICE_CONNECT_TIMEOUT_MS = 30_000;

function clearReconnectTimer(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleReconnect(reason: string): void {
  if (!shouldAutoReconnect || !activeClient || reconnectTimer || connection) return;

  const scheduledAttemptId = currentAttemptId;
  const delay = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** reconnectAttempts, RECONNECT_MAX_DELAY_MS);
  reconnectAttempts += 1;

  log.warn(`Scheduling voice rejoin in ${delay}ms (${reason}).`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (scheduledAttemptId !== currentAttemptId) return;
    if (!shouldAutoReconnect || !activeClient || connection) return;
    connect(activeClient, targetChannelId).catch((err) => {
      log.error('Voice rejoin failed:', err);
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
      log.error(`Error: ${err.message}`, err);
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
  currentChannelId = null;
  setVoiceDisconnected();
}

function makeDeps(): ConnectionHandlerDeps {
  return {
    getAttemptId: () => currentAttemptId,
    getConnection: () => connection,
    setConnection: (c) => { connection = c; },
    tearDown: tearDownPlayer,
    scheduleReconnect,
  };
}

/**
 * Join the specified voice channel or the configured one and subscribe the audio player.
 * Should be called once the Discord client is ready.
 */
export async function connect(client: Client, channelId?: string): Promise<void> {
  clearReconnectTimer();
  const attemptId = ++currentAttemptId;
  let nextConnection: VoiceConnection | null = null;

  activeClient = client;
  targetChannelId = channelId;
  shouldAutoReconnect = true;

  const previousConnection = connection;
  const deps = makeDeps();

  try {
    const resolvedChannelId = channelId || DISCORD_VOICE_CHANNEL_ID;

    if (!DISCORD_GUILD_ID || !resolvedChannelId) {
      throw new Error('Missing DISCORD_GUILD_ID or voice channel ID');
    }

    const guild = await client.guilds.fetch(DISCORD_GUILD_ID);
    if (attemptId !== currentAttemptId) return;

    const channel = await guild.channels.fetch(resolvedChannelId);
    if (attemptId !== currentAttemptId) return;

    if (!channel || channel.type !== ChannelType.GuildVoice) {
      throw new Error(`Channel ${resolvedChannelId} is not a voice channel`);
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
    setupConnectionHandlers(joinedConnection, attemptId, deps);

    await entersState(joinedConnection, VoiceConnectionStatus.Ready, VOICE_CONNECT_TIMEOUT_MS);

    if (attemptId !== currentAttemptId) {
      joinedConnection.destroy();
      return;
    }

    releasePreviousConnection(previousConnection, joinedConnection, deps);
    connection = joinedConnection;
    currentChannelId = channel.id;

    clearReconnectTimer();
    log.info('Voice connection ready.');
    reconnectAttempts = 0;

    joinedConnection.subscribe(getPlayer());
    setVoiceConnected(channel.name);
    log.info(`Joined voice channel: ${channel.name}`);
  } catch (err) {
    if (attemptId === currentAttemptId) {
      cleanupFailedConnect(previousConnection, nextConnection, deps);
    } else {
      nextConnection?.destroy();
    }

    if (attemptId === currentAttemptId && shouldAutoReconnect && !isPermanentVoiceMisconfigurationError(err)) {
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
  targetChannelId = undefined;
  clearReconnectTimer();
  reconnectAttempts = 0;
  currentChannelId = null;

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
    log.info('Disconnected from voice channel.');
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

/** Returns the current voice channel ID if connected, null otherwise. */
export function getCurrentChannelId(): string | null {
  return currentChannelId;
}

/** Marks playback as active and sends the resource to the audio player. */
export function startPlayback(resource: AudioResource): void {
  playing = true;
  getPlayer().play(resource);
}
