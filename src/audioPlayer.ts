import {
  createAudioPlayer,
  createAudioResource,
  joinVoiceChannel,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
  NoSubscriberBehavior,
  type VoiceConnection,
  type AudioPlayer as DjsAudioPlayer,
  type DiscordGatewayAdapterCreator,
  type DiscordGatewayAdapterLibraryMethods,
} from '@discordjs/voice';
import { Client, ChannelType, type VoiceBasedChannel } from 'discord.js';
import path from 'path';
import fs from 'fs';
import ffmpegPath from 'ffmpeg-static';
import { DISCORD_GUILD_ID, DISCORD_VOICE_CHANNEL_ID } from './config';
import { setVoiceConnected, setVoiceDisconnected, setVoiceIdle } from './statusStore';

// Tell @discordjs/voice where the ffmpeg binary is
if (ffmpegPath) {
  process.env.FFMPEG_PATH = ffmpegPath;
} else {
  console.warn('[AudioPlayer] ffmpeg-static returned no path!');
}

/**
 * Build a voice adapter that listens to the raw Discord gateway events.
 * This bypasses any type/version mismatch in discord.js's built-in voiceAdapterCreator.
 */
function buildAdapter(channel: VoiceBasedChannel): DiscordGatewayAdapterCreator {
  return (methods: DiscordGatewayAdapterLibraryMethods) => {
    function onRaw(packet: { t: string; d: Record<string, unknown> }) {
      if (packet.t === 'VOICE_STATE_UPDATE') {
        methods.onVoiceStateUpdate(packet.d as unknown as Parameters<typeof methods.onVoiceStateUpdate>[0]);
      }
      if (packet.t === 'VOICE_SERVER_UPDATE') {
        methods.onVoiceServerUpdate(packet.d as unknown as Parameters<typeof methods.onVoiceServerUpdate>[0]);
      }
    }
    channel.client.on('raw', onRaw);
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
      destroy: () => channel.client.off('raw', onRaw),
    };
  };
}

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

/**
 * Join the configured voice channel and subscribe the audio player.
 * Should be called once the Discord client is ready.
 */
export async function connect(client: Client): Promise<void> {
  const attemptId = ++currentAttemptId;
  let nextConnection: VoiceConnection | null = null;

  activeClient = client;
  shouldAutoReconnect = true;

  const previousConnection = connection;
  if (previousConnection) {
    previousConnection.destroy();
    if (connection === previousConnection) {
      connection = null;
    }
  }

  try {
    if (!DISCORD_GUILD_ID || !DISCORD_VOICE_CHANNEL_ID) {
      throw new Error('Missing DISCORD_GUILD_ID or DISCORD_VOICE_CHANNEL_ID');
    }

    const guild = await client.guilds.fetch(DISCORD_GUILD_ID);
    if (attemptId !== currentAttemptId) {
      return;
    }

    const channel = await guild.channels.fetch(DISCORD_VOICE_CHANNEL_ID);
    if (attemptId !== currentAttemptId) {
      return;
    }

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

    connection = joinedConnection;

    // Register immediately so join/rejoin handshake errors do not become unhandled.
    joinedConnection.on('error', (err) => {
      if (attemptId !== currentAttemptId || connection !== joinedConnection) {
        return;
      }

      const netErr = err as NodeJS.ErrnoException & { hostname?: string };
      const host = netErr.hostname;
      const code = netErr.code;
      // Reconnect scheduling is handled by the Disconnected state handler.
      if (code === 'EAI_AGAIN') {
        console.warn(
          `[AudioPlayer] Voice DNS lookup failed temporarily${host ? ` (${host})` : ''}; connection will retry via state handler.`,
        );
        return;
      }
      console.error('[AudioPlayer] Voice connection error:', err);
    });

    joinedConnection.on(VoiceConnectionStatus.Disconnected, async () => {
      if (attemptId !== currentAttemptId || connection !== joinedConnection) {
        return;
      }

      try {
        await Promise.race([
          entersState(joinedConnection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(joinedConnection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
        // Reconnecting
      } catch {
        if (attemptId !== currentAttemptId || connection !== joinedConnection) {
          return;
        }

        // Truly disconnected - clean up
        joinedConnection.destroy();
        if (connection === joinedConnection) {
          connection = null;
        }
        setVoiceDisconnected();
        console.warn('[AudioPlayer] Voice connection lost.');
        scheduleReconnect('disconnected');
      }
    });

    await entersState(joinedConnection, VoiceConnectionStatus.Ready, 30_000);

    if (attemptId !== currentAttemptId || connection !== joinedConnection) {
      joinedConnection.destroy();
      return;
    }

    clearReconnectTimer();
    console.log('[AudioPlayer] Voice connection ready.');
    reconnectAttempts = 0;

    nextConnection.subscribe(getPlayer());
    setVoiceConnected(channel.name);
    console.log(`[AudioPlayer] Joined voice channel: ${channel.name}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : '';
    const isPermanentMisconfiguration =
      message.includes('Missing DISCORD_GUILD_ID or DISCORD_VOICE_CHANNEL_ID') ||
      message.includes('is not a voice channel');

    if (attemptId === currentAttemptId && connection === nextConnection && nextConnection) {
      nextConnection.destroy();
      connection = null;
      setVoiceDisconnected();
    }

    if (attemptId === currentAttemptId && shouldAutoReconnect && !isPermanentMisconfiguration) {
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
  clearReconnectTimer();
  reconnectAttempts = 0;

  const existingConnection = connection;
  if (existingConnection) {
    existingConnection.destroy();
    connection = null;
    playing = false;
    setVoiceDisconnected();
    console.log('[AudioPlayer] Disconnected from voice channel.');
  }
}

/** Returns true if a sound is currently being played. */
export function isPlaying(): boolean {
  return playing;
}

/**
 * Play a local sound file into the connected voice channel.
 * Throws if not connected or the file does not exist.
 */
export function playFile(filePath: string): void {
  if (!connection) {
    throw new Error('Not connected to a voice channel');
  }
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Sound file not found: ${resolved}`);
  }

  playing = true;
  const resource = createAudioResource(resolved);
  getPlayer().play(resource);
}
