import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db', () => ({ getVideosForReward: vi.fn(), getStreamerById: vi.fn() }));
vi.mock('../../commands/soundSelector', () => ({ pickWeightedRandom: vi.fn() }));
vi.mock('../../commands/shoutoutHandler', () => ({ buildShoutoutMessage: vi.fn() }));
vi.mock('../../commands/commandMonitorStore', () => ({ recordCommandTestEntry: vi.fn() }));
vi.mock('../../shared/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
vi.mock('../monitor/twitchMonitor', () => ({ triggerImmediateLiveCheck: vi.fn().mockResolvedValue(undefined) }));

import {
  handleFollow, handleSub, handleResub, handleGiftSub, handleRaid, handleRedemption,
  handleStreamOnline, handleStreamOffline, handleChannelUpdate,
  registerEventSubOverlayRuntime, registerEventSubTwitchRuntime, registerEventSubCompanionRuntime,
} from './twitchEventSubHandler';
import { getVideosForReward, getStreamerById } from '../../db';
import { pickWeightedRandom } from '../../commands/soundSelector';
import { buildShoutoutMessage } from '../../commands/shoutoutHandler';
import { recordCommandTestEntry } from '../../commands/commandMonitorStore';
import { triggerImmediateLiveCheck } from '../monitor/twitchMonitor';

const mockSend = vi.fn<(channel: string, message: string) => Promise<void>>();
registerEventSubTwitchRuntime({ send: mockSend });

const mockPushOverlayEvent = vi.fn();
registerEventSubOverlayRuntime({ pushOverlayEvent: mockPushOverlayEvent });

const mockPushCompanionEvent = vi.fn();
registerEventSubCompanionRuntime({ pushCompanionEvent: mockPushCompanionEvent });

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
    await handleFollow('streamer', event, makeConfig({ follow_enabled: false }));
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('calls injected runtime (mockSend) with substituted {username} and {display_name} when follow_enabled is true', async () => {
    await handleFollow('streamer', event, makeConfig({
      follow_enabled: true,
      follow_message: 'Welcome {username} aka {display_name}!',
    }));
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
    await handleSub('streamer', { ...baseEvent }, makeConfig({ sub_enabled: false }));
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('does not call injected runtime when is_gift is true even if sub_enabled is true', async () => {
    await handleSub('streamer', { ...baseEvent, is_gift: true }, makeConfig({ sub_enabled: true }));
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('calls injected runtime (mockSend) with {tier} and {tier_name} substituted (Tier 1)', async () => {
    await handleSub('streamer', { ...baseEvent, tier: '1000' }, makeConfig({
      sub_enabled: true,
      sub_message: 'tier={tier} name={tier_name}',
    }));
    expect(mockSend).toHaveBeenCalledWith('streamer', 'tier=1000 name=Tier 1');
  });

  it('tierName maps 2000 to Tier 2', async () => {
    await handleSub('streamer', { ...baseEvent, tier: '2000' }, makeConfig({
      sub_enabled: true,
      sub_message: 'name={tier_name}',
    }));
    expect(mockSend).toHaveBeenCalledWith('streamer', 'name=Tier 2');
  });

  it('tierName maps 3000 to Tier 3', async () => {
    await handleSub('streamer', { ...baseEvent, tier: '3000' }, makeConfig({
      sub_enabled: true,
      sub_message: 'name={tier_name}',
    }));
    expect(mockSend).toHaveBeenCalledWith('streamer', 'name=Tier 3');
  });

  it('tierName passes unknown tier through unchanged', async () => {
    await handleSub('streamer', { ...baseEvent, tier: 'prime' }, makeConfig({
      sub_enabled: true,
      sub_message: 'name={tier_name}',
    }));
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
    }));
    expect(mockSend).toHaveBeenCalledWith('streamer', 'months=6 streak=3');
  });

  it('substitutes {streak} as "0" when streak_months is null', async () => {
    await handleResub('streamer', { ...baseEvent, streak_months: null }, makeConfig({
      sub_enabled: true,
      resub_message: 'streak={streak}',
    }));
    expect(mockSend).toHaveBeenCalledWith('streamer', 'streak=0');
  });

  it('substitutes {streak} as the number string when streak_months is set', async () => {
    await handleResub('streamer', { ...baseEvent, streak_months: 12 }, makeConfig({
      sub_enabled: true,
      resub_message: 'streak={streak}',
    }));
    expect(mockSend).toHaveBeenCalledWith('streamer', 'streak=12');
  });

  it('does not call injected runtime when sub_enabled is false', async () => {
    await handleResub('streamer', baseEvent, makeConfig({ sub_enabled: false }));
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
    await handleGiftSub('streamer', baseEvent, makeConfig({ sub_enabled: false }));
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('uses "anonymous" and "Anonymous" for {gifter} and {gifter_display} when is_anonymous is true', async () => {
    await handleGiftSub('streamer', { ...baseEvent, is_anonymous: true }, makeConfig({
      sub_enabled: true,
      giftsub_message: '{gifter} / {gifter_display}',
    }));
    expect(mockSend).toHaveBeenCalledWith('streamer', 'anonymous / Anonymous');
  });

  it('uses event.user_login as {gifter} when is_anonymous is false', async () => {
    await handleGiftSub('streamer', { ...baseEvent, is_anonymous: false }, makeConfig({
      sub_enabled: true,
      giftsub_message: '{gifter} / {gifter_display}',
    }));
    expect(mockSend).toHaveBeenCalledWith('streamer', 'gifter / GifterDisplay');
  });

  it('substitutes {count} correctly', async () => {
    await handleGiftSub('streamer', { ...baseEvent, total: 3 }, makeConfig({
      sub_enabled: true,
      giftsub_message: 'count={count}',
    }));
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
    await handleRaid('streamer', event, makeConfig({ raid_enabled: false }));
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('calls injected runtime (mockSend) with {from_channel}, {from_display}, {viewers} substituted when raid_enabled is true', async () => {
    await handleRaid('streamer', event, makeConfig({
      raid_enabled: true,
      raid_message: '{from_channel} ({from_display}) viewers={viewers}',
    }));
    expect(mockSend).toHaveBeenCalledWith('streamer', 'raider (RaiderDisplay) viewers=42');
  });

  it('sends the shoutout for the raiding channel when raid_shoutout_enabled is true, even if raid_enabled is false', async () => {
    vi.mocked(buildShoutoutMessage).mockResolvedValue('Go check out @raider!');

    await handleRaid('streamer', event, makeConfig({ raid_enabled: false, raid_shoutout_enabled: true }));

    expect(buildShoutoutMessage).toHaveBeenCalledWith('raider');
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledWith('streamer', 'Go check out @raider!');
  });

  it('records the auto-shoutout via recordCommandTestEntry for monitor-panel visibility', async () => {
    vi.mocked(buildShoutoutMessage).mockResolvedValue('Go check out @raider!');

    await handleRaid('streamer', event, makeConfig({ raid_shoutout_enabled: true }));

    expect(recordCommandTestEntry).toHaveBeenCalledWith(expect.objectContaining({
      source: 'twitch',
      command: '!so (raid)',
      response: 'Go check out @raider!',
      channel: 'streamer',
      user: 'raider',
    }));
  });

  it('sends both the welcome message and the shoutout when both toggles are on (independent)', async () => {
    vi.mocked(buildShoutoutMessage).mockResolvedValue('Go check out @raider!');

    await handleRaid('streamer', event, makeConfig({
      raid_enabled: true,
      raid_message: 'Welcome {from_channel}!',
      raid_shoutout_enabled: true,
    }));

    expect(mockSend).toHaveBeenCalledWith('streamer', 'Welcome raider!');
    expect(mockSend).toHaveBeenCalledWith('streamer', 'Go check out @raider!');
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it('does not send a shoutout when raid_shoutout_enabled is true but the raiding channel is not found on Twitch', async () => {
    vi.mocked(buildShoutoutMessage).mockResolvedValue(null);

    await handleRaid('streamer', event, makeConfig({ raid_enabled: false, raid_shoutout_enabled: true }));

    expect(mockSend).not.toHaveBeenCalled();
    expect(recordCommandTestEntry).not.toHaveBeenCalled();
  });

  it('does not look up a shoutout when raid_shoutout_enabled is false', async () => {
    await handleRaid('streamer', event, makeConfig({ raid_enabled: true, raid_shoutout_enabled: false }));

    expect(buildShoutoutMessage).not.toHaveBeenCalled();
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
