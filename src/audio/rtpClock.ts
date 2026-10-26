import { NetworkingStatusCode, VoiceConnectionStatus, type VoiceConnection } from '@discordjs/voice';

/** RTP timestamp units per millisecond: Discord voice runs Opus at a 48kHz clock. */
const RTP_UNITS_PER_MS = 48;

/** RTP timestamps are unsigned 32-bit and wrap around. */
const RTP_TIMESTAMP_RANGE = 2 ** 32;

/**
 * Moves a voice connection's outgoing RTP timestamp forward by a stretch of silence, so the next
 * sound is stamped at the time it is actually sent.
 *
 * @discordjs/voice only advances the timestamp per packet sent, so while the bot is silent between
 * sounds it stands still and every new sound is stamped as if it followed the last one without a
 * break. Discord clients size their jitter buffer from timestamps against arrival times, so over a
 * long-lived connection those growing gaps read as heavy jitter and the clients' playout delay can
 * climb to around two seconds, until a rejoin starts a fresh connection. A normal client's
 * timestamps keep running through silence; this does the same once, just before playback resumes.
 * The sequence number stays contiguous, since no packets were lost.
 *
 * @param connection - The guild's voice connection.
 * @param silenceMs - How long the connection has sent no audio.
 * @returns True if the timestamp was moved; false when the connection or its networking isn't
 *   ready (it then has no timestamp to move, and a fresh one starts on its own clock).
 */
export function advanceRtpTimestamp(connection: VoiceConnection, silenceMs: number): boolean {
  const connectionState = connection.state;
  if (connectionState.status !== VoiceConnectionStatus.Ready || silenceMs <= 0) return false;
  const networkingState = connectionState.networking.state;
  if (networkingState.code !== NetworkingStatusCode.Ready) return false;
  const { connectionData } = networkingState;
  connectionData.timestamp = (connectionData.timestamp + Math.round(silenceMs * RTP_UNITS_PER_MS)) % RTP_TIMESTAMP_RANGE;
  return true;
}
