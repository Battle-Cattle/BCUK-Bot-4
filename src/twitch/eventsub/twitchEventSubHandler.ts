import type { EventSubConfig } from '../../db';
import { getVideosForReward, getStreamerById } from '../../db';
import { pickWeightedRandom } from '../../commands/soundSelector';
import { createLogger } from '../../shared/logger';
import { triggerImmediateLiveCheck } from '../monitor/twitchMonitor';

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

// Runtime injection for the companion app push function — same rationale as
// EventSubOverlayRuntime above. Registered from index.ts after startWebPanel().
/**
 * Public contract for the companion app runtime injection.
 * Passed to {@link registerEventSubCompanionRuntime} from index.ts.
 */
interface EventSubCompanionRuntime {
  /**
   * Push a companion event to the named Discord user's SSE stream.
   * @param discordId - Discord snowflake of the streamer who owns the redemption.
   * @param event - The companion event payload to deliver.
   */
  pushCompanionEvent: (discordId: string, event: import('../../web/routes/companionEvents').CompanionEvent) => void;
}

let _companionRuntime: EventSubCompanionRuntime | null = null;

/** Register the companion app push function. Called from index.ts after startWebPanel(). */
export function registerEventSubCompanionRuntime(runtime: EventSubCompanionRuntime): void {
  _companionRuntime = runtime;
}

// Runtime injection for the Twitch chat send function — avoids a direct import
// of twitchBot from core EventSub handler code.  Registered from index.ts.
interface EventSubTwitchRuntime {
  send: (channel: string, message: string) => Promise<void>;
}

let _twitchRuntime: EventSubTwitchRuntime | null = null;

/**
 * Register the Twitch chat send function. Called from index.ts during initialisation,
 * before startTwitchBot(), so the runtime is in place before the first event arrives.
 * Stores the provided runtime in the module-level _twitchRuntime variable for later use.
 *
 * @param runtime - The {@link EventSubTwitchRuntime} to store; must supply a `send` function
 *   that delivers a chat message to the given channel.
 * @returns void
 */
export function registerEventSubTwitchRuntime(runtime: EventSubTwitchRuntime): void {
  _twitchRuntime = runtime;
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

/**
 * Handle a channel.follow EventSub notification.
 * Sends a chat message to the broadcaster's channel using the injected `_twitchRuntime`.
 * No-ops when `config.follow_enabled` is false or `_twitchRuntime` has not been registered.
 *
 * @param login - Broadcaster login name (chat channel to send to).
 * @param event - Follow event payload from Twitch EventSub.
 * @param config - Streamer's event response configuration.
 */
export async function handleFollow(login: string, event: FollowEvent, config: EventSubConfig): Promise<void> {
  if (!config.follow_enabled) return;
  const msg = fill(config.follow_message, {
    username: event.user_login,
    display_name: event.user_name,
  });
  await _twitchRuntime?.send(login, msg);
}

/**
 * Handle a channel.subscribe EventSub notification.
 * No-ops when `config.sub_enabled` is false, the subscription is a gift, or `_twitchRuntime` is absent.
 *
 * @param login - Broadcaster login name.
 * @param event - Subscribe event payload; gift subs are silently skipped (handled by handleGiftSub).
 * @param config - Streamer's event response configuration.
 */
export async function handleSub(login: string, event: SubEvent, config: EventSubConfig): Promise<void> {
  if (!config.sub_enabled || event.is_gift) return;
  const msg = fill(config.sub_message, {
    username: event.user_login,
    display_name: event.user_name,
    tier: event.tier,
    tier_name: tierName(event.tier),
  });
  await _twitchRuntime?.send(login, msg);
}

/**
 * Handle a channel.subscription.message (resub) EventSub notification.
 * No-ops when `config.sub_enabled` is false or `_twitchRuntime` is absent.
 *
 * @param login - Broadcaster login name.
 * @param event - Resub event payload including cumulative and streak month counts.
 * @param config - Streamer's event response configuration.
 */
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
  await _twitchRuntime?.send(login, msg);
}

/**
 * Handle a channel.subscription.gift EventSub notification.
 * Anonymous gifters are reported as "anonymous" / "Anonymous".
 * No-ops when `config.sub_enabled` is false or `_twitchRuntime` is absent.
 *
 * @param login - Broadcaster login name.
 * @param event - Gift-sub event payload; `is_anonymous` controls gifter display name.
 * @param config - Streamer's event response configuration.
 */
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
  await _twitchRuntime?.send(login, msg);
}

