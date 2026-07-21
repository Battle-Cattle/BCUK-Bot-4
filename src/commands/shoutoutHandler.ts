import { createLogger } from '../shared/logger';
import { getUsers, getChannelInfo, getStreams, TwitchChannelInfo, TwitchStream } from '../twitch/twitchApi';

const log = createLogger('Shoutout');
import { extractCommand } from './commandUtils';
import { createRuntimeRegistry, type TwitchSendRuntime } from './twitchRuntime';

const SO_COMMAND = '!so';

// ─── Twitch runtime (registered from index.ts before startTwitchBot) ─────────

type ShoutoutRuntime = TwitchSendRuntime;

const shoutoutRuntime = createRuntimeRegistry<ShoutoutRuntime>();

/** Stores the Twitch chat runtime used to send `!so` shoutouts. Call once from index.ts after the Twitch bot is ready. */
export function registerShoutoutRuntime(runtime: ShoutoutRuntime): void {
  shoutoutRuntime.register(runtime);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Builds the `!so` shoutout message text for `login`, tailored to whether they're currently live and/or have a known last-played game. */
function formatShoutoutMessage(login: string, gameName: string | null, isLive: boolean): string {
  const url = `twitch.tv/${login}`;
  if (isLive && gameName) return `Go check out @${login}, they're live playing ${gameName}! ${url}`;
  if (gameName) return `Go give @${login} a follow! They were last seen playing ${gameName} — ${url}`;
  return `Go give @${login} a follow at ${url}!`;
}

/**
 * Looks up `target` on Twitch and resolves the login, most recent/current game
 * name, and live status needed to build a shoutout message. Channel info and
 * stream lookups run independently so a failure in one doesn't block the other.
 *
 * @param target - Twitch login to look up.
 * @returns The resolved shoutout data, or null if `target` isn't a valid Twitch user.
 */
async function resolveShoutoutData(
  target: string,
): Promise<{ login: string; gameName: string | null; isLive: boolean } | null> {
  const users = await getUsers([target]);
  const user = users[0];
  if (!user) return null;

  // Independent failures: a bad getStreams response still lets getChannelInfo succeed.
  const [channelResult, streamsResult] = await Promise.allSettled([
    getChannelInfo([user.id]),
    getStreams([user.id]),
  ]);

  const channelInfos: TwitchChannelInfo[] = channelResult.status === 'fulfilled' ? channelResult.value : [];
  const streams: TwitchStream[] = streamsResult.status === 'fulfilled' ? streamsResult.value : [];
  const stream = streams[0];

  return {
    login: user.login,
    gameName: stream?.game_name || channelInfos[0]?.game_name || null,
    isLive: !!stream,
  };
}

/**
 * Sends a shoutout `message` to `channel` via the registered Twitch runtime.
 *
 * @param channel - Twitch channel to send the shoutout to.
 * @param message - Shoutout text to send.
 * @returns True if the message was sent; false if no runtime is registered or the send failed.
 */
async function dispatchShoutout(channel: string, message: string): Promise<boolean> {
  const runtime = shoutoutRuntime.get();
  if (!runtime) return false;
  try {
    await runtime.send(channel, message);
    log.info(`[Twitch] Sent !so in ${channel} — ${message}`);
    return true;
  } catch (err) {
    log.error(`[Twitch] Failed to send !so in ${channel}:`, err);
    return false;
  }
}

// ─── Execute ──────────────────────────────────────────────────────────────────

/**
 * Resolve a shoutout target on Twitch and build the message to send for them.
 * Wraps `resolveShoutoutData` + `formatShoutoutMessage` behind a single call so every
 * shoutout caller (the `!so` command handler and the automatic raid shoutout) shares
 * one Helix lookup path instead of duplicating it.
 *
 * @param target - Twitch login to look up (already lowercased/stripped of a leading `@`).
 * @returns The formatted shoutout message, or null if the target could not be found on Twitch.
 */
export async function buildShoutoutMessage(target: string): Promise<string | null> {
  const data = await resolveShoutoutData(target);
  if (!data) return null;
  return formatShoutoutMessage(data.login, data.gameName, data.isLive);
}

/**
 * Handle a `!so <target>` moderator command in Twitch chat: look up the target via
 * {@link buildShoutoutMessage} and send the resulting message to the channel (or
 * silently no-op if the target wasn't found). No-ops for non-`!so` messages or
 * non-moderator callers.
 *
 * @param channel - Twitch channel the command was sent in (also the send target).
 * @param rawMessage - Raw chat message text, e.g. `!so @someuser`.
 * @param username - Twitch login of the command invoker (unused).
 * @param isModerator - Whether the invoker has moderator privileges; required to run.
 * @returns Resolves once the shoutout (or no-op) has completed.
 */
export async function executeShoutoutForTwitch(
  channel: string,
  rawMessage: string,
  username: string | null,
  isModerator: boolean,
): Promise<void> {
  if (extractCommand(rawMessage) !== SO_COMMAND || !isModerator) return;

  const rawTarget = rawMessage.trim().split(/\s+/)[1];
  const target = rawTarget?.replace(/^@/, '').toLowerCase();
  if (!target) return;

  const response = await buildShoutoutMessage(target);
  if (!response) return;

  await dispatchShoutout(channel, response);
}
