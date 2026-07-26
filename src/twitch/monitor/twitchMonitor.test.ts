import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { logMock } = vi.hoisted(() => ({
  logMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../shared/logger', () => ({ createLogger: () => logMock }));
vi.mock('../../shared/statusStore', () => ({ setTwitchChannelLive: vi.fn() }));
vi.mock('../../discord/discordBot', () => ({ getDiscordClient: vi.fn() }));
vi.mock('../../db', () => ({
  getAllStreamersWithGroups: vi.fn(),
  setStreamerLive: vi.fn().mockResolvedValue(undefined),
  clearStreamerLive: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../twitchApi', () => ({ getUsers: vi.fn(), getStreams: vi.fn() }));
vi.mock('./twitchMonitorOffline', () => ({
  cancelOfflineTimersForLogin: vi.fn(),
  // Simulates the real module's effect (sets a non-null offlineTimer marker on matching
  // entries) without scheduling a real 5-minute setTimeout that would leak past the test.
  handleStreamOffline: vi.fn(async (liveStates: Map<string, { login: string; offlineTimer: unknown }>, _loginToUserId: unknown, login: string) => {
    for (const state of liveStates.values()) {
      if (state.login === login) state.offlineTimer = {};
    }
  }),
}));
vi.mock('./twitchMonitorStartup', () => ({ performStartupLiveCheck: vi.fn().mockResolvedValue(undefined) }));

import {
  startTwitchMonitor, stopTwitchMonitor, triggerImmediateLiveCheck, getLiveStates,
  shutdownTwitchMonitor, restartTwitchMonitor, getMultiTwitchDataForChannel, isChannelLive,
} from './twitchMonitor';
import { getAllStreamersWithGroups, clearStreamerLive } from '../../db';
import { getUsers, getStreams } from '../twitchApi';
import { cancelOfflineTimersForLogin, handleStreamOffline } from './twitchMonitorOffline';
import { getDiscordClient } from '../../discord/discordBot';
import * as twitchMonitorAnnouncements from './twitchMonitorAnnouncements';

function makeTextChannel(msgOverrides: Record<string, unknown> = {}) {
  const message = { id: 'msg1', channelId: '111', delete: vi.fn().mockResolvedValue(undefined), edit: vi.fn().mockResolvedValue(undefined), ...msgOverrides };
  return {
    isTextBased: () => true,
    send: vi.fn().mockResolvedValue({ id: 'msg1', channelId: '111' }),
    messages: { fetch: vi.fn().mockResolvedValue(message) },
    _message: message,
  };
}

function makeDiscordClient(channel: ReturnType<typeof makeTextChannel> = makeTextChannel()) {
  return { channels: { fetch: vi.fn().mockResolvedValue(channel) } };
}

function makeStreamer(overrides: Record<string, unknown> = {}) {
  return {
    id: 5,
    discord_id: 'd5',
    twitch_name: 'teststreamer',
    discord_message_id: null,
    discord_channel_id: null,
    live_game: null,
    group: {
      id: 1, name: 'Main', discord_channel: '111',
      live_message: 'live', new_game_message: 'game',
      multi_twitch: false, delete_old_posts: false, guild_id: 'guild-1',
    },
    ...overrides,
  };
}

function makeStream(overrides: Record<string, unknown> = {}) {
  return {
    user_id: 'uid-5', user_login: 'teststreamer', game_name: 'Just Chatting',
    title: 'hello', thumbnail_url: 'https://example.com/thumb-{width}x{height}.jpg', type: 'live',
    ...overrides,
  };
}

// Drives stream.online/offline EventSub notifications: triggerImmediateLiveCheck() re-runs
// the same poll-and-decide logic the 60s poller uses for a single streamer, so EventSub
// can short-circuit the poll interval without duplicating any announcement/grace-period code.
describe('triggerImmediateLiveCheck', () => {
  const editAnnouncementSpy = vi.spyOn(twitchMonitorAnnouncements, 'editAnnouncement');

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(getAllStreamersWithGroups).mockResolvedValue([makeStreamer()] as any);
    vi.mocked(getUsers).mockResolvedValue([{ login: 'teststreamer', id: 'uid-5' }]);
    vi.mocked(getDiscordClient).mockReturnValue(makeDiscordClient() as any);
    await startTwitchMonitor();
  });

  afterEach(async () => {
    await stopTwitchMonitor();
  });

  it('no-ops without calling getStreams when the login is not monitored', async () => {
    await triggerImmediateLiveCheck('unknownstreamer');
    expect(getStreams).not.toHaveBeenCalled();
  });

  it('records the streamer as live on the first immediate check', async () => {
    vi.mocked(getStreams).mockResolvedValue([makeStream()] as any);

    await triggerImmediateLiveCheck('teststreamer');

    expect(getStreams).toHaveBeenCalledWith(['uid-5']);
    const states = getLiveStates('guild-1');
    expect(states).toHaveLength(1);
    expect(states[0].login).toBe('teststreamer');
    expect(states[0].currentGame).toBe('Just Chatting');
  });

  it('is case-insensitive on the login', async () => {
    vi.mocked(getStreams).mockResolvedValue([makeStream()] as any);

    await triggerImmediateLiveCheck('TestStreamer');

    expect(getLiveStates('guild-1')).toHaveLength(1);
  });

  it('starts the offline grace period when an already-live streamer is found offline', async () => {
    vi.mocked(getStreams).mockResolvedValueOnce([makeStream()] as any);
    await triggerImmediateLiveCheck('teststreamer'); // first check: goes live

    vi.mocked(getStreams).mockResolvedValueOnce([]); // second check: offline
    await triggerImmediateLiveCheck('teststreamer');

    expect(handleStreamOffline).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'teststreamer');
  });

  it('cancels the offline grace period when the streamer comes back during it', async () => {
    vi.mocked(getStreams).mockResolvedValueOnce([makeStream()] as any);
    await triggerImmediateLiveCheck('teststreamer'); // live

    vi.mocked(getStreams).mockResolvedValueOnce([]);
    await triggerImmediateLiveCheck('teststreamer'); // offline — grace period starts (mocked)

    vi.mocked(getStreams).mockResolvedValueOnce([makeStream()] as any);
    await triggerImmediateLiveCheck('teststreamer'); // back online before grace period ends

    expect(cancelOfflineTimersForLogin).toHaveBeenCalledWith(expect.anything(), 'teststreamer');
  });

  it('edits the announcement with the live_message template on a title-only change', async () => {
    vi.mocked(getStreams).mockResolvedValueOnce([makeStream()] as any);
    await triggerImmediateLiveCheck('teststreamer'); // first check: goes live

    vi.mocked(getStreams).mockResolvedValueOnce([makeStream({ title: 'New title' })] as any);
    await triggerImmediateLiveCheck('teststreamer'); // second check: title changed, game unchanged

    expect(editAnnouncementSpy).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), expect.objectContaining({ title: 'New title' }), 'live_message',
    );
    expect(getLiveStates('guild-1')[0].title).toBe('New title');
  });

  it('edits the announcement with the new_game_message template on a game change', async () => {
    vi.mocked(getStreams).mockResolvedValueOnce([makeStream()] as any);
    await triggerImmediateLiveCheck('teststreamer'); // first check: goes live

    vi.mocked(getStreams).mockResolvedValueOnce([makeStream({ game_name: 'Valorant' })] as any);
    await triggerImmediateLiveCheck('teststreamer'); // second check: game changed

    expect(editAnnouncementSpy).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), expect.objectContaining({ game_name: 'Valorant' }), 'new_game_message',
    );
  });

  it('logs and resolves without throwing when the Twitch API call fails', async () => {
    vi.mocked(getStreams).mockRejectedValueOnce(new Error('API down'));

    await expect(triggerImmediateLiveCheck('teststreamer')).resolves.toBeUndefined();

    expect(getLiveStates('guild-1')).toHaveLength(0);
  });
});

