import { createLogger } from '../shared/logger';
import {
  createAudioPlayer,
  AudioPlayerStatus,
  NoSubscriberBehavior,
  type AudioResource,
  type VoiceConnection,
  type AudioPlayer as DjsAudioPlayer,
} from '@discordjs/voice';
import { setVoiceIdle } from '../shared/statusStore';
import { syncRtpTimestamp } from './rtpClock';

// ─── Per-guild audio player ─────────────────────────────────────────────────
//
// Each guild gets its own @discordjs/voice AudioPlayer, subscribed only to that
// guild's connection, so two guilds can play independent audio concurrently —
// playing a sound in one guild is never heard in another. The connection side
// (joining, reconnecting, tearing down) lives in `audioPlayer.ts`, which owns
// the per-guild state record this module reads and updates.

const log = createLogger('AudioPlayer');

/** The playback fields of a guild's voice state (`GuildVoiceState` in `audioPlayer.ts`). */
export interface GuildPlaybackState {
  guildId: string;
  connection: VoiceConnection | null;
  player: DjsAudioPlayer | null;
  playing: boolean;
  // When the current connection became Ready (Date.now()), for the playback-start log's connection age.
  connectedAt: number | null;
  // When playOnGuildPlayer last handed the player a resource, until the player reports Playing.
  playRequestedAt: number | null;
}

/**
 * A sound that takes longer than this from {@link playOnGuildPlayer} to its first audio frame is
 * logged as a warning instead of at debug level, so a growing SFX delay shows up in the logs.
 */
const SLOW_PLAYBACK_START_MS = 500;

/**
 * Returns this guild's audio player, lazily creating it with playing, idle and error handlers on first use.
 * @param state - The guild voice state that owns the player.
 * @returns The guild's audio player.
 */
export function getPlayer(state: GuildPlaybackState): DjsAudioPlayer {
  if (!state.player) {
    const guildPlayer = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
    });
    guildPlayer.on(AudioPlayerStatus.Playing, () => {
      syncRtpClock(state);
      logPlaybackStart(state);
    });
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
 * Brings the guild connection's RTP timestamp up to real time whenever the player enters Playing:
 * a new sound once it has buffered, a replacement, or a resume from auto-pause. That runs before
 * any packet of what follows is prepared, so the next frame carries a timestamp that matches when
 * it is sent, however long the bot sent nothing. See {@link syncRtpTimestamp}. Logs a move at
 * debug level, so production can confirm the correction is happening.
 * @param state - The guild's voice state.
 */
function syncRtpClock(state: GuildPlaybackState): void {
  if (!state.connection) return;
  const movedMs = syncRtpTimestamp(state.connection, performance.now());
  if (movedMs) log.debug(`Moved the RTP clock forward ${Math.round(movedMs)}ms in guild ${state.guildId}`);
}

/**
 * Logs how long the sound handed to {@link playOnGuildPlayer} took to reach its first audio frame
 * (ffmpeg spawn and decode), with the voice connection's age and gateway/UDP ping, so a growing
 * SFX delay can be traced to the audio pipeline, the voice connection or neither. A no-op when no
 * start is pending, e.g. when the player resumes from auto-pause mid-sound.
 * @param state - The guild's voice state.
 */
function logPlaybackStart(state: GuildPlaybackState): void {
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
export function stopGuildPlayer(state: GuildPlaybackState): void {
  try {
    state.player?.stop(true);
  } catch {
    // Ignore audio stop errors during disconnect cleanup.
  }
  state.playing = false;
}

/**
 * Marks playback as active for the guild and sends the resource to that guild's own audio player.
 * @param state - The guild voice state to play in.
 * @param resource - The audio resource to play.
 */
export function playOnGuildPlayer(state: GuildPlaybackState, resource: AudioResource): void {
  state.playing = true;
  state.playRequestedAt = Date.now();
  getPlayer(state).play(resource);
}
