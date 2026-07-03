import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../shared/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
vi.mock('../../db', () => ({
  getAllEventSubStreamers: vi.fn(),
  clearStreamerToken: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../twitchApi', () => ({ getUsers: vi.fn() }));
vi.mock('../twitchChannelMembership', () => ({ getActiveChannels: vi.fn().mockReturnValue(new Set<string>()) }));
vi.mock('../twitchChannelName', () => ({ normalizeTwitchChannelName: vi.fn((n: string) => n.toLowerCase()) }));
vi.mock('./twitchApiEventSub', () => ({
  createEventSubSubscription: vi.fn().mockResolvedValue('sub-id-1'),
  listEventSubSubscriptions: vi.fn().mockResolvedValue([]),
  deleteEventSubSubscription: vi.fn().mockResolvedValue(undefined),
  getValidToken: vi.fn().mockResolvedValue('token-abc'),
  TwitchAuthError: class TwitchAuthError extends Error {},
}));
vi.mock('./twitchEventSubHandler', () => ({
  handleFollow: vi.fn(),
  handleSub: vi.fn(),
  handleResub: vi.fn(),
  handleGiftSub: vi.fn(),
  handleRaid: vi.fn(),
  handleRedemption: vi.fn(),
  handleStreamOnline: vi.fn().mockResolvedValue(undefined),
  handleStreamOffline: vi.fn().mockResolvedValue(undefined),
  handleChannelUpdate: vi.fn().mockResolvedValue(undefined),
}));

import {
  hasAuthFailedSubs,
  clearAuthFailedSubs,
  loadStreamersForEventSub,
  subscribeForStreamer,
  dispatchNotification,
} from './twitchEventSubSubscriptions';
import { getAllEventSubStreamers } from '../../db';
import { getValidToken, createEventSubSubscription, listEventSubSubscriptions, deleteEventSubSubscription, TwitchAuthError } from './twitchApiEventSub';
import { getUsers } from '../twitchApi';
import { getActiveChannels } from '../twitchChannelMembership';
import { handleStreamOnline, handleStreamOffline, handleChannelUpdate } from './twitchEventSubHandler';

// ---------------------------------------------------------------------------
// hasAuthFailedSubs / clearAuthFailedSubs
// ---------------------------------------------------------------------------
describe('hasAuthFailedSubs / clearAuthFailedSubs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Clear any auth failures left from previous tests by clearing known logins
    clearAuthFailedSubs('streamerA');
    clearAuthFailedSubs('streamerB');
  });

  it('returns false when no auth failures have been recorded', () => {
    expect(hasAuthFailedSubs('streamerA')).toBe(false);
  });

  it('returns true after a subscription fails with TwitchAuthError', async () => {
    vi.mocked(getActiveChannels).mockReturnValue(new Set(['streamera']));
    vi.mocked(createEventSubSubscription).mockRejectedValueOnce(new TwitchAuthError('403'));

    // subscribeForStreamer will invoke subscribe internally
    await subscribeForStreamer('sess-1', {
      uid: 'uid-A',
      token: 'token',
      name: 'streamerA',
      config: { follow_enabled: true, sub_enabled: false, raid_enabled: false } as any,
      streamerId: 1,
    });

    expect(hasAuthFailedSubs('streamerA')).toBe(true);
  });

  it('clearAuthFailedSubs removes entries for the given login and leaves others intact', async () => {
    // Seed auth failures for both streamers. Each config (follow_enabled + non-null config)
    // triggers 2 subscribe calls (follow + channel_points), so mock 4 rejections total.
    vi.mocked(getActiveChannels).mockReturnValue(new Set(['streamera', 'streamerb']));
    vi.mocked(createEventSubSubscription)
      .mockRejectedValue(new TwitchAuthError('403'));

    await subscribeForStreamer('sess-2', {
      uid: 'uid-A2',
      token: 'tokenA',
      name: 'streamerA',
      config: { follow_enabled: true, sub_enabled: false, raid_enabled: false } as any,
      streamerId: 2,
    });
    await subscribeForStreamer('sess-2', {
      uid: 'uid-B2',
      token: 'tokenB',
      name: 'streamerB',
      config: { follow_enabled: true, sub_enabled: false, raid_enabled: false } as any,
      streamerId: 3,
    });

    expect(hasAuthFailedSubs('streamerA')).toBe(true);
    expect(hasAuthFailedSubs('streamerB')).toBe(true);

    clearAuthFailedSubs('streamerA');

    expect(hasAuthFailedSubs('streamerA')).toBe(false);
    expect(hasAuthFailedSubs('streamerB')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// loadStreamersForEventSub
// ---------------------------------------------------------------------------
describe('loadStreamersForEventSub', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the correct shape for streamers with a stored twitch_user_id', async () => {
    const fakeStreamer = {
      id: 10,
      twitch_name: 'someStreamer',
      twitch_user_id: 'uid-10',
      config: { follow_enabled: true },
    };
    vi.mocked(getAllEventSubStreamers).mockResolvedValue([fakeStreamer] as any);
    vi.mocked(getValidToken).mockResolvedValue('tok-10');

    const result = await loadStreamersForEventSub();

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      uid: 'uid-10',
      token: 'tok-10',
      name: 'someStreamer',
      streamerId: 10,
    });
  });

  it('skips streamers where UID cannot be resolved', async () => {
    const fakeStreamer = {
      id: 11,
      twitch_name: 'noUidStreamer',
      twitch_user_id: null,
      config: null, // raid_enabled is falsy so resolveBroadcasterId returns null
    };
    vi.mocked(getAllEventSubStreamers).mockResolvedValue([fakeStreamer] as any);
    vi.mocked(getValidToken).mockResolvedValue(null);

    const result = await loadStreamersForEventSub();
    expect(result).toHaveLength(0);
  });

  it('falls back to Helix getUsers for raid-only streamers without stored UID', async () => {
    const fakeStreamer = {
      id: 12,
      twitch_name: 'raidOnly',
      twitch_user_id: null,
      config: { raid_enabled: true },
    };
    vi.mocked(getAllEventSubStreamers).mockResolvedValue([fakeStreamer] as any);
    vi.mocked(getValidToken).mockResolvedValue('tok-12');
    vi.mocked(getUsers).mockResolvedValue([{ login: 'raidonly', id: 'uid-raid' }] as any);

    const result = await loadStreamersForEventSub();

    expect(getUsers).toHaveBeenCalledWith(['raidOnly']);
    expect(result).toHaveLength(1);
    expect(result[0].uid).toBe('uid-raid');
  });

  it('falls back to Helix getUsers for shoutout-only streamers (raid_enabled off, raid_shoutout_enabled on) without stored UID', async () => {
    const fakeStreamer = {
      id: 13,
      twitch_name: 'shoutoutOnly',
      twitch_user_id: null,
      config: { raid_enabled: false, raid_shoutout_enabled: true },
    };
    vi.mocked(getAllEventSubStreamers).mockResolvedValue([fakeStreamer] as any);
    vi.mocked(getValidToken).mockResolvedValue('tok-13');
    vi.mocked(getUsers).mockResolvedValue([{ login: 'shoutoutonly', id: 'uid-shoutout' }] as any);

    const result = await loadStreamersForEventSub();

    expect(getUsers).toHaveBeenCalledWith(['shoutoutOnly']);
    expect(result).toHaveLength(1);
    expect(result[0].uid).toBe('uid-shoutout');
  });
});