// A login can map to multiple monitored streamer rows (the same Twitch name posted
// to several Discord groups) — a failure for one must not skip the others.
describe('triggerImmediateLiveCheck with multiple streamer rows for one login', () => {
  const postAnnouncementSpy = vi.spyOn(twitchMonitorAnnouncements, 'postAnnouncement');

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(getAllStreamersWithGroups).mockResolvedValue([
      makeStreamer({ id: 5, group: { id: 1, name: 'GroupA', discord_channel: '111', live_message: 'live', new_game_message: 'game', multi_twitch: false, delete_old_posts: false, guild_id: 'guild-1' } }),
      makeStreamer({ id: 6, group: { id: 2, name: 'GroupB', discord_channel: '222', live_message: 'live', new_game_message: 'game', multi_twitch: false, delete_old_posts: false, guild_id: 'guild-1' } }),
    ] as any);
    vi.mocked(getUsers).mockResolvedValue([{ login: 'teststreamer', id: 'uid-5' }]);
    vi.mocked(getDiscordClient).mockReturnValue(makeDiscordClient() as any);
    await startTwitchMonitor();
  });

  afterEach(async () => {
    await stopTwitchMonitor();
  });

  it('still processes the second streamer row after the first one fails', async () => {
    vi.mocked(getStreams).mockResolvedValue([makeStream()] as any);
    postAnnouncementSpy.mockRejectedValueOnce(new Error('discord down'));

    await triggerImmediateLiveCheck('teststreamer');

    expect(postAnnouncementSpy).toHaveBeenCalledTimes(2);
    const states = getLiveStates('guild-1');
    expect(states.map((s) => s.streamerId)).toContain(6);
  });
});

