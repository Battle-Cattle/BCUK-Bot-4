import { createLogger } from '../shared/logger';

const log = createLogger('TwitchBroadcast');

/**
 * Sends `message` to each channel in `targets` via `send`, de-duplicating by
 * Twitch shared-chat session: once a channel belonging to a given session has
 * received the message, later channels resolving to that same session are
 * skipped. Session IDs are resolved once per unique user ID (via `loginUserIds`
 * and `resolveSessionId`) in parallel before sending, to avoid a serial Helix
 * lookup per channel. A channel with no entry in `loginUserIds` is treated as
 * having no session and is always sent to. Per-channel send failures are
 * logged and do not abort the remaining sends.
 *
 * @param targets - Ordered list of channel logins to send to.
 * @param loginUserIds - Map from channel login to Twitch user ID, used to resolve shared-chat sessions.
 * @param message - The message to send to each (deduplicated) target channel.
 * @param send - Sends `message` to a single channel.
 * @param resolveSessionId - Resolves a Twitch user ID to its current shared-chat session ID (or null).
 * @returns True if at least one channel received the message.
 */
export async function sendDedupedBySession(
  targets: string[],
  loginUserIds: ReadonlyMap<string, string>,
  message: string,
  send: (channel: string, message: string) => Promise<void>,
  resolveSessionId: (userId: string) => Promise<string | null>,
): Promise<boolean> {
  // Pre-resolve all session IDs in parallel to avoid serial Helix calls per channel
  const userIds = [...new Set(targets.map((ch) => loginUserIds.get(ch)).filter((id): id is string => id !== undefined))];
  const resolvedIds = await Promise.all(userIds.map((uid) => resolveSessionId(uid)));
  const sessionIdByUserId = new Map(userIds.map((uid, i) => [uid, resolvedIds[i]]));

  const repliedSessionIds = new Set<string>();
  let anySent = false;

  for (const channel of targets) {
    const userId = loginUserIds.get(channel);
    const sessionId = userId ? (sessionIdByUserId.get(userId) ?? null) : null;

    if (sessionId && repliedSessionIds.has(sessionId)) continue;

    try {
      await send(channel, message);
      if (sessionId) repliedSessionIds.add(sessionId);
      anySent = true;
    } catch (err) {
      log.error(`Failed to send to ${channel}:`, err);
    }
  }

  return anySent;
}
