import type { EventSubConfig } from '../../db';
import { getVideosForReward, getStreamerById } from '../../db';
import { pickWeightedRandom } from '../../commands/soundSelector';
import { buildShoutoutMessage } from '../../commands/shoutoutHandler';
import { recordCommandTestEntry } from '../../commands/commandMonitorStore';
import { createLogger } from '../../shared/logger';
import { triggerImmediateLiveCheck } from '../monitor/twitchMonitor';
import { fillTemplate } from '../../shared/textTemplate';
import { applyRedemptionPricing } from '../pricing/rewardPricingService';
import { createRuntimeRegistry } from '../../commands/twitchRuntime';

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

const overlayRuntimeRegistry = createRuntimeRegistry<EventSubOverlayRuntime>();

/**
 * Register the overlay push function. Called from index.ts after startWebPanel().
 * @param runtime - The {@link EventSubOverlayRuntime} to store.
 * @returns void
 */
export function registerEventSubOverlayRuntime(runtime: EventSubOverlayRuntime): void {
  overlayRuntimeRegistry.register(runtime);
}

// Runtime injection for the companion app push function — same rationale as
// EventSubOverlayRuntime above. Registered from index.ts before startWebPanel(),
// since pushCompanionEvent is just a function reference and doesn't require the
// HTTP server to be running yet.
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

const companionRuntimeRegistry = createRuntimeRegistry<EventSubCompanionRuntime>();

/**
 * Register the companion app push function. Called from index.ts before startWebPanel().
 * @param runtime - The {@link EventSubCompanionRuntime} to store.
 * @returns void
 */
export function registerEventSubCompanionRuntime(runtime: EventSubCompanionRuntime): void {
  companionRuntimeRegistry.register(runtime);
}

// Runtime injection for the Twitch chat send function — avoids a direct import
// of twitchBot from core EventSub handler code.  Registered from index.ts.
interface EventSubTwitchRuntime {
  send: (channel: string, message: string) => Promise<void>;
}

const twitchRuntimeRegistry = createRuntimeRegistry<EventSubTwitchRuntime>();

/**
 * Register the Twitch chat send function. Called from index.ts during initialisation,
 * before startTwitchBot(), so the runtime is in place before the first event arrives.
 *
 * @param runtime - The {@link EventSubTwitchRuntime} to store; must supply a `send` function
 *   that delivers a chat message to the given channel.
 * @returns void
 */
