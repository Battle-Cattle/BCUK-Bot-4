import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { deferred } from '../test-utils/deferredPromise';
import { flushMicrotasks } from '../test-utils/flushMicrotasks';

// A single hoisted instance (rather than the shared mockLogger() factory, which mints a
// fresh object per call) so tests can assert on it — the module captures `log` once at
// import time, so every createLogger() call here must return the same object.
const mockLog = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('../shared/logger', () => ({ createLogger: () => mockLog }));
vi.mock('../db', () => ({ getTwitchEnabledChannels: vi.fn() }));
vi.mock('./twitchApi', () => ({ getUsers: vi.fn() }));
vi.mock('../shared/statusStore', () => ({ setTwitchChannel: vi.fn() }));

import {
  setChatClient,
  setConnected,
  setChannelJoinedHook,
  reconcileJoinedChannels,
  initializeActiveChannels,
  joinTwitchChannel,
  partTwitchChannel,
  getActiveChannels,
  getActiveChannelUserIds,
  clearMembershipState,
  startChannelReconciliationPoll,
  stopChannelReconciliationPoll,
  __setConfirmedJoinedChannelsForTests,
} from './twitchChannelMembership';
import { getTwitchEnabledChannels } from '../db';
import { getUsers } from './twitchApi';
import { setTwitchChannel } from '../shared/statusStore';

/**
 * Builds a minimal fake Twurple chat client, pre-seeded with the given already-joined channels.
 * Also seeds {@link __setConfirmedJoinedChannelsForTests} with the same list — that's what
 * `isChannelJoined` actually reads (see its doc for why `client.currentChannels` isn't trusted).
 * `currentChannels` is kept on the mock only for shape-compatibility with the real `ChatClient`.
 */
