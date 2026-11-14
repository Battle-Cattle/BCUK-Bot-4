import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockLog = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('../shared/logger', () => ({ createLogger: () => mockLog }));

vi.mock('../db', () => ({
  findOwnerUser: vi.fn(),
}));

import { findOwnerUser } from '../db';
import * as healthStore from '../shared/healthStore';
import { registerOwnerAlertRuntime, __resetOwnerAlertsForTests } from './ownerAlerts';
import {
  primeOwnerAlertBaseline,
  startOwnerAlertWatcher,
  stopOwnerAlertWatcher,
  __resetOwnerAlertWatcherForTests,
  DOWN_ALERT_GRACE_MS,
} from './ownerAlertWatcher';

const OWNER_ID = '111222333444555666';
const OWNER_ROW = {
  discord_id: OWNER_ID,
  discord_name: 'Owner',
  is_twitch_bot_enabled: false,
  twitch_name: null,
  access_level: 3,
  is_owner: true,
};

/**
 * Waits enough microtask ticks for the fire-and-forget `sendOwnerAlert` promise chain
 * (resolveOwnerDiscordId's own await chain, then `runtime.send`) to fully settle before
 * assertions run.
 */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

/** Advances the fake clock past the "down" DM's grace-period delay (see `DOWN_ALERT_GRACE_MS`
 *  in `ownerAlertWatcher.ts`) and flushes microtasks, so a pending down alert actually fires. */
async function advanceGrace(): Promise<void> {
  await vi.advanceTimersByTimeAsync(DOWN_ALERT_GRACE_MS);
  await flush();
}