// Drives the 60s poll interval set up by startTwitchMonitor: pollStreams() dispatches
// the full streamer list to dispatchStreamerPolls() on each tick, separately from the
// single-streamer triggerImmediateLiveCheck() path exercised above.
describe('60s poll interval', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.mocked(getAllStreamersWithGroups).mockResolvedValue([makeStreamer()] as any);
    vi.mocked(getUsers).mockResolvedValue([{ login: 'teststreamer', id: 'uid-5' }]);
    vi.mocked(getDiscordClient).mockReturnValue(makeDiscordClient() as any);
    await startTwitchMonitor();
  });

  afterEach(async () => {
    await stopTwitchMonitor();
    vi.useRealTimers();
  });

  it('polls every streamer on each tick and records newly-live streamers', async () => {
    vi.mocked(getStreams).mockResolvedValue([makeStream()] as any);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(getStreams).toHaveBeenCalledWith(['uid-5']);
    const states = getLiveStates('guild-1');
    expect(states).toHaveLength(1);
    expect(states[0].login).toBe('teststreamer');
  });

  it('logs and recovers when getStreams rejects during a poll tick', async () => {
    vi.mocked(getStreams).mockRejectedValueOnce(new Error('boom'));

    await vi.advanceTimersByTimeAsync(60_000);

    expect(logMock.error).toHaveBeenCalledWith('Poll error:', expect.any(Error));
    expect(getLiveStates('guild-1')).toHaveLength(0);

    // A subsequent tick still works — pollRunning was reset in the `finally` block.
    vi.mocked(getStreams).mockResolvedValueOnce([makeStream()] as any);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(getLiveStates('guild-1')).toHaveLength(1);
  });
});

describe('startTwitchMonitor with no configured streamers', () => {
  afterEach(async () => {
    await stopTwitchMonitor();
  });

  it('logs a warning and does not fetch users when there are no streamers in the DB', async () => {
    vi.clearAllMocks();
    vi.mocked(getAllStreamersWithGroups).mockResolvedValue([]);
    vi.mocked(getUsers).mockResolvedValue([]);

    await startTwitchMonitor();

    expect(logMock.warn).toHaveBeenCalledWith('No streamers configured in DB — nothing to monitor');
    expect(getUsers).toHaveBeenCalledWith([]);
  });
});

