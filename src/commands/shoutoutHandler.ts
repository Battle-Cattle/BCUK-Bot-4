import { createLogger } from '../shared/logger';
import { getUsers, getChannelInfo, getStreams, TwitchChannelInfo, TwitchStream } from '../twitch/twitchApi';

const log = createLogger('Shoutout');
import { recordCommandTestEntry } from './commandMonitorStore';
import { extractCommand } from './commandUtils';

const SO_COMMAND = '!so';

// ─── Twitch runtime (registered from index.ts before startTwitchBot) ─────────

interface ShoutoutRuntime {
  send: (channel: string, message: string) => Promise<void>;
}

let _runtime: ShoutoutRuntime | null = null;

export function registerShoutoutRuntime(runtime: ShoutoutRuntime): void {
  _runtime = runtime;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatShoutoutMessage(login: string, gameName: string | null, isLive: boolean): string {
  const url = `twitch.tv/${login}`;
  if (isLive && gameName) return `Go check out @${login}, they're live playing ${gameName}! ${url}`;
  if (gameName) return `Go give @${login} a follow! They were last seen playing ${gameName} — ${url}`;
  return `Go give @${login} a follow at ${url}!`;
}

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

async function dispatchShoutout(channel: string, message: string): Promise<boolean> {
  const runtime = _runtime;
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
 * {@link buildShoutoutMessage}, send the resulting message to the channel (or an
 * "unknown user" note if the target wasn't found), and record the outcome for the
 * monitor panel via `recordCommandTestEntry`. No-ops for non-`!so` messages or
 * non-moderator callers.
 *
 * @param channel - Twitch channel the command was sent in (also the send target).
 * @param rawMessage - Raw chat message text, e.g. `!so @someuser`.
 * @param username - Twitch login of the command invoker, for monitor-panel logging.
 * @param isModerator - Whether the invoker has moderator privileges; required to run.
 * @returns Resolves once the shoutout (or failure) has been recorded.
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

  if (response) {
    const sent = await dispatchShoutout(channel, response);
    recordCommandTestEntry({
      source: 'twitch',
      command: SO_COMMAND,
      response: sent ? response : `[SEND FAILED] ${response}`,
      channel,
      user: username,
    });
  } else {
    const unknown = `(unknown user: ${target})`;
    recordCommandTestEntry({ source: 'twitch', command: SO_COMMAND, response: unknown, channel, user: username });
  }
}