function makeMockClient(channels: string[] = []) {
  __setConfirmedJoinedChannelsForTests(channels);
  return {
    currentChannels: channels,
    join: vi.fn().mockResolvedValue(undefined),
    part: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  clearMembershipState();
  setChatClient(null);
  setConnected(false);
  setChannelJoinedHook(() => {});
  vi.mocked(getUsers).mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── joinTwitchChannel ─────────────────────────────────────────────────────

describe('joinTwitchChannel', () => {
  it('throws on an invalid channel name and does not touch state', async () => {
    await expect(joinTwitchChannel('!!invalid!!')).rejects.toThrow(/Invalid channel name/);
    expect(getActiveChannels().size).toBe(0);
  });

  it('queues the channel locally without calling client.join when not connected', async () => {
    const client = makeMockClient();
    setChatClient(client as any); // client present but disconnected — isolates the !_connected guard
    setConnected(false);

    await joinTwitchChannel('alice');

    expect(getActiveChannels().has('alice')).toBe(true);
    expect(vi.mocked(setTwitchChannel)).toHaveBeenCalledWith('alice', false);
    expect(client.join).not.toHaveBeenCalled();
  });

  it('joins via the client and marks the channel active when connected', async () => {
    const client = makeMockClient();
    setChatClient(client as any);
    setConnected(true);
    const hook = vi.fn();
    setChannelJoinedHook(hook);

    await joinTwitchChannel('alice');

    expect(client.join).toHaveBeenCalledWith('alice');
    expect(getActiveChannels().has('alice')).toBe(true);
    expect(vi.mocked(setTwitchChannel)).toHaveBeenCalledWith('alice', true);
    expect(hook).toHaveBeenCalledWith('alice');
  });

  it('syncs local state without re-joining when the client already has the channel joined', async () => {
    const client = makeMockClient(['alice']);
    setChatClient(client as any);
    setConnected(true);
    const hook = vi.fn();
    setChannelJoinedHook(hook);

    await joinTwitchChannel('alice');

    expect(client.join).not.toHaveBeenCalled();
    expect(getActiveChannels().has('alice')).toBe(true);
    expect(hook).toHaveBeenCalledWith('alice');
  });

  it('rolls back local state and rethrows when client.join fails', async () => {
    const client = makeMockClient();
    client.join.mockRejectedValue(new Error('join failed'));
    setChatClient(client as any);
    setConnected(true);

    await expect(joinTwitchChannel('alice')).rejects.toThrow('join failed');

    expect(getActiveChannels().has('alice')).toBe(false);
    expect(vi.mocked(setTwitchChannel)).toHaveBeenLastCalledWith('alice', false);
  });

  it('caches the channel user ID via getUsers after joining', async () => {
    const client = makeMockClient();
    setChatClient(client as any);
    setConnected(true);
    vi.mocked(getUsers).mockResolvedValue([{ login: 'alice', id: 'uid-alice' }]);

    await joinTwitchChannel('alice');
    await flushMicrotasks();

    expect(getActiveChannelUserIds().get('alice')).toBe('uid-alice');
  });

  it('logs and does not throw when the joined-channel hook itself throws', async () => {
    const client = makeMockClient();
    setChatClient(client as any);
    setConnected(true);
    setChannelJoinedHook(() => { throw new Error('hook boom'); });

    await expect(joinTwitchChannel('alice')).resolves.toBeUndefined();

    expect(getActiveChannels().has('alice')).toBe(true);
    expect(mockLog.error).toHaveBeenCalledWith('Channel joined hook error:', expect.any(Error));
  });
});

// ─── partTwitchChannel ─────────────────────────────────────────────────────

describe('partTwitchChannel', () => {
  it('is a no-op for an invalid channel name', async () => {
    await expect(partTwitchChannel('!!invalid!!')).resolves.toBeUndefined();
  });

  it('is a no-op when the channel is neither active nor joined', async () => {
    const client = makeMockClient();
    setChatClient(client as any);
    setConnected(true);

    await partTwitchChannel('alice');

    expect(vi.mocked(setTwitchChannel)).not.toHaveBeenCalled();
    expect(client.part).not.toHaveBeenCalled();
  });

  it('removes local state without calling client.part when not connected', async () => {
    const client = makeMockClient();
    setChatClient(client as any); // client present but disconnected — isolates the !_connected guard
    setConnected(false);
    await joinTwitchChannel('alice');

    await partTwitchChannel('alice');

    expect(getActiveChannels().has('alice')).toBe(false);
    expect(client.part).not.toHaveBeenCalled();
  });

  it('parts via the client when connected and joined', async () => {
    const client = makeMockClient(['alice']);
    setChatClient(client as any);
    setConnected(true);
    await joinTwitchChannel('alice');

    await partTwitchChannel('alice');

    expect(client.part).toHaveBeenCalledWith('alice');
    expect(getActiveChannels().has('alice')).toBe(false);
  });

  it('keeps state removed and rethrows when client.part fails', async () => {
    const client = makeMockClient(['alice']);
    client.part.mockImplementation(() => { throw new Error('part failed'); });
    setChatClient(client as any);
    setConnected(true);
    await joinTwitchChannel('alice');

    await expect(partTwitchChannel('alice')).rejects.toThrow('part failed');

    expect(getActiveChannels().has('alice')).toBe(false);
  });
});

// ─── membershipMutationQueue serialization ─────────────────────────────────

describe('membershipMutationQueue serialization', () => {
  it('serializes join then part on the same channel', async () => {
    const client = makeMockClient();
    setChatClient(client as any);
    setConnected(true);
    const order: string[] = [];
    const { promise: gate, resolve: openGate } = deferred();
    client.join.mockImplementation(async () => {
      order.push('join-start');
      await gate;
      order.push('join-end');
    });
    client.part.mockImplementation(async () => { order.push('part'); });

    const joinPromise = joinTwitchChannel('alice');
    const partPromise = partTwitchChannel('alice');

    openGate();
    await Promise.all([joinPromise, partPromise]);

    expect(order).toEqual(['join-start', 'join-end', 'part']);
  });

  it('runs non-join operations on different channels independently', async () => {
    // client.join() calls are globally throttled (see the throttledJoin describe block below),
    // so this exercises the queue's per-channel independence using part instead.
    const client = makeMockClient(['alice', 'carol']);
    setChatClient(client as any);
    setConnected(true);
    const order: string[] = [];
    const { promise: gate, resolve: openGate } = deferred();
    client.part.mockImplementation(async (channel: string) => {
      if (channel === 'alice') await gate;
      order.push(channel);
    });

    const alicePromise = partTwitchChannel('alice'); // blocks on gate
    await partTwitchChannel('carol'); // must resolve without waiting for alice's gate
    expect(order).toEqual(['carol']);

    openGate();
    await alicePromise;
    expect(order).toEqual(['carol', 'alice']);
  });
});

// ─── joinTwitchChannel global JOIN throttle ────────────────────────────────

describe('joinTwitchChannel global join throttle', () => {
  it('spaces client.join() calls across different channels by JOIN_THROTTLE_MS, not just per-channel', async () => {
    const client = makeMockClient();
    setChatClient(client as any);
    setConnected(true);

    const alicePromise = joinTwitchChannel('alice');
    const carolPromise = joinTwitchChannel('carol'); // must not call client.join before alice's throttle window elapses

    await flushMicrotasks();
    expect(client.join).toHaveBeenCalledTimes(1);
    expect(client.join).toHaveBeenCalledWith('alice');

    // Assert the throttle actually holds for the full window, not just "eventually" — advancing
    // one tick short of JOIN_THROTTLE_MS must not release carol's join yet.
    await vi.advanceTimersByTimeAsync(599);
    expect(client.join).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await Promise.all([alicePromise, carolPromise]);

    expect(client.join).toHaveBeenNthCalledWith(1, 'alice');
    expect(client.join).toHaveBeenNthCalledWith(2, 'carol');
  });
});

// ─── join/part timeout safeguard ───────────────────────────────────────────

describe('join/part timeout safeguard', () => {
  it('times out a hung client.join and still releases the join gate for a later join', async () => {
    const client = makeMockClient();
    setChatClient(client as any);
    setConnected(true);
    client.join.mockImplementation((channel: string) => (channel === 'alice' ? new Promise<void>(() => {}) : Promise.resolve()));

    const alicePromise = joinTwitchChannel('alice');
    const aliceAssertion = expect(alicePromise).rejects.toThrow('Twitch join timed out after 10000ms');
    await vi.advanceTimersByTimeAsync(10_000); // JOIN_PART_TIMEOUT_MS
    await aliceAssertion;

    // The global join gate must have been released by throttledJoin's `finally` despite the
    // timeout — a later join for a different channel must still go through instead of queuing
    // behind the hung one forever.
    const carolPromise = joinTwitchChannel('carol');
    const carolAssertion = expect(carolPromise).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(600); // JOIN_THROTTLE_MS
    await carolAssertion;
    expect(client.join).toHaveBeenCalledWith('carol');
  });

  // Unlike tmi.js's client.part() (a real network round trip that could hang), Twurple's part()
  // is synchronous and fire-and-forget — see partAsync() in twitchChannelNetworkOps.ts. It can
  // never hang, so the only failure mode left to guard is a synchronous throw from part() itself
  // still propagating as a rejection instead of wedging the per-channel queue.
  it('propagates a synchronous throw from client.part and still releases the per-channel queue for a later operation on the same channel', async () => {
    const client = makeMockClient(['alice']);
    setChatClient(client as any);
    setConnected(true);
    await joinTwitchChannel('alice'); // already-joined branch — syncs local state, no client.join call
    client.part.mockImplementation(() => { throw new Error('part failed'); });

    await expect(partTwitchChannel('alice')).rejects.toThrow('part failed');

    // membershipMutationQueue's 'alice' entry must have released — a later same-key operation
    // (still seeing the channel as joined, since the throwing part never actually took effect)
    // must resolve instead of queuing behind the failed part forever.
    await expect(joinTwitchChannel('alice')).resolves.toBeUndefined();
  });
});

// ─── stale join/part compensation ──────────────────────────────────────────
// A timeout only stops *waiting* on client.join()/client.part() — it doesn't cancel the real
// network call. If that call later actually succeeds, after the caller already gave up and moved
// on, its effect on real Twitch-side membership must be reconciled against activeChannels instead
// of being trusted blindly (CodeRabbit review finding on PR #533).

describe('stale join/part compensation', () => {
  it('reverts a stale join that lands late, after the channel is no longer desired active', async () => {
    const client = makeMockClient();
    setChatClient(client as any);
    setConnected(true);
    let resolveJoin!: () => void;
    client.join.mockImplementation(() => new Promise<void>((resolve) => { resolveJoin = resolve; }));

    const joinPromise = joinTwitchChannel('alice');
    const assertion = expect(joinPromise).rejects.toThrow('Twitch join timed out after 10000ms');
    await vi.advanceTimersByTimeAsync(10_000); // JOIN_PART_TIMEOUT_MS — the caller gives up and rolls back
    await assertion;
    expect(getActiveChannels().has('alice')).toBe(false);

    // The real join now actually lands, out of band, well after the caller stopped waiting —
    // compensateIfStale's own markJoined callback (not client.currentChannels) is what records it.
    resolveJoin();
    await flushMicrotasks();

    // Actual membership no longer matches desired state (not active) — compensateIfStale must
    // notice and part the channel again rather than leaving a stale, unwanted join in place.
    expect(client.part).toHaveBeenCalledWith('alice');
  });

  // No equivalent "stale part lands late" scenario exists for Twurple: partAsync() wraps
  // client.part() (synchronous, fire-and-forget) in an already-settled promise, so a part can
  // never still be pending by the time a later operation on the same channel runs — unlike
  // tmi.js's part(), which was a real network round trip that could land after its caller had
  // already timed out and moved on. The join-side equivalent above still applies, since
  // client.join() genuinely is an async round trip that can hang.

  it('does not compensate a join that settles normally, within the timeout window', async () => {
    const client = makeMockClient();
    setChatClient(client as any);
    setConnected(true);

    await joinTwitchChannel('alice');
    await flushMicrotasks();

    expect(client.part).not.toHaveBeenCalled();
  });
});

// ─── reconcileJoinedChannels ────────────────────────────────────────────────

describe('reconcileJoinedChannels', () => {
  it('no-ops when there is no client, even if connected is true', async () => {
    setChatClient(null);
    setConnected(true);

    await expect(reconcileJoinedChannels()).resolves.toBeUndefined();

    expect(vi.mocked(setTwitchChannel)).not.toHaveBeenCalled();
  });

  it('no-ops when the client is not connected, even with a client present', async () => {
    const client = makeMockClient(['stale']);
    setChatClient(client as any);
    setConnected(false);

    await expect(reconcileJoinedChannels()).resolves.toBeUndefined();

    expect(client.part).not.toHaveBeenCalled();
    expect(client.join).not.toHaveBeenCalled();
    expect(vi.mocked(setTwitchChannel)).not.toHaveBeenCalled();
  });

  it('parts a channel the client has joined but is no longer in activeChannels (stale)', async () => {
    const client = makeMockClient(['stale']);
    setChatClient(client as any);
    setConnected(true);

    const p = reconcileJoinedChannels();
    await vi.runAllTimersAsync();
    await p;

    expect(client.part).toHaveBeenCalledWith('stale');
    expect(vi.mocked(setTwitchChannel)).toHaveBeenCalledWith('stale', false);
  });

  it('continues reconciling other stale channels when parting one fails', async () => {
    const client = makeMockClient(['stale', 'other']);
    setChatClient(client as any);
    setConnected(true);
    client.part.mockImplementation(async (channel: string) => {
      if (channel === 'stale') throw new Error('part failed');
    });

    const p = reconcileJoinedChannels();
    await vi.runAllTimersAsync();
    await p;

    expect(client.part).toHaveBeenCalledWith('stale');
    expect(client.part).toHaveBeenCalledWith('other');
    expect(vi.mocked(setTwitchChannel)).toHaveBeenCalledWith('other', false);
  });

  it('refreshes status to online for a joined channel that is still in activeChannels', async () => {
    const client = makeMockClient(['alice']); // Twurple's currentChannels are unprefixed (no leading #)
    setChatClient(client as any);
    setConnected(true);
    await joinTwitchChannel('alice'); // already-joined branch — adds to activeChannels
    vi.mocked(setTwitchChannel).mockClear();

    const p = reconcileJoinedChannels();
    await vi.runAllTimersAsync();
    await p;

    expect(client.part).not.toHaveBeenCalled();
    expect(vi.mocked(setTwitchChannel)).toHaveBeenCalledWith('alice', true);
  });

  it('joins a queued-but-unjoined active channel, throttled by JOIN_THROTTLE_MS', async () => {
    const client = makeMockClient([]);
    setChatClient(client as any);
    setConnected(false);
    await joinTwitchChannel('alice'); // queues into activeChannels without calling client.join
    setConnected(true); // simulate reconnect

    const p = reconcileJoinedChannels();
    await vi.runAllTimersAsync();
    await p;

    expect(client.join).toHaveBeenCalledWith('alice');
    expect(vi.mocked(setTwitchChannel)).toHaveBeenCalledWith('alice', true);
  });

  it('continues reconciling other channels when one fails to join', async () => {
    const client = makeMockClient([]);
    setChatClient(client as any);
    setConnected(false);
    await joinTwitchChannel('alice');
    await joinTwitchChannel('carol');
    setConnected(true);
    client.join.mockImplementation(async (channel: string) => {
      if (channel === 'alice') throw new Error('join failed');
    });

    const p = reconcileJoinedChannels();
    await vi.runAllTimersAsync();
    await p;

    expect(client.join).toHaveBeenCalledWith('carol');
    expect(vi.mocked(setTwitchChannel)).toHaveBeenCalledWith('carol', true);
    expect(vi.mocked(setTwitchChannel)).toHaveBeenCalledWith('alice', false);
  });
});

// ─── startChannelReconciliationPoll / stopChannelReconciliationPoll ────────

describe('startChannelReconciliationPoll', () => {
  it('re-runs reconciliation on an interval, retrying a channel a prior pass failed to join', async () => {
    const client = makeMockClient([]);
    setChatClient(client as any);
    setConnected(false);
    await joinTwitchChannel('alice'); // queues into activeChannels without calling client.join
    setConnected(true);

    // Simulate the connect-time reconciliation pass (onConnected's own call) failing to join —
    // unlike joinTwitchChannel's own failure path, this leaves 'alice' in activeChannels (still
    // desired) but not actually joined, exactly the case the periodic poll exists to retry.
    client.join.mockRejectedValueOnce(new Error('join failed'));
    await reconcileJoinedChannels();
    expect(client.join).toHaveBeenCalledWith('alice');
    expect(getActiveChannels().has('alice')).toBe(true);
    vi.mocked(setTwitchChannel).mockClear();
    client.join.mockClear();

    startChannelReconciliationPoll();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(client.join).toHaveBeenCalledWith('alice');
    expect(vi.mocked(setTwitchChannel)).toHaveBeenCalledWith('alice', true);
  });

  it('does not register a second interval when called again while already running', async () => {
    const client = makeMockClient(['alice']);
    setChatClient(client as any);
    setConnected(true);
    await joinTwitchChannel('alice');
    vi.mocked(setTwitchChannel).mockClear();

    startChannelReconciliationPoll();
    startChannelReconciliationPoll();
    await vi.advanceTimersByTimeAsync(60_000);

    // A duplicate interval would have run reconcileJoinedChannels twice in this window,
    // marking the already-joined channel online twice instead of once.
    expect(vi.mocked(setTwitchChannel)).toHaveBeenCalledTimes(1);
  });
});

describe('stopChannelReconciliationPoll', () => {
  it('stops further reconciliation passes', async () => {
    const client = makeMockClient(['alice']);
    setChatClient(client as any);
    setConnected(true);
    await joinTwitchChannel('alice');
    vi.mocked(setTwitchChannel).mockClear();

    startChannelReconciliationPoll();
    stopChannelReconciliationPoll();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(vi.mocked(setTwitchChannel)).not.toHaveBeenCalled();
  });

  it('is a no-op when the poll was never started', () => {
    expect(() => stopChannelReconciliationPoll()).not.toThrow();
  });
});

// ─── initializeActiveChannels ───────────────────────────────────────────────

describe('initializeActiveChannels', () => {
  it('loads enabled channels from the DB, normalizes them, and marks them offline initially', async () => {
    vi.mocked(getTwitchEnabledChannels).mockResolvedValue(['#Alice', 'CAROL']);

    await initializeActiveChannels();

    expect(getActiveChannels()).toEqual(new Set(['alice', 'carol']));
    expect(vi.mocked(setTwitchChannel)).toHaveBeenCalledWith('alice', false);
    expect(vi.mocked(setTwitchChannel)).toHaveBeenCalledWith('carol', false);
  });

  it('skips an invalid channel name from the DB without throwing', async () => {
    vi.mocked(getTwitchEnabledChannels).mockResolvedValue(['good', '!!bad!!']);

    await expect(initializeActiveChannels()).resolves.toBeUndefined();

    expect(getActiveChannels()).toEqual(new Set(['good']));
  });

  it('warns and leaves activeChannels empty when there are no enabled channels', async () => {
    vi.mocked(getTwitchEnabledChannels).mockResolvedValue([]);

    await initializeActiveChannels();

    expect(getActiveChannels().size).toBe(0);
    expect(vi.mocked(getUsers)).not.toHaveBeenCalled();
    expect(mockLog.warn).toHaveBeenCalledWith('No enabled Twitch channels found in DB; connecting with no joined channels.');
  });

  it('populates the user ID cache from getUsers', async () => {
    vi.mocked(getTwitchEnabledChannels).mockResolvedValue(['alice']);
    vi.mocked(getUsers).mockResolvedValue([{ login: 'alice', id: 'uid-1' }]);

    await initializeActiveChannels();

    expect(getActiveChannelUserIds().get('alice')).toBe('uid-1');
  });

  it('logs and continues when getUsers fails', async () => {
    vi.mocked(getTwitchEnabledChannels).mockResolvedValue(['alice']);
    vi.mocked(getUsers).mockRejectedValue(new Error('API down'));

    await expect(initializeActiveChannels()).resolves.toBeUndefined();

    expect(getActiveChannelUserIds().size).toBe(0);
    expect(mockLog.error).toHaveBeenCalledWith(
      'Failed to resolve channel user IDs (shared-chat dedup unavailable):',
      expect.any(Error),
    );
  });
});

// ─── clearMembershipState ───────────────────────────────────────────────────

describe('clearMembershipState', () => {
  it('empties both active channels and cached user IDs', async () => {
    vi.mocked(getTwitchEnabledChannels).mockResolvedValue(['alice']);
    vi.mocked(getUsers).mockResolvedValue([{ login: 'alice', id: 'uid-1' }]);
    await initializeActiveChannels();
    expect(getActiveChannels().size).toBe(1);
    expect(getActiveChannelUserIds().size).toBe(1);

    clearMembershipState();

    expect(getActiveChannels().size).toBe(0);
    expect(getActiveChannelUserIds().size).toBe(0);
  });
});