// Exercises shutdownTwitchMonitor, restartTwitchMonitor, getMultiTwitchDataForChannel, and the
// getLiveStates() sort comparator — none of these paths are covered by the EventSub-style
// triggerImmediateLiveCheck tests above, which never restart or tear the monitor down.
describe('shutdown, restart, multitwitch lookup, and live-state ordering', () => {
  function makeGroup(overrides: Record<string, unknown> = {}) {
    return {
      id: 1, name: 'Alpha', discord_channel: '111',
      live_message: 'live', new_game_message: 'game',
      multi_twitch: false, delete_old_posts: false, guild_id: 'guild-1',
      ...overrides,
    };
  }

  let channel: ReturnType<typeof makeTextChannel>;

  beforeEach(async () => {
    vi.clearAllMocks();
    channel = makeTextChannel();
    vi.mocked(getDiscordClient).mockReturnValue(makeDiscordClient(channel) as any);
  });

  afterEach(async () => {
    await stopTwitchMonitor();
  });

  it('shuts down cleanly, deleting every live announcement and clearing all state', async () => {
    vi.mocked(getAllStreamersWithGroups).mockResolvedValue([
      makeStreamer({ id: 5, twitch_name: 'streamera', group: makeGroup({ id: 1, name: 'Alpha' }) }),
      makeStreamer({ id: 6, twitch_name: 'streamerb', group: makeGroup({ id: 2, name: 'Beta' }) }),
    ] as any);
    vi.mocked(getUsers).mockResolvedValue([
      { login: 'streamera', id: 'uid-5' },
      { login: 'streamerb', id: 'uid-6' },
    ]);
    await startTwitchMonitor();

    vi.mocked(getStreams).mockResolvedValueOnce([makeStream({ user_id: 'uid-5', user_login: 'streamera' })] as any);
    await triggerImmediateLiveCheck('streamera');
    vi.mocked(getStreams).mockResolvedValueOnce([makeStream({ user_id: 'uid-6', user_login: 'streamerb' })] as any);
    await triggerImmediateLiveCheck('streamerb');
    expect(getLiveStates('guild-1')).toHaveLength(2);

    await shutdownTwitchMonitor();

    expect(clearStreamerLive).toHaveBeenCalledTimes(2);
    expect(getLiveStates('guild-1')).toHaveLength(0);
    expect(logMock.info).toHaveBeenCalledWith('Shutdown complete — all live messages deleted');
  });

  it('logs a warning with the failure count when some announcement deletes fail, but still clears all state', async () => {
    vi.mocked(getAllStreamersWithGroups).mockResolvedValue([
      makeStreamer({ id: 5, twitch_name: 'streamera', group: makeGroup({ id: 1, name: 'Alpha' }) }),
      makeStreamer({ id: 6, twitch_name: 'streamerb', group: makeGroup({ id: 2, name: 'Beta' }) }),
    ] as any);
    vi.mocked(getUsers).mockResolvedValue([
      { login: 'streamera', id: 'uid-5' },
      { login: 'streamerb', id: 'uid-6' },
    ]);
    await startTwitchMonitor();

    vi.mocked(getStreams).mockResolvedValueOnce([makeStream({ user_id: 'uid-5', user_login: 'streamera' })] as any);
    await triggerImmediateLiveCheck('streamera');
    vi.mocked(getStreams).mockResolvedValueOnce([makeStream({ user_id: 'uid-6', user_login: 'streamerb' })] as any);
    await triggerImmediateLiveCheck('streamerb');

    vi.mocked(clearStreamerLive).mockRejectedValueOnce(new Error('db down'));

    await shutdownTwitchMonitor();

    expect(getLiveStates('guild-1')).toHaveLength(0);
    expect(logMock.warn).toHaveBeenCalledWith('Shutdown complete with 1 failed delete(s) — some announcements may remain');
  });

  it('restarts by tearing down and re-running startup without deleting Discord messages', async () => {
    vi.mocked(getAllStreamersWithGroups).mockResolvedValue([makeStreamer()] as any);
    vi.mocked(getUsers).mockResolvedValue([{ login: 'teststreamer', id: 'uid-5' }]);
    await startTwitchMonitor();

    vi.mocked(getStreams).mockResolvedValueOnce([makeStream()] as any);
    await triggerImmediateLiveCheck('teststreamer');
    vi.mocked(channel._message.delete).mockClear();

    await restartTwitchMonitor();

    expect(logMock.info).toHaveBeenCalledWith('Restarting...');
    expect(getAllStreamersWithGroups).toHaveBeenCalledTimes(2);
    expect(channel._message.delete).not.toHaveBeenCalled();
    // Restart clears in-memory state; the startup live-check (mocked) doesn't repopulate it.
    expect(getLiveStates('guild-1')).toHaveLength(0);
  });

  it('getMultiTwitchDataForChannel returns null for a login with no live state', async () => {
    vi.mocked(getAllStreamersWithGroups).mockResolvedValue([makeStreamer()] as any);
    vi.mocked(getUsers).mockResolvedValue([{ login: 'teststreamer', id: 'uid-5' }]);
    await startTwitchMonitor();

    expect(getMultiTwitchDataForChannel('unknownstreamer')).toBeNull();
  });

  it('getMultiTwitchDataForChannel returns null when fewer than two streamers in the group are live', async () => {
    vi.mocked(getAllStreamersWithGroups).mockResolvedValue([makeStreamer()] as any);
    vi.mocked(getUsers).mockResolvedValue([{ login: 'teststreamer', id: 'uid-5' }]);
    await startTwitchMonitor();

    vi.mocked(getStreams).mockResolvedValueOnce([makeStream()] as any);
    await triggerImmediateLiveCheck('teststreamer');

    expect(getMultiTwitchDataForChannel('teststreamer')).toBeNull();
  });

  it('getMultiTwitchDataForChannel returns the multitwitch URL when two+ streamers in a multi-twitch group share a game', async () => {
    vi.mocked(getAllStreamersWithGroups).mockResolvedValue([
      makeStreamer({ id: 5, twitch_name: 'zeta', group: makeGroup({ id: 9, name: 'Beta', multi_twitch: true }) }),
      makeStreamer({ id: 6, twitch_name: 'alpha', group: makeGroup({ id: 9, name: 'Beta', multi_twitch: true }) }),
    ] as any);
    vi.mocked(getUsers).mockResolvedValue([
      { login: 'zeta', id: 'uid-5' },
      { login: 'alpha', id: 'uid-6' },
    ]);
    await startTwitchMonitor();

    vi.mocked(getStreams).mockResolvedValueOnce([makeStream({ user_id: 'uid-5', user_login: 'zeta', game_name: 'Just Chatting' })] as any);
    await triggerImmediateLiveCheck('zeta');
    vi.mocked(getStreams).mockResolvedValueOnce([makeStream({ user_id: 'uid-6', user_login: 'alpha', game_name: 'Just Chatting' })] as any);
    await triggerImmediateLiveCheck('alpha');

    const result = getMultiTwitchDataForChannel('zeta');
    expect(result).not.toBeNull();
    expect(result!.url).toBe('https://www.multitwitch.tv/alpha/zeta');
    expect(result!.participants).toEqual(['alpha', 'zeta']);
  });

  it('isChannelLive returns false for a login with no live state', async () => {
    vi.mocked(getAllStreamersWithGroups).mockResolvedValue([makeStreamer()] as any);
    vi.mocked(getUsers).mockResolvedValue([{ login: 'teststreamer', id: 'uid-5' }]);
    await startTwitchMonitor();

    expect(isChannelLive('teststreamer')).toBe(false);
  });

  it('isChannelLive returns true once the streamer is tracked as live, case-insensitively', async () => {
    vi.mocked(getAllStreamersWithGroups).mockResolvedValue([makeStreamer()] as any);
    vi.mocked(getUsers).mockResolvedValue([{ login: 'teststreamer', id: 'uid-5' }]);
    await startTwitchMonitor();

    vi.mocked(getStreams).mockResolvedValueOnce([makeStream()] as any);
    await triggerImmediateLiveCheck('teststreamer');

    expect(isChannelLive('TestStreamer')).toBe(true);
  });

  it('getLiveStates sorts by group name, then by login within a group', async () => {
    vi.mocked(getAllStreamersWithGroups).mockResolvedValue([
      makeStreamer({ id: 5, twitch_name: 'zeta', group: makeGroup({ id: 9, name: 'Beta' }) }),
      makeStreamer({ id: 6, twitch_name: 'alpha', group: makeGroup({ id: 9, name: 'Beta' }) }),
      makeStreamer({ id: 7, twitch_name: 'yankee', group: makeGroup({ id: 1, name: 'Alpha' }) }),
    ] as any);
    vi.mocked(getUsers).mockResolvedValue([
      { login: 'zeta', id: 'uid-5' },
      { login: 'alpha', id: 'uid-6' },
      { login: 'yankee', id: 'uid-7' },
    ]);
    await startTwitchMonitor();

    vi.mocked(getStreams).mockResolvedValueOnce([makeStream({ user_id: 'uid-5', user_login: 'zeta' })] as any);
    await triggerImmediateLiveCheck('zeta');
    vi.mocked(getStreams).mockResolvedValueOnce([makeStream({ user_id: 'uid-6', user_login: 'alpha' })] as any);
    await triggerImmediateLiveCheck('alpha');
    vi.mocked(getStreams).mockResolvedValueOnce([makeStream({ user_id: 'uid-7', user_login: 'yankee' })] as any);
    await triggerImmediateLiveCheck('yankee');

    const states = getLiveStates('guild-1');
    expect(states.map((s) => [s.groupName, s.login])).toEqual([
      ['Alpha', 'yankee'],
      ['Beta', 'alpha'],
      ['Beta', 'zeta'],
    ]);
  });
});