// ---------------------------------------------------------------------------
// subscribeForStreamer
// ---------------------------------------------------------------------------
describe('subscribeForStreamer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearAuthFailedSubs('botInChannel');
    clearAuthFailedSubs('notInChannel');
  });

  it('returns 0 and skips subscriptions when bot is not in the channel', async () => {
    vi.mocked(getActiveChannels).mockReturnValue(new Set()); // bot not in any channel

    const count = await subscribeForStreamer('sess-x', {
      uid: 'uid-x',
      token: 'tok',
      name: 'notInChannel',
      config: { follow_enabled: true, sub_enabled: true, raid_enabled: true } as any,
      streamerId: 99,
    });

    expect(count).toBe(0);
    expect(createEventSubSubscription).not.toHaveBeenCalled();
  });

  it('calls createEventSubSubscription for enabled subscription types', async () => {
    vi.mocked(getActiveChannels).mockReturnValue(new Set(['botinchannel']));
    vi.mocked(createEventSubSubscription).mockResolvedValue('sub-new');
    vi.mocked(listEventSubSubscriptions).mockResolvedValue([]);

    const count = await subscribeForStreamer('sess-y', {
      uid: 'uid-y',
      token: 'tok-y',
      name: 'botInChannel',
      config: { follow_enabled: true, sub_enabled: false, raid_enabled: false } as any,
      streamerId: 20,
    });

    expect(createEventSubSubscription).toHaveBeenCalled();
    expect(count).toBeGreaterThan(0);
  });

  it('calls deleteEventSubSubscription for stale subscriptions', async () => {
    vi.mocked(getActiveChannels).mockReturnValue(new Set(['botinchannel']));
    vi.mocked(createEventSubSubscription).mockResolvedValue('sub-new');
    vi.mocked(listEventSubSubscriptions).mockResolvedValue([
      { id: 'stale-sub', type: 'channel.subscribe' }, // not in desired set
    ] as any);

    await subscribeForStreamer('sess-z', {
      uid: 'uid-z',
      token: 'tok-z',
      name: 'botInChannel',
      config: { follow_enabled: true, sub_enabled: false, raid_enabled: false } as any,
      streamerId: 21,
    });

    expect(deleteEventSubSubscription).toHaveBeenCalledWith('stale-sub', 'tok-z');
  });

  it('subscribes to stream.online and stream.offline whenever config and token are present', async () => {
    vi.mocked(getActiveChannels).mockReturnValue(new Set(['botinchannel']));
    vi.mocked(createEventSubSubscription).mockResolvedValue('sub-new');
    vi.mocked(listEventSubSubscriptions).mockResolvedValue([]);

    await subscribeForStreamer('sess-live', {
      uid: 'uid-live',
      token: 'tok-live',
      name: 'botInChannel',
      // No chat-alert features enabled — stream.online/offline should still subscribe.
      config: { follow_enabled: false, sub_enabled: false, raid_enabled: false } as any,
      streamerId: 22,
    });

    expect(createEventSubSubscription).toHaveBeenCalledWith(
      'stream.online', '1', { broadcaster_user_id: 'uid-live' }, 'sess-live', 'tok-live',
    );
    expect(createEventSubSubscription).toHaveBeenCalledWith(
      'stream.offline', '1', { broadcaster_user_id: 'uid-live' }, 'sess-live', 'tok-live',
    );
    expect(createEventSubSubscription).toHaveBeenCalledWith(
      'channel.update', '2', { broadcaster_user_id: 'uid-live' }, 'sess-live', 'tok-live',
    );
  });

  it('does not subscribe to stream.online/offline/channel.update when config is null', async () => {
    vi.mocked(getActiveChannels).mockReturnValue(new Set(['botinchannel']));
    vi.mocked(createEventSubSubscription).mockResolvedValue('sub-new');
    vi.mocked(listEventSubSubscriptions).mockResolvedValue([]);

    await subscribeForStreamer('sess-nocfg', {
      uid: 'uid-nocfg',
      token: 'tok-nocfg',
      name: 'botInChannel',
      config: null,
      streamerId: 23,
    });

    expect(createEventSubSubscription).not.toHaveBeenCalledWith(
      'stream.online', expect.anything(), expect.anything(), expect.anything(), expect.anything(),
    );
    expect(createEventSubSubscription).not.toHaveBeenCalledWith(
      'stream.offline', expect.anything(), expect.anything(), expect.anything(), expect.anything(),
    );
    expect(createEventSubSubscription).not.toHaveBeenCalledWith(
      'channel.update', expect.anything(), expect.anything(), expect.anything(), expect.anything(),
    );
  });

  it('subscribes to channel.raid when only raid_shoutout_enabled is set (raid_enabled off)', async () => {
    vi.mocked(getActiveChannels).mockReturnValue(new Set(['botinchannel']));
    vi.mocked(createEventSubSubscription).mockResolvedValue('sub-new');
    vi.mocked(listEventSubSubscriptions).mockResolvedValue([]);

    await subscribeForStreamer('sess-shoutout', {
      uid: 'uid-shoutout',
      token: 'tok-shoutout',
      name: 'botInChannel',
      config: { follow_enabled: false, sub_enabled: false, raid_enabled: false, raid_shoutout_enabled: true } as any,
      streamerId: 24,
    });

    expect(createEventSubSubscription).toHaveBeenCalledWith(
      'channel.raid', '1', { to_broadcaster_user_id: 'uid-shoutout' }, 'sess-shoutout', 'tok-shoutout',
    );
  });

  it('does not subscribe to channel.raid when both raid_enabled and raid_shoutout_enabled are false', async () => {
    vi.mocked(getActiveChannels).mockReturnValue(new Set(['botinchannel']));
    vi.mocked(createEventSubSubscription).mockResolvedValue('sub-new');
    vi.mocked(listEventSubSubscriptions).mockResolvedValue([]);

    await subscribeForStreamer('sess-noraid', {
      uid: 'uid-noraid',
      token: 'tok-noraid',
      name: 'botInChannel',
      config: { follow_enabled: true, sub_enabled: false, raid_enabled: false, raid_shoutout_enabled: false } as any,
      streamerId: 25,
    });

    expect(createEventSubSubscription).not.toHaveBeenCalledWith(
      'channel.raid', expect.anything(), expect.anything(), expect.anything(), expect.anything(),
    );
  });
});