export function registerEventSubTwitchRuntime(runtime: EventSubTwitchRuntime): void {
  twitchRuntimeRegistry.register(runtime);
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

function tierName(tier: string): string {
  return ({ '1000': 'Tier 1', '2000': 'Tier 2', '3000': 'Tier 3' } as Record<string, string>)[tier] ?? tier;
}

/**
 * Handle a channel.follow EventSub notification.
 * Sends a chat message to the broadcaster's channel using the injected Twitch runtime.
 * No-ops when `config.follow_enabled` is false or no Twitch runtime has been registered.
 *
 * @param login - Broadcaster login name (chat channel to send to).
 * @param event - Follow event payload from Twitch EventSub.
 * @param config - Streamer's event response configuration.
 */
export async function handleFollow(login: string, event: FollowEvent, config: EventSubConfig): Promise<void> {
  if (!config.follow_enabled) return;
  const msg = fillTemplate(config.follow_message, {
    username: event.user_login,
    display_name: event.user_name,
  });
  await twitchRuntimeRegistry.get()?.send(login, msg);
}

/**
 * Handle a channel.subscribe EventSub notification.
 * No-ops when `config.sub_enabled` is false, the subscription is a gift, or no Twitch runtime is registered.
 *
 * @param login - Broadcaster login name.
 * @param event - Subscribe event payload; gift subs are silently skipped (handled by handleGiftSub).
 * @param config - Streamer's event response configuration.
 */
export async function handleSub(login: string, event: SubEvent, config: EventSubConfig): Promise<void> {
  if (!config.sub_enabled || event.is_gift) return;
  const msg = fillTemplate(config.sub_message, {
    username: event.user_login,
    display_name: event.user_name,
    tier: event.tier,
    tier_name: tierName(event.tier),
  });
  await twitchRuntimeRegistry.get()?.send(login, msg);
}

/**
 * Handle a channel.subscription.message (resub) EventSub notification.
 * No-ops when `config.sub_enabled` is false or no Twitch runtime is registered.
 *
 * @param login - Broadcaster login name.
 * @param event - Resub event payload including cumulative and streak month counts.
 * @param config - Streamer's event response configuration.
 */
export async function handleResub(login: string, event: ResubEvent, config: EventSubConfig): Promise<void> {
  if (!config.sub_enabled) return;
  const msg = fillTemplate(config.resub_message, {
    username: event.user_login,
    display_name: event.user_name,
    tier: event.tier,
    tier_name: tierName(event.tier),
    months: String(event.cumulative_months),
    streak: event.streak_months != null ? String(event.streak_months) : '0',
  });
  await twitchRuntimeRegistry.get()?.send(login, msg);
}

/**
 * Handle a channel.subscription.gift EventSub notification.
 * Anonymous gifters are reported as "anonymous" / "Anonymous".
 * No-ops when `config.sub_enabled` is false or no Twitch runtime is registered.
 *
 * @param login - Broadcaster login name.
 * @param event - Gift-sub event payload; `is_anonymous` controls gifter display name.
 * @param config - Streamer's event response configuration.
 */
export async function handleGiftSub(login: string, event: GiftSubEvent, config: EventSubConfig): Promise<void> {
  if (!config.sub_enabled) return;
  const gifter = event.is_anonymous ? 'anonymous' : event.user_login;
  const gifterDisplay = event.is_anonymous ? 'Anonymous' : event.user_name;
  const msg = fillTemplate(config.giftsub_message, {
    gifter,
    gifter_display: gifterDisplay,
    count: String(event.total),
    tier: event.tier,
    tier_name: tierName(event.tier),
  });
  await twitchRuntimeRegistry.get()?.send(login, msg);
}

/**
 * Handle a channel.raid EventSub notification. Two independent behaviours are gated
 * by their own config flags and neither depends on the other:
 *  - `config.raid_enabled` — sends the configured welcome message.
 *  - `config.raid_shoutout_enabled` — looks up the raiding channel via
 *    {@link buildShoutoutMessage} (the same Helix lookup path as the `!so` command)
 *    and sends the resulting shoutout, recording the match via `recordCommandTestEntry`
 *    for monitor-panel visibility. No-ops silently if the raiding channel can't be
 *    resolved on Twitch.
 * Both branches no-op when no Twitch runtime has been registered.
 *
 * @param login - Broadcaster login name (the raid target's channel).
 * @param event - Raid event payload including the raiding channel and viewer count.
 * @param config - Streamer's event response configuration.
 */
export async function handleRaid(login: string, event: RaidEvent, config: EventSubConfig): Promise<void> {
  if (config.raid_enabled) {
    const msg = fillTemplate(config.raid_message, {
      from_channel: event.from_broadcaster_user_login,
      from_display: event.from_broadcaster_user_name,
      viewers: String(event.viewers),
    });
    await twitchRuntimeRegistry.get()?.send(login, msg);
  }

  if (config.raid_shoutout_enabled) {
    const shoutoutMsg = await buildShoutoutMessage(event.from_broadcaster_user_login);
    if (shoutoutMsg) {
      await twitchRuntimeRegistry.get()?.send(login, shoutoutMsg);
      recordCommandTestEntry({
        source: 'twitch',
        command: '!so (raid)',
        response: shoutoutMsg,
        channel: login,
        user: event.from_broadcaster_user_login,
      });
    }
  }
}

/**
 * Handle a channel.channel_points_custom_reward_redemption.add EventSub notification.
 * Unconditionally forwards the redemption to the streamer's companion app (if any device
 * is connected), fires off dynamic pricing for the redeemed reward (a no-op if the reward
 * doesn't have dynamic pricing enabled), then separately looks up videos configured for
 * the redeemed reward and triggers an overlay event if found. The overlay push still
 * no-ops when no videos are configured for the reward or no overlay runtime is registered.
 * The companion push is isolated in its own try/catch, and the pricing update is
 * intentionally not awaited (its errors are caught via `.catch` instead), so a failure or
 * network latency in either (e.g. a DB error, or a slow/failed Twitch price push) cannot
 * delay or prevent the independent overlay-video logic below from running.
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
      companionRuntimeRegistry.get()?.pushCompanionEvent(streamer.discord_id, {
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

  // Not awaited: applyRedemptionPricing drives a queued Twitch Helix call, and there's no
  // correctness reason to make the overlay-trigger path below wait on that network latency.
  applyRedemptionPricing(streamerId, event.reward.id).catch((err) => {
    log.error('Failed to apply dynamic pricing for redemption:', err);
  });

  const videos = await getVideosForReward(event.reward.id, streamerId);
  if (videos.length === 0) return;

  const filename = pickWeightedRandom(videos);
  const videoPath = `/overlay/videos/${streamerId}/${filename}`;
  overlayRuntimeRegistry.get()?.pushOverlayEvent(login, videoPath);
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
