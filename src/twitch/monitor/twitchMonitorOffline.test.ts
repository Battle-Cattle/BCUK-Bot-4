import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { logMock } = vi.hoisted(() => ({
  logMock: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../shared/logger', () => ({ createLogger: () => logMock }));
vi.mock('../twitchApi', () => ({ getStreams: vi.fn() }));
vi.mock('./twitchMonitorAnnouncements', () => ({ deleteAnnouncement: vi.fn() }));
vi.mock('../../shared/statusStore', () => ({ setTwitchChannelLive: vi.fn() }));

import { cancelOfflineTimersForLogin, runOfflineCheck, handleStreamOffline } from './twitchMonitorOffline';
import { withLoginLock } from './twitchMonitorLoginLock';
import { getStreams } from '../twitchApi';
import { deleteAnnouncement } from './twitchMonitorAnnouncements';
import { setTwitchChannelLive } from '../../shared/statusStore';
import type { LiveState } from './twitchMonitorTypes';

function makeState(overrides: Partial<LiveState> = {}): LiveState {
  return {
    streamerId: 1,
    login: 'alice',
    groupId: 10,
    currentGame: 'Minecraft',
    title: 'Playing',
    currentStream: {} as any,
    messageId: 'msg1',
    channelId: 'chan1',
    offlineTimer: null,
    group: { id: 10, guild_id: 'guild-1', name: 'G', discord_channel: 'c', live_message: 'l', new_game_message: 'g', multi_twitch: true, delete_old_posts: false },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── cancelOfflineTimersForLogin ─────────────────────────────────────────────

describe('cancelOfflineTimersForLogin', () => {
  it('clears the offlineTimer for matching login and sets it to null', () => {
    const timer = setTimeout(() => {}, 99999);
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    const state = makeState({ login: 'alice', offlineTimer: timer });
    const map = new Map([['k1', state]]);

    cancelOfflineTimersForLogin(map, 'alice');

    expect(clearSpy).toHaveBeenCalledWith(timer);
    expect(state.offlineTimer).toBeNull();
    clearTimeout(timer);
  });

  it('does not clear timers for a different login', () => {
    const timer = setTimeout(() => {}, 99999);
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    const state = makeState({ login: 'bob', offlineTimer: timer });
    const map = new Map([['k1', state]]);

    cancelOfflineTimersForLogin(map, 'alice');

    expect(clearSpy).not.toHaveBeenCalled();
    expect(state.offlineTimer).not.toBeNull();
    clearTimeout(timer);
  });

  it('does nothing when the map is empty', () => {
    expect(() => cancelOfflineTimersForLogin(new Map(), 'alice')).not.toThrow();
  });

  it('skips states where offlineTimer is already null', () => {
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    const state = makeState({ login: 'alice', offlineTimer: null });
    const map = new Map([['k1', state]]);

    cancelOfflineTimersForLogin(map, 'alice');

    expect(clearSpy).not.toHaveBeenCalled();
  });

  it('cancels timers across multiple states for the same login', () => {
    const t1 = setTimeout(() => {}, 99999);
    const t2 = setTimeout(() => {}, 99999);
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    const s1 = makeState({ login: 'alice', offlineTimer: t1 });
    const s2 = makeState({ login: 'alice', offlineTimer: t2 });
    const map = new Map([['k1', s1], ['k2', s2]]);

    cancelOfflineTimersForLogin(map, 'alice');

    expect(clearSpy).toHaveBeenCalledTimes(2);
    expect(s1.offlineTimer).toBeNull();
    expect(s2.offlineTimer).toBeNull();
    clearTimeout(t1);
    clearTimeout(t2);
  });
});

// ─── runOfflineCheck ──────────────────────────────────────────────────────────

describe('runOfflineCheck', () => {
  it('returns early and does nothing when state is not in liveStates', async () => {
    const map = new Map<string, LiveState>();
    await runOfflineCheck(map, new Map(), 'missing', 'alice', 'alice');
    expect(getStreams).not.toHaveBeenCalled();
  });

  it('returns early when userId is not found in loginToUserId', async () => {
    const state = makeState();
    const map = new Map([['k1', state]]);
    await runOfflineCheck(map, new Map(), 'k1', 'alice', 'alice');
    expect(getStreams).not.toHaveBeenCalled();
    expect(state.offlineTimer).toBeNull();
  });

  it('deletes the announcement and sets channel offline when stream is no longer live', async () => {
    vi.mocked(getStreams).mockResolvedValue([]);
    const state = makeState();
    const liveStates = new Map([['k1', state]]);
    const loginToUserId = new Map([['alice', 'uid123']]);

    await runOfflineCheck(liveStates, loginToUserId, 'k1', 'alice', 'alice');

    expect(getStreams).toHaveBeenCalledWith(['uid123']);
    expect(setTwitchChannelLive).toHaveBeenCalledWith('alice', false);
    expect(deleteAnnouncement).toHaveBeenCalledWith(liveStates, 'k1', expect.any(Function));
    expect(state.offlineTimer).toBeNull();
  });

  it('does not delete announcement when stream is still live', async () => {
    vi.mocked(getStreams).mockResolvedValue([{ user_id: 'uid123', type: 'live' } as any]);
    const state = makeState();
    const liveStates = new Map([['k1', state]]);
    const loginToUserId = new Map([['alice', 'uid123']]);

    await runOfflineCheck(liveStates, loginToUserId, 'k1', 'alice', 'alice');

    expect(deleteAnnouncement).not.toHaveBeenCalled();
    expect(setTwitchChannelLive).not.toHaveBeenCalled();
    expect(state.offlineTimer).toBeNull();
  });

  it('nulls offlineTimer in the finally block even when an error is thrown', async () => {
    vi.mocked(getStreams).mockRejectedValue(new Error('API error'));
    const state = makeState();
    const liveStates = new Map([['k1', state]]);
    const loginToUserId = new Map([['alice', 'uid123']]);

    await expect(runOfflineCheck(liveStates, loginToUserId, 'k1', 'alice', 'alice')).rejects.toThrow('API error');
    expect(state.offlineTimer).toBeNull();
  });

  it('treats a non-live stream type as offline', async () => {
    vi.mocked(getStreams).mockResolvedValue([{ user_id: 'uid123', type: 'vodcast' } as any]);
    const state = makeState();
    const liveStates = new Map([['k1', state]]);
    const loginToUserId = new Map([['alice', 'uid123']]);

    await runOfflineCheck(liveStates, loginToUserId, 'k1', 'alice', 'alice');

    expect(deleteAnnouncement).toHaveBeenCalled();
  });

  // Regression test: the finally block must only clear the offlineTimer this specific check
  // owns, not one a newer same-login operation has since scheduled on the same LiveState object
  // (e.g. a fresh handleStreamOffline() call after a flap back offline) while this check's own
  // Helix call was in flight.
  it('does not clear a newer offlineTimer scheduled on the same state while the check was in flight', async () => {
    let resolveGetStreams!: (streams: Awaited<ReturnType<typeof getStreams>>) => void;
    vi.mocked(getStreams).mockImplementation(
      () => new Promise((resolve) => { resolveGetStreams = resolve; }),
    );
    const ownedTimer = setTimeout(() => {}, 99999);
    const state = makeState({ offlineTimer: ownedTimer });
    const liveStates = new Map([['k1', state]]);
    const loginToUserId = new Map([['alice', 'uid123']]);

    const checkPromise = runOfflineCheck(liveStates, loginToUserId, 'k1', 'alice', 'alice');
    await Promise.resolve();
    await Promise.resolve();

    // A newer offline-grace-period timer gets scheduled on the same state object before the
    // in-flight check resolves — it must survive the earlier check's cleanup.
    const newerTimer = setTimeout(() => {}, 99999);
    state.offlineTimer = newerTimer;

    resolveGetStreams([]);
    await checkPromise;

    expect(state.offlineTimer).toBe(newerTimer);
    clearTimeout(ownedTimer);
    clearTimeout(newerTimer);
  });

  // Regression test: runOfflineCheck must route through the same per-login withLoginLock the
  // poll loop/triggerImmediateLiveCheck use, so a concurrent operation for the same login that
  // takes over after this check's own Helix call is in flight is recognized as superseding it —
  // otherwise a flap right at grace-period expiry could delete an announcement a concurrent,
  // lock-protected poll had just confirmed live. Mirrors the timeout/supersession pattern in
  // twitchMonitorPoll.test.ts's `withLoginLock` suite: a later same-login lock operation only
  // gets to run once the earlier one's lock slot frees up, which (short of it actually finishing)
  // happens on the lock's own timeout — so this simulates that by letting the lock time out
  // while runOfflineCheck's Helix call is still pending, using a login key unique to this test so
  // it can't leak lock state into other tests.
  describe('supersession via withLoginLock', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('does not delete the announcement when superseded by a newer same-login lock operation mid-check', async () => {
      const login = 'racecondlogin';
      let resolveGetStreams!: (streams: Awaited<ReturnType<typeof getStreams>>) => void;
      vi.mocked(getStreams).mockImplementation(
        () => new Promise((resolve) => { resolveGetStreams = resolve; }),
      );
      const state = makeState({ login });
      const liveStates = new Map([['k1', state]]);
      const loginToUserId = new Map([[login, 'uid123']]);

      const checkPromise = runOfflineCheck(liveStates, loginToUserId, 'k1', login, login);
      const checkRejection = checkPromise.catch((err: unknown) => err);

      // Let the lock's own timeout free the queue while runOfflineCheck's getStreams() call is
      // still pending — the only way a later same-login operation can start before this one
      // finishes (see withLoginLock's doc comment).
      await vi.advanceTimersByTimeAsync(20_000); // LOGIN_LOCK_TIMEOUT_MS
      expect(await checkRejection).toBeInstanceOf(Error);

      // A newer operation for the same login (e.g. a poll tick confirming the streamer is live
      // again) takes over the lock.
      await withLoginLock(login, async () => {});

      // Now let the stale getStreams() call resolve with "still offline" — runOfflineCheck's
      // fn should notice it's been superseded (isCurrent() false) and skip the delete, even
      // though its own Helix result says offline.
      resolveGetStreams([]);
      await Promise.resolve();
      await Promise.resolve();

      expect(deleteAnnouncement).not.toHaveBeenCalled();
      expect(setTwitchChannelLive).not.toHaveBeenCalled();
    });
  });
});

// ─── handleStreamOffline ──────────────────────────────────────────────────────

describe('handleStreamOffline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does nothing when no live-state entries match the login', async () => {
    const map = new Map<string, LiveState>();

    await handleStreamOffline(map, new Map(), 'alice');

    expect(logMock.info).not.toHaveBeenCalled();
  });

  it('starts a grace-period timer for every entry matching the login (case-insensitive)', async () => {
    const s1 = makeState({ login: 'alice', groupId: 10 });
    const s2 = makeState({ login: 'alice', groupId: 20 });
    const other = makeState({ login: 'bob' });
    const map = new Map([['k1', s1], ['k2', s2], ['k3', other]]);

    await handleStreamOffline(map, new Map(), 'Alice');

    expect(s1.offlineTimer).not.toBeNull();
    expect(s2.offlineTimer).not.toBeNull();
    expect(other.offlineTimer).toBeNull();
    expect(logMock.info).toHaveBeenCalledWith('Alice went offline — grace period started');
  });

  it('clears a pre-existing offlineTimer before starting a new one', async () => {
    const oldTimer = setTimeout(() => {}, 99999);
    const state = makeState({ login: 'alice', offlineTimer: oldTimer });
    const map = new Map([['k1', state]]);
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');

    await handleStreamOffline(map, new Map(), 'alice');

    expect(clearSpy).toHaveBeenCalledWith(oldTimer);
    expect(state.offlineTimer).not.toBeNull();
    expect(state.offlineTimer).not.toBe(oldTimer);
  });

  it('confirms the streamer offline and removes the announcement once the grace period elapses', async () => {
    vi.mocked(getStreams).mockResolvedValue([]);
    const state = makeState({ login: 'alice' });
    const map = new Map([['k1', state]]);
    const loginToUserId = new Map([['alice', 'uid123']]);

    await handleStreamOffline(map, loginToUserId, 'alice');
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

    expect(getStreams).toHaveBeenCalledWith(['uid123']);
    expect(deleteAnnouncement).toHaveBeenCalledWith(map, 'k1', expect.any(Function));
    expect(state.offlineTimer).toBeNull();
  });

  it('logs and does not throw when the grace-period check itself fails', async () => {
    vi.mocked(getStreams).mockRejectedValue(new Error('API down'));
    const state = makeState({ login: 'alice' });
    const map = new Map([['k1', state]]);
    const loginToUserId = new Map([['alice', 'uid123']]);

    await handleStreamOffline(map, loginToUserId, 'alice');
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

    expect(logMock.error).toHaveBeenCalledWith('Offline-check failed for alice (k1):', expect.any(Error));
    expect(state.offlineTimer).toBeNull();
  });
});
