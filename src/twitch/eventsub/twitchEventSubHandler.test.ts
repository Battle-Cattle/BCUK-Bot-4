import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../../test-utils/loggerMock';

vi.mock('../../db', () => ({
  getVideosForReward: vi.fn(), getStreamerById: vi.fn(), findCachedAlertConfig: vi.fn(), recordStreamerEvent: vi.fn(),
}));
vi.mock('../../commands/soundSelector', () => ({ pickWeightedRandom: vi.fn() }));
vi.mock('../../commands/shoutoutHandler', () => ({ buildShoutoutMessage: vi.fn() }));
vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));
vi.mock('../monitor/twitchMonitor', () => ({ triggerImmediateLiveCheck: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../pricing/rewardPricingService', () => ({ applyRedemptionPricing: vi.fn().mockResolvedValue(undefined) }));

import {
  handleFollow, handleSub, handleResub, handleGiftSub, handleRaid, handleRedemption,
  handleStreamOnline, handleStreamOffline, handleChannelUpdate,
} from './twitchEventSubHandler';
import { seenRedemptionIds, pendingRedemptionIds } from './twitchEventSubRedemptionDedup';
import {
  registerEventSubOverlayRuntime, registerEventSubTwitchRuntime, registerEventSubCompanionRuntime,
  registerEventSubAlertRuntime, registerEventSubDashboardRuntime,
} from './twitchEventSubRuntime';
import { getVideosForReward, getStreamerById, findCachedAlertConfig, recordStreamerEvent } from '../../db';
import { pickWeightedRandom } from '../../commands/soundSelector';
import { buildShoutoutMessage } from '../../commands/shoutoutHandler';
import { triggerImmediateLiveCheck } from '../monitor/twitchMonitor';
import { applyRedemptionPricing } from '../pricing/rewardPricingService';
import { TEST_ALERT_VARS } from '../../web/routes/testAlertVars';

const mockSend = vi.fn<(channel: string, message: string) => Promise<void>>();
registerEventSubTwitchRuntime({ send: mockSend });

const mockPushOverlayEvent = vi.fn();
registerEventSubOverlayRuntime({ pushOverlayEvent: mockPushOverlayEvent });

const mockPushCompanionEvent = vi.fn();
registerEventSubCompanionRuntime({ pushCompanionEvent: mockPushCompanionEvent });

const mockPushAlertEvent = vi.fn();
registerEventSubAlertRuntime({ pushAlertEvent: mockPushAlertEvent });

const mockPushDashboardEvent = vi.fn();
registerEventSubDashboardRuntime({ pushDashboardEvent: mockPushDashboardEvent });

// Fixed streamerId used by tests that don't care about alert-config lookup specifics.
const STREAMER_ID = 7;

// Minimal EventSubConfig helper — avoids importing from db/eventSub
function makeConfig(overrides: Partial<{
  follow_enabled: boolean;
  follow_message: string;
  sub_enabled: boolean;
  sub_message: string;
  resub_message: string;
  giftsub_message: string;
  raid_enabled: boolean;
  raid_message: string;
  raid_shoutout_enabled: boolean;
}> = {}) {
  return {
    follow_enabled: false,
    follow_message: 'Follow from {username} ({display_name})',
    sub_enabled: false,
    sub_message: 'Sub from {username} ({display_name}) tier={tier} tier_name={tier_name}',
    resub_message: 'Resub from {username} months={months} streak={streak} tier={tier} tier_name={tier_name}',
    giftsub_message: 'Gift from {gifter} ({gifter_display}) count={count} tier={tier} tier_name={tier_name}',
    raid_enabled: false,
    raid_message: 'Raid from {from_channel} ({from_display}) viewers={viewers}',
    raid_shoutout_enabled: false,
    ...overrides,
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(findCachedAlertConfig).mockResolvedValue(null);
  vi.mocked(recordStreamerEvent).mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// handleFollow
// ---------------------------------------------------------------------------
describe('handleFollow', () => {
  const event = {
    user_login: 'testuser',
    user_name: 'TestUser',
    broadcaster_user_login: 'streamer',
  };

  it('does not call injected runtime when follow_enabled is false', async () => {
    await handleFollow('streamer', event, makeConfig({ follow_enabled: false }), STREAMER_ID);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('calls injected runtime (mockSend) with substituted {username} and {display_name} when follow_enabled is true', async () => {
    await handleFollow('streamer', event, makeConfig({
      follow_enabled: true,
      follow_message: 'Welcome {username} aka {display_name}!',
    }), STREAMER_ID);
    expect(mockSend).toHaveBeenCalledOnce();
    expect(mockSend).toHaveBeenCalledWith('streamer', 'Welcome testuser aka TestUser!');
  });
});

// ---------------------------------------------------------------------------
// handleSub
// ---------------------------------------------------------------------------
describe('handleSub', () => {
  const baseEvent = {
    user_login: 'subuser',
    user_name: 'SubUser',
    broadcaster_user_login: 'streamer',
    tier: '1000',
    is_gift: false,
  };

  it('does not call injected runtime when sub_enabled is false', async () => {
    await handleSub('streamer', { ...baseEvent }, makeConfig({ sub_enabled: false }), STREAMER_ID);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('does not call injected runtime when is_gift is true even if sub_enabled is true', async () => {
    await handleSub('streamer', { ...baseEvent, is_gift: true }, makeConfig({ sub_enabled: true }), STREAMER_ID);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('calls injected runtime (mockSend) with {tier} and {tier_name} substituted (Tier 1)', async () => {
    await handleSub('streamer', { ...baseEvent, tier: '1000' }, makeConfig({
      sub_enabled: true,
      sub_message: 'tier={tier} name={tier_name}',
    }), STREAMER_ID);
    expect(mockSend).toHaveBeenCalledWith('streamer', 'tier=1000 name=Tier 1');
  });

  it('tierName maps 2000 to Tier 2', async () => {
    await handleSub('streamer', { ...baseEvent, tier: '2000' }, makeConfig({
      sub_enabled: true,
      sub_message: 'name={tier_name}',
    }), STREAMER_ID);
    expect(mockSend).toHaveBeenCalledWith('streamer', 'name=Tier 2');
  });

  it('tierName maps 3000 to Tier 3', async () => {
    await handleSub('streamer', { ...baseEvent, tier: '3000' }, makeConfig({
      sub_enabled: true,
      sub_message: 'name={tier_name}',
    }), STREAMER_ID);
    expect(mockSend).toHaveBeenCalledWith('streamer', 'name=Tier 3');
  });

  it('tierName passes unknown tier through unchanged', async () => {
    await handleSub('streamer', { ...baseEvent, tier: 'prime' }, makeConfig({
      sub_enabled: true,
      sub_message: 'name={tier_name}',
    }), STREAMER_ID);
    expect(mockSend).toHaveBeenCalledWith('streamer', 'name=prime');
  });
});

// ---------------------------------------------------------------------------
// handleResub
// ---------------------------------------------------------------------------
describe('handleResub', () => {
  const baseEvent = {
    user_login: 'resubuser',
    user_name: 'ResubUser',
    broadcaster_user_login: 'streamer',
    tier: '1000',
    cumulative_months: 6,
    streak_months: 3,
  };

  it('calls injected runtime (mockSend) with {months} and {streak} substituted when sub_enabled is true', async () => {
    await handleResub('streamer', baseEvent, makeConfig({
      sub_enabled: true,
      resub_message: 'months={months} streak={streak}',
    }), STREAMER_ID);
    expect(mockSend).toHaveBeenCalledWith('streamer', 'months=6 streak=3');
  });

  it('substitutes {streak} as "0" when streak_months is null', async () => {
    await handleResub('streamer', { ...baseEvent, streak_months: null }, makeConfig({
      sub_enabled: true,
      resub_message: 'streak={streak}',
    }), STREAMER_ID);
    expect(mockSend).toHaveBeenCalledWith('streamer', 'streak=0');
  });

  it('substitutes {streak} as the number string when streak_months is set', async () => {
    await handleResub('streamer', { ...baseEvent, streak_months: 12 }, makeConfig({
      sub_enabled: true,
      resub_message: 'streak={streak}',
    }), STREAMER_ID);
    expect(mockSend).toHaveBeenCalledWith('streamer', 'streak=12');
  });

  it('does not call injected runtime when sub_enabled is false', async () => {
    await handleResub('streamer', baseEvent, makeConfig({ sub_enabled: false }), STREAMER_ID);
    expect(mockSend).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// handleGiftSub
// ---------------------------------------------------------------------------
describe('handleGiftSub', () => {
  const baseEvent = {
    user_login: 'gifter',
    user_name: 'GifterDisplay',
    broadcaster_user_login: 'streamer',
    total: 5,
    tier: '1000',
    is_anonymous: false,
  };

  it('does not call injected runtime when sub_enabled is false', async () => {
    await handleGiftSub('streamer', baseEvent, makeConfig({ sub_enabled: false }), STREAMER_ID);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('uses "anonymous" and "Anonymous" for {gifter} and {gifter_display} when is_anonymous is true', async () => {
    await handleGiftSub('streamer', { ...baseEvent, is_anonymous: true }, makeConfig({
      sub_enabled: true,
      giftsub_message: '{gifter} / {gifter_display}',
    }), STREAMER_ID);
    expect(mockSend).toHaveBeenCalledWith('streamer', 'anonymous / Anonymous');
  });

  it('uses event.user_login as {gifter} when is_anonymous is false', async () => {
    await handleGiftSub('streamer', { ...baseEvent, is_anonymous: false }, makeConfig({
      sub_enabled: true,
      giftsub_message: '{gifter} / {gifter_display}',
    }), STREAMER_ID);
    expect(mockSend).toHaveBeenCalledWith('streamer', 'gifter / GifterDisplay');
  });

  it('substitutes {count} correctly', async () => {
    await handleGiftSub('streamer', { ...baseEvent, total: 3 }, makeConfig({
      sub_enabled: true,
      giftsub_message: 'count={count}',
    }), STREAMER_ID);
    expect(mockSend).toHaveBeenCalledWith('streamer', 'count=3');
  });
});

// ---------------------------------------------------------------------------
// handleRaid
// ---------------------------------------------------------------------------
describe('handleRaid', () => {
  const event = {
    from_broadcaster_user_login: 'raider',
    from_broadcaster_user_name: 'RaiderDisplay',
    to_broadcaster_user_login: 'streamer',
    viewers: 42,
  };

  it('does not call injected runtime when raid_enabled is false', async () => {
    await handleRaid('streamer', event, makeConfig({ raid_enabled: false }), STREAMER_ID);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('calls injected runtime (mockSend) with {from_channel}, {from_display}, {viewers} substituted when raid_enabled is true', async () => {
    await handleRaid('streamer', event, makeConfig({
      raid_enabled: true,
      raid_message: '{from_channel} ({from_display}) viewers={viewers}',
    }), STREAMER_ID);
    expect(mockSend).toHaveBeenCalledWith('streamer', 'raider (RaiderDisplay) viewers=42');
  });

  it('sends the shoutout for the raiding channel when raid_shoutout_enabled is true, even if raid_enabled is false', async () => {
    vi.mocked(buildShoutoutMessage).mockResolvedValue('Go check out @raider!');

    await handleRaid('streamer', event, makeConfig({ raid_enabled: false, raid_shoutout_enabled: true }), STREAMER_ID);

    expect(buildShoutoutMessage).toHaveBeenCalledWith('raider');
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledWith('streamer', 'Go check out @raider!');
  });

  it('sends both the welcome message and the shoutout when both toggles are on (independent)', async () => {
    vi.mocked(buildShoutoutMessage).mockResolvedValue('Go check out @raider!');

    await handleRaid('streamer', event, makeConfig({
      raid_enabled: true,
      raid_message: 'Welcome {from_channel}!',
      raid_shoutout_enabled: true,
    }), STREAMER_ID);

    expect(mockSend).toHaveBeenCalledWith('streamer', 'Welcome raider!');
    expect(mockSend).toHaveBeenCalledWith('streamer', 'Go check out @raider!');
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it('does not send a shoutout when raid_shoutout_enabled is true but the raiding channel is not found on Twitch', async () => {
    vi.mocked(buildShoutoutMessage).mockResolvedValue(null);

    await handleRaid('streamer', event, makeConfig({ raid_enabled: false, raid_shoutout_enabled: true }), STREAMER_ID);

    expect(mockSend).not.toHaveBeenCalled();
  });

  it('does not look up a shoutout when raid_shoutout_enabled is false', async () => {
    await handleRaid('streamer', event, makeConfig({ raid_enabled: true, raid_shoutout_enabled: false }), STREAMER_ID);

    expect(buildShoutoutMessage).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Alerts overlay push — independent of the chat-message *_enabled flags
// ---------------------------------------------------------------------------
describe('alerts overlay push', () => {
  /** Builds a fake alert_config row, pass `overrides` to customize. */
  function makeAlert(overrides: object = {}) {
    return {
      id: 1,
      streamer_id: STREAMER_ID,
      event_type: 'follow',
      enabled: true,
      message_template: 'template',
      image_filename: null,
      sound_filename: null,
      duration_ms: 6000,
      text_animation: 'none',
      ...overrides,
    } as any;
  }

  it('handleFollow does not push an alert when findCachedAlertConfig returns null', async () => {
    vi.mocked(findCachedAlertConfig).mockResolvedValue(null);
    await handleFollow('streamer', {
      user_login: 'testuser', user_name: 'TestUser', broadcaster_user_login: 'streamer',
    }, makeConfig({ follow_enabled: false }), STREAMER_ID);
    expect(mockPushAlertEvent).not.toHaveBeenCalled();
  });

  it('handleFollow does not push an alert when the alert config is disabled', async () => {
    vi.mocked(findCachedAlertConfig).mockResolvedValue(makeAlert({ enabled: false }));
    await handleFollow('streamer', {
      user_login: 'testuser', user_name: 'TestUser', broadcaster_user_login: 'streamer',
    }, makeConfig({ follow_enabled: false }), STREAMER_ID);
    expect(mockPushAlertEvent).not.toHaveBeenCalled();
  });

  it('handleFollow pushes an alert even when follow_enabled (chat message) is false — independent flags', async () => {
    vi.mocked(findCachedAlertConfig).mockResolvedValue(makeAlert({
      message_template: 'Welcome {username} aka {display_name}!',
      duration_ms: 4000,
    }));
    await handleFollow('streamer', {
      user_login: 'testuser', user_name: 'TestUser', broadcaster_user_login: 'streamer',
    }, makeConfig({ follow_enabled: false }), STREAMER_ID);

    expect(mockSend).not.toHaveBeenCalled();
    expect(findCachedAlertConfig).toHaveBeenCalledWith(STREAMER_ID, 'follow');
    expect(mockPushAlertEvent).toHaveBeenCalledWith('streamer', {
      type: 'follow',
      message: 'Welcome testuser aka TestUser!',
      imageUrl: null,
      soundUrl: null,
      durationMs: 4000,
      textAnimation: 'none',
    });
  });

  it('builds asset URLs from image_filename/sound_filename when set', async () => {
    vi.mocked(findCachedAlertConfig).mockResolvedValue(makeAlert({
      image_filename: 'follow.png',
      sound_filename: 'follow.mp3',
    }));
    await handleFollow('streamer', {
      user_login: 'testuser', user_name: 'TestUser', broadcaster_user_login: 'streamer',
    }, makeConfig(), STREAMER_ID);

    expect(mockPushAlertEvent).toHaveBeenCalledWith('streamer', expect.objectContaining({
      imageUrl: `/alerts/assets/${STREAMER_ID}/follow.png`,
      soundUrl: `/alerts/assets/${STREAMER_ID}/follow.mp3`,
    }));
  });

  it('passes through the alert config\'s text_animation as textAnimation', async () => {
    vi.mocked(findCachedAlertConfig).mockResolvedValue(makeAlert({ text_animation: 'wave' }));
    await handleFollow('streamer', {
      user_login: 'testuser', user_name: 'TestUser', broadcaster_user_login: 'streamer',
    }, makeConfig(), STREAMER_ID);

    expect(mockPushAlertEvent).toHaveBeenCalledWith('streamer', expect.objectContaining({
      textAnimation: 'wave',
    }));
  });

  it('leaves an unrecognised placeholder in place (keep fallback) instead of blanking it, matching the test-alert preview', async () => {
    vi.mocked(findCachedAlertConfig).mockResolvedValue(makeAlert({ message_template: 'Hi {diplay_name}!' }));
    await handleFollow('streamer', {
      user_login: 'testuser', user_name: 'TestUser', broadcaster_user_login: 'streamer',
    }, makeConfig(), STREAMER_ID);

    expect(mockPushAlertEvent).toHaveBeenCalledWith('streamer', expect.objectContaining({
      message: 'Hi {diplay_name}!',
    }));
  });

  it('handleSub does not push a "sub" alert for gift subs — handled by handleGiftSub instead', async () => {
    vi.mocked(findCachedAlertConfig).mockResolvedValue(makeAlert({ event_type: 'sub' }));
    await handleSub('streamer', {
      user_login: 'subuser', user_name: 'SubUser', broadcaster_user_login: 'streamer', tier: '1000', is_gift: true,
    }, makeConfig({ sub_enabled: true }), STREAMER_ID);
    expect(mockPushAlertEvent).not.toHaveBeenCalled();
  });

  it('handleSub pushes a "sub" alert independent of sub_enabled (chat message)', async () => {
    vi.mocked(findCachedAlertConfig).mockResolvedValue(makeAlert({ event_type: 'sub', message_template: 'tier={tier_name}' }));
    await handleSub('streamer', {
      user_login: 'subuser', user_name: 'SubUser', broadcaster_user_login: 'streamer', tier: '1000', is_gift: false,
    }, makeConfig({ sub_enabled: false }), STREAMER_ID);

    expect(findCachedAlertConfig).toHaveBeenCalledWith(STREAMER_ID, 'sub');
    expect(mockPushAlertEvent).toHaveBeenCalledWith('streamer', expect.objectContaining({ type: 'sub', message: 'tier=Tier 1' }));
  });

  it('handleResub pushes a "resub" alert with {months}/{streak} substituted', async () => {
    vi.mocked(findCachedAlertConfig).mockResolvedValue(makeAlert({ event_type: 'resub', message_template: 'months={months} streak={streak}' }));
    await handleResub('streamer', {
      user_login: 'resubuser', user_name: 'ResubUser', broadcaster_user_login: 'streamer',
      tier: '1000', cumulative_months: 6, streak_months: 3,
    }, makeConfig({ sub_enabled: false }), STREAMER_ID);

    expect(findCachedAlertConfig).toHaveBeenCalledWith(STREAMER_ID, 'resub');
    expect(mockPushAlertEvent).toHaveBeenCalledWith('streamer', expect.objectContaining({ type: 'resub', message: 'months=6 streak=3' }));
  });

  it('handleGiftSub pushes a "giftsub" alert with gifter vars substituted', async () => {
    vi.mocked(findCachedAlertConfig).mockResolvedValue(makeAlert({ event_type: 'giftsub', message_template: '{gifter_display} x{count}' }));
    await handleGiftSub('streamer', {
      user_login: 'gifter', user_name: 'GifterDisplay', broadcaster_user_login: 'streamer',
      total: 5, tier: '1000', is_anonymous: false,
    }, makeConfig({ sub_enabled: false }), STREAMER_ID);

    expect(findCachedAlertConfig).toHaveBeenCalledWith(STREAMER_ID, 'giftsub');
    expect(mockPushAlertEvent).toHaveBeenCalledWith('streamer', expect.objectContaining({ type: 'giftsub', message: 'GifterDisplay x5' }));
  });

  it('handleRaid pushes a "raid" alert independent of raid_enabled and raid_shoutout_enabled', async () => {
    vi.mocked(findCachedAlertConfig).mockResolvedValue(makeAlert({ event_type: 'raid', message_template: '{from_display} x{viewers}' }));
    await handleRaid('streamer', {
      from_broadcaster_user_login: 'raider', from_broadcaster_user_name: 'RaiderDisplay',
      to_broadcaster_user_login: 'streamer', viewers: 42,
    }, makeConfig({ raid_enabled: false, raid_shoutout_enabled: false }), STREAMER_ID);

    expect(mockSend).not.toHaveBeenCalled();
    expect(findCachedAlertConfig).toHaveBeenCalledWith(STREAMER_ID, 'raid');
    expect(mockPushAlertEvent).toHaveBeenCalledWith('streamer', expect.objectContaining({ type: 'raid', message: 'RaiderDisplay x42' }));
  });
});

// ---------------------------------------------------------------------------
// Dashboard "Recent Events" push — unconditional, independent of alert/chat config
// ---------------------------------------------------------------------------
describe('dashboard events push', () => {
  it('handleFollow records and pushes a follow event unconditionally', async () => {
    await handleFollow('streamer', {
      user_login: 'testuser', user_name: 'TestUser', broadcaster_user_login: 'streamer',
    }, makeConfig({ follow_enabled: false }), STREAMER_ID);

    expect(recordStreamerEvent).toHaveBeenCalledWith(STREAMER_ID, 'follow', 'TestUser', null);
    expect(mockPushDashboardEvent).toHaveBeenCalledWith(STREAMER_ID, {
      eventType: 'follow', displayName: 'TestUser', detail: null, occurredAt: expect.any(String),
    });
  });

  it('handleSub does not record a dashboard event for gift subs — handled by handleGiftSub instead', async () => {
    await handleSub('streamer', {
      user_login: 'subuser', user_name: 'SubUser', broadcaster_user_login: 'streamer', tier: '1000', is_gift: true,
    }, makeConfig({ sub_enabled: true }), STREAMER_ID);
    expect(recordStreamerEvent).not.toHaveBeenCalled();
  });

  it('handleSub records a sub event with the tier name as detail', async () => {
    await handleSub('streamer', {
      user_login: 'subuser', user_name: 'SubUser', broadcaster_user_login: 'streamer', tier: '2000', is_gift: false,
    }, makeConfig({ sub_enabled: false }), STREAMER_ID);
    expect(recordStreamerEvent).toHaveBeenCalledWith(STREAMER_ID, 'sub', 'SubUser', 'Tier 2');
  });

  it('handleResub records a resub event with tier and months as detail', async () => {
    await handleResub('streamer', {
      user_login: 'resubuser', user_name: 'ResubUser', broadcaster_user_login: 'streamer',
      tier: '1000', cumulative_months: 6, streak_months: 3,
    }, makeConfig({ sub_enabled: false }), STREAMER_ID);
    expect(recordStreamerEvent).toHaveBeenCalledWith(STREAMER_ID, 'resub', 'ResubUser', 'Tier 1 · 6 months');
  });

  it('handleGiftSub records a giftsub event using the gifter display name and count/tier as detail', async () => {
    await handleGiftSub('streamer', {
      user_login: 'gifter', user_name: 'GifterDisplay', broadcaster_user_login: 'streamer',
      total: 5, tier: '1000', is_anonymous: false,
    }, makeConfig({ sub_enabled: false }), STREAMER_ID);
    expect(recordStreamerEvent).toHaveBeenCalledWith(STREAMER_ID, 'giftsub', 'GifterDisplay', '5 x Tier 1');
  });

  it('handleGiftSub records "Anonymous" as the display name for anonymous gifters', async () => {
    await handleGiftSub('streamer', {
      user_login: 'gifter', user_name: 'GifterDisplay', broadcaster_user_login: 'streamer',
      total: 5, tier: '1000', is_anonymous: true,
    }, makeConfig({ sub_enabled: false }), STREAMER_ID);
    expect(recordStreamerEvent).toHaveBeenCalledWith(STREAMER_ID, 'giftsub', 'Anonymous', '5 x Tier 1');
  });

  it('handleRaid records a raid event with viewer count as detail, independent of raid_enabled/raid_shoutout_enabled', async () => {
    await handleRaid('streamer', {
      from_broadcaster_user_login: 'raider', from_broadcaster_user_name: 'RaiderDisplay',
      to_broadcaster_user_login: 'streamer', viewers: 42,
    }, makeConfig({ raid_enabled: false, raid_shoutout_enabled: false }), STREAMER_ID);
    expect(recordStreamerEvent).toHaveBeenCalledWith(STREAMER_ID, 'raid', 'RaiderDisplay', '42 viewers');
  });
});

// ---------------------------------------------------------------------------
// TEST_ALERT_VARS (alertsAdminMutations.ts's "Send Test Alert" preview) must stay in sync with
// the real vars each handler below actually builds — otherwise a renamed/removed real variable
// silently leaves a stale `{placeholder}` in the live preview while the real handler works fine.
// Probes every TEST_ALERT_VARS key through the real handler and asserts none come back as an
// unfilled `{placeholder}` (which 'keep' fallback would leave literally in place if the real
// handler didn't actually provide that key).
// ---------------------------------------------------------------------------
describe('TEST_ALERT_VARS stays in sync with the real handlers\' template vars', () => {
  /** Builds a fake alert_config row, pass `overrides` to customize. */
  function makeAlert(overrides: object = {}) {
    return {
      id: 1,
      streamer_id: STREAMER_ID,
      event_type: 'follow',
      enabled: true,
      message_template: 'template',
      image_filename: null,
      sound_filename: null,
      duration_ms: 6000,
      text_animation: 'none',
      ...overrides,
    } as any;
  }

  /** Builds a message_template consisting of every key in `vars`, each wrapped as `{key}`. */
  function probeAllKeys(vars: Record<string, string>): string {
    return Object.keys(vars).map((k) => `{${k}}`).join(' ');
  }

  it('handleFollow provides every key TEST_ALERT_VARS.follow expects', async () => {
    vi.mocked(findCachedAlertConfig).mockResolvedValue(makeAlert({ event_type: 'follow', message_template: probeAllKeys(TEST_ALERT_VARS.follow) }));
    await handleFollow('streamer', {
      user_login: 'testuser', user_name: 'TestUser', broadcaster_user_login: 'streamer',
    }, makeConfig(), STREAMER_ID);
    const payload = mockPushAlertEvent.mock.calls.at(-1)?.[1];
    expect(payload.message).not.toMatch(/\{[\w-]+\}/);
  });

  it('handleSub provides every key TEST_ALERT_VARS.sub expects', async () => {
    vi.mocked(findCachedAlertConfig).mockResolvedValue(makeAlert({ event_type: 'sub', message_template: probeAllKeys(TEST_ALERT_VARS.sub) }));
    await handleSub('streamer', {
      user_login: 'subuser', user_name: 'SubUser', broadcaster_user_login: 'streamer', tier: '1000', is_gift: false,
    }, makeConfig(), STREAMER_ID);
    const payload = mockPushAlertEvent.mock.calls.at(-1)?.[1];
    expect(payload.message).not.toMatch(/\{[\w-]+\}/);
  });

  it('handleResub provides every key TEST_ALERT_VARS.resub expects', async () => {
    vi.mocked(findCachedAlertConfig).mockResolvedValue(makeAlert({ event_type: 'resub', message_template: probeAllKeys(TEST_ALERT_VARS.resub) }));
    await handleResub('streamer', {
      user_login: 'resubuser', user_name: 'ResubUser', broadcaster_user_login: 'streamer',
      tier: '1000', cumulative_months: 6, streak_months: 3,
    }, makeConfig(), STREAMER_ID);
    const payload = mockPushAlertEvent.mock.calls.at(-1)?.[1];
    expect(payload.message).not.toMatch(/\{[\w-]+\}/);
  });

  it('handleGiftSub provides every key TEST_ALERT_VARS.giftsub expects', async () => {
    vi.mocked(findCachedAlertConfig).mockResolvedValue(makeAlert({ event_type: 'giftsub', message_template: probeAllKeys(TEST_ALERT_VARS.giftsub) }));
    await handleGiftSub('streamer', {
      user_login: 'gifter', user_name: 'GifterDisplay', broadcaster_user_login: 'streamer',
      total: 5, tier: '1000', is_anonymous: false,
    }, makeConfig(), STREAMER_ID);
    const payload = mockPushAlertEvent.mock.calls.at(-1)?.[1];
    expect(payload.message).not.toMatch(/\{[\w-]+\}/);
  });

  it('handleRaid provides every key TEST_ALERT_VARS.raid expects', async () => {
    vi.mocked(findCachedAlertConfig).mockResolvedValue(makeAlert({ event_type: 'raid', message_template: probeAllKeys(TEST_ALERT_VARS.raid) }));
    await handleRaid('streamer', {
      from_broadcaster_user_login: 'raider', from_broadcaster_user_name: 'RaiderDisplay',
      to_broadcaster_user_login: 'streamer', viewers: 42,
    }, makeConfig(), STREAMER_ID);
    const payload = mockPushAlertEvent.mock.calls.at(-1)?.[1];
    expect(payload.message).not.toMatch(/\{[\w-]+\}/);
  });
});

// ---------------------------------------------------------------------------
// Chat-send failures must not block the independent alert push
// ---------------------------------------------------------------------------
describe('chat-send failures are isolated from the alert push', () => {
  const followEvent = { user_login: 'testuser', user_name: 'TestUser', broadcaster_user_login: 'streamer' };
  const subEvent = {
    user_login: 'subuser', user_name: 'SubUser', broadcaster_user_login: 'streamer', tier: '1000', is_gift: false,
  };
  const resubEvent = {
    user_login: 'resubuser', user_name: 'ResubUser', broadcaster_user_login: 'streamer',
    tier: '1000', cumulative_months: 6, streak_months: 3,
  };
  const giftSubEvent = {
    user_login: 'gifter', user_name: 'GifterDisplay', broadcaster_user_login: 'streamer',
    total: 5, tier: '1000', is_anonymous: false,
  };
  const raidEvent = {
    from_broadcaster_user_login: 'raider', from_broadcaster_user_name: 'RaiderDisplay',
    to_broadcaster_user_login: 'streamer', viewers: 42,
  };

  beforeEach(() => {
    vi.mocked(findCachedAlertConfig).mockResolvedValue({
      id: 1, streamer_id: STREAMER_ID, event_type: 'follow', enabled: true,
      message_template: 'alert fired', image_filename: null, sound_filename: null, duration_ms: 6000,
      text_animation: 'none',
    } as any);
  });

  it('handleFollow still pushes the alert when the chat send rejects', async () => {
    mockSend.mockRejectedValueOnce(new Error('chat send failed'));
    await handleFollow('streamer', followEvent, makeConfig({ follow_enabled: true }), STREAMER_ID);
    expect(mockPushAlertEvent).toHaveBeenCalled();
  });

  it('handleSub still pushes the alert when the chat send rejects', async () => {
    mockSend.mockRejectedValueOnce(new Error('chat send failed'));
    await handleSub('streamer', subEvent, makeConfig({ sub_enabled: true }), STREAMER_ID);
    expect(mockPushAlertEvent).toHaveBeenCalled();
  });

  it('handleResub still pushes the alert when the chat send rejects', async () => {
    mockSend.mockRejectedValueOnce(new Error('chat send failed'));
    await handleResub('streamer', resubEvent, makeConfig({ sub_enabled: true }), STREAMER_ID);
    expect(mockPushAlertEvent).toHaveBeenCalled();
  });

  it('handleGiftSub still pushes the alert when the chat send rejects', async () => {
    mockSend.mockRejectedValueOnce(new Error('chat send failed'));
    await handleGiftSub('streamer', giftSubEvent, makeConfig({ sub_enabled: true }), STREAMER_ID);
    expect(mockPushAlertEvent).toHaveBeenCalled();
  });

  it('handleRaid still sends the welcome message, sends the shoutout, and pushes the alert when the welcome-message send rejects', async () => {
    mockSend.mockRejectedValueOnce(new Error('chat send failed'));
    vi.mocked(buildShoutoutMessage).mockResolvedValue('Go check out @raider!');

    await handleRaid('streamer', raidEvent, makeConfig({ raid_enabled: true, raid_shoutout_enabled: true }), STREAMER_ID);

    expect(mockSend).toHaveBeenCalledWith('streamer', 'Go check out @raider!');
    expect(mockPushAlertEvent).toHaveBeenCalled();
  });

  it('handleRaid still pushes the alert when buildShoutoutMessage rejects', async () => {
    vi.mocked(buildShoutoutMessage).mockRejectedValueOnce(new Error('helix lookup failed'));

    await handleRaid('streamer', raidEvent, makeConfig({ raid_enabled: false, raid_shoutout_enabled: true }), STREAMER_ID);

    expect(mockPushAlertEvent).toHaveBeenCalled();
  });

  it('handleRaid still pushes the alert when the shoutout send fails', async () => {
    vi.mocked(buildShoutoutMessage).mockResolvedValue('Go check out @raider!');
    mockSend.mockRejectedValueOnce(new Error('chat send failed'));

    await handleRaid('streamer', raidEvent, makeConfig({ raid_enabled: false, raid_shoutout_enabled: true }), STREAMER_ID);

    expect(mockPushAlertEvent).toHaveBeenCalled();
  });

  it('handleFollow does not reject when findCachedAlertConfig rejects (chat message still already sent)', async () => {
    vi.mocked(findCachedAlertConfig).mockRejectedValueOnce(new Error('db unavailable'));
    await expect(
      handleFollow('streamer', followEvent, makeConfig({ follow_enabled: true }), STREAMER_ID),
    ).resolves.toBeUndefined();
    expect(mockSend).toHaveBeenCalled();
    expect(mockPushAlertEvent).not.toHaveBeenCalled();
  });

  it('handleFollow does not reject when pushAlertEvent throws', async () => {
    mockPushAlertEvent.mockImplementationOnce(() => { throw new Error('overlay push failed'); });
    await expect(
      handleFollow('streamer', followEvent, makeConfig({ follow_enabled: false }), STREAMER_ID),
    ).resolves.toBeUndefined();
    expect(mockPushAlertEvent).toHaveBeenCalledOnce();
  });

  it('handleFollow still records the dashboard event when the chat send rejects', async () => {
    mockSend.mockRejectedValueOnce(new Error('chat send failed'));
    await handleFollow('streamer', followEvent, makeConfig({ follow_enabled: true }), STREAMER_ID);
    expect(mockPushDashboardEvent).toHaveBeenCalled();
  });

  it('handleFollow does not reject when recordStreamerEvent rejects', async () => {
    vi.mocked(recordStreamerEvent).mockRejectedValueOnce(new Error('db unavailable'));
    await expect(
      handleFollow('streamer', followEvent, makeConfig({ follow_enabled: false }), STREAMER_ID),
    ).resolves.toBeUndefined();
    expect(mockPushDashboardEvent).not.toHaveBeenCalled();
  });

  it('handleFollow does not reject when pushDashboardEvent throws', async () => {
    mockPushDashboardEvent.mockImplementationOnce(() => { throw new Error('sse push failed'); });
    await expect(
      handleFollow('streamer', followEvent, makeConfig({ follow_enabled: false }), STREAMER_ID),
    ).resolves.toBeUndefined();
    expect(mockPushDashboardEvent).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// handleRedemption
// ---------------------------------------------------------------------------
describe('handleRedemption', () => {
  const event = {
    id: 'redemption-1',
    user_login: 'redeemer',
    user_name: 'Redeemer',
    broadcaster_user_login: 'streamer',
    reward: { id: 'reward-abc', title: 'Cool Reward' },
    user_input: '',
  };
  const streamerId = 7;

  beforeEach(() => {
    vi.mocked(getStreamerById).mockResolvedValue({ discord_id: '999888777' } as any);
    seenRedemptionIds.clear();
    pendingRedemptionIds.clear();
  });

  it('does not call pushOverlayEvent when getVideosForReward returns an empty array', async () => {
    vi.mocked(getVideosForReward).mockResolvedValue([]);
    await handleRedemption('streamer', event, makeConfig(), streamerId);
    expect(mockPushOverlayEvent).not.toHaveBeenCalled();
  });

  it('calls pickWeightedRandom and pushOverlayEvent with correct path when videos are available', async () => {
    const videos = [{ file: 'clip1.mp4', weight: 1 }, { file: 'clip2.mp4', weight: 2 }] as any[];
    vi.mocked(getVideosForReward).mockResolvedValue(videos);
    vi.mocked(pickWeightedRandom).mockReturnValue('clip2.mp4');

    await handleRedemption('streamer', event, makeConfig(), streamerId);

    expect(getVideosForReward).toHaveBeenCalledWith('reward-abc', streamerId);
    expect(pickWeightedRandom).toHaveBeenCalledWith(videos);
    expect(mockPushOverlayEvent).toHaveBeenCalledWith('streamer', '/overlay/videos/7/clip2.mp4');
  });

  it('pushes a companion event keyed by the streamer discord_id even when no videos are configured', async () => {
    vi.mocked(getVideosForReward).mockResolvedValue([]);

    await handleRedemption('streamer', event, makeConfig(), streamerId);

    expect(getStreamerById).toHaveBeenCalledWith(streamerId);
    expect(mockPushCompanionEvent).toHaveBeenCalledWith('999888777', {
      type: 'channel_points_redemption',
      rewardId: 'reward-abc',
      rewardTitle: 'Cool Reward',
      userLogin: 'redeemer',
      userName: 'Redeemer',
      userInput: '',
      redeemedAt: expect.any(String),
    });
  });

  it('pushes a companion event in addition to triggering the overlay when videos are configured', async () => {
    const videos = [{ file: 'clip1.mp4', weight: 1 }] as any[];
    vi.mocked(getVideosForReward).mockResolvedValue(videos);
    vi.mocked(pickWeightedRandom).mockReturnValue('clip1.mp4');

    await handleRedemption('streamer', event, makeConfig(), streamerId);

    expect(mockPushCompanionEvent).toHaveBeenCalledWith('999888777', expect.objectContaining({ type: 'channel_points_redemption' }));
    expect(mockPushOverlayEvent).toHaveBeenCalledWith('streamer', '/overlay/videos/7/clip1.mp4');
  });

  it('does not push a companion event when the streamer cannot be found', async () => {
    vi.mocked(getStreamerById).mockResolvedValue(null);
    vi.mocked(getVideosForReward).mockResolvedValue([]);

    await handleRedemption('streamer', event, makeConfig(), streamerId);

    expect(mockPushCompanionEvent).not.toHaveBeenCalled();
  });

  it('still triggers the overlay when the companion lookup throws', async () => {
    vi.mocked(getStreamerById).mockRejectedValue(new Error('db unavailable'));
    const videos = [{ file: 'clip1.mp4', weight: 1 }] as any[];
    vi.mocked(getVideosForReward).mockResolvedValue(videos);
    vi.mocked(pickWeightedRandom).mockReturnValue('clip1.mp4');

    await handleRedemption('streamer', event, makeConfig(), streamerId);

    expect(mockPushCompanionEvent).not.toHaveBeenCalled();
    expect(mockPushOverlayEvent).toHaveBeenCalledWith('streamer', '/overlay/videos/7/clip1.mp4');
  });

  it('applies dynamic pricing for the redeemed reward', async () => {
    vi.mocked(getVideosForReward).mockResolvedValue([]);

    await handleRedemption('streamer', event, makeConfig(), streamerId);

    expect(applyRedemptionPricing).toHaveBeenCalledWith(streamerId, 'reward-abc');
  });

  it('records a dashboard event using the reward title as detail when there is no user input', async () => {
    vi.mocked(getVideosForReward).mockResolvedValue([]);

    await handleRedemption('streamer', event, makeConfig(), streamerId);

    expect(recordStreamerEvent).toHaveBeenCalledWith(streamerId, 'redemption', 'Redeemer', 'Cool Reward');
    expect(mockPushDashboardEvent).toHaveBeenCalledWith(streamerId, expect.objectContaining({
      eventType: 'redemption', displayName: 'Redeemer', detail: 'Cool Reward',
    }));
  });

  it('records a dashboard event including the viewer-entered text as detail when present', async () => {
    vi.mocked(getVideosForReward).mockResolvedValue([]);

    await handleRedemption('streamer', { ...event, user_input: 'drink water!' }, makeConfig(), streamerId);

    expect(recordStreamerEvent).toHaveBeenCalledWith(streamerId, 'redemption', 'Redeemer', 'Cool Reward: drink water!');
  });

  it('rejects and skips the overlay lookup when applyRedemptionPricing throws, since pricing is a required effect', async () => {
    vi.mocked(applyRedemptionPricing).mockRejectedValueOnce(new Error('pricing failed'));
    const videos = [{ file: 'clip1.mp4', weight: 1 }] as any[];
    vi.mocked(getVideosForReward).mockResolvedValue(videos);
    vi.mocked(pickWeightedRandom).mockReturnValue('clip1.mp4');

    await expect(handleRedemption('streamer', event, makeConfig(), streamerId)).rejects.toThrow('pricing failed');

    expect(getVideosForReward).not.toHaveBeenCalled();
    expect(mockPushOverlayEvent).not.toHaveBeenCalled();
    expect(mockPushCompanionEvent).not.toHaveBeenCalled();
  });

  it('delivers the companion event only once when a pricing failure is retried, since the best-effort companion push runs after the required effects', async () => {
    vi.mocked(applyRedemptionPricing).mockRejectedValueOnce(new Error('pricing failed'));
    vi.mocked(getVideosForReward).mockResolvedValue([]);

    await expect(handleRedemption('streamer', event, makeConfig(), streamerId)).rejects.toThrow('pricing failed');
    expect(mockPushCompanionEvent).not.toHaveBeenCalled();

    await expect(handleRedemption('streamer', event, makeConfig(), streamerId)).resolves.toBe(true);
    expect(mockPushCompanionEvent).toHaveBeenCalledOnce();
  });

  it('rejects and is not marked handled when recordStreamerEvent throws, since dashboard recording is a required effect', async () => {
    vi.mocked(recordStreamerEvent).mockRejectedValueOnce(new Error('db unavailable'));
    vi.mocked(getVideosForReward).mockResolvedValue([]);

    await expect(handleRedemption('streamer', event, makeConfig(), streamerId)).rejects.toThrow('db unavailable');

    expect(applyRedemptionPricing).not.toHaveBeenCalled();
    expect(mockPushDashboardEvent).not.toHaveBeenCalled();

    // A retry with the same id must not be dropped as a duplicate.
    vi.mocked(recordStreamerEvent).mockResolvedValue(undefined);
    vi.mocked(getVideosForReward).mockResolvedValue([]);
    await expect(handleRedemption('streamer', event, makeConfig(), streamerId)).resolves.toBe(true);
  });

  it('ignores a second notification carrying the same redemption id', async () => {
    const videos = [{ file: 'clip1.mp4', weight: 1 }] as any[];
    vi.mocked(getVideosForReward).mockResolvedValue(videos);
    vi.mocked(pickWeightedRandom).mockReturnValue('clip1.mp4');

    await handleRedemption('streamer', event, makeConfig(), streamerId);
    await handleRedemption('streamer', event, makeConfig(), streamerId);

    expect(recordStreamerEvent).toHaveBeenCalledOnce();
    expect(mockPushDashboardEvent).toHaveBeenCalledOnce();
    expect(mockPushCompanionEvent).toHaveBeenCalledOnce();
    expect(applyRedemptionPricing).toHaveBeenCalledOnce();
    expect(getVideosForReward).toHaveBeenCalledOnce();
    expect(mockPushOverlayEvent).toHaveBeenCalledOnce();
  });

  it('retries and completes on a second attempt with the same redemption id after the first attempt throws', async () => {
    const videos = [{ file: 'clip1.mp4', weight: 1 }] as any[];
    vi.mocked(getVideosForReward).mockRejectedValueOnce(new Error('transient db error'));

    await expect(handleRedemption('streamer', event, makeConfig(), streamerId)).rejects.toThrow('transient db error');

    // The failed attempt must not be misclassified as "already handled" — none of its effects
    // should have been left counted from a partial run, and a retry must be free to run again.
    vi.mocked(getVideosForReward).mockResolvedValue(videos);
    vi.mocked(pickWeightedRandom).mockReturnValue('clip1.mp4');

    await expect(handleRedemption('streamer', event, makeConfig(), streamerId)).resolves.toBe(true);

    // The dashboard/companion/pricing effects run ahead of the getVideosForReward call that
    // failed the first time, so they fire once per attempt (twice total); the overlay trigger
    // only ever completes on the successful second attempt.
    expect(recordStreamerEvent).toHaveBeenCalledTimes(2);
    expect(mockPushDashboardEvent).toHaveBeenCalledTimes(2);
    expect(mockPushCompanionEvent).toHaveBeenCalledTimes(2);
    expect(applyRedemptionPricing).toHaveBeenCalledTimes(2);
    expect(mockPushOverlayEvent).toHaveBeenCalledOnce();
    expect(mockPushOverlayEvent).toHaveBeenCalledWith('streamer', '/overlay/videos/7/clip1.mp4');
  });

  it('processes two notifications with different redemption ids normally', async () => {
    vi.mocked(getVideosForReward).mockResolvedValue([]);

    await handleRedemption('streamer', event, makeConfig(), streamerId);
    await handleRedemption('streamer', { ...event, id: 'redemption-2' }, makeConfig(), streamerId);

    expect(recordStreamerEvent).toHaveBeenCalledTimes(2);
  });

  it('resolves true when the redemption is actually processed, and false for a duplicate', async () => {
    vi.mocked(getVideosForReward).mockResolvedValue([]);

    await expect(handleRedemption('streamer', event, makeConfig(), streamerId)).resolves.toBe(true);
    await expect(handleRedemption('streamer', event, makeConfig(), streamerId)).resolves.toBe(false);
  });
});

// ---------------------------------------------------------------------------
// handleStreamOnline / handleStreamOffline
// ---------------------------------------------------------------------------
describe('handleStreamOnline', () => {
  it('triggers an immediate live-check for the broadcaster login', async () => {
    await handleStreamOnline('streamer');
    expect(triggerImmediateLiveCheck).toHaveBeenCalledWith('streamer');
  });
});

describe('handleStreamOffline', () => {
  it('triggers an immediate live-check for the broadcaster login', async () => {
    await handleStreamOffline('streamer');
    expect(triggerImmediateLiveCheck).toHaveBeenCalledWith('streamer');
  });
});

describe('handleChannelUpdate', () => {
  it('triggers an immediate live-check for the broadcaster login', async () => {
    await handleChannelUpdate('streamer');
    expect(triggerImmediateLiveCheck).toHaveBeenCalledWith('streamer');
  });
});
