import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../../test-utils/loggerMock';

vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));
vi.mock('../../shared/statusStore', () => ({ setTwitchChannelLive: vi.fn() }));
vi.mock('./twitchMonitorAnnouncements', () => ({
  postAnnouncement: vi.fn().mockResolvedValue(undefined),
  editAnnouncement: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./twitchMonitorOffline', () => ({
  cancelOfflineTimersForLogin: vi.fn(),
  handleStreamOffline: vi.fn().mockResolvedValue(undefined),
}));

import { handlePollStreamer, dispatchStreamerPolls, withLoginLock } from './twitchMonitorPoll';
import { postAnnouncement, editAnnouncement } from './twitchMonitorAnnouncements';
import { cancelOfflineTimersForLogin, handleStreamOffline } from './twitchMonitorOffline';
import { setTwitchChannelLive } from '../../shared/statusStore';
import type { DbStreamerFull, DbStreamGroup } from '../../db';
import type { TwitchStream } from '../twitchApi';
import type { LiveState } from './twitchMonitorTypes';

function makeGroup(overrides: Partial<DbStreamGroup> = {}): DbStreamGroup {
  return { id: 1, guild_id: 'guild-1', name: 'Main', discord_channel: 'ch1', live_message: 'live', new_game_message: 'game', multi_twitch: false, delete_old_posts: false, ...overrides };
}

function makeStreamer(overrides: Partial<DbStreamerFull> = {}): DbStreamerFull {
  return { id: 5, discord_id: 'd5', twitch_name: 'teststreamer', discord_message_id: null, discord_channel_id: null, live_game: null, group: makeGroup(), ...overrides };
}

function makeStream(overrides: Partial<TwitchStream> = {}): TwitchStream {
  return { user_id: 'uid-5', user_login: 'teststreamer', game_name: 'Just Chatting', title: 'hello', thumbnail_url: '', type: 'live', ...overrides };
}

