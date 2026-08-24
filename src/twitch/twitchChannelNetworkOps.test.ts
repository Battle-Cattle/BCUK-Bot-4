import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { throttledJoin, compensateIfStale, resetJoinGate, JOIN_PART_TIMEOUT_MS, MembershipDeps } from './twitchChannelNetworkOps';
import { flushMicrotasks } from '../test-utils/flushMicrotasks';

/** Builds a minimal fake Twurple chat client, pre-seeded with the given already-joined channels. */
function makeMockClient(channels: string[] = []) {
  return {
    getChannels: vi.fn(() => channels),
    join: vi.fn().mockResolvedValue(undefined),
    part: vi.fn().mockResolvedValue(undefined),
  };
}

/** Builds a {@link MembershipDeps} bundle backed by mutable test state, overridable per test. */
function makeDeps(overrides: Partial<MembershipDeps> = {}): MembershipDeps & { setClient: (c: unknown) => void; setConnected: (v: boolean) => void; setDesired: (channel: string, desired: boolean) => void } {
  let client: unknown = null;
  let connected = true;
  const desired = new Set<string>();
  const deps: MembershipDeps = {
    getClient: () => client as any,
    isConnected: () => connected,
    isChannelJoined: (channel) => (client as any)?.getChannels().includes(channel) ?? false,
    isDesiredJoined: (channel) => desired.has(channel),
    runExclusive: (_channel, op) => op(),
    ...overrides,
  };
  return {
    ...deps,
    setClient: (c: unknown) => { client = c; },
    setConnected: (v: boolean) => { connected = v; },
    setDesired: (channel: string, isDesired: boolean) => {
      if (isDesired) desired.add(channel);
      else desired.delete(channel);
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  resetJoinGate();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('throttledJoin', () => {
  it('calls client.join and resolves once it settles', async () => {
    const client = makeMockClient();
    await throttledJoin(client as any, 'alice', () => {});
    expect(client.join).toHaveBeenCalledWith('alice');
  });

  it('throttles successive joins by JOIN_THROTTLE_MS', async () => {
    const client = makeMockClient();
    const first = throttledJoin(client as any, 'alice', () => {});
    const second = throttledJoin(client as any, 'carol', () => {});

    await vi.advanceTimersByTimeAsync(0);
    expect(client.join).toHaveBeenCalledTimes(1);
    expect(client.join).toHaveBeenCalledWith('alice');

    await vi.advanceTimersByTimeAsync(599);
    expect(client.join).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await Promise.all([first, second]);
    expect(client.join).toHaveBeenNthCalledWith(2, 'carol');
  });

  it('rejects with a timeout error when client.join hangs, and still releases the gate for a later join', async () => {
    const client = makeMockClient();
    client.join.mockImplementation((channel: string) => (channel === 'alice' ? new Promise(() => {}) : Promise.resolve()));

    const alicePromise = throttledJoin(client as any, 'alice', () => {});
    const assertion = expect(alicePromise).rejects.toThrow('Twitch join timed out after 10000ms');
    await vi.advanceTimersByTimeAsync(JOIN_PART_TIMEOUT_MS);
    await assertion;

    const carolPromise = throttledJoin(client as any, 'carol', () => {});
    const carolAssertion = expect(carolPromise).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(600);
    await carolAssertion;
    expect(client.join).toHaveBeenCalledWith('carol');
  });

  it('calls onSettled with the raw join promise right after issuing it', async () => {
    const client = makeMockClient();
    const seen: unknown[] = [];
    await throttledJoin(client as any, 'alice', (call) => seen.push(call));
    expect(seen).toHaveLength(1);
    await expect(seen[0]).resolves.toBeUndefined();
  });

  it('releases the join gate even when onSettled throws synchronously', async () => {
    const client = makeMockClient();

    await expect(throttledJoin(client as any, 'alice', () => { throw new Error('onSettled boom'); }))
      .rejects.toThrow('onSettled boom');

    // A later join must still go through instead of queuing behind the failed one forever.
    const carolPromise = throttledJoin(client as any, 'carol', () => {});
    await vi.advanceTimersByTimeAsync(600); // JOIN_THROTTLE_MS
    await carolPromise;
    expect(client.join).toHaveBeenCalledWith('carol');
  });
});

describe('compensateIfStale', () => {
  it('does not reconcile a call that settles within JOIN_PART_TIMEOUT_MS', async () => {
    const client = makeMockClient(['alice']);
    const deps = makeDeps();
    deps.setClient(client);
    deps.setDesired('alice', false); // desired state disagrees with actual — would trigger revert if considered stale

    compensateIfStale(deps, 'alice', Promise.resolve(), 'join');
    await flushMicrotasks();

    expect(client.part).not.toHaveBeenCalled();
  });

  it('does not attempt a corrective join/part when the client has since disconnected', async () => {
    const client = makeMockClient(['alice']);
    const deps = makeDeps();
    deps.setClient(client);
    deps.setDesired('alice', false); // would trigger a revert if the client were still connected

    const staleCall = new Promise<void>((resolve) => setTimeout(resolve, JOIN_PART_TIMEOUT_MS));
    compensateIfStale(deps, 'alice', staleCall, 'join');
    deps.setConnected(false);
    await vi.advanceTimersByTimeAsync(JOIN_PART_TIMEOUT_MS);
    await flushMicrotasks();

    expect(client.part).not.toHaveBeenCalled();
    expect(client.join).not.toHaveBeenCalled();
  });

  it('reverts a stale join that lands after the channel is no longer desired active', async () => {
    const client = makeMockClient(['alice']);
    const deps = makeDeps();
    deps.setClient(client);
    deps.setDesired('alice', false);

    const staleCall = new Promise<void>((resolve) => setTimeout(resolve, JOIN_PART_TIMEOUT_MS));
    compensateIfStale(deps, 'alice', staleCall, 'join');
    await vi.advanceTimersByTimeAsync(JOIN_PART_TIMEOUT_MS);
    await flushMicrotasks(); // let the reconciliation's own await chain settle

    expect(client.part).toHaveBeenCalledWith('alice');
  });

  // A prior version of this suite (written against tmi.js, whose client.part() was a real
  // network round trip) covered the revert branch's own corrective client.part() call itself
  // landing late — see PR #533. That scenario cannot occur with Twurple: partAsync() wraps
  // client.part() (synchronous, fire-and-forget) in an already-settled promise, so the revert
  // call here can never still be pending by the time compensateIfStale's own watch on it would
  // otherwise notice a late settlement.

  it('rejoins after a stale part lands while the channel is still desired active', async () => {
    const client = makeMockClient([]); // part already "took effect" per the mock's channel list
    const deps = makeDeps();
    deps.setClient(client);
    deps.setDesired('alice', true);

    const staleCall = new Promise<void>((resolve) => setTimeout(resolve, JOIN_PART_TIMEOUT_MS));
    compensateIfStale(deps, 'alice', staleCall, 'part');
    await vi.advanceTimersByTimeAsync(JOIN_PART_TIMEOUT_MS);
    await flushMicrotasks();

    expect(client.join).toHaveBeenCalledWith('alice');
  });

  it('does not reconcile when actual state already matches desired state', async () => {
    const client = makeMockClient(['alice']);
    const deps = makeDeps();
    deps.setClient(client);
    deps.setDesired('alice', true); // desired matches actual (joined) — a "stale" join here is a non-issue

    const staleCall = new Promise<void>((resolve) => setTimeout(resolve, JOIN_PART_TIMEOUT_MS));
    compensateIfStale(deps, 'alice', staleCall, 'join');
    await vi.advanceTimersByTimeAsync(JOIN_PART_TIMEOUT_MS);
    await flushMicrotasks();

    expect(client.part).not.toHaveBeenCalled();
  });

  it('does not reconcile a late rejection', async () => {
    const client = makeMockClient(['alice']);
    const deps = makeDeps();
    deps.setClient(client);
    deps.setDesired('alice', false);

    const staleCall = new Promise<void>((_resolve, reject) => setTimeout(() => reject(new Error('boom')), JOIN_PART_TIMEOUT_MS));
    compensateIfStale(deps, 'alice', staleCall, 'join');
    await vi.advanceTimersByTimeAsync(JOIN_PART_TIMEOUT_MS);
    await flushMicrotasks();

    expect(client.part).not.toHaveBeenCalled();
  });

  it('runs the reconciliation through runExclusive for the affected channel', async () => {
    const client = makeMockClient(['alice']);
    const runs: string[] = [];
    const deps = makeDeps({ runExclusive: (channel, op) => { runs.push(channel); return op(); } });
    deps.setClient(client);
    deps.setDesired('alice', false);

    const staleCall = new Promise<void>((resolve) => setTimeout(resolve, JOIN_PART_TIMEOUT_MS));
    compensateIfStale(deps, 'alice', staleCall, 'join');
    await vi.advanceTimersByTimeAsync(JOIN_PART_TIMEOUT_MS);
    await flushMicrotasks();

    expect(runs).toEqual(['alice']);
  });
});
