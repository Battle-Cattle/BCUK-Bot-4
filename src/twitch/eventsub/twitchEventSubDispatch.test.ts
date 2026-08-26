import { describe, it, expect, vi, beforeEach } from 'vitest';

const { logMock } = vi.hoisted(() => ({
  logMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../shared/logger', () => ({ createLogger: () => logMock }));
vi.mock('../../shared/config', () => ({}));
vi.mock('../../db', () => ({
  clearStreamerToken: vi.fn().mockResolvedValue(undefined),
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

import { setStreamerInfo, removeStreamerFromMap, dispatchNotification, handleRevocation, getAllStreamerInfo } from './twitchEventSubDispatch';
import { clearStreamerToken, DEFAULT_EVENT_CONFIG } from '../../db';
import {
  handleStreamOnline, handleStreamOffline, handleChannelUpdate,
  handleFollow, handleSub, handleResub, handleGiftSub, handleRaid, handleRedemption,
} from './twitchEventSubHandler';
import { registerEventSubReloadRuntime } from './twitchEventSubRuntime';

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// dispatchNotification — stream.online / stream.offline routing
// ---------------------------------------------------------------------------
describe('dispatchNotification routes stream.online/offline', () => {
  beforeEach(() => {
    setStreamerInfo('uid-dispatch', {
      login: 'liveStreamer', streamerId: 30,
      config: { follow_enabled: false, sub_enabled: false, raid_enabled: false } as any,
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
// dispatchNotification — remaining notification types
// ---------------------------------------------------------------------------
describe('dispatchNotification routes chat-alert and redemption events', () => {
  beforeEach(() => {
    setStreamerInfo('uid-alert', {
      login: 'alertStreamer', streamerId: 50,
      config: { follow_enabled: true, sub_enabled: true, raid_enabled: true } as any,
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

  it('logs a warning and does nothing when the condition carries no broadcaster id', () => {
    dispatchNotification('channel.follow', {}, {});
    expect(logMock.warn).toHaveBeenCalledWith(
      'EventSub notification (channel.follow) has no broadcaster_user_id/to_broadcaster_user_id in its condition — dropping',
    );
    expect(handleFollow).not.toHaveBeenCalled();
  });

  it('logs a warning and does nothing for a broadcaster id not in the dispatch map', () => {
    dispatchNotification('channel.follow', {}, { broadcaster_user_id: 'uid-unknown' });
    expect(logMock.warn).toHaveBeenCalledWith(
      'EventSub notification (channel.follow) for unknown broadcaster uid-unknown — not in the dispatch map, dropping',
    );
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
// dispatchNotification — streamer with no streamer_event_config row
// ---------------------------------------------------------------------------
describe('dispatchNotification with a null streamer config (alert-only streamer)', () => {
  beforeEach(() => {
    setStreamerInfo('uid-alert-only', { login: 'alertOnlyStreamer', streamerId: 60, config: null });
  });

  it('still routes the notification, falling back to DEFAULT_EVENT_CONFIG instead of dropping it', () => {
    dispatchNotification('channel.follow', { user_name: 'follower' }, { broadcaster_user_id: 'uid-alert-only' });
    expect(handleFollow).toHaveBeenCalledWith('alertOnlyStreamer', { user_name: 'follower' }, DEFAULT_EVENT_CONFIG, 60);
  });
});

// ---------------------------------------------------------------------------
// removeStreamerFromMap
// ---------------------------------------------------------------------------
describe('removeStreamerFromMap', () => {
  beforeEach(() => {
    setStreamerInfo('uid-rm', {
      login: 'removable', streamerId: 60,
      config: { follow_enabled: false, sub_enabled: false, raid_enabled: false } as any,
    });
  });

  it('removes the streamer so dispatchNotification no longer routes to it', () => {
    removeStreamerFromMap('uid-rm');

    dispatchNotification('stream.online', {}, { broadcaster_user_id: 'uid-rm' });

    expect(handleStreamOnline).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// handleRevocation
// ---------------------------------------------------------------------------
describe('handleRevocation', () => {
  const triggerReload = vi.fn();

  beforeEach(() => {
    vi.mocked(clearStreamerToken).mockResolvedValue(true as any);
    setStreamerInfo('uid-revoke', {
      login: 'revokedStreamer', streamerId: 100,
      config: { follow_enabled: false, sub_enabled: false, raid_enabled: false } as any,
    });
    triggerReload.mockClear();
    registerEventSubReloadRuntime({ triggerReload });
  });

  it('logs the revocation but does not clear a token for an unknown broadcaster', () => {
    handleRevocation({ type: 'channel.follow', status: 'authorization_revoked', condition: { broadcaster_user_id: 'unknown-uid' } });

    expect(logMock.warn).toHaveBeenCalledWith('Subscription revoked: type=channel.follow status=authorization_revoked');
    expect(clearStreamerToken).not.toHaveBeenCalled();
  });

  it('clears the token when status is authorization_revoked for a known broadcaster', async () => {
    handleRevocation({ type: 'channel.follow', status: 'authorization_revoked', condition: { broadcaster_user_id: 'uid-revoke' } });
    await new Promise((resolve) => setImmediate(resolve));

    expect(clearStreamerToken).toHaveBeenCalledWith(100);
    expect(logMock.warn).toHaveBeenCalledWith('Cleared token for revokedStreamer (authorization_revoked)');
  });

  it('clears the token when status is user_removed, using to_broadcaster_user_id', async () => {
    handleRevocation({ type: 'channel.raid', status: 'user_removed', condition: { to_broadcaster_user_id: 'uid-revoke' } });
    await new Promise((resolve) => setImmediate(resolve));

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

  it('triggers an EventSub reload once the token is cleared, so the now-tokenless connection is torn down promptly', async () => {
    handleRevocation({ type: 'channel.follow', status: 'authorization_revoked', condition: { broadcaster_user_id: 'uid-revoke' } });
    await new Promise((resolve) => setImmediate(resolve));

    expect(triggerReload).toHaveBeenCalledTimes(1);
  });

  it('does not log a clear or trigger a reload when clearStreamerToken resolves false (no row matched)', async () => {
    vi.mocked(clearStreamerToken).mockResolvedValueOnce(false);

    handleRevocation({ type: 'channel.follow', status: 'authorization_revoked', condition: { broadcaster_user_id: 'uid-revoke' } });
    await new Promise((resolve) => setImmediate(resolve));

    expect(logMock.warn).not.toHaveBeenCalledWith('Cleared token for revokedStreamer (authorization_revoked)');
    expect(triggerReload).not.toHaveBeenCalled();
  });

  it('does not trigger a reload if clearing the token fails', async () => {
    vi.mocked(clearStreamerToken).mockRejectedValueOnce(new Error('db down'));

    handleRevocation({ type: 'channel.follow', status: 'authorization_revoked', condition: { broadcaster_user_id: 'uid-revoke' } });
    await new Promise((resolve) => setImmediate(resolve));

    expect(triggerReload).not.toHaveBeenCalled();
  });

  it('does not throw when no reload runtime is registered', async () => {
    // Simulates index.ts never having called registerEventSubReloadRuntime (e.g. app startup
    // order) — eventSubReloadRuntimeRegistry.get() returns null and must be handled with
    // optional chaining, not assumed non-null.
    registerEventSubReloadRuntime(null as unknown as { triggerReload: () => void });

    expect(() => {
      handleRevocation({ type: 'channel.follow', status: 'authorization_revoked', condition: { broadcaster_user_id: 'uid-revoke' } });
    }).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));
  });
});

describe('getAllStreamerInfo', () => {
  it('reflects entries added via setStreamerInfo and removed via removeStreamerFromMap', () => {
    setStreamerInfo('uid-getall', { login: 'getAllStreamer', streamerId: 999, config: null });
    expect(getAllStreamerInfo().get('uid-getall')).toEqual({ login: 'getAllStreamer', streamerId: 999, config: null });

    removeStreamerFromMap('uid-getall');
    expect(getAllStreamerInfo().has('uid-getall')).toBe(false);
  });
});
