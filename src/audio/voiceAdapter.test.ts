import { describe, it, expect, vi } from 'vitest';
import { createVoiceAdapterFactory } from './voiceAdapter';

// Minimal fake voice channel exposing only what the adapter touches.
// getMaxListeners/setMaxListeners are stateful so the incremental cap bookkeeping
// can be tested accurately.
function makeChannel() {
  const shardSend = vi.fn();
  let cap = 10;
  const client = {
    on: vi.fn(),
    off: vi.fn(),
    getMaxListeners: vi.fn(() => cap),
    setMaxListeners: vi.fn((n: number) => { cap = n; }),
  };
  const channel = { client, guild: { shard: { send: shardSend } } };
  return { channel, client, shardSend };
}

const methods = {
  onVoiceStateUpdate: vi.fn(),
  onVoiceServerUpdate: vi.fn(),
} as never;

describe('createVoiceAdapterFactory', () => {
  it('registers a raw listener and raises the max-listener cap on build', () => {
    const { channel, client } = makeChannel();
    const factory = createVoiceAdapterFactory();

    factory.build(channel as never)(methods);

    expect(client.on).toHaveBeenCalledWith('raw', expect.any(Function));
    expect(client.setMaxListeners).toHaveBeenCalledWith(11);
  });

  it('tears down the previous adapter before registering a new one (no listener accumulation)', () => {
    const { channel, client } = makeChannel();
    const factory = createVoiceAdapterFactory();

    factory.build(channel as never)(methods);
    expect(client.off).not.toHaveBeenCalled();

    // Second build for the same guild must clean up the first listener.
    factory.build(channel as never)(methods);
    expect(client.off).toHaveBeenCalledWith('raw', expect.any(Function));
    expect(client.setMaxListeners).toHaveBeenLastCalledWith(11);
  });

  it('destroy() removes the listener and restores the original cap', () => {
    const { channel, client } = makeChannel();
    const factory = createVoiceAdapterFactory();

    const adapter = factory.build(channel as never)(methods);
    adapter.destroy();

    expect(client.off).toHaveBeenCalledWith('raw', expect.any(Function));
    expect(client.setMaxListeners).toHaveBeenLastCalledWith(10);
  });

  it('sendPayload routes through the guild shard and reports success/failure', () => {
    const { channel, shardSend } = makeChannel();
    const factory = createVoiceAdapterFactory();
    const adapter = factory.build(channel as never)(methods);

    expect(adapter.sendPayload({ op: 4 })).toBe(true);
    expect(shardSend).toHaveBeenCalledWith({ op: 4 });

    shardSend.mockImplementationOnce(() => { throw new Error('shard down'); });
    expect(adapter.sendPayload({ op: 4 })).toBe(false);
  });

  it('leaves an unlimited (0) max-listener cap untouched', () => {
    const { channel, client } = makeChannel();
    client.getMaxListeners.mockReturnValue(0);
    const factory = createVoiceAdapterFactory();

    factory.build(channel as never)(methods);

    expect(client.setMaxListeners).not.toHaveBeenCalled();
  });

  it('two guild adapters sharing a client restore the baseline cap regardless of destroy order', () => {
    let cap = 10;
    const sharedClient = {
      on: vi.fn(),
      off: vi.fn(),
      getMaxListeners: vi.fn(() => cap),
      setMaxListeners: vi.fn((n: number) => { cap = n; }),
    };
    const channelA = { client: sharedClient, guild: { shard: { send: vi.fn() } } };
    const channelB = { client: sharedClient, guild: { shard: { send: vi.fn() } } };

    const factoryA = createVoiceAdapterFactory();
    const factoryB = createVoiceAdapterFactory();
    const adapterA = factoryA.build(channelA as never)(methods);
    const adapterB = factoryB.build(channelB as never)(methods);
    expect(cap).toBe(12);

    // Destroy A first — the snapshot approach would leave cap at 11 after B also
    // destroys (B's snapshot was 11, not the true baseline of 10).
    adapterA.destroy();
    expect(cap).toBe(11);
    adapterB.destroy();
    expect(cap).toBe(10);
  });

  it('forwards raw voice packets to the matching gateway method', () => {
    const { channel, client } = makeChannel();
    const factory = createVoiceAdapterFactory();
    const localMethods = { onVoiceStateUpdate: vi.fn(), onVoiceServerUpdate: vi.fn() } as never;

    factory.build(channel as never)(localMethods);
    const onRaw = client.on.mock.calls[0][1] as (p: unknown) => void;

    onRaw({ t: 'VOICE_STATE_UPDATE', d: { a: 1 } });
    onRaw({ t: 'VOICE_SERVER_UPDATE', d: { b: 2 } });
    onRaw({ t: 'SOMETHING_ELSE', d: {} });

    expect((localMethods as { onVoiceStateUpdate: ReturnType<typeof vi.fn> }).onVoiceStateUpdate)
      .toHaveBeenCalledWith({ a: 1 });
    expect((localMethods as { onVoiceServerUpdate: ReturnType<typeof vi.fn> }).onVoiceServerUpdate)
      .toHaveBeenCalledWith({ b: 2 });
  });
});