// ---------------------------------------------------------------------------
// dispatchNotification — stream.online / stream.offline routing
// ---------------------------------------------------------------------------
describe('dispatchNotification routes stream.online/offline', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    clearAuthFailedSubs('liveStreamer');
    vi.mocked(getActiveChannels).mockReturnValue(new Set(['livestreamer']));
    vi.mocked(createEventSubSubscription).mockResolvedValue('sub-id');
    vi.mocked(listEventSubSubscriptions).mockResolvedValue([]);
    // Populate streamerMap with a known config so dispatchNotification doesn't early-exit.
    await subscribeForStreamer('sess-dispatch', {
      uid: 'uid-dispatch',
      token: 'tok-dispatch',
      name: 'liveStreamer',
      config: { follow_enabled: false, sub_enabled: false, raid_enabled: false } as any,
      streamerId: 30,
    });
  });

  it('calls handleStreamOnline for a stream.online notification', () => {
    dispatchNotification('stream.online', {}, { broadcaster_user_id: 'uid-dispatch' });
    expect(handleStreamOnline).toHaveBeenCalledWith('liveStreamer');
  });

  it('calls handleStreamOffline for a stream.offline notification', () => {
    dispatchNotification('stream.offline', {}, { broadcaster_user_id: 'uid-dispatch' });
    expect(handleStreamOffline).toHaveBeenCalledWith('liveStreamer');
  });

  it('calls handleChannelUpdate for a channel.update notification', () => {
    dispatchNotification('channel.update', {}, { broadcaster_user_id: 'uid-dispatch' });
    expect(handleChannelUpdate).toHaveBeenCalledWith('liveStreamer');
  });
});
