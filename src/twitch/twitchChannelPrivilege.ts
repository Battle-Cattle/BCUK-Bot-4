import type { UserState } from '@twurple/chat';
import { normalizeTwitchChannelName } from './twitchChannelName';

/**
 * Per-channel badge status (moderator/VIP/broadcaster) for the bot's own account, refreshed from
 * the raw IRC `USERSTATE` message Twitch sends after joining a channel and after every send in it
 * (see {@link onOwnUserState}) — Twurple's `ChatClient` has no higher-level "am I currently
 * privileged here" query. Missing until the bot has received a `USERSTATE` for a channel — e.g.
 * right after joining — which safely defaults {@link isPrivilegedInChannel} to the more
 * conservative non-privileged rate.
 */
const privilegedChannels = new Set<string>();

/** Test-only: clears {@link privilegedChannels} so each test starts from a clean slate. */
export function __resetTwitchPrivilegedChannelsForTests(): void {
  privilegedChannels.clear();
}

/**
 * Clears all tracked per-channel privilege status. Called from `twitchBot.ts` on disconnect —
 * Twurple reconnects within the same `ChatClient` instance on an automatic reconnect (not implying
 * a new client), so without this a channel that revoked the bot's mod/VIP status while disconnected
 * would keep the stale privileged rate-limit ceiling until its next `USERSTATE`, rather than
 * reverting to the conservative default immediately.
 */
export function clearPrivilegeState(): void {
  privilegedChannels.clear();
}

/**
 * Parses a raw IRC `badges` tag value (e.g. `"moderator/1,subscriber/12"`) into a set of badge names.
 * @param rawBadges - The raw `badges` tag value, or `undefined` if the tag was absent.
 * @returns The badge names present (e.g. `{'moderator', 'subscriber'}`), or an empty set if `rawBadges` was `undefined`.
 */
function parseBadgeNames(rawBadges: string | undefined): Set<string> {
  if (!rawBadges) return new Set();
  return new Set(rawBadges.split(',').map((entry) => entry.split('/')[0]));
}

/**
 * Records the bot's own moderator/VIP/broadcaster badge status for `channel` in
 * {@link privilegedChannels}, so {@link isPrivilegedInChannel} can answer live without a per-send
 * API call.
 * @param channel - Normalized Twitch channel name the badges were observed in.
 * @param badgeNames - Badge names parsed from the `USERSTATE`'s `badges` tag (see {@link parseBadgeNames}).
 * @returns Nothing — mutates {@link privilegedChannels} in place.
 */
function updateOwnPrivilegeStatus(channel: string, badgeNames: Set<string>): void {
  const privileged = badgeNames.has('moderator') || badgeNames.has('vip') || badgeNames.has('broadcaster');
  if (privileged) privilegedChannels.add(channel);
  else privilegedChannels.delete(channel);
}

/**
 * Raw IRC `USERSTATE` handler, registered directly on the underlying `ircv3` client (see
 * `twitchBot.ts`'s `startTwitchBot`) since Twurple's `ChatClient` doesn't expose this event itself.
 * Twitch sends `USERSTATE` after the bot joins a channel and after every message it sends there,
 * carrying the bot's own current badges in that channel — the only reliable live source for this,
 * since Twitch does not echo the bot's own `PRIVMSG`s back through `onMessage`.
 * @param msg - The raw `USERSTATE` message, including the channel (`#channel`) and IRC tags.
 * @returns Nothing — updates {@link privilegedChannels} via {@link updateOwnPrivilegeStatus}.
 */
export function onOwnUserState(msg: UserState): void {
  const normalizedChannel = normalizeTwitchChannelName(msg.channel);
  if (!normalizedChannel) return;
  updateOwnPrivilegeStatus(normalizedChannel, parseBadgeNames(msg.tags.get('badges')));
}

/**
 * Resolves whether the bot currently holds moderator/VIP/broadcaster status in `channel`, from
 * {@link privilegedChannels} (see {@link updateOwnPrivilegeStatus} for how it's populated).
 * Under-detecting privilege here only makes a send unnecessarily conservative (throttled at the
 * stricter non-privileged rate) rather than unsafe, so a channel the bot hasn't been observed
 * chatting in yet — e.g. right after joining — safely resolves to false.
 * @param channel - Normalized Twitch channel name (without a leading `#`).
 * @returns True if the bot's last-observed status in `channel` was moderator, VIP, or broadcaster.
 */
export function isPrivilegedInChannel(channel: string): boolean {
  return privilegedChannels.has(channel);
}
