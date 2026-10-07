import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../../test-utils/loggerMock';

vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));
vi.mock('./twitchEventSubSubscriptions', () => ({
  subscribeForStreamer: vi.fn(),
  fetchValidEventSubToken: vi.fn(),
  removeSessionSubscriptions: vi.fn().mockResolvedValue(undefined),
}));

import { SubscribePassRunner, type SubscribePassHost } from './twitchEventSubSubscribePass';
import { subscribeForStreamer, fetchValidEventSubToken, removeSessionSubscriptions } from './twitchEventSubSubscriptions';

const DATA = { uid: 'u1', name: 'streamer', streamerId: 1, token: 'old-token' } as any;

function makeHost(overrides: Partial<SubscribePassHost> = {}): SubscribePassHost & { data: any } {
  const host: any = {
    name: 'streamer',
    data: DATA,
    sessionId: vi.fn(() => 'sess-1'),
    isStopped: vi.fn(() => false),
    isMigrating: vi.fn(() => false),
    freshSessionGeneration: vi.fn(() => 0),
    deferToMigrationWelcome: vi.fn(),
    getData: vi.fn(() => host.data),
    setData: vi.fn((d) => { host.data = d; }),
    onSubscribeSucceeded: vi.fn(),
    selfStop: vi.fn(),
    ...overrides,
  };
  return host;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchValidEventSubToken).mockResolvedValue('fresh-token');
  vi.mocked(subscribeForStreamer).mockResolvedValue({ desired: 2, live: 2, transientFailures: 0 } as any);
});

describe('SubscribePassRunner', () => {
  it('runs enqueued work serially and logs, rather than propagates, a failure', async () => {
    const runner = new SubscribePassRunner(makeHost());
    const order: string[] = [];
    runner.enqueue(async () => { order.push('a'); throw new Error('boom'); }, 'First');
    runner.enqueue(async () => { order.push('b'); }, 'Second');
    await runner.chain;
    expect(order).toEqual(['a', 'b']);
  });

  it('refreshes the token before a queued pass and reports a live result to the host', async () => {
    const host = makeHost();
    const runner = new SubscribePassRunner(host);
    runner.queue('sess-1', 'empty', 'Pass error');
    await runner.chain;
    expect(host.setData).toHaveBeenCalledWith({ ...DATA, token: 'fresh-token' });
    expect(subscribeForStreamer).toHaveBeenCalledWith('sess-1', { ...DATA, token: 'fresh-token' });
    expect(host.onSubscribeSucceeded).toHaveBeenCalled();
    expect(host.selfStop).not.toHaveBeenCalled();
  });

  it('asks the host to self-stop when nothing is desired', async () => {
    vi.mocked(subscribeForStreamer).mockResolvedValue({ desired: 0, live: 0, transientFailures: 0 } as any);
    const host = makeHost();
    const runner = new SubscribePassRunner(host);
    await runner.run({ sessionId: 'sess-1', emptyLogMessage: 'empty', refreshToken: false, generation: 0 });
    expect(host.selfStop).toHaveBeenCalledTimes(1);
  });

  it('defers a pass to the migration welcome when its session is migrating', async () => {
    const host = makeHost({ isMigrating: vi.fn(() => true) });
    const runner = new SubscribePassRunner(host);
    await runner.run({ sessionId: 'sess-1', emptyLogMessage: 'empty', refreshToken: false, generation: 0 });
    expect(host.deferToMigrationWelcome).toHaveBeenCalled();
    expect(subscribeForStreamer).not.toHaveBeenCalled();
  });

  it('drops a pass whose session was replaced by a fresh connection', async () => {
    const host = makeHost({ sessionId: vi.fn(() => 'sess-2'), freshSessionGeneration: vi.fn(() => 1) });
    const runner = new SubscribePassRunner(host);
    await runner.run({ sessionId: 'sess-1', emptyLogMessage: 'empty', refreshToken: false, generation: 0 });
    expect(subscribeForStreamer).not.toHaveBeenCalled();
    expect(host.deferToMigrationWelcome).not.toHaveBeenCalled();
  });

  it('cleans up what it created if the connection stopped while subscribing', async () => {
    let stopped = false;
    vi.mocked(subscribeForStreamer).mockImplementation(async () => { stopped = true; return { desired: 1, live: 1, transientFailures: 0 } as any; });
    const host = makeHost({ isStopped: vi.fn(() => stopped) });
    const runner = new SubscribePassRunner(host);
    await runner.run({ sessionId: 'sess-1', emptyLogMessage: 'empty', refreshToken: false, generation: 0 });
    expect(removeSessionSubscriptions).toHaveBeenCalledWith('sess-1', DATA);
    expect(host.onSubscribeSucceeded).not.toHaveBeenCalled();
  });

  it('schedules a retry after transient failures', async () => {
    vi.mocked(subscribeForStreamer).mockResolvedValue({ desired: 2, live: 1, transientFailures: 1 } as any);
    const runner = new SubscribePassRunner(makeHost());
    await runner.run({ sessionId: 'sess-1', emptyLogMessage: 'empty', refreshToken: false, generation: 0 });
    expect(runner.retry.pending).toBe(true);
    runner.retry.reset();
  });
});