describe('ownerAlertWatcher', () => {
  let send: ReturnType<typeof vi.fn<(discordId: string, message: string) => Promise<void>>>;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    __resetOwnerAlertsForTests();
    __resetOwnerAlertWatcherForTests();
    send = vi.fn().mockResolvedValue(undefined);
    registerOwnerAlertRuntime({ send });
    vi.mocked(findOwnerUser).mockResolvedValue(OWNER_ROW as any);
    // Baseline every other tracked component healthy first, so each test below can isolate
    // a single component's ok→fail/fail→ok transition without discordConnected/
    // twitchChatConnected's own false-by-default starting state (or `db`'s state left over
    // from a previous test — healthStore itself is a real, un-reset module singleton here)
    // also counting as a (never-seen-before or edge-triggering) transition that sends its
    // own alert. `startOwnerAlertWatcher()`'s listener registration also persists across
    // tests (healthStore.onHealthChanged has no "off"), so these baseline calls are already
    // observed live once a prior test has started the watcher — `flush()` below drains any
    // alert they trigger before `send.mockClear()`, so a late-resolving baseline alert can't
    // land in the mock's call history after it's been cleared.
    healthStore.recordDiscordConnected(true);
    healthStore.recordTwitchChatConnected(true);
    healthStore.recordDbPing(true);
    await flush();
    send.mockClear();
    // Seed the baseline from that healthy state, as production does before starting the watcher,
    // so the tests below that fail 'db' etc. take the tracked-component path whatever order they
    // run in. (Without it, the first test to run in a fresh module would see 'db' as first-seen.)
    await primeOwnerAlertBaseline();
    startOwnerAlertWatcher();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not alert at all on a quick reconnect that recovers within the grace period', async () => {
    healthStore.recordDbPing(false, 'connection refused');
    await vi.advanceTimersByTimeAsync(DOWN_ALERT_GRACE_MS / 2);
    healthStore.recordDbPing(true);
    await advanceGrace();
    expect(send).not.toHaveBeenCalled();
  });

  // These two use an EventSub streamer no other test uses, so the component is genuinely first-seen
  // whatever order the tests run in. 'db' isn't: beforeEach primes it into the watcher's tracked state.
  it('applies the grace period to a component seen failing for the first time, not an immediate alert', async () => {
    try {
      healthStore.recordEventSubConnected('firstseenstreamer', false, 'socket closed');
      await flush();
      expect(send).not.toHaveBeenCalled();
      await advanceGrace();
      expect(send).toHaveBeenCalledExactlyOnceWith(OWNER_ID, expect.stringContaining('eventsub:firstseenstreamer'));
    } finally {
      healthStore.removeEventSubHealth('firstseenstreamer');
    }
  });

  it('sends no alert when a first-seen failing component recovers within the grace period', async () => {
    try {
      healthStore.recordEventSubConnected('quickstreamer', false, 'socket closed');
      await vi.advanceTimersByTimeAsync(DOWN_ALERT_GRACE_MS / 2);
      healthStore.recordEventSubConnected('quickstreamer', true);
      await advanceGrace();
      expect(send).not.toHaveBeenCalled();
    } finally {
      healthStore.removeEventSubHealth('quickstreamer');
    }
  });

  it('sends exactly one alert on an ok→fail transition that outlasts the grace period', async () => {
    healthStore.recordDbPing(false, 'connection refused');
    await advanceGrace();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(OWNER_ID, expect.stringContaining('🔴'));
    expect(send).toHaveBeenCalledWith(OWNER_ID, expect.stringContaining('connection refused'));
  });

  it('does not resend while still failing within the cooldown window', async () => {
    healthStore.recordDbPing(false, 'boom');
    await advanceGrace();
    expect(send).toHaveBeenCalledTimes(1);

    healthStore.recordDbPing(false, 'boom again');
    await flush();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('sends a recovery alert on a fail→ok transition', async () => {
    healthStore.recordDbPing(false, 'boom');
    await advanceGrace();
    expect(send).toHaveBeenCalledTimes(1);

    healthStore.recordDbPing(true);
    await flush();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith(OWNER_ID, expect.stringContaining('✅'));
  });

  it('falls back to the last cached owner ID when findOwnerUser rejects', async () => {
    // First alert resolves normally and populates the cache.
    healthStore.recordDbPing(false, 'boom');
    await advanceGrace();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenLastCalledWith(OWNER_ID, expect.any(String));

    // Recover, then fail again after findOwnerUser starts rejecting (e.g. DB is down).
    healthStore.recordDbPing(true);
    await flush();

    vi.mocked(findOwnerUser).mockRejectedValue(new Error('db down'));
    healthStore.recordDbPing(false, 'boom again');
    await advanceGrace();

    expect(send).toHaveBeenCalledTimes(3);
    expect(send).toHaveBeenLastCalledWith(OWNER_ID, expect.any(String));
  });

  it('skips the alert (does not throw) when findOwnerUser rejects with no cached ID yet', async () => {
    // A previous test's own db-recovery alert (during ITS baseline) can have already
    // populated ownerAlerts.ts's owner-ID cache — reset it again here so this test starts
    // from a genuinely never-resolved cache, matching its name.
    __resetOwnerAlertsForTests();
    vi.mocked(findOwnerUser).mockRejectedValue(new Error('db down'));
    healthStore.recordDbPing(false, 'boom');
    await advanceGrace();
    expect(send).not.toHaveBeenCalled();
  });

  it('treats a successful lookup that returns no owner as authoritative — does not fall back to a stale cached id', async () => {
    // First alert resolves normally and populates the cache.
    healthStore.recordDbPing(false, 'boom');
    await advanceGrace();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenLastCalledWith(OWNER_ID, expect.any(String));

    // Recover, then fail again once findOwnerUser successfully resolves null (e.g. ownership
    // was just removed) — the cached id must not be used.
    healthStore.recordDbPing(true);
    await flush();

    vi.mocked(findOwnerUser).mockResolvedValue(null);
    send.mockClear();
    healthStore.recordDbPing(false, 'boom again');
    await advanceGrace();

    expect(send).not.toHaveBeenCalled();
  });

  it('never throws when the runtime send itself rejects', async () => {
    send.mockRejectedValue(new Error('DM failed — user has DMs disabled'));
    healthStore.recordDbPing(false, 'boom');
    await expect(advanceGrace()).resolves.toBeUndefined();
  });

  it('does not send a false recovery DM when the down DM itself failed to deliver', async () => {
    send.mockRejectedValue(new Error('DM failed — user has DMs disabled'));
    healthStore.recordDbPing(false, 'boom');
    await advanceGrace();
    expect(send).toHaveBeenCalledTimes(1); // the (failed) down DM attempt

    send.mockClear();
    send.mockResolvedValue(undefined);
    healthStore.recordDbPing(true);
    await flush();

    // No down DM was ever actually delivered, so recovery must stay silent.
    expect(send).not.toHaveBeenCalled();
  });

  it('does not send a false recovery DM when the down DM was skipped (no owner to notify)', async () => {
    // findOwnerUser resolves with no owner row, and no ID is cached yet — sendOwnerAlert must
    // skip the down DM for lack of a resolvable owner, which must not count as delivered.
    vi.mocked(findOwnerUser).mockResolvedValue(null);
    healthStore.recordDbPing(false, 'boom');
    await advanceGrace();
    expect(send).not.toHaveBeenCalled();

    healthStore.recordDbPing(true);
    await flush();

    expect(send).not.toHaveBeenCalled();
  });

  it('alerts on an EventSub streamer disconnecting, naming the streamer', async () => {
    try {
      healthStore.recordEventSubConnected('streamerX', false, 'socket closed');
      await advanceGrace();

      expect(send).toHaveBeenCalledWith(OWNER_ID, expect.stringContaining('eventsub:streamerX'));
      expect(send).toHaveBeenCalledWith(OWNER_ID, expect.stringContaining('socket closed'));
    } finally {
      // healthStore is a real, un-reset module singleton across this file's tests (see the
      // beforeEach comment above) — remove this streamer's entry so it doesn't linger as a
      // permanently-failing component and pollute later tests' baselines/assertions.
      healthStore.removeEventSubHealth('streamerX');
      await flush();
    }
  });

  it('alerts on a scheduler run failing, naming the scheduler', async () => {
    try {
      healthStore.recordSchedulerRun('counter', false, 'archive failed');
      await advanceGrace();

      expect(send).toHaveBeenCalledWith(OWNER_ID, expect.stringContaining('scheduler:counter'));
      expect(send).toHaveBeenCalledWith(OWNER_ID, expect.stringContaining('archive failed'));
    } finally {
      // healthStore's scheduler map has no removal operation (schedulers are always one of a
      // fixed set of names, unlike EventSub streamers) — restore it to healthy so it doesn't
      // linger as a permanently-failing component and pollute later tests' baselines.
      healthStore.recordSchedulerRun('counter', true);
      await flush();
    }
  });

  it('re-alerts "still down" once the cooldown window has elapsed for a component that never recovered', async () => {
    try {
      healthStore.recordDbPing(false, 'boom');
      await advanceGrace();
      expect(send).toHaveBeenCalledTimes(1);

      // Still failing, but re-notified with a distinct DB error — before the cooldown elapses
      // this must NOT resend (covered by the existing "does not resend..." test); here we
      // advance past the 30-minute cooldown so the "still down" branch fires instead.
      await vi.advanceTimersByTimeAsync(31 * 60_000);
      healthStore.recordDbPing(false, 'still boom');
      await flush();

      expect(send).toHaveBeenCalledTimes(2);
      expect(send).toHaveBeenLastCalledWith(OWNER_ID, expect.stringContaining('is still down'));
    } finally {
      healthStore.recordDbPing(true);
      await flush();
    }
  });

  it('ignores every disconnect once stopOwnerAlertWatcher() is called, even outlasting the grace period', async () => {
    try {
      stopOwnerAlertWatcher();
      healthStore.recordDbPing(false, 'shutting down');
      await advanceGrace();
      expect(send).not.toHaveBeenCalled();
    } finally {
      healthStore.recordDbPing(true);
      await flush();
    }
  });

  it('cancels a grace-period timer already pending when stopOwnerAlertWatcher() is called', async () => {
    try {
      healthStore.recordDbPing(false, 'boom');
      await vi.advanceTimersByTimeAsync(DOWN_ALERT_GRACE_MS / 2);
      stopOwnerAlertWatcher();
      await advanceGrace();
      expect(send).not.toHaveBeenCalled();
    } finally {
      healthStore.recordDbPing(true);
      await flush();
    }
  });

  it('cancels a pending "down" DM for a component removed from health before the grace period ends', async () => {
    healthStore.recordEventSubConnected('removedstreamer', true);
    await flush();
    healthStore.recordEventSubConnected('removedstreamer', false, 'socket closed');
    await vi.advanceTimersByTimeAsync(DOWN_ALERT_GRACE_MS / 2);

    healthStore.removeEventSubHealth('removedstreamer');
    await advanceGrace();

    expect(send).not.toHaveBeenCalled();
  });

  it('tracks a removed component afresh if it comes back, rather than from its old state', async () => {
    healthStore.recordEventSubConnected('returningstreamer', false, 'socket closed');
    healthStore.removeEventSubHealth('returningstreamer');
    // Seen again as healthy: a first-seen healthy component is stored without any alert.
    healthStore.recordEventSubConnected('returningstreamer', true);
    await advanceGrace();
    expect(send).not.toHaveBeenCalled();

    healthStore.recordEventSubConnected('returningstreamer', false, 'dropped again');
    await advanceGrace();
    expect(send).toHaveBeenCalledExactlyOnceWith(OWNER_ID, expect.stringContaining('dropped again'));
    healthStore.removeEventSubHealth('returningstreamer');
  });

  it('registers its health listener only once, however many times it is started', async () => {
    // A fresh module pair, so the first start is observed (beforeEach already started the shared one)
    // and the listener it adds stays off the healthStore the other tests use.
    vi.resetModules();
    const freshHealthStore = await import('../shared/healthStore.js');
    const spy = vi.spyOn(freshHealthStore, 'onHealthChanged');
    const fresh = await import('./ownerAlertWatcher.js');

    fresh.startOwnerAlertWatcher();
    fresh.startOwnerAlertWatcher();

    expect(spy).toHaveBeenCalledOnce();
  });

  it('drops a "down" DM that was waiting on the runtime when the component recovered meanwhile', async () => {
    let markReady!: () => void;
    const ready = new Promise<void>((resolve) => { markReady = resolve; });
    registerOwnerAlertRuntime({ send, waitUntilReady: () => ready });

    healthStore.recordDbPing(false, 'connection refused');
    await advanceGrace();
    // The down DM is now waiting for the runtime; the component recovers before it's ready.
    healthStore.recordDbPing(true);
    await flush();
    markReady();
    await flush();

    // Neither the stale "down" DM nor a "recovered" DM (no down DM was ever delivered).
    expect(send).not.toHaveBeenCalled();
  });

  it('drops a "down" DM when the component recovers while the owner lookup is still pending', async () => {
    healthStore.recordDbPing(false, 'connection refused');
    let resolveOwner!: (row: unknown) => void;
    vi.mocked(findOwnerUser).mockReturnValueOnce(new Promise((resolve) => { resolveOwner = resolve; }) as any);
    await advanceGrace();
    // The down DM is now waiting on findOwnerUser(); the component recovers before it resolves.
    healthStore.recordDbPing(true);
    await flush();
    resolveOwner(OWNER_ROW);
    await flush();

    expect(send).not.toHaveBeenCalled();
  });

  it('still delivers a waiting "down" DM once the runtime is ready if the component is still failing', async () => {
    let markReady!: () => void;
    const ready = new Promise<void>((resolve) => { markReady = resolve; });
    registerOwnerAlertRuntime({ send, waitUntilReady: () => ready });

    healthStore.recordDbPing(false, 'connection refused');
    await advanceGrace();
    expect(send).not.toHaveBeenCalled();
    markReady();
    await flush();

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(OWNER_ID, expect.stringContaining('connection refused'));
  });
});

