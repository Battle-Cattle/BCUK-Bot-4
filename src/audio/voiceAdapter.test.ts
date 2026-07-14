import { describe, it, expect, vi } from 'vitest';
import { createVoiceAdapterFactory } from './voiceAdapter';

/** Minimal fake voice channel exposing only what the adapter touches. */
function makeChannel(client: { on: ReturnType<typeof vi.fn> }, guildId: string) {
  const shardSend = vi.fn();
  const channel = { client, guild: { id: guildId, shard: { send: shardSend } } };
  return { channel, shardSend };
}

/** A fake discord.js Client that captures its single registered 'raw' handler. */
function makeClient() {
  return { on: vi.fn() };
}

function makeMethods() {
  return { onVoiceStateUpdate: vi.fn(), onVoiceServerUpdate: vi.fn() };
}

/** Retrieves the shared 'raw' handler registered on `client`. */
function getRawHandler(client: ReturnType<typeof makeClient>): (packet: unknown) => void {
  return client.on.mock.calls[0][1] as (packet: unknown) => void;
}

describe('createVoiceAdapterFactory', () => {
  it('registers a single raw listener on first build', () => {
    const client = makeClient();
    const { channel } = makeChannel(client, 'guild-a');
    const factory = createVoiceAdapterFactory();

    factory.build(channel as never)(makeMethods() as never);

    expect(client.on).toHaveBeenCalledTimes(1);
    expect(client.on).toHaveBeenCalledWith('raw', expect.any(Function));
  });

  it('reuses the same raw listener across multiple guilds sharing a client', () => {
    const client = makeClient();
    const { channel: channelA } = makeChannel(client, 'guild-a');
    const { channel: channelB } = makeChannel(client, 'guild-b');

    createVoiceAdapterFactory().build(channelA as never)(makeMethods() as never);
    createVoiceAdapterFactory().build(channelB as never)(makeMethods() as never);

    // Only one 'raw' listener total, regardless of how many guilds/factories share the client.
    expect(client.on).toHaveBeenCalledTimes(1);
  });

  it('routes a VOICE_STATE_UPDATE/VOICE_SERVER_UPDATE packet to the matching guild only', () => {
    const client = makeClient();
    const { channel: channelA } = makeChannel(client, 'guild-a');
    const { channel: channelB } = makeChannel(client, 'guild-b');
    const methodsA = makeMethods();
    const methodsB = makeMethods();

    createVoiceAdapterFactory().build(channelA as never)(methodsA as never);
    createVoiceAdapterFactory().build(channelB as never)(methodsB as never);
    const onRaw = getRawHandler(client);

    onRaw({ t: 'VOICE_STATE_UPDATE', d: { guild_id: 'guild-a', a: 1 } });
    onRaw({ t: 'VOICE_SERVER_UPDATE', d: { guild_id: 'guild-b', b: 2 } });

    expect(methodsA.onVoiceStateUpdate).toHaveBeenCalledWith({ guild_id: 'guild-a', a: 1 });
    expect(methodsA.onVoiceServerUpdate).not.toHaveBeenCalled();
    expect(methodsB.onVoiceServerUpdate).toHaveBeenCalledWith({ guild_id: 'guild-b', b: 2 });
    expect(methodsB.onVoiceStateUpdate).not.toHaveBeenCalled();
  });

  it('ignores non-voice packets and packets with no guild_id', () => {
    const client = makeClient();
    const { channel } = makeChannel(client, 'guild-a');
    const methods = makeMethods();

    createVoiceAdapterFactory().build(channel as never)(methods as never);
    const onRaw = getRawHandler(client);

    onRaw({ t: 'SOMETHING_ELSE', d: { guild_id: 'guild-a' } });
    onRaw({ t: 'VOICE_STATE_UPDATE', d: {} });

    expect(methods.onVoiceStateUpdate).not.toHaveBeenCalled();
    expect(methods.onVoiceServerUpdate).not.toHaveBeenCalled();
  });

  it('tears down the previous registration before a new build for the same guild (latest methods win)', () => {
    const client = makeClient();
    const { channel } = makeChannel(client, 'guild-a');
    const oldMethods = makeMethods();
    const newMethods = makeMethods();
    const factory = createVoiceAdapterFactory();

    factory.build(channel as never)(oldMethods as never);
    factory.build(channel as never)(newMethods as never);
    const onRaw = getRawHandler(client);

    onRaw({ t: 'VOICE_STATE_UPDATE', d: { guild_id: 'guild-a' } });

    expect(oldMethods.onVoiceStateUpdate).not.toHaveBeenCalled();
    expect(newMethods.onVoiceStateUpdate).toHaveBeenCalledOnce();
  });

  it('destroy() stops routing packets to that guild', () => {
    const client = makeClient();
    const { channel } = makeChannel(client, 'guild-a');
    const methods = makeMethods();
    const factory = createVoiceAdapterFactory();

    const adapter = factory.build(channel as never)(methods as never);
    adapter.destroy();
    const onRaw = getRawHandler(client);

    onRaw({ t: 'VOICE_STATE_UPDATE', d: { guild_id: 'guild-a' } });

    expect(methods.onVoiceStateUpdate).not.toHaveBeenCalled();
  });

  it('destroy() does not affect a different guild sharing the same client', () => {
    const client = makeClient();
    const { channel: channelA } = makeChannel(client, 'guild-a');
    const { channel: channelB } = makeChannel(client, 'guild-b');
    const methodsA = makeMethods();
    const methodsB = makeMethods();

    const adapterA = createVoiceAdapterFactory().build(channelA as never)(methodsA as never);
    createVoiceAdapterFactory().build(channelB as never)(methodsB as never);
    adapterA.destroy();
    const onRaw = getRawHandler(client);

    onRaw({ t: 'VOICE_STATE_UPDATE', d: { guild_id: 'guild-b' } });

    expect(methodsB.onVoiceStateUpdate).toHaveBeenCalledOnce();
  });

  it('a stale destroy() cannot clobber a newer registration for the same guild', () => {
    // Simulates an out-of-order destroy: two independent registrations for the same
    // guildId (e.g. from overlapping reconnect attempts), where the OLD adapter's
    // destroy() fires after the NEW one already took over the guild's slot.
    const client = makeClient();
    const { channel } = makeChannel(client, 'guild-a');
    const oldMethods = makeMethods();
    const newMethods = makeMethods();

    const oldAdapter = createVoiceAdapterFactory().build(channel as never)(oldMethods as never);
    createVoiceAdapterFactory().build(channel as never)(newMethods as never);
    oldAdapter.destroy();
    const onRaw = getRawHandler(client);

    onRaw({ t: 'VOICE_STATE_UPDATE', d: { guild_id: 'guild-a' } });

    expect(newMethods.onVoiceStateUpdate).toHaveBeenCalledOnce();
  });

  it('sendPayload routes through the guild shard and reports success/failure', () => {
    const client = makeClient();
    const { channel, shardSend } = makeChannel(client, 'guild-a');
    const factory = createVoiceAdapterFactory();
    const adapter = factory.build(channel as never)(makeMethods() as never);

    expect(adapter.sendPayload({ op: 4 })).toBe(true);
    expect(shardSend).toHaveBeenCalledWith({ op: 4 });

    shardSend.mockImplementationOnce(() => { throw new Error('shard down'); });
    expect(adapter.sendPayload({ op: 4 })).toBe(false);
  });
});
