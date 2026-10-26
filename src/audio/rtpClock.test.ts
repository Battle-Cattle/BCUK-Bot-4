import { describe, it, expect } from 'vitest';
import { NetworkingStatusCode, VoiceConnectionStatus } from '@discordjs/voice';
import { advanceRtpTimestamp } from './rtpClock';

function makeConnection(timestamp: number, opts: { status?: string; code?: number } = {}) {
  const connectionData = { timestamp, sequence: 7 };
  const connection = {
    state: {
      status: opts.status ?? VoiceConnectionStatus.Ready,
      networking: { state: { code: opts.code ?? NetworkingStatusCode.Ready, connectionData } },
    },
  };
  return { connection: connection as never, connectionData };
}

describe('advanceRtpTimestamp', () => {
  it('moves the timestamp forward 48 units per millisecond of silence', () => {
    const { connection, connectionData } = makeConnection(1_000);

    expect(advanceRtpTimestamp(connection, 5 * 60_000)).toBe(true);

    expect(connectionData.timestamp).toBe(1_000 + 5 * 60_000 * 48);
  });

  it('leaves the sequence number contiguous', () => {
    const { connection, connectionData } = makeConnection(0);

    advanceRtpTimestamp(connection, 1_000);

    expect(connectionData.sequence).toBe(7);
  });

  it('wraps the timestamp around at 2^32', () => {
    const { connection, connectionData } = makeConnection(2 ** 32 - 480);

    advanceRtpTimestamp(connection, 20);

    expect(connectionData.timestamp).toBe(480);
  });

  it('does nothing while the voice connection is not ready', () => {
    const { connection, connectionData } = makeConnection(1_000, { status: VoiceConnectionStatus.Signalling });

    expect(advanceRtpTimestamp(connection, 1_000)).toBe(false);
    expect(connectionData.timestamp).toBe(1_000);
  });

  it('does nothing while the networking is not ready (e.g. resuming)', () => {
    const { connection, connectionData } = makeConnection(1_000, { code: NetworkingStatusCode.Resuming });

    expect(advanceRtpTimestamp(connection, 1_000)).toBe(false);
    expect(connectionData.timestamp).toBe(1_000);
  });

  it('does nothing for no silence', () => {
    const { connection, connectionData } = makeConnection(1_000);

    expect(advanceRtpTimestamp(connection, 0)).toBe(false);
    expect(connectionData.timestamp).toBe(1_000);
  });
});