function makeLiveState(overrides: Partial<LiveState> = {}): LiveState {
  return {
    streamerId: 5, login: 'teststreamer', groupId: 1, group: makeGroup(), currentGame: 'Just Chatting',
    title: 'hello', messageId: 'msg1', channelId: 'ch1', currentStream: makeStream(), offlineTimer: null,
    ...overrides,
  } as LiveState;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── handlePollStreamer ───────────────────────────────────────────────────────

describe('handlePollStreamer', () => {
  it('does nothing when the streamer has no twitch_name', async () => {
    const liveStates = new Map<string, LiveState>();
    await handlePollStreamer(liveStates, new Map(), makeStreamer({ twitch_name: null }), new Map());
    expect(postAnnouncement).not.toHaveBeenCalled();
  });

  it('does nothing when the login has no resolved user ID', async () => {
    const liveStates = new Map<string, LiveState>();
    await handlePollStreamer(liveStates, new Map(), makeStreamer(), new Map());
    expect(postAnnouncement).not.toHaveBeenCalled();
  });

  it('posts a new announcement and marks the channel live when a new streamer goes live', async () => {
    const liveStates = new Map<string, LiveState>();
    const loginToUserId = new Map([['teststreamer', 'uid-5']]);
    const liveByUserId = new Map([['uid-5', makeStream()]]);

    await handlePollStreamer(liveStates, loginToUserId, makeStreamer(), liveByUserId);

    expect(setTwitchChannelLive).toHaveBeenCalledWith('teststreamer', true);
    expect(postAnnouncement).toHaveBeenCalledWith(liveStates, expect.objectContaining({ id: 5 }), expect.objectContaining({ user_id: 'uid-5' }));
  });

  it('cancels offline timers when a streamer with a running grace period comes back live', async () => {
    const liveStates = new Map<string, LiveState>([['5', makeLiveState({ offlineTimer: {} as any })]]);
    const loginToUserId = new Map([['teststreamer', 'uid-5']]);
    const liveByUserId = new Map([['uid-5', makeStream()]]);

    await handlePollStreamer(liveStates, loginToUserId, makeStreamer(), liveByUserId);

    expect(cancelOfflineTimersForLogin).toHaveBeenCalledWith(liveStates, 'teststreamer');
  });

  it('edits with new_game_message when the game changes', async () => {
    const liveStates = new Map<string, LiveState>([['5', makeLiveState({ messageId: 'msg1' })]]);
    const loginToUserId = new Map([['teststreamer', 'uid-5']]);
    const liveByUserId = new Map([['uid-5', makeStream({ game_name: 'Valorant' })]]);

    await handlePollStreamer(liveStates, loginToUserId, makeStreamer(), liveByUserId);

    expect(editAnnouncement).toHaveBeenCalledWith(liveStates, expect.anything(), expect.objectContaining({ game_name: 'Valorant' }), 'new_game_message');
  });

  it('edits with live_message when only the title changes', async () => {
    const liveStates = new Map<string, LiveState>([['5', makeLiveState({ messageId: 'msg1' })]]);
    const loginToUserId = new Map([['teststreamer', 'uid-5']]);
    const liveByUserId = new Map([['uid-5', makeStream({ title: 'New title' })]]);

    await handlePollStreamer(liveStates, loginToUserId, makeStreamer(), liveByUserId);

    expect(editAnnouncement).toHaveBeenCalledWith(liveStates, expect.anything(), expect.objectContaining({ title: 'New title' }), 'live_message');
  });

  it('syncs currentStream without posting or editing when nothing changed', async () => {
    const liveState = makeLiveState({ messageId: 'msg1' });
    const liveStates = new Map<string, LiveState>([['5', liveState]]);
    const loginToUserId = new Map([['teststreamer', 'uid-5']]);
    const newStream = makeStream();
    const liveByUserId = new Map([['uid-5', newStream]]);

    await handlePollStreamer(liveStates, loginToUserId, makeStreamer(), liveByUserId);

    expect(postAnnouncement).not.toHaveBeenCalled();
    expect(editAnnouncement).not.toHaveBeenCalled();
    expect(liveState.currentStream).toBe(newStream);
  });

  it('starts the offline grace period when a previously-live streamer is now offline', async () => {
    const liveStates = new Map<string, LiveState>([['5', makeLiveState()]]);
    const loginToUserId = new Map([['teststreamer', 'uid-5']]);

    await handlePollStreamer(liveStates, loginToUserId, makeStreamer(), new Map());

    expect(handleStreamOffline).toHaveBeenCalledWith(liveStates, loginToUserId, 'teststreamer');
  });

  it('does not restart the offline grace period when one is already running', async () => {
    const liveStates = new Map<string, LiveState>([['5', makeLiveState({ offlineTimer: {} as any })]]);
    const loginToUserId = new Map([['teststreamer', 'uid-5']]);

    await handlePollStreamer(liveStates, loginToUserId, makeStreamer(), new Map());

    expect(handleStreamOffline).not.toHaveBeenCalled();
  });
});

// ─── dispatchStreamerPolls ────────────────────────────────────────────────────

describe('dispatchStreamerPolls', () => {
  it('dispatches each streamer and continues past a single failure', async () => {
    vi.mocked(postAnnouncement).mockRejectedValueOnce(new Error('discord down')).mockResolvedValue(undefined);

    const liveStates = new Map<string, LiveState>();
    const loginToUserId = new Map([['streamera', 'uid-a'], ['streamerb', 'uid-b']]);
    const streamers = [
      makeStreamer({ id: 1, twitch_name: 'streamerA' }),
      makeStreamer({ id: 2, twitch_name: 'streamerB' }),
    ];
    const liveByUserId = new Map([
      ['uid-a', makeStream({ user_id: 'uid-a', user_login: 'streamera' })],
      ['uid-b', makeStream({ user_id: 'uid-b', user_login: 'streamerb' })],
    ]);

    await dispatchStreamerPolls(liveStates, loginToUserId, streamers, liveByUserId);

    expect(postAnnouncement).toHaveBeenCalledTimes(2);
  });

  it('skips streamers with no twitch_name', async () => {
    const liveStates = new Map<string, LiveState>();
    const loginToUserId = new Map<string, string>();
    await dispatchStreamerPolls(liveStates, loginToUserId, [makeStreamer({ twitch_name: null })], new Map());
    expect(postAnnouncement).not.toHaveBeenCalled();
  });
});

// ─── withLoginLock ────────────────────────────────────────────────────────────
// Guards against the poll loop and triggerImmediateLiveCheck racing on the same
// login's liveStates entry (CodeRabbit review finding on PR #303).

describe('withLoginLock', () => {
  it('serializes operations queued for the same login', async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const first = withLoginLock('alice', () => new Promise<void>((resolve) => {
      releaseFirst = () => { order.push('first'); resolve(); };
    }));
    const second = withLoginLock('alice', async () => { order.push('second'); });

    await Promise.resolve(); // let microtasks settle without releasing the first op
    expect(order).toEqual([]);

    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['first', 'second']);
  });

  it('does not block operations queued for a different login', async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const first = withLoginLock('alice', () => new Promise<void>((resolve) => {
      releaseFirst = resolve;
    }));
    const second = withLoginLock('bob', async () => { order.push('bob'); });

    await second;
    expect(order).toEqual(['bob']);

    releaseFirst();
    await first;
  });

  it('still processes the next queued operation after a failure', async () => {
    await expect(withLoginLock('alice', async () => { throw new Error('boom'); })).rejects.toThrow('boom');

    const order: string[] = [];
    await withLoginLock('alice', async () => { order.push('after-failure'); });
    expect(order).toEqual(['after-failure']);
  });

  it('resolves with the wrapped function\'s return value', async () => {
    const result = await withLoginLock('alice', async () => 42);
    expect(result).toBe(42);
  });
});
