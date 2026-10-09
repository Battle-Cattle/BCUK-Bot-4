import type { EventSubConfig } from '../../db';
import { buildShoutoutMessage } from '../../commands/shoutoutHandler';
import { createLogger } from '../../shared/logger';
import { triggerImmediateLiveCheck } from '../monitor/twitchMonitor';
import {
  sendChatMessage, maybeSendChatMessage, maybePushAlert, recordAndPushDashboardEvent,
} from './twitchEventSubEffects';

const log = createLogger('EventSubHandler');

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

/**
 * Converts a Twitch subscription tier code to a display name.
 * @param tier - Tier code (`'1000'`, `'2000'` or `'3000'`).
 * @returns `'Tier 1'`–`'Tier 3'`, or the raw code if unrecognised.
 */
function tierName(tier: string): string {
  return ({ '1000': 'Tier 1', '2000': 'Tier 2', '3000': 'Tier 3' } as Record<string, string>)[tier] ?? tier;
}

/**
 * Handle a channel.follow EventSub notification.
 * Sends a chat message to the broadcaster's channel using the injected Twitch runtime when
 * `config.follow_enabled` is true, independently pushes a browser-source alert via
 * {@link maybePushAlert} when the streamer's follow alert is enabled, and unconditionally
 * records the follow to the dashboard's "Recent Events" feed via {@link recordAndPushDashboardEvent}.
 *
 * @param login - Broadcaster login name (chat channel to send to).
 * @param event - Follow event payload from Twitch EventSub.
 * @param config - Streamer's event response configuration.
 * @param streamerId - DB row ID of the streamer, used to look up alert config.
 */
export async function handleFollow(login: string, event: FollowEvent, config: EventSubConfig, streamerId: number): Promise<void> {
  const vars = { username: event.user_login, display_name: event.user_name };
  await maybeSendChatMessage(login, config.follow_enabled, config.follow_message, vars);
  await maybePushAlert(login, streamerId, 'follow', vars);
  await recordAndPushDashboardEvent(streamerId, 'follow', event.user_name, null);
}

/**
 * Handle a channel.subscribe EventSub notification. Gift subs are silently skipped entirely
 * (handled by handleGiftSub) for the chat message, the alert, and the dashboard feed. Otherwise
 * sends a chat message when `config.sub_enabled` is true, independently pushes a browser-source
 * alert via {@link maybePushAlert} when the streamer's sub alert is enabled, and unconditionally
 * records the sub to the dashboard's "Recent Events" feed via {@link recordAndPushDashboardEvent}.
 *
 * @param login - Broadcaster login name.
 * @param event - Subscribe event payload; gift subs are silently skipped (handled by handleGiftSub).
 * @param config - Streamer's event response configuration.
 * @param streamerId - DB row ID of the streamer, used to look up alert config.
 */
export async function handleSub(login: string, event: SubEvent, config: EventSubConfig, streamerId: number): Promise<void> {
  if (event.is_gift) return;
  const vars = {
    username: event.user_login,
    display_name: event.user_name,
    tier: event.tier,
    tier_name: tierName(event.tier),
  };
  await maybeSendChatMessage(login, config.sub_enabled, config.sub_message, vars);
  await maybePushAlert(login, streamerId, 'sub', vars);
  await recordAndPushDashboardEvent(streamerId, 'sub', event.user_name, tierName(event.tier));
}

/**
 * Handle a channel.subscription.message (resub) EventSub notification.
 * Sends a chat message when `config.sub_enabled` is true, independently pushes a
 * browser-source alert via {@link maybePushAlert} when the streamer's resub alert is enabled,
 * and unconditionally records the resub to the dashboard's "Recent Events" feed via
 * {@link recordAndPushDashboardEvent}.
 *
 * @param login - Broadcaster login name.
 * @param event - Resub event payload including cumulative and streak month counts.
 * @param config - Streamer's event response configuration.
 * @param streamerId - DB row ID of the streamer, used to look up alert config.
 */
