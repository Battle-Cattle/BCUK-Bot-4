import { describe, it, expect, vi, beforeEach } from 'vitest';

const { logMock } = vi.hoisted(() => ({
  logMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../shared/logger', () => ({ createLogger: () => logMock }));
vi.mock('../../db', () => ({
  getAllEventSubStreamers: vi.fn(),
  clearStreamerToken: vi.fn().mockResolvedValue(undefined),
  getAlertConfigsForStreamer: vi.fn().mockResolvedValue([]),
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
  handleFollow: vi.fn().mockResolvedValue(undefined),
  handleSub: vi.fn().mockResolvedValue(undefined),
  handleResub: vi.fn().mockResolvedValue(undefined),
  handleGiftSub: vi.fn().mockResolvedValue(undefined),
  handleRaid: vi.fn().mockResolvedValue(undefined),
  handleRedemption: vi.fn().mockResolvedValue(undefined),
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
  removeStreamerFromMap,
  handleRevocation,
} from './twitchEventSubSubscriptions';
import { getAllEventSubStreamers, clearStreamerToken, getAlertConfigsForStreamer } from '../../db';
import { getValidToken, createEventSubSubscription, listEventSubSubscriptions, deleteEventSubSubscription, TwitchAuthError } from './twitchApiEventSub';
import { getUsers } from '../twitchApi';
import { getActiveChannels } from '../twitchChannelMembership';
import {
  handleStreamOnline, handleStreamOffline, handleChannelUpdate,
  handleFollow, handleSub, handleResub, handleGiftSub, handleRaid, handleRedemption,
} from './twitchEventSubHandler';

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

  it('builds enabledAlerts from the streamer\'s enabled alert_config rows', async () => {
    const fakeStreamer = {
      id: 14,
      twitch_name: 'alertOnly',
      twitch_user_id: 'uid-14',
      config: { follow_enabled: true },
    };
    vi.mocked(getAllEventSubStreamers).mockResolvedValue([fakeStreamer] as any);
    vi.mocked(getValidToken).mockResolvedValue('tok-14');
    vi.mocked(getAlertConfigsForStreamer).mockResolvedValue([
      { event_type: 'follow', enabled: false },
      { event_type: 'raid', enabled: true },
      { event_type: 'giftsub', enabled: true },
    ] as any);

    const result = await loadStreamersForEventSub();

    expect(getAlertConfigsForStreamer).toHaveBeenCalledWith(14);
    expect(result[0].enabledAlerts).toEqual(new Set(['raid', 'giftsub']));
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

  // Subscription-gating fix: a streamer who wants a browser-source alert but no chat message
  // for the same event type must still get the underlying EventSub subscription created —
  // otherwise the alert could never fire, since dispatchNotification only routes notifications
  // for subscriptions that actually exist.
  it('subscribes to channel.follow when only the follow alert is enabled (chat message off)', async () => {
    vi.mocked(getActiveChannels).mockReturnValue(new Set(['botinchannel']));
    vi.mocked(createEventSubSubscription).mockResolvedValue('sub-new');
    vi.mocked(listEventSubSubscriptions).mockResolvedValue([]);

    await subscribeForStreamer('sess-alert-follow', {
      uid: 'uid-alert-follow',
      token: 'tok-alert-follow',
      name: 'botInChannel',
      config: { follow_enabled: false, sub_enabled: false, raid_enabled: false } as any,
      streamerId: 26,
      enabledAlerts: new Set(['follow']),
    });

    expect(createEventSubSubscription).toHaveBeenCalledWith(
      'channel.follow', '2', { broadcaster_user_id: 'uid-alert-follow', moderator_user_id: 'uid-alert-follow' }, 'sess-alert-follow', 'tok-alert-follow',
    );
  });

  it('subscribes to the sub/resub/giftsub group when only a gift-sub alert is enabled (chat message off)', async () => {
    vi.mocked(getActiveChannels).mockReturnValue(new Set(['botinchannel']));
    vi.mocked(createEventSubSubscription).mockResolvedValue('sub-new');
    vi.mocked(listEventSubSubscriptions).mockResolvedValue([]);

    await subscribeForStreamer('sess-alert-giftsub', {
      uid: 'uid-alert-giftsub',
      token: 'tok-alert-giftsub',
      name: 'botInChannel',
      config: { follow_enabled: false, sub_enabled: false, raid_enabled: false } as any,
      streamerId: 27,
      enabledAlerts: new Set(['giftsub']),
    });

    expect(createEventSubSubscription).toHaveBeenCalledWith(
      'channel.subscription.gift', '1', { broadcaster_user_id: 'uid-alert-giftsub' }, 'sess-alert-giftsub', 'tok-alert-giftsub',
    );
  });

  it('subscribes to channel.raid when only the raid alert is enabled (both chat flags off)', async () => {
    vi.mocked(getActiveChannels).mockReturnValue(new Set(['botinchannel']));
    vi.mocked(createEventSubSubscription).mockResolvedValue('sub-new');
    vi.mocked(listEventSubSubscriptions).mockResolvedValue([]);

    await subscribeForStreamer('sess-alert-raid', {
      uid: 'uid-alert-raid',
      token: 'tok-alert-raid',
      name: 'botInChannel',
      config: { follow_enabled: false, sub_enabled: false, raid_enabled: false, raid_shoutout_enabled: false } as any,
      streamerId: 28,
      enabledAlerts: new Set(['raid']),
    });

    expect(createEventSubSubscription).toHaveBeenCalledWith(
      'channel.raid', '1', { to_broadcaster_user_id: 'uid-alert-raid' }, 'sess-alert-raid', 'tok-alert-raid',
    );
  });

  it('does not subscribe to channel.follow when neither the chat message nor the alert is enabled', async () => {
    vi.mocked(getActiveChannels).mockReturnValue(new Set(['botinchannel']));
    vi.mocked(createEventSubSubscription).mockResolvedValue('sub-new');
    vi.mocked(listEventSubSubscriptions).mockResolvedValue([]);

    await subscribeForStreamer('sess-noalert', {
      uid: 'uid-noalert',
      token: 'tok-noalert',
      name: 'botInChannel',
      config: { follow_enabled: false, sub_enabled: false, raid_enabled: false } as any,
      streamerId: 29,
      enabledAlerts: new Set(),
    });

    expect(createEventSubSubscription).not.toHaveBeenCalledWith(
      'channel.follow', expect.anything(), expect.anything(), expect.anything(), expect.anything(),
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

// ---------------------------------------------------------------------------
// subscribeForStreamer — sub_enabled subscription creation
// ---------------------------------------------------------------------------
describe('subscribeForStreamer with sub_enabled', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearAuthFailedSubs('subStreamer');
    vi.mocked(getActiveChannels).mockReturnValue(new Set(['substreamer']));
    vi.mocked(createEventSubSubscription).mockResolvedValue('sub-id');
    vi.mocked(listEventSubSubscriptions).mockResolvedValue([]);
  });

  it('subscribes to channel.subscribe, subscription.message, and subscription.gift', async () => {
    const count = await subscribeForStreamer('sess-sub', {
      uid: 'uid-sub',
      token: 'tok-sub',
      name: 'subStreamer',
      config: { follow_enabled: false, sub_enabled: true, raid_enabled: false } as any,
      streamerId: 40,
    });

    expect(createEventSubSubscription).toHaveBeenCalledWith(
      'channel.subscribe', '1', { broadcaster_user_id: 'uid-sub' }, 'sess-sub', 'tok-sub',
    );
    expect(createEventSubSubscription).toHaveBeenCalledWith(
      'channel.subscription.message', '1', { broadcaster_user_id: 'uid-sub' }, 'sess-sub', 'tok-sub',
    );
    expect(createEventSubSubscription).toHaveBeenCalledWith(
      'channel.subscription.gift', '1', { broadcaster_user_id: 'uid-sub' }, 'sess-sub', 'tok-sub',
    );
    expect(count).toBeGreaterThanOrEqual(3);
  });

  it('does not subscribe to any sub events when sub_enabled is false', async () => {
    await subscribeForStreamer('sess-nosub', {
      uid: 'uid-nosub',
      token: 'tok-nosub',
      name: 'subStreamer',
      config: { follow_enabled: false, sub_enabled: false, raid_enabled: false } as any,
      streamerId: 41,
    });

    expect(createEventSubSubscription).not.toHaveBeenCalledWith(
      'channel.subscribe', expect.anything(), expect.anything(), expect.anything(), expect.anything(),
    );
  });
});

// ---------------------------------------------------------------------------
// dispatchNotification — remaining notification types
// ---------------------------------------------------------------------------
describe('dispatchNotification routes chat-alert and redemption events', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    clearAuthFailedSubs('alertStreamer');
    vi.mocked(getActiveChannels).mockReturnValue(new Set(['alertstreamer']));
    vi.mocked(createEventSubSubscription).mockResolvedValue('sub-id');
    vi.mocked(listEventSubSubscriptions).mockResolvedValue([]);
    await subscribeForStreamer('sess-alert', {
      uid: 'uid-alert',
      token: 'tok-alert',
      name: 'alertStreamer',
      config: { follow_enabled: true, sub_enabled: true, raid_enabled: true } as any,
      streamerId: 50,
    });
  });

  it('routes channel.follow to handleFollow', () => {
    dispatchNotification('channel.follow', { user_name: 'follower' }, { broadcaster_user_id: 'uid-alert' });
    expect(handleFollow).toHaveBeenCalledWith('alertStreamer', { user_name: 'follower' }, expect.anything(), 50);
  });

  it('routes channel.subscribe to handleSub', () => {
    dispatchNotification('channel.subscribe', { tier: '1000' }, { broadcaster_user_id: 'uid-alert' });
    expect(handleSub).toHaveBeenCalledWith('alertStreamer', { tier: '1000' }, expect.anything(), 50);
  });

  it('routes channel.subscription.message to handleResub', () => {
    dispatchNotification('channel.subscription.message', { cumulative_months: 5 }, { broadcaster_user_id: 'uid-alert' });
    expect(handleResub).toHaveBeenCalledWith('alertStreamer', { cumulative_months: 5 }, expect.anything(), 50);
  });

  it('routes channel.subscription.gift to handleGiftSub', () => {
    dispatchNotification('channel.subscription.gift', { total: 3 }, { broadcaster_user_id: 'uid-alert' });
    expect(handleGiftSub).toHaveBeenCalledWith('alertStreamer', { total: 3 }, expect.anything(), 50);
  });

  it('routes channel.raid to handleRaid using to_broadcaster_user_id', () => {
    dispatchNotification('channel.raid', { from_broadcaster_user_name: 'raider' }, { to_broadcaster_user_id: 'uid-alert' });
    expect(handleRaid).toHaveBeenCalledWith('alertStreamer', { from_broadcaster_user_name: 'raider' }, expect.anything(), 50);
  });

  it('routes a channel-points redemption to handleRedemption with the streamerId', () => {
    dispatchNotification(
      'channel.channel_points_custom_reward_redemption.add',
      { reward: { id: 'r1' } },
      { broadcaster_user_id: 'uid-alert' },
    );
    expect(handleRedemption).toHaveBeenCalledWith('alertStreamer', { reward: { id: 'r1' } }, expect.anything(), 50);
  });

  it('logs a warning and does nothing for an unsupported notification type', () => {
    dispatchNotification('channel.cheer', {}, { broadcaster_user_id: 'uid-alert' });
    expect(logMock.warn).toHaveBeenCalledWith('Unsupported EventSub notification type: channel.cheer');
    expect(handleFollow).not.toHaveBeenCalled();
  });

  it('logs an error when the routed handler rejects', async () => {
    vi.mocked(handleFollow).mockRejectedValueOnce(new Error('handler exploded'));

    dispatchNotification('channel.follow', {}, { broadcaster_user_id: 'uid-alert' });
    await new Promise((resolve) => setImmediate(resolve));

    expect(logMock.error).toHaveBeenCalledWith('channel.follow handler error:', expect.any(Error));
  });
});

// ---------------------------------------------------------------------------
// removeStreamerFromMap
// ---------------------------------------------------------------------------
describe('removeStreamerFromMap', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    clearAuthFailedSubs('removable');
    vi.mocked(getActiveChannels).mockReturnValue(new Set(['removable']));
    vi.mocked(createEventSubSubscription).mockResolvedValue('sub-id');
    vi.mocked(listEventSubSubscriptions).mockResolvedValue([]);
    await subscribeForStreamer('sess-rm', {
      uid: 'uid-rm',
      token: 'tok-rm',
      name: 'removable',
      config: { follow_enabled: false, sub_enabled: false, raid_enabled: false } as any,
      streamerId: 60,
    });
  });

  it('removes the streamer so dispatchNotification no longer routes to it', () => {
    removeStreamerFromMap('uid-rm');

    dispatchNotification('stream.online', {}, { broadcaster_user_id: 'uid-rm' });

    expect(handleStreamOnline).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Error paths: deleteStaleSubscriptions, resolveBroadcasterId, subscribe()
// ---------------------------------------------------------------------------
describe('error handling in subscription setup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearAuthFailedSubs('errStreamer');
    vi.mocked(getActiveChannels).mockReturnValue(new Set(['errstreamer']));
  });

  it('logs and continues when listing existing subscriptions fails during cleanup', async () => {
    vi.mocked(createEventSubSubscription).mockResolvedValue('sub-id');
    vi.mocked(listEventSubSubscriptions).mockRejectedValueOnce(new Error('list failed'));

    const count = await subscribeForStreamer('sess-err', {
      uid: 'uid-err',
      token: 'tok-err',
      name: 'errStreamer',
      config: { follow_enabled: true, sub_enabled: false, raid_enabled: false } as any,
      streamerId: 70,
    });

    expect(logMock.error).toHaveBeenCalledWith('Subscription cleanup failed for uid uid-err:', expect.any(Error));
    expect(count).toBeGreaterThan(0);
  });

  it('logs and excludes the streamer when resolving a raid-only streamer\'s Twitch user ID fails', async () => {
    vi.mocked(getAllEventSubStreamers).mockResolvedValue([{
      id: 80,
      twitch_name: 'raidFailStreamer',
      twitch_user_id: null,
      config: { raid_enabled: true },
    }] as any);
    vi.mocked(getValidToken).mockResolvedValue('tok-raidfail');
    vi.mocked(getUsers).mockRejectedValueOnce(new Error('Helix down'));

    const result = await loadStreamersForEventSub();

    expect(logMock.error).toHaveBeenCalledWith('Failed to resolve Twitch user ID for raidFailStreamer:', expect.any(Error));
    expect(result).toHaveLength(0);
  });

  it('logs a generic subscribe failure (not a TwitchAuthError) without recording it as an auth failure', async () => {
    vi.mocked(createEventSubSubscription).mockRejectedValueOnce(new Error('500 Internal Server Error'));
    vi.mocked(listEventSubSubscriptions).mockResolvedValue([]);

    await subscribeForStreamer('sess-generic', {
      uid: 'uid-generic',
      token: 'tok-generic',
      name: 'errStreamer',
      config: { follow_enabled: true, sub_enabled: false, raid_enabled: false } as any,
      streamerId: 90,
    });

    expect(logMock.error).toHaveBeenCalledWith(
      'Failed to subscribe to channel.follow for errStreamer:', expect.any(Error),
    );
    expect(hasAuthFailedSubs('errStreamer')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// handleRevocation
// ---------------------------------------------------------------------------
describe('handleRevocation', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    clearAuthFailedSubs('revokedStreamer');
    vi.mocked(getActiveChannels).mockReturnValue(new Set(['revokedstreamer']));
    vi.mocked(createEventSubSubscription).mockResolvedValue('sub-id');
    vi.mocked(listEventSubSubscriptions).mockResolvedValue([]);
    vi.mocked(clearStreamerToken).mockResolvedValue(undefined);
    await subscribeForStreamer('sess-revoke', {
      uid: 'uid-revoke',
      token: 'tok-revoke',
      name: 'revokedStreamer',
      config: { follow_enabled: false, sub_enabled: false, raid_enabled: false } as any,
      streamerId: 100,
    });
  });

  it('logs the revocation but does not clear a token for an unknown broadcaster', () => {
    handleRevocation({ type: 'channel.follow', status: 'authorization_revoked', condition: { broadcaster_user_id: 'unknown-uid' } });

    expect(logMock.warn).toHaveBeenCalledWith('Subscription revoked: type=channel.follow status=authorization_revoked');
    expect(clearStreamerToken).not.toHaveBeenCalled();
  });

  it('clears the token when status is authorization_revoked for a known broadcaster', () => {
    handleRevocation({ type: 'channel.follow', status: 'authorization_revoked', condition: { broadcaster_user_id: 'uid-revoke' } });

    expect(clearStreamerToken).toHaveBeenCalledWith(100);
    expect(logMock.warn).toHaveBeenCalledWith('Cleared token for revokedStreamer (authorization_revoked)');
  });

  it('clears the token when status is user_removed, using to_broadcaster_user_id', () => {
    handleRevocation({ type: 'channel.raid', status: 'user_removed', condition: { to_broadcaster_user_id: 'uid-revoke' } });

    expect(clearStreamerToken).toHaveBeenCalledWith(100);
    expect(logMock.warn).toHaveBeenCalledWith('Cleared token for revokedStreamer (user_removed)');
  });

  it('does not clear the token for other revocation statuses', () => {
    handleRevocation({ type: 'channel.follow', status: 'moderator_removed', condition: { broadcaster_user_id: 'uid-revoke' } });

    expect(clearStreamerToken).not.toHaveBeenCalled();
  });

  it('logs an error if clearing the token itself fails', async () => {
    vi.mocked(clearStreamerToken).mockRejectedValueOnce(new Error('db down'));

    handleRevocation({ type: 'channel.follow', status: 'authorization_revoked', condition: { broadcaster_user_id: 'uid-revoke' } });
    await new Promise((resolve) => setImmediate(resolve));

    expect(logMock.error).toHaveBeenCalledWith('Clear token error:', expect.any(Error));
  });
});