/**
 * Handle a channel.raid EventSub notification.
 * No-ops when `config.raid_enabled` is false or `_twitchRuntime` is absent.
 *
 * @param login - Broadcaster login name (the raid target's channel).
 * @param event - Raid event payload including the raiding channel and viewer count.
 * @param config - Streamer's event response configuration.
 */
export async function handleRaid(login: string, event: RaidEvent, config: EventSubConfig): Promise<void> {
  if (!config.raid_enabled) return;
  const msg = fill(config.raid_message, {
    from_channel: event.from_broadcaster_user_login,
    from_display: event.from_broadcaster_user_name,
    viewers: String(event.viewers),
  });
  await _twitchRuntime?.send(login, msg);
}

/**
 * Handle a channel.channel_points_custom_reward_redemption.add EventSub notification.
 * Unconditionally forwards the redemption to the streamer's companion app (if any device
 * is connected), then separately looks up videos configured for the redeemed reward and
 * triggers an overlay event if found. The overlay push still no-ops when no videos are
 * configured for the reward or `_overlayRuntime` is absent. The companion push is isolated
 * in its own try/catch so a failure there (e.g. a DB error from `getStreamerById`) cannot
 * prevent the independent overlay-video logic below from running.
 *
 * @param login - Broadcaster login name.
 * @param event - Redemption event payload including reward ID and user details.
 * @param _config - Streamer event config (unused for redemptions; reserved for future use).
 * @param streamerId - DB row ID of the streamer, used to scope video lookups and resolve the owning Discord ID.
 */
export async function handleRedemption(
  login: string,
  event: RedemptionEvent,
  _config: EventSubConfig,
  streamerId: number,
): Promise<void> {
  try {
    const streamer = await getStreamerById(streamerId);
    if (streamer) {
      _companionRuntime?.pushCompanionEvent(streamer.discord_id, {
        type: 'channel_points_redemption',
        rewardId: event.reward.id,
        rewardTitle: event.reward.title,
        userLogin: event.user_login,
        userName: event.user_name,
        userInput: event.user_input,
        redeemedAt: new Date().toISOString(),
      });
    }
  } catch (err) {
    log.error('Failed to push companion event for redemption:', err);
  }

  const videos = await getVideosForReward(event.reward.id, streamerId);
  if (videos.length === 0) return;

  const filename = pickWeightedRandom(videos);
  const videoPath = `/overlay/videos/${streamerId}/${filename}`;
  _overlayRuntime?.pushOverlayEvent(login, videoPath);
  log.info(`Overlay triggered for ${login}: reward="${event.reward.title}" video=${filename}`);
}

/**
 * Handle a stream.online EventSub notification by triggering an immediate live-check
 * for the broadcaster, bypassing the Twitch monitor's 60s poll interval. The poller
 * still runs as a fallback for streamers without EventSub connected, and re-checking
 * here is harmless if it already caught the change first.
 *
 * @param login - Broadcaster login name.
 * @returns Resolves after triggering the immediate live-check.
 */
export async function handleStreamOnline(login: string): Promise<void> {
  await triggerImmediateLiveCheck(login);
}

/**
 * Handle a stream.offline EventSub notification by triggering an immediate live-check
 * for the broadcaster. This starts the same 5-minute offline grace period the poller
 * uses before removing the live announcement, since both paths share the same
 * `liveStates` map.
 *
 * @param login - Broadcaster login name.
 * @returns Resolves after triggering the immediate live-check.
 */
export async function handleStreamOffline(login: string): Promise<void> {
  await triggerImmediateLiveCheck(login);
}

/**
 * Handle a channel.update EventSub notification (title/category change) by triggering
 * an immediate live-check for the broadcaster. Reuses the same poll-and-decide logic
 * as stream.online/offline, so a title or game change posted via Twitch is reflected
 * on Discord without waiting for the next 60s poll.
 *
 * @param login - Broadcaster login name.
 * @returns Resolves after triggering the immediate live-check.
 */
export async function handleChannelUpdate(login: string): Promise<void> {
  await triggerImmediateLiveCheck(login);
}
