import { sayInChannel } from '../twitchBot';
import type { EventSubConfig } from '../../db';
import { getVideosForReward } from '../../db';
import { pickWeightedRandom } from '../../commands/soundSelector';
import { createLogger } from '../../shared/logger';

const log = createLogger('EventSubHandler');

// Runtime injection for the overlay push function — avoids a direct import of the
// web layer from core Twitch handler code.  registerEventSubOverlayRuntime is called
// from index.ts before startWebPanel(), which is safe because pushOverlayEvent is
// just a function reference and does not require the HTTP server to be running.
/**
 * Public contract for the overlay runtime injection.
 * Passed to {@link registerEventSubOverlayRuntime} from index.ts.
 */
interface EventSubOverlayRuntime {
  /**
   * Push an overlay event to the named channel's SSE stream.
   * @param login - Broadcaster login name.
   * @param videoPath - Server-relative path of the video to display.
   */
  pushOverlayEvent: (login: string, videoPath: string) => void;
}

let _overlayRuntime: EventSubOverlayRuntime | null = null;

/** Register the overlay push function. Called from index.ts after startWebPanel(). */
export function registerEventSubOverlayRuntime(runtime: EventSubOverlayRuntime): void {
  _overlayRuntime = runtime;
}

export interface FollowEvent {
  user_login: string;
  user_name: string;
  broadcaster_user_login: string;
}

export interface SubEvent {
  user_login: string;
  user_name: string;
  broadcaster_user_login: string;
  tier: string;
  is_gift: boolean;
}

export interface ResubEvent {
  user_login: string;
  user_name: string;
  broadcaster_user_login: string;
  tier: string;
  cumulative_months: number;
  streak_months: number | null;
}

export interface GiftSubEvent {
  user_login: string;
  user_name: string;
  broadcaster_user_login: string;
  total: number;
  tier: string;
  is_anonymous: boolean;
}

export interface RaidEvent {
  from_broadcaster_user_login: string;
  from_broadcaster_user_name: string;
  to_broadcaster_user_login: string;
  viewers: number;
}

export interface RedemptionEvent {
  id: string;
  user_login: string;
  user_name: string;
  broadcaster_user_login: string;
  reward: { id: string; title: string };
  user_input: string;
}

function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? '');
}

function tierName(tier: string): string {
  return ({ '1000': 'Tier 1', '2000': 'Tier 2', '3000': 'Tier 3' } as Record<string, string>)[tier] ?? tier;
}

export async function handleFollow(login: string, event: FollowEvent, config: EventSubConfig): Promise<void> {
  if (!config.follow_enabled) return;
  const msg = fill(config.follow_message, {
    username: event.user_login,
    display_name: event.user_name,
  });
  await sayInChannel(login, msg);
}

export async function handleSub(login: string, event: SubEvent, config: EventSubConfig): Promise<void> {
  if (!config.sub_enabled || event.is_gift) return;
  const msg = fill(config.sub_message, {
    username: event.user_login,
    display_name: event.user_name,
    tier: event.tier,
    tier_name: tierName(event.tier),
  });
  await sayInChannel(login, msg);
}

export async function handleResub(login: string, event: ResubEvent, config: EventSubConfig): Promise<void> {
  if (!config.sub_enabled) return;
  const msg = fill(config.resub_message, {
    username: event.user_login,
    display_name: event.user_name,
    tier: event.tier,
    tier_name: tierName(event.tier),
    months: String(event.cumulative_months),
    streak: event.streak_months != null ? String(event.streak_months) : '0',
  });
  await sayInChannel(login, msg);
}

export async function handleGiftSub(login: string, event: GiftSubEvent, config: EventSubConfig): Promise<void> {
  if (!config.sub_enabled) return;
  const gifter = event.is_anonymous ? 'anonymous' : event.user_login;
  const gifterDisplay = event.is_anonymous ? 'Anonymous' : event.user_name;
  const msg = fill(config.giftsub_message, {
    gifter,
    gifter_display: gifterDisplay,
    count: String(event.total),
    tier: event.tier,
    tier_name: tierName(event.tier),
  });
  await sayInChannel(login, msg);
}

export async function handleRaid(login: string, event: RaidEvent, config: EventSubConfig): Promise<void> {
  if (!config.raid_enabled) return;
  const msg = fill(config.raid_message, {
    from_channel: event.from_broadcaster_user_login,
    from_display: event.from_broadcaster_user_name,
    viewers: String(event.viewers),
  });
  await sayInChannel(login, msg);
}

export async function handleRedemption(
  login: string,
  event: RedemptionEvent,
  _config: EventSubConfig,
  streamerId: number,
): Promise<void> {
  const videos = await getVideosForReward(event.reward.id, streamerId);
  if (videos.length === 0) return;

  const filename = pickWeightedRandom(videos);
  const videoPath = `/overlay/videos/${streamerId}/${filename}`;
  _overlayRuntime?.pushOverlayEvent(login, videoPath);
  log.info(`Overlay triggered for ${login}: reward="${event.reward.title}" video=${filename}`);
}
