import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../shared/logger', () => ({ createLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }) }));
vi.mock('../twitchApi', () => ({ getStreams: vi.fn() }));
vi.mock('./twitchMonitorAnnouncements', () => ({ deleteAnnouncement: vi.fn() }));
vi.mock('../../shared/statusStore', () => ({ setTwitchChannelLive: vi.fn() }));

import { cancelOfflineTimersForLogin, runOfflineCheck } from './twitchMonitorOffline';
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
    group: { id: 10, name: 'G', discord_channel: 'c', live_message: 'l', new_game_message: 'g', multi_twitch: true, delete_old_posts: false },
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
    expect(deleteAnnouncement).toHaveBeenCalledWith(liveStates, 'k1');
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
});
