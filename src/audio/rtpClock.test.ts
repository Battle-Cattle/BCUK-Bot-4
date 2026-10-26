import { describe, it, expect, vi } from 'vitest';
import { Networking, NetworkingStatusCode, VoiceConnectionStatus } from '@discordjs/voice';
import { syncRtpTimestamp } from './rtpClock';

function makeConnection(timestamp: number, opts: { status?: string; code?: number } = {}) {
  const connectionData = { timestamp, sequence: 7 };
  const networkingState: { code: number; connectionData: typeof connectionData; preparedPacket?: Buffer } = {
    code: opts.code ?? NetworkingStatusCode.Ready,
    connectionData,
  };
  const connection = {
    state: { status: opts.status ?? VoiceConnectionStatus.Ready, networking: { state: networkingState } },
  };
  return { connection: connection as never, connectionData, networkingState };
}

/** Plays `ms` of audio the way @discordjs/voice does: +960 per 20ms packet sent. */
function sendAudio(connectionData: { timestamp: number }, ms: number) {
  connectionData.timestamp = (connectionData.timestamp + (ms / 20) * 960) % 2 ** 32;
}

describe('syncRtpTimestamp', () => {
  it('anchors on the first call without moving the timestamp', () => {
    const { connection, connectionData } = makeConnection(1_000);

    expect(syncRtpTimestamp(connection, 0)).toBe(0);
    expect(connectionData.timestamp).toBe(1_000);
  });

  it('brings the timestamp up to real time after silence, 48 units per millisecond', () => {
    const { connection, connectionData } = makeConnection(1_000);
    syncRtpTimestamp(connection, 0);
    sendAudio(connectionData, 2_000);

    expect(syncRtpTimestamp(connection, 2_000 + 5 * 60_000)).toBe(5 * 60_000);
    expect(connectionData.timestamp).toBe(1_000 + (2_000 + 5 * 60_000) * 48);
  });

  it('leaves a timestamp that has kept pace with real time alone', () => {
    const { connection, connectionData } = makeConnection(1_000);
    syncRtpTimestamp(connection, 0);
    sendAudio(connectionData, 3_000);

    expect(syncRtpTimestamp(connection, 3_010)).toBe(0);
    expect(connectionData.timestamp).toBe(1_000 + 3_000 * 48);
  });

  it('never moves a timestamp that is ahead of real time back', () => {
    const { connection, connectionData } = makeConnection(1_000);
    syncRtpTimestamp(connection, 0);
    sendAudio(connectionData, 3_000);

    expect(syncRtpTimestamp(connection, 1_000)).toBe(0);
    expect(connectionData.timestamp).toBe(1_000 + 3_000 * 48);
  });

  it('catches up in full on the next call after one that could not act, without over-counting', () => {
    const { connection, connectionData, networkingState } = makeConnection(0);
    syncRtpTimestamp(connection, 0);
    networkingState.code = NetworkingStatusCode.Resuming;
    expect(syncRtpTimestamp(connection, 10_000)).toBeNull();
    networkingState.code = NetworkingStatusCode.Ready;
    sendAudio(connectionData, 5_000); // a sound that went out once the networking recovered

    expect(syncRtpTimestamp(connection, 30_000)).toBe(25_000);
    expect(connectionData.timestamp).toBe(30_000 * 48);
  });

  it('drops a packet prepared with the old timestamp when it moves the timestamp', () => {
    const { connection, networkingState } = makeConnection(0);
    syncRtpTimestamp(connection, 0);
    networkingState.preparedPacket = Buffer.from('stale padding frame');

    syncRtpTimestamp(connection, 60_000);

    expect(networkingState.preparedPacket).toBeUndefined();
  });

  it('keeps a prepared packet when the timestamp is already in step', () => {
    const { connection, networkingState } = makeConnection(0);
    syncRtpTimestamp(connection, 0);
    const packet = Buffer.from('next frame');
    networkingState.preparedPacket = packet;

    syncRtpTimestamp(connection, 5);

    expect(networkingState.preparedPacket).toBe(packet);
  });

  it('leaves the sequence number contiguous', () => {
    const { connection, connectionData } = makeConnection(0);
    syncRtpTimestamp(connection, 0);

    syncRtpTimestamp(connection, 60_000);

    expect(connectionData.sequence).toBe(7);
  });

  it('wraps the timestamp around at 2^32', () => {
    const { connection, connectionData } = makeConnection(2 ** 32 - 480);
    syncRtpTimestamp(connection, 0);

    syncRtpTimestamp(connection, 1_000);

    expect(connectionData.timestamp).toBe(1_000 * 48 - 480);
  });

  it('starts a new anchor for a new networking on the same connection (rejoin or channel move)', () => {
    const { connection, networkingState } = makeConnection(0);
    syncRtpTimestamp(connection, 0);
    const fresh = { timestamp: 123_456, sequence: 0 };
    networkingState.connectionData = fresh;

    expect(syncRtpTimestamp(connection, 10 * 60_000)).toBe(0);
    expect(fresh.timestamp).toBe(123_456);
  });

  it('does nothing while the voice connection is not ready', () => {
    const { connection, connectionData } = makeConnection(1_000, { status: VoiceConnectionStatus.Signalling });

    expect(syncRtpTimestamp(connection, 0)).toBeNull();
    expect(connectionData.timestamp).toBe(1_000);
  });
});

// Contract with the @discordjs/voice internals syncRtpTimestamp writes to, run against the
// library's own Networking code: if an upgrade stops reading these fields, these fail instead of
// the fix silently doing nothing.
describe('@discordjs/voice networking contract', () => {
  type Internals = {
    createAudioPacket(opus: Buffer, connectionData: object, dave?: unknown): Buffer;
    dispatchAudio(): boolean;
    playAudioPacket(packet: Buffer): void;
  };
  const proto = Networking.prototype as unknown as Internals;

  it('stamps outgoing packets with connectionData.timestamp', () => {
    const fakeNetworking = { encryptOpusPacket: () => [Buffer.alloc(0)] };
    const connectionData = { timestamp: 0x12345678, sequence: 42, ssrc: 1 };

    const packet = proto.createAudioPacket.call(fakeNetworking, Buffer.from([1]), connectionData);

    expect(packet.readUInt32BE(4)).toBe(0x12345678);
    expect(packet.readUInt16BE(2)).toBe(42);
  });

  it('sends state.preparedPacket on dispatch, advancing the timestamp one frame, and nothing once it is cleared', () => {
    const send = vi.fn();
    const connectionData = { timestamp: 1_000, sequence: 1, packetsPlayed: 0 };
    const packet = Buffer.from('frame');
    const fakeNetworking = {
      state: { code: NetworkingStatusCode.Ready, connectionData, preparedPacket: packet as Buffer | undefined, udp: { send } },
      playAudioPacket: proto.playAudioPacket,
      setSpeaking: vi.fn(),
    };

    expect(proto.dispatchAudio.call(fakeNetworking)).toBe(true);
    expect(send).toHaveBeenCalledExactlyOnceWith(packet);
    expect(connectionData.timestamp).toBe(1_960);

    fakeNetworking.state.preparedPacket = undefined;
    expect(proto.dispatchAudio.call(fakeNetworking)).toBe(false);
    expect(send).toHaveBeenCalledOnce();
  });
});
