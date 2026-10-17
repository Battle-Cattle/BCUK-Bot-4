import { describe, it, expect, vi } from 'vitest';
import { mockLogger } from '../test-utils/loggerMock';
import { waitFor } from '../test-utils/waitFor';

const log = vi.hoisted(() => ({ current: undefined as ReturnType<typeof mockLogger> | undefined }));
vi.mock('../shared/logger', () => ({
  createLogger: () => (log.current ??= mockLogger()),
}));

import { WebSocketShardEvents } from 'discord.js';
import { createVoiceAdapterFactory } from './voiceAdapter';

type FakeClient = { ws: { on: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn> } };

/** Minimal fake voice channel exposing only what the adapter touches. */
function makeChannel(client: FakeClient, guildId: string, shardId = 0) {
  const channel = { client, guild: { id: guildId, shardId } };
  return { channel, wsSend: client.ws.send };
}

/** A fake discord.js Client whose `ws` manager captures its single registered dispatch handler. */
function makeClient(): FakeClient {
  return { ws: { on: vi.fn(), send: vi.fn(async () => undefined) } };
}

function makeMethods() {
  return { onVoiceStateUpdate: vi.fn(), onVoiceServerUpdate: vi.fn() };
}

/** Retrieves the shared gateway dispatch handler registered on `client.ws`. */
function getDispatchHandler(client: ReturnType<typeof makeClient>): (packet: unknown) => void {
  return client.ws.on.mock.calls[0]![1] as (packet: unknown) => void;
}

describe('createVoiceAdapterFactory', () => {
  it('registers a single gateway dispatch listener on first build', () => {
    const client = makeClient();
    const { channel } = makeChannel(client, 'guild-a');
    const factory = createVoiceAdapterFactory();

    factory.build(channel as never)(makeMethods() as never);

    expect(client.ws.on).toHaveBeenCalledTimes(1);
    expect(client.ws.on).toHaveBeenCalledWith(WebSocketShardEvents.Dispatch, expect.any(Function));
  });

  it('reuses the same dispatch listener across multiple guilds sharing a client', () => {
    const client = makeClient();
    const { channel: channelA } = makeChannel(client, 'guild-a');
    const { channel: channelB } = makeChannel(client, 'guild-b');

    createVoiceAdapterFactory().build(channelA as never)(makeMethods() as never);
    createVoiceAdapterFactory().build(channelB as never)(makeMethods() as never);

    // Only one dispatch listener total, regardless of how many guilds/factories share the client.
    expect(client.ws.on).toHaveBeenCalledTimes(1);
  });

  it('routes a VOICE_STATE_UPDATE/VOICE_SERVER_UPDATE packet to the matching guild only', () => {
    const client = makeClient();
    const { channel: channelA } = makeChannel(client, 'guild-a');
    const { channel: channelB } = makeChannel(client, 'guild-b');
    const methodsA = makeMethods();
    const methodsB = makeMethods();

    createVoiceAdapterFactory().build(channelA as never)(methodsA as never);
    createVoiceAdapterFactory().build(channelB as never)(methodsB as never);
    const onDispatch = getDispatchHandler(client);

    onDispatch({ t: 'VOICE_STATE_UPDATE', d: { guild_id: 'guild-a', a: 1 } });
    onDispatch({ t: 'VOICE_SERVER_UPDATE', d: { guild_id: 'guild-b', b: 2 } });

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
    const onDispatch = getDispatchHandler(client);

    onDispatch({ t: 'SOMETHING_ELSE', d: { guild_id: 'guild-a' } });
    onDispatch({ t: 'VOICE_STATE_UPDATE', d: {} });

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
    const onDispatch = getDispatchHandler(client);

    onDispatch({ t: 'VOICE_STATE_UPDATE', d: { guild_id: 'guild-a' } });

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
    const onDispatch = getDispatchHandler(client);

    onDispatch({ t: 'VOICE_STATE_UPDATE', d: { guild_id: 'guild-a' } });

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
    const onDispatch = getDispatchHandler(client);

    onDispatch({ t: 'VOICE_STATE_UPDATE', d: { guild_id: 'guild-b' } });

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
    const onDispatch = getDispatchHandler(client);

    onDispatch({ t: 'VOICE_STATE_UPDATE', d: { guild_id: 'guild-a' } });

    expect(newMethods.onVoiceStateUpdate).toHaveBeenCalledOnce();
  });

  it('sendPayload routes through the guild shard and reports success/failure', () => {
    const client = makeClient();
    const { channel, wsSend } = makeChannel(client, 'guild-a', 3);
    const factory = createVoiceAdapterFactory();
    const adapter = factory.build(channel as never)(makeMethods() as never);

    expect(adapter.sendPayload({ op: 4 })).toBe(true);
    expect(wsSend).toHaveBeenCalledWith(3, { op: 4 });

    wsSend.mockImplementationOnce(() => { throw new Error('shard down'); });
    expect(adapter.sendPayload({ op: 4 })).toBe(false);
  });

  it('sendPayload logs an async send rejection instead of leaving it unhandled', async () => {
    const client = makeClient();
    const { channel, wsSend } = makeChannel(client, 'guild-a');
    const factory = createVoiceAdapterFactory();
    const adapter = factory.build(channel as never)(makeMethods() as never);
    const err = new Error('socket closed');
    wsSend.mockRejectedValueOnce(err);

    expect(adapter.sendPayload({ op: 4 })).toBe(true);
    await waitFor(() => expect(log.current?.warn).toHaveBeenCalledWith(
      'Voice gateway payload send failed for guild guild-a:', err,
    ));
  });
});
