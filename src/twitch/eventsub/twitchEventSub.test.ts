import { describe, it, expect, vi, beforeEach } from 'vitest';
import { flushMicrotasks } from '../../test-utils/flushMicrotasks';
import { deferred } from '../../test-utils/deferredPromise';

vi.mock('../../shared/logger', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));

vi.mock('./twitchEventSubSubscriptions', () => ({
  loadStreamersForEventSub: vi.fn(),
}));

const connectionInstances: Array<{
  uid: string;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  reload: ReturnType<typeof vi.fn>;
  setSelfStopCallback: ReturnType<typeof vi.fn>;
}> = [];

vi.mock('./twitchEventSubConnection', () => ({
  StreamerConnection: vi.fn().mockImplementation(function (data: { uid: string }) {
    const instance = {
      uid: data.uid,
      start: vi.fn(),
      stop: vi.fn(),
      reload: vi.fn(),
      setSelfStopCallback: vi.fn(),
    };
    connectionInstances.push(instance);
    return instance;
  }),
}));

import { startEventSub, stopEventSub, reloadEventSubSubscriptions } from './twitchEventSub';
import { loadStreamersForEventSub } from './twitchEventSubSubscriptions';

function makeStreamer(uid: string) {
  return { uid, token: 'token', name: uid, config: null, streamerId: 1 };
}

beforeEach(() => {
  vi.clearAllMocks();
  connectionInstances.length = 0;
  vi.mocked(loadStreamersForEventSub).mockResolvedValue([]);
  // Ensure no connections leak between tests regardless of prior test outcome.
  stopEventSub();
});

describe('startEventSub', () => {
  it('creates and starts a connection for each loaded streamer', async () => {
    vi.mocked(loadStreamersForEventSub).mockResolvedValue([makeStreamer('uid-1'), makeStreamer('uid-2')]);
    startEventSub();
    await flushMicrotasks();

    expect(connectionInstances).toHaveLength(2);
    expect(connectionInstances[0].start).toHaveBeenCalledTimes(1);
    expect(connectionInstances[1].start).toHaveBeenCalledTimes(1);
  });

  it('does not create a duplicate connection for a uid that already exists', async () => {
    vi.mocked(loadStreamersForEventSub).mockResolvedValue([makeStreamer('uid-1')]);
    startEventSub();
    await flushMicrotasks();
    expect(connectionInstances).toHaveLength(1);

    startEventSub();
    await flushMicrotasks();
    expect(connectionInstances).toHaveLength(1);
  });

  it('logs and swallows errors from loadStreamersForEventSub', async () => {
    vi.mocked(loadStreamersForEventSub).mockRejectedValue(new Error('DB down'));
    expect(() => startEventSub()).not.toThrow();
    await flushMicrotasks();
    expect(connectionInstances).toHaveLength(0);
  });
});

describe('stopEventSub', () => {
  it('stops and clears all active connections', async () => {
    vi.mocked(loadStreamersForEventSub).mockResolvedValue([makeStreamer('uid-1'), makeStreamer('uid-2')]);
    startEventSub();
    await flushMicrotasks();
    expect(connectionInstances).toHaveLength(2);

    stopEventSub();
    expect(connectionInstances[0].stop).toHaveBeenCalledTimes(1);
    expect(connectionInstances[1].stop).toHaveBeenCalledTimes(1);
  });

  it('prevents a subsequent reload from doing anything until startEventSub runs again', async () => {
    stopEventSub();
    vi.mocked(loadStreamersForEventSub).mockResolvedValue([makeStreamer('uid-1')]);
    reloadEventSubSubscriptions();
    await flushMicrotasks();
    expect(loadStreamersForEventSub).not.toHaveBeenCalled();
  });
});

describe('reloadEventSubSubscriptions', () => {
  it('starts a new connection for a streamer added since the last load', async () => {
    vi.mocked(loadStreamersForEventSub).mockResolvedValue([]);
    startEventSub();
    await flushMicrotasks();
    expect(connectionInstances).toHaveLength(0);

    vi.mocked(loadStreamersForEventSub).mockResolvedValue([makeStreamer('uid-new')]);
    reloadEventSubSubscriptions();
    await flushMicrotasks();

    expect(connectionInstances).toHaveLength(1);
    expect(connectionInstances[0].start).toHaveBeenCalledTimes(1);
  });

  it('reloads an existing connection rather than recreating it', async () => {
    const streamer = makeStreamer('uid-1');
    vi.mocked(loadStreamersForEventSub).mockResolvedValue([streamer]);
    startEventSub();
    await flushMicrotasks();
    expect(connectionInstances).toHaveLength(1);

    const updatedStreamer = { ...streamer, name: 'renamed' };
    vi.mocked(loadStreamersForEventSub).mockResolvedValue([updatedStreamer]);
    reloadEventSubSubscriptions();
    await flushMicrotasks();

    expect(connectionInstances).toHaveLength(1);
    expect(connectionInstances[0].reload).toHaveBeenCalledWith(updatedStreamer);
    expect(connectionInstances[0].start).toHaveBeenCalledTimes(1);
  });

  it('stops and removes a connection whose streamer is no longer present', async () => {
    vi.mocked(loadStreamersForEventSub).mockResolvedValue([makeStreamer('uid-1'), makeStreamer('uid-2')]);
    startEventSub();
    await flushMicrotasks();
    expect(connectionInstances).toHaveLength(2);

    vi.mocked(loadStreamersForEventSub).mockResolvedValue([makeStreamer('uid-2')]);
    reloadEventSubSubscriptions();
    await flushMicrotasks();

    expect(connectionInstances[0].stop).toHaveBeenCalledTimes(1);
    expect(connectionInstances[1].stop).not.toHaveBeenCalled();
  });

  it('is a no-op when stopped globally', async () => {
    stopEventSub();
    reloadEventSubSubscriptions();
    await flushMicrotasks();
    expect(loadStreamersForEventSub).not.toHaveBeenCalled();
  });

  it('logs and swallows errors during reload', async () => {
    vi.mocked(loadStreamersForEventSub).mockResolvedValue([]);
    startEventSub();
    await flushMicrotasks();

    vi.mocked(loadStreamersForEventSub).mockRejectedValue(new Error('DB down'));
    expect(() => reloadEventSubSubscriptions()).not.toThrow();
    await flushMicrotasks();
  });

  it('serialises concurrent reload calls through the reload chain', async () => {
    vi.mocked(loadStreamersForEventSub).mockResolvedValue([]);
    startEventSub();
    await flushMicrotasks();

    // Gate both loads on deferred promises so we can prove the second reload's
    // loadStreamersForEventSub call doesn't fire until the first one settles.
    const first = deferred<ReturnType<typeof makeStreamer>[]>();
    const second = deferred<ReturnType<typeof makeStreamer>[]>();
    const loadCallOrder: number[] = [];
    vi.mocked(loadStreamersForEventSub)
      .mockImplementationOnce(() => { loadCallOrder.push(1); return first.promise; })
      .mockImplementationOnce(() => { loadCallOrder.push(2); return second.promise; });

    reloadEventSubSubscriptions();
    reloadEventSubSubscriptions();
    await flushMicrotasks();

    expect(loadCallOrder).toEqual([1]);

    first.resolve([]);
    await flushMicrotasks();
    expect(loadCallOrder).toEqual([1, 2]);

    second.resolve([makeStreamer('uid-a')]);
    await flushMicrotasks();

    expect(connectionInstances).toHaveLength(1);
  });
});
