import { describe, it, expect, vi, beforeEach } from 'vitest';

const { logMock } = vi.hoisted(() => ({
  logMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../shared/logger', () => ({ createLogger: () => logMock }));
vi.mock('../../shared/config', () => ({}));
// './twitchEventSubSubscriptions' re-exports dispatchNotification/handleRevocation/
// removeStreamerFromMap from './twitchEventSubDispatch', which in turn imports
// clearStreamerToken/DEFAULT_EVENT_CONFIG from '../../db' — both mocked here purely so that
// transitive import chain resolves, even though this file's own tests exercise
// subscribeForStreamer/loadStreamersForEventSub, not dispatch.
vi.mock('../../db', () => ({
  getAllEventSubStreamers: vi.fn(),
  clearStreamerToken: vi.fn().mockResolvedValue(undefined),
  getEnabledAlertEventTypesBatch: vi.fn().mockResolvedValue(new Map()),
  DEFAULT_EVENT_CONFIG: {
    follow_enabled: false,
    follow_message: 'Thanks {display_name} for the follow!',
    sub_enabled: false,
    sub_message: 'Thanks {display_name} for subscribing! ({tier_name})',
    resub_message: 'Thanks {display_name} for {months} months! ({tier_name})',
    giftsub_message: '{gifter_display} gifted {count} sub(s) to the community!',
    raid_enabled: false,
    raid_message: 'Welcome raiders from {from_display}! Thank you for the {viewers} person raid!',
    raid_shoutout_enabled: false,
  },
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
} from './twitchEventSubSubscriptions';
import { getAllEventSubStreamers, getEnabledAlertEventTypesBatch } from '../../db';
import { getValidToken, createEventSubSubscription, listEventSubSubscriptions, deleteEventSubSubscription, TwitchAuthError } from './twitchApiEventSub';
import { getUsers } from '../twitchApi';
import { getActiveChannels } from '../twitchChannelMembership';

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

  it('builds enabledAlerts from the batched enabled-alert-types lookup', async () => {
    const fakeStreamer = {
      id: 14,
      twitch_name: 'alertOnly',
      twitch_user_id: 'uid-14',
      config: { follow_enabled: true },
    };
    vi.mocked(getAllEventSubStreamers).mockResolvedValue([fakeStreamer] as any);
    vi.mocked(getValidToken).mockResolvedValue('tok-14');
    vi.mocked(getEnabledAlertEventTypesBatch).mockResolvedValue(new Map([
      [14, new Set(['raid', 'giftsub'])],
    ]) as any);

    const result = await loadStreamersForEventSub();

    expect(getEnabledAlertEventTypesBatch).toHaveBeenCalledWith([14]);
    expect(result[0].enabledAlerts).toEqual(new Set(['raid', 'giftsub']));
  });

  it('fetches enabled alert types for all streamers in a single batched call, not one per streamer', async () => {
    const streamerA = { id: 20, twitch_name: 'streamerA', twitch_user_id: 'uid-20', config: { follow_enabled: true } };
    const streamerB = { id: 21, twitch_name: 'streamerB', twitch_user_id: 'uid-21', config: { follow_enabled: true } };
    vi.mocked(getAllEventSubStreamers).mockResolvedValue([streamerA, streamerB] as any);
    vi.mocked(getValidToken).mockResolvedValue('tok');

    await loadStreamersForEventSub();

    expect(getEnabledAlertEventTypesBatch).toHaveBeenCalledTimes(1);
    expect(getEnabledAlertEventTypesBatch).toHaveBeenCalledWith([20, 21]);
  });

  it('resolves streamers concurrently rather than waiting for each token refresh in turn', async () => {
    const streamerA = { id: 30, twitch_name: 'streamerA', twitch_user_id: 'uid-30', config: { follow_enabled: true } };
    const streamerB = { id: 31, twitch_name: 'streamerB', twitch_user_id: 'uid-31', config: { follow_enabled: true } };
    vi.mocked(getAllEventSubStreamers).mockResolvedValue([streamerA, streamerB] as any);

    let resolveFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { resolveFirst = resolve; });
    let secondStarted = false;

    vi.mocked(getValidToken).mockImplementation(async (streamer: any) => {
      if (streamer.id === 30) {
        await firstGate; // blocks the first streamer's token refresh until released below
      } else {
        secondStarted = true; // only reachable if the second streamer didn't wait for the first
      }
      return 'tok';
    });

    const resultPromise = loadStreamersForEventSub();
    for (let i = 0; i < 20 && !secondStarted; i++) {
      await Promise.resolve();
    }
    expect(secondStarted).toBe(true);

    resolveFirst();
    const result = await resultPromise;
    expect(result).toHaveLength(2);
  });

  it('defaults enabledAlerts to an empty Set for a streamer missing from the batch result', async () => {
    const fakeStreamer = { id: 15, twitch_name: 'noAlerts', twitch_user_id: 'uid-15', config: { follow_enabled: true } };
    vi.mocked(getAllEventSubStreamers).mockResolvedValue([fakeStreamer] as any);
    vi.mocked(getValidToken).mockResolvedValue('tok-15');
    vi.mocked(getEnabledAlertEventTypesBatch).mockResolvedValue(new Map());

    const result = await loadStreamersForEventSub();

    expect(result[0].enabledAlerts).toEqual(new Set());
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

  it('prunes a duplicate subscription of a still-desired type left over from a prior session', async () => {
    vi.mocked(getActiveChannels).mockReturnValue(new Set(['botinchannel']));
    vi.mocked(createEventSubSubscription).mockResolvedValue('sub-new-follow');
    // The old, orphaned subscription (e.g. from a process that died without stop()) is still
    // "enabled" and shows up alongside the one just created this round.
    vi.mocked(listEventSubSubscriptions).mockResolvedValue([
      { id: 'sub-new-follow', type: 'channel.follow' },
      { id: 'sub-stale-follow', type: 'channel.follow' },
    ] as any);

    await subscribeForStreamer('sess-dup', {
      uid: 'uid-dup',
      token: 'tok-dup',
      name: 'botInChannel',
      config: { follow_enabled: true, sub_enabled: false, raid_enabled: false } as any,
      streamerId: 22,
    });

    expect(deleteEventSubSubscription).toHaveBeenCalledWith('sub-stale-follow', 'tok-dup');
    expect(deleteEventSubSubscription).not.toHaveBeenCalledWith('sub-new-follow', 'tok-dup');
  });

  it('does not prune any existing subscription of a type when creating it hit a 409 (already exists)', async () => {
    vi.mocked(getActiveChannels).mockReturnValue(new Set(['botinchannel']));
    // 409 -> createEventSubSubscription resolves null, so subscribe() has no fresh id for this type.
    vi.mocked(createEventSubSubscription).mockResolvedValue(null);
    vi.mocked(listEventSubSubscriptions).mockResolvedValue([
      { id: 'sub-existing-follow', type: 'channel.follow' },
    ] as any);

    await subscribeForStreamer('sess-409', {
      uid: 'uid-409',
      token: 'tok-409',
      name: 'botInChannel',
      config: { follow_enabled: true, sub_enabled: false, raid_enabled: false } as any,
      streamerId: 23,
    });

    expect(deleteEventSubSubscription).not.toHaveBeenCalledWith('sub-existing-follow', 'tok-409');
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

  it('continues deleting remaining stale subscriptions after one deletion fails', async () => {
    vi.mocked(createEventSubSubscription).mockResolvedValue('sub-id');
    vi.mocked(listEventSubSubscriptions).mockResolvedValue([
      { id: 'stale-1', type: 'channel.subscribe' },
      { id: 'stale-2', type: 'channel.raid' },
    ] as any);
    vi.mocked(deleteEventSubSubscription)
      .mockRejectedValueOnce(new Error('delete failed'))
      .mockResolvedValueOnce(undefined);

    await subscribeForStreamer('sess-delete-err', {
      uid: 'uid-delete-err',
      token: 'tok-delete-err',
      name: 'errStreamer',
      config: { follow_enabled: true, sub_enabled: false, raid_enabled: false } as any,
      streamerId: 71,
    });

    expect(deleteEventSubSubscription).toHaveBeenCalledWith('stale-1', 'tok-delete-err');
    expect(deleteEventSubSubscription).toHaveBeenCalledWith('stale-2', 'tok-delete-err');
    expect(logMock.error).toHaveBeenCalledWith(
      'Failed to delete subscription stale-1 (channel.subscribe) for uid uid-delete-err:', expect.any(Error),
    );
  });

  it('deletes stale subscriptions concurrently, isolating one deletion failure from the other', async () => {
    vi.mocked(createEventSubSubscription).mockResolvedValue('sub-id');
    vi.mocked(listEventSubSubscriptions).mockResolvedValue([
      { id: 'stale-1', type: 'channel.subscribe' },
      { id: 'stale-2', type: 'channel.raid' },
    ] as any);

    let rejectFirst!: (err: Error) => void;
    const firstGate = new Promise<void>((_resolve, reject) => { rejectFirst = reject; });
    let secondStarted = false;

    vi.mocked(deleteEventSubSubscription).mockImplementation(async (id: string) => {
      if (id === 'stale-1') {
        await firstGate;
      } else {
        secondStarted = true;
      }
    });

    const call = subscribeForStreamer('sess-concurrent-delete', {
      uid: 'uid-concurrent-delete',
      token: 'tok-concurrent-delete',
      name: 'errStreamer',
      config: { follow_enabled: true, sub_enabled: false, raid_enabled: false } as any,
      streamerId: 72,
    });

    // Waits until the second deletion starts — proves it isn't waiting on the first to settle.
    await vi.waitFor(() => expect(secondStarted).toBe(true));

    rejectFirst(new Error('delete failed'));
    await expect(call).resolves.not.toThrow();
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