export async function handleResub(login: string, event: ResubEvent, config: EventSubConfig, streamerId: number): Promise<void> {
  const vars = {
    username: event.user_login,
    display_name: event.user_name,
    tier: event.tier,
    tier_name: tierName(event.tier),
    months: String(event.cumulative_months),
    streak: event.streak_months != null ? String(event.streak_months) : '0',
  };
  await maybeSendChatMessage(login, config.sub_enabled, config.resub_message, vars);
  await maybePushAlert(login, streamerId, 'resub', vars);
  await recordAndPushDashboardEvent(streamerId, 'resub', event.user_name, `${tierName(event.tier)} · ${event.cumulative_months} months`);
}

/**
 * Handle a channel.subscription.gift EventSub notification.
 * Anonymous gifters are reported as "anonymous" / "Anonymous" everywhere, including the
 * dashboard feed. Sends a chat message when `config.sub_enabled` is true, independently pushes
 * a browser-source alert via {@link maybePushAlert} when the streamer's gift-sub alert is
 * enabled, and unconditionally records the gift sub to the dashboard's "Recent Events" feed via
 * {@link recordAndPushDashboardEvent}.
 *
 * @param login - Broadcaster login name.
 * @param event - Gift-sub event payload; `is_anonymous` controls gifter display name.
 * @param config - Streamer's event response configuration.
 * @param streamerId - DB row ID of the streamer, used to look up alert config.
 */
export async function handleGiftSub(login: string, event: GiftSubEvent, config: EventSubConfig, streamerId: number): Promise<void> {
  const gifter = event.is_anonymous ? 'anonymous' : event.user_login;
  const gifterDisplay = event.is_anonymous ? 'Anonymous' : event.user_name;
  const vars = {
    gifter,
    gifter_display: gifterDisplay,
    count: String(event.total),
    tier: event.tier,
    tier_name: tierName(event.tier),
  };
  await maybeSendChatMessage(login, config.sub_enabled, config.giftsub_message, vars);
  await maybePushAlert(login, streamerId, 'giftsub', vars);
  await recordAndPushDashboardEvent(streamerId, 'giftsub', gifterDisplay, `${event.total} x ${tierName(event.tier)}`);
}

/**
 * Handle a channel.raid EventSub notification. Three independent behaviours are gated by
 * their own flags and none depends on the others:
 *  - `config.raid_enabled` — sends the configured welcome message.
 *  - `config.raid_shoutout_enabled` — looks up the raiding channel via
 *    {@link buildShoutoutMessage} (the same Helix lookup path as the `!so` command)
 *    and sends the resulting shoutout. No-ops silently if the raiding channel can't
 *    be resolved on Twitch.
 *  - The streamer's raid alert config (via {@link maybePushAlert}) — pushes a browser-source
 *    alert independently of both of the above.
 *  - The dashboard's "Recent Events" feed (via {@link recordAndPushDashboardEvent}) — recorded
 *    unconditionally, independently of all of the above.
 * The chat-message branches no-op when no Twitch runtime has been registered.
 *
 * @param login - Broadcaster login name (the raid target's channel).
 * @param event - Raid event payload including the raiding channel and viewer count.
 * @param config - Streamer's event response configuration.
 * @param streamerId - DB row ID of the streamer, used to look up alert config.
 */
export async function handleRaid(login: string, event: RaidEvent, config: EventSubConfig, streamerId: number): Promise<void> {
  const vars = {
    from_channel: event.from_broadcaster_user_login,
    from_display: event.from_broadcaster_user_name,
    viewers: String(event.viewers),
  };

  await maybeSendChatMessage(login, config.raid_enabled, config.raid_message, vars);

  if (config.raid_shoutout_enabled) {
    try {
      const shoutoutMsg = await buildShoutoutMessage(event.from_broadcaster_user_login);
      if (shoutoutMsg) {
        await sendChatMessage(login, shoutoutMsg);
      }
    } catch (err) {
      log.error(`Failed to build raid shoutout for ${login}:`, err);
    }
  }

  await maybePushAlert(login, streamerId, 'raid', vars);
  await recordAndPushDashboardEvent(streamerId, 'raid', event.from_broadcaster_user_name, `${event.viewers} viewers`);
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
