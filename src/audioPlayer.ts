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
  const guild = await client.guilds.fetch(DISCORD_GUILD_ID);
  const channel = await guild.channels.fetch(DISCORD_VOICE_CHANNEL_ID);

  if (!channel || channel.type !== ChannelType.GuildVoice) {
    throw new Error(`Channel ${DISCORD_VOICE_CHANNEL_ID} is not a voice channel`);
  }

  connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: guild.id,
    adapterCreator: buildAdapter(channel),
    selfDeaf: false,
    selfMute: false,
  });

  await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
  console.log('[AudioPlayer] Voice connection ready.');

  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection!, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection!, VoiceConnectionStatus.Connecting, 5_000),
      ]);
      // Reconnecting
    } catch {
      // Truly disconnected - clean up
      connection?.destroy();
      connection = null;
      setVoiceDisconnected();
      console.warn('[AudioPlayer] Voice connection lost.');
    }
  });

  connection.subscribe(getPlayer());
  setVoiceConnected(channel.name);
  console.log(`[AudioPlayer] Joined voice channel: ${channel.name}`);
}

/**
 * Disconnect from the current voice channel, if connected.
 * Safe to call when already disconnected.
 */
export function disconnect(): void {
  if (connection) {
    connection.destroy();
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
