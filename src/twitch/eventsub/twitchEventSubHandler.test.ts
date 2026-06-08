import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db', () => ({ getVideosForReward: vi.fn() }));
vi.mock('../../commands/soundSelector', () => ({ pickWeightedRandom: vi.fn() }));
vi.mock('../../shared/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));

import { handleFollow, handleSub, handleResub, handleGiftSub, handleRaid, handleRedemption, registerEventSubOverlayRuntime, registerEventSubTwitchRuntime } from './twitchEventSubHandler';
import { getVideosForReward } from '../../db';
import { pickWeightedRandom } from '../../commands/soundSelector';

const mockSend = vi.fn<(channel: string, message: string) => Promise<void>>();
registerEventSubTwitchRuntime({ send: mockSend });

const mockPushOverlayEvent = vi.fn();
registerEventSubOverlayRuntime({ pushOverlayEvent: mockPushOverlayEvent });

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

  it('does not call sayInChannel when follow_enabled is false', async () => {
    await handleFollow('streamer', event, makeConfig({ follow_enabled: false }));
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('calls sayInChannel with substituted {username} and {display_name} when follow_enabled is true', async () => {
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

  it('does not call sayInChannel when sub_enabled is false', async () => {
    await handleSub('streamer', { ...baseEvent }, makeConfig({ sub_enabled: false }));
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('does not call sayInChannel when is_gift is true even if sub_enabled is true', async () => {
    await handleSub('streamer', { ...baseEvent, is_gift: true }, makeConfig({ sub_enabled: true }));
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('calls sayInChannel with {tier} and {tier_name} substituted (Tier 1)', async () => {
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

  it('calls sayInChannel with {months} and {streak} substituted when sub_enabled is true', async () => {
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

  it('does not call sayInChannel when sub_enabled is false', async () => {
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

  it('does not call sayInChannel when sub_enabled is false', async () => {
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

  it('does not call sayInChannel when raid_enabled is false', async () => {
    await handleRaid('streamer', event, makeConfig({ raid_enabled: false }));
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('calls sayInChannel with {from_channel}, {from_display}, {viewers} substituted when raid_enabled is true', async () => {
    await handleRaid('streamer', event, makeConfig({
      raid_enabled: true,
      raid_message: '{from_channel} ({from_display}) viewers={viewers}',
    }));
    expect(mockSend).toHaveBeenCalledWith('streamer', 'raider (RaiderDisplay) viewers=42');
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

  it('does not call pushOverlayEvent when getVideosForReward returns an empty array', async () => {
    vi.mocked(getVideosForReward).mockResolvedValue([]);
    await handleRedemption('streamer', event, makeConfig(), streamerId);
    expect(mockPushOverlayEvent).not.toHaveBeenCalled();
  });

  it('calls pickWeightedRandom and pushOverlayEvent with correct path when videos are available', async () => {
    const videos = [{ filename: 'clip1.mp4', weight: 1 }, { filename: 'clip2.mp4', weight: 2 }] as any[];
    vi.mocked(getVideosForReward).mockResolvedValue(videos);
    vi.mocked(pickWeightedRandom).mockReturnValue('clip2.mp4');

    await handleRedemption('streamer', event, makeConfig(), streamerId);

    expect(getVideosForReward).toHaveBeenCalledWith('reward-abc', streamerId);
    expect(pickWeightedRandom).toHaveBeenCalledWith(videos);
    expect(mockPushOverlayEvent).toHaveBeenCalledWith('streamer', '/overlay/videos/7/clip2.mp4');
  });
});