describe('primeOwnerAlertBaseline', () => {
  let send: ReturnType<typeof vi.fn<(discordId: string, message: string) => Promise<void>>>;

  async function flush(): Promise<void> {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  }

  async function advanceGrace(): Promise<void> {
    await vi.advanceTimersByTimeAsync(DOWN_ALERT_GRACE_MS);
    await flush();
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    __resetOwnerAlertsForTests();
    __resetOwnerAlertWatcherForTests();
    send = vi.fn().mockResolvedValue(undefined);
    registerOwnerAlertRuntime({ send });
    vi.mocked(findOwnerUser).mockResolvedValue(OWNER_ROW as any);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('seeds the baseline from a currently-unhealthy component without alerting', async () => {
    // The watcher's listener is a single persistent function attached to the real, un-reset
    // `healthStore` module for the lifetime of this test file (see the `ownerAlertWatcher` describe
    // block's beforeEach comment above) — so this setup mutation may itself be observed by a
    // watcher instance left listening from an earlier test. Settle and clear it before
    // asserting what THIS test cares about: that `primeOwnerAlertBaseline()` itself never alerts.
    healthStore.recordTwitchChatConnected(false);
    await flush();
    send.mockClear();

    await primeOwnerAlertBaseline();
    startOwnerAlertWatcher();
    await flush();
    expect(send).not.toHaveBeenCalled();

    // Later, once it actually connects — since no "down" DM was ever sent for this
    // startup-seeded failure (e.g. twitchChat, still connecting when the watcher started), this
    // must NOT fire a false "recovered" DM either.
    healthStore.recordTwitchChatConnected(true);
    await flush();
    expect(send).not.toHaveBeenCalled();

    // A genuine later failure, though, must still alert normally.
    healthStore.recordTwitchChatConnected(false);
    await advanceGrace();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(OWNER_ID, expect.stringContaining('🔴'));

    // ...and its recovery now alerts too, since a real "down" DM was sent this time.
    send.mockClear();
    healthStore.recordTwitchChatConnected(true);
    await flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(OWNER_ID, expect.stringContaining('✅'));
  });

  it('warms the cached owner id up front, so the first real failure can still alert even if findOwnerUser then rejects', async () => {
    healthStore.recordDbPing(true);
    await flush();
    send.mockClear();

    await primeOwnerAlertBaseline();
    startOwnerAlertWatcher();

    vi.mocked(findOwnerUser).mockRejectedValue(new Error('db down'));
    healthStore.recordDbPing(false, 'connection refused');
    await advanceGrace();

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(OWNER_ID, expect.stringContaining('connection refused'));
  });

  it('seeds the baseline from the state as of when owner resolution finishes, not from a stale snapshot taken before it', async () => {
    // Settle db healthy too — a prior test in this file may have left it failing, which would
    // make this test's own recordDbPing(false, ...) transition a no-op (already-failing state)
    // instead of the fresh ok→fail edge it's meant to exercise.
    healthStore.recordDiscordConnected(false);
    healthStore.recordDbPing(true);
    await flush();
    send.mockClear();

    let resolveLookup!: () => void;
    const lookupGate = new Promise<void>((resolve) => { resolveLookup = resolve; });
    vi.mocked(findOwnerUser).mockImplementation(async () => {
      await lookupGate;
      return OWNER_ROW as any;
    });

    const primePromise = primeOwnerAlertBaseline();

    // Discord finishes connecting while owner resolution is still pending — if the baseline
    // snapshot were taken up front (before this await), it would capture the old
    // discordConnected: false state and treat it as the primed baseline.
    healthStore.recordDiscordConnected(true);
    resolveLookup();
    await primePromise;
    startOwnerAlertWatcher();
    await flush();
    send.mockClear();

    // An unrelated transition must not trigger a false "discord recovered" alert from a stale
    // (pre-connect) baseline.
    healthStore.recordDbPing(false, 'boom');
    await advanceGrace();

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(OWNER_ID, expect.stringContaining('db is down'));
    expect(send).not.toHaveBeenCalledWith(OWNER_ID, expect.stringContaining('discord'));
  });
});
