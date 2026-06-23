import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../shared/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
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

import { startTwitchMonitor, stopTwitchMonitor, triggerImmediateLiveCheck, getLiveStates } from './twitchMonitor';
import { getAllStreamersWithGroups } from '../../db';
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
      multi_twitch: false, delete_old_posts: false,
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
    const states = getLiveStates();
    expect(states).toHaveLength(1);
    expect(states[0].login).toBe('teststreamer');
    expect(states[0].currentGame).toBe('Just Chatting');
  });

  it('is case-insensitive on the login', async () => {
    vi.mocked(getStreams).mockResolvedValue([makeStream()] as any);

    await triggerImmediateLiveCheck('TestStreamer');

    expect(getLiveStates()).toHaveLength(1);
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
    expect(getLiveStates()[0].title).toBe('New title');
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

    expect(getLiveStates()).toHaveLength(0);
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
    const states = getLiveStates();
    expect(states).toHaveLength(1);
    expect(states[0].login).toBe('teststreamer');
  });
});
