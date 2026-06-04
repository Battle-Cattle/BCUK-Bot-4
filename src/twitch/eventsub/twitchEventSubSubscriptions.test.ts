import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../shared/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
vi.mock('../../db', () => ({
  getAllEventSubStreamers: vi.fn(),
  clearStreamerToken: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../twitchApi', () => ({ getUsers: vi.fn() }));
vi.mock('../twitchBot', () => ({ getActiveChannels: vi.fn().mockReturnValue(new Set<string>()) }));
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
}));

import {
  hasAuthFailedSubs,
  clearAuthFailedSubs,
  loadStreamersForEventSub,
  subscribeForStreamer,
} from './twitchEventSubSubscriptions';
import { getAllEventSubStreamers } from '../../db';
import { getValidToken, createEventSubSubscription, listEventSubSubscriptions, deleteEventSubSubscription, TwitchAuthError } from './twitchApiEventSub';
import { getUsers } from '../twitchApi';
import { getActiveChannels } from '../twitchBot';

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
});
