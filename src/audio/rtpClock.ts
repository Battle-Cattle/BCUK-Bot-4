import { NetworkingStatusCode, VoiceConnectionStatus, type ConnectionData, type VoiceConnection } from '@discordjs/voice';

/** RTP timestamp units per millisecond: Discord voice runs Opus at a 48kHz clock. */
const RTP_UNITS_PER_MS = 48;

/** One 20ms Opus frame in RTP units, the step @discordjs/voice adds per packet sent. */
const FRAME_UNITS = 960;

/** RTP timestamps are unsigned 32-bit and wrap around. */
const RTP_TIMESTAMP_RANGE = 2 ** 32;

/** Where an RTP clock stood at a known moment, so its expected value can be read off elapsed time. */
interface RtpAnchor {
  /** Monotonic time (`performance.now()`) of the reading. */
  atMs: number;
  /** The clock's RTP timestamp at that time. */
  timestamp: number;
}

// Keyed by the networking's own ConnectionData: every new Networking (a fresh join, a rejoin or a
// channel move, even on the same VoiceConnection) starts a new random RTP clock with a new
// ConnectionData object, and so a new anchor. A WeakMap lets a finished networking's anchor go.
const anchors = new WeakMap<ConnectionData, RtpAnchor>();

/**
 * Brings a voice connection's outgoing RTP timestamp up to real time before a sound's next frame
 * goes out, and returns how far it moved.
 *
 * @discordjs/voice advances the timestamp only per packet sent, so whenever the bot sends nothing
 * (silence between sounds, a sound buffering, a pause while the connection recovers) the timestamp
 * stands still while time moves on. Discord clients size their jitter buffer from timestamps
 * against arrival times, so over a long-lived connection those gaps read as heavy jitter and their
 * playout delay can climb to around two seconds, until a rejoin starts a fresh clock. A normal
 * client's timestamps keep running through silence.
 *
 * The first call for a networking records where its clock stands as the anchor. Each later call
 * sets the timestamp to the anchor plus the elapsed time, when it has fallen at least a frame
 * behind. It never moves the timestamp past real time, so it can't over-count, and a call that
 * can't act (networking not ready) loses nothing: the next one catches up in full. A packet already
 * prepared with the old timestamp (the last padding frame of the previous sound, which the player
 * stops before sending) is dropped so it doesn't go out first. The sequence number stays
 * contiguous, since that dropped packet never took one.
 *
 * @param connection - The guild's voice connection.
 * @param nowMs - The current monotonic time, from `performance.now()`.
 * @returns How many milliseconds the timestamp moved forward (0 when it was already in step, or
 *   for the anchoring call), or null when the connection or its networking isn't ready.
 */
export function syncRtpTimestamp(connection: VoiceConnection, nowMs: number): number | null {
  const connectionState = connection.state;
  if (connectionState.status !== VoiceConnectionStatus.Ready) return null;
  const networkingState = connectionState.networking.state;
  if (networkingState.code !== NetworkingStatusCode.Ready) return null;
  const { connectionData } = networkingState;

  const anchor = anchors.get(connectionData);
  if (!anchor) {
    anchors.set(connectionData, { atMs: nowMs, timestamp: connectionData.timestamp });
    return 0;
  }
  const target = (anchor.timestamp + Math.round((nowMs - anchor.atMs) * RTP_UNITS_PER_MS)) % RTP_TIMESTAMP_RANGE;
  // Wrap-aware distance: a value in the upper half of the range means the timestamp is ahead.
  const behind = (target - connectionData.timestamp + RTP_TIMESTAMP_RANGE) % RTP_TIMESTAMP_RANGE;
  if (behind < FRAME_UNITS || behind >= RTP_TIMESTAMP_RANGE / 2) return 0;

  connectionData.timestamp = target;
  networkingState.preparedPacket = undefined;
  return behind / RTP_UNITS_PER_MS;
}
