import { createLogger } from '../shared/logger';
import { getUsers, getChannelFollower } from '../twitch/twitchApi';
import { getValidToken } from '../twitch/eventsub/twitchApiEventSub';
import { getStreamerByTwitchUserId } from '../db';
import { resolveCommand } from './commandUtils';
import { createRuntimeRegistry } from '../shared/runtimeRegistry';
import type { TwitchSendRuntime } from './twitchRuntime';
import { createCooldownGate } from './cooldownGate';

const log = createLogger('Followage');

const FOLLOWAGE_COMMAND = '!followage';
const DAY_MS = 24 * 60 * 60 * 1000;

// ─── Cooldown ─────────────────────────────────────────────────────────────────
//
// Any chat member can run `!followage`, and each run costs a Helix call (plus a
// DB lookup and possibly a token refresh), so it's gated per channel, mirroring
// countdownHandler.ts/multiCommandHandler.ts.

const followageCooldown = createCooldownGate();

// ─── Twitch runtime (registered from index.ts before startTwitchBot) ─────────

type FollowageRuntime = TwitchSendRuntime;

const followageRuntime = createRuntimeRegistry<FollowageRuntime>();

/** Stores the Twitch chat runtime used to send `!followage` replies. Call once from index.ts after the Twitch bot is ready. */
export function registerFollowageRuntime(runtime: FollowageRuntime): void {
  followageRuntime.register(runtime);
}

// ─── Formatting ───────────────────────────────────────────────────────────────

/**
 * Adds `months` calendar months to `date` (UTC), clamping the day to the target month's
 * length so e.g. 31 Jan + 1 month is 28/29 Feb rather than rolling over into March.
 */
function addMonthsClamped(date: Date, months: number): Date {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + months;
  const daysInTarget = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const result = new Date(date.getTime());
  result.setUTCFullYear(year, month, Math.min(date.getUTCDate(), daysInTarget));
  return result;
}

/** Formats `n` with `unit`, pluralised when `n !== 1` (e.g. `1 year`, `2 years`). */
function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

/**
 * Formats the time between `followedAt` and `now` as a calendar-aware
 * "X years, Y months, Z days" string, omitting zero parts. Returns
 * `less than a day` when under a day has passed (or `followedAt` is in the future).
 *
 * @param followedAt - When the follow happened.
 * @param now - The reference "now".
 * @returns The human-readable follow duration.
 */
export function formatFollowDuration(followedAt: Date, now: Date): string {
  if (now.getTime() <= followedAt.getTime()) return 'less than a day';

  // Largest whole number of calendar months that fits between followedAt and now.
  let totalMonths = (now.getUTCFullYear() - followedAt.getUTCFullYear()) * 12
    + (now.getUTCMonth() - followedAt.getUTCMonth());
  while (totalMonths > 0 && addMonthsClamped(followedAt, totalMonths).getTime() > now.getTime()) totalMonths--;

  const anchor = addMonthsClamped(followedAt, totalMonths);
  const years = Math.floor(totalMonths / 12);
  const months = totalMonths % 12;
  const days = Math.floor((now.getTime() - anchor.getTime()) / DAY_MS);

  const parts: string[] = [];
  if (years > 0) parts.push(plural(years, 'year'));
  if (months > 0) parts.push(plural(months, 'month'));
  if (days > 0) parts.push(plural(days, 'day'));
  return parts.length > 0 ? parts.join(', ') : 'less than a day';
}

/** Formats a follow date as e.g. `12 Mar 2024` (UTC). */
function formatFollowDate(date: Date): string {
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

// ─── Execute ──────────────────────────────────────────────────────────────────

/** A Twitch user as `!followage` addresses them: their user ID and the name to @-mention. */
export interface FollowageUser {
  id: string;
  name: string;
}

/**
 * Resolves who `!followage` is being asked about: the named `@target` if one was given,
 * otherwise the caller themselves.
 *
 * @param rawMessage - Raw chat message text, e.g. `!followage @someone`.
 * @param caller - The command invoker's Twitch user ID and display name.
 * @returns The target's Twitch user ID and the name to address them by, or null if a named
 *   target isn't a valid Twitch user.
 */
async function resolveFollowageTarget(
  rawMessage: string,
  caller: FollowageUser,
): Promise<FollowageUser | null> {
  const rawTarget = rawMessage.trim().split(/\s+/)[1];
  const login = rawTarget?.replace(/^@/, '').toLowerCase();
  if (!login) return caller;

  const user = (await getUsers([login]))[0];
  return user ? { id: user.id, name: user.login } : null;
}

/**
 * Builds the `!followage` reply for `targetId` in the broadcaster's channel, using the
 * broadcaster's stored OAuth token (which carries `moderator:read:followers`).
 *
 * @param channel - Twitch channel login, used in the reply text.
 * @param broadcasterId - Twitch user ID of the channel.
 * @param target - The user being asked about.
 * @returns The reply text, or null if the channel's streamer has no usable token.
 */
async function buildFollowageMessage(
  channel: string,
  broadcasterId: string,
  target: FollowageUser,
): Promise<string | null> {
  if (target.id === broadcasterId) return `${channel} can't follow themselves!`;

  const streamer = await getStreamerByTwitchUserId(broadcasterId);
  const token = streamer ? await getValidToken(streamer) : null;
  if (!token) {
    log.warn(`[Twitch] !followage in ${channel}: no connected streamer token, skipping`);
    return null;
  }

  const follow = await getChannelFollower(broadcasterId, target.id, token);
  if (!follow) return `@${target.name} isn't following ${channel}.`;

  const followedAt = new Date(follow.followed_at);
  return `@${target.name} has been following ${channel} for ${formatFollowDuration(followedAt, new Date())} (since ${formatFollowDate(followedAt)}).`;
}

/**
 * Handle a `!followage [@target]` command in Twitch chat: replies with how long the caller
 * (or the named target) has followed the channel. Any chat member may use it; throttled per
 * channel. No-ops for other commands, when no runtime is registered, when the broadcaster ID
 * is unknown, when a named target isn't a Twitch user, or when the channel's streamer hasn't
 * connected their Twitch account. Helix/DB failures are logged, not thrown.
 *
 * @param channel - Twitch channel the command was sent in (also the send target).
 * @param rawMessage - Raw chat message text, e.g. `!followage @someone`.
 * @param broadcasterId - Twitch user ID of the channel, or null if Twurple didn't supply one.
 * @param caller - The command invoker's Twitch user ID and display name.
 * @param precomputedCommand - Already-parsed command token from the caller's single
 *   `extractCommand` call for this message, or omit to parse `rawMessage` here.
 * @returns Resolves once the reply (or no-op) has completed.
 */
export async function executeFollowageForTwitch(
  channel: string,
  rawMessage: string,
  broadcasterId: string | null,
  caller: FollowageUser,
  precomputedCommand?: string | null,
): Promise<void> {
  if (resolveCommand(rawMessage, precomputedCommand) !== FOLLOWAGE_COMMAND) return;
  const runtime = followageRuntime.get();
  if (!runtime || !broadcasterId) return;
  if (!followageCooldown.tryClaim(`twitch:${channel}`)) return;

  try {
    const target = await resolveFollowageTarget(rawMessage, caller);
    if (!target) return;
    const message = await buildFollowageMessage(channel, broadcasterId, target);
    if (!message) return;
    await runtime.send(channel, message);
    log.info(`[Twitch] Sent !followage in ${channel} — ${message}`);
  } catch (err) {
    log.error(`[Twitch] !followage failed in ${channel}:`, err);
  }
}
