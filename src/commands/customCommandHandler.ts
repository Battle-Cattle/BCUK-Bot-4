import { createLogger } from '../shared/logger';
import type { Message } from 'discord.js';
import { getCustomCommandForDiscord, getCustomCommandForTwitchChannel } from '../db';

const log = createLogger('CustomCmd');
import { recordCommandTestEntry } from './commandMonitorStore';
import { getSharedChatSession } from '../twitch/twitchApi';
import { extractCommand, extractArgs } from './commandUtils';
import { isDiscordNotFoundError } from '../discord/discordUtils';
import { getMultiTwitchDataForChannel } from '../twitch/monitor/twitchMonitor';
import { fillTemplate } from '../shared/textTemplate';

// ─── Twitch runtime (registered from index.ts before startTwitchBot) ─────────
//
// Avoids a circular import: twitchBot.ts → customCommandHandler.ts → twitchBot.ts.
// index.ts wires the concrete implementations once both modules are loaded.

interface TwitchChatRuntime {
  send: (channel: string, message: string) => Promise<void>;
  getActiveChannels: () => ReadonlySet<string>;
  getLoginUserIds: () => ReadonlyMap<string, string>;
}

let _twitchRuntime: TwitchChatRuntime | null = null;

/** Stores the concrete Twitch chat runtime (send/getActiveChannels/getLoginUserIds) so Twitch custom commands can be sent and broadcast. Call once from index.ts after the Twitch bot is ready. */
export function registerTwitchChatRuntime(runtime: TwitchChatRuntime): void {
  _twitchRuntime = runtime;
}

// ─── Lookup ───────────────────────────────────────────────────────────────────

interface LookupResult {
  response: string;
  isMultiTwitch: boolean;
}

/** Looks up `command` via the supplied platform-specific finder and returns its response/multi-twitch flag, or null if no custom command matches. */
async function lookupCommand(
  command: string,
  findCustomCommand: (cmd: string) => Promise<{ output: string; is_multi_twitch: boolean } | null>,
): Promise<LookupResult | null> {
  const customCommand = await findCustomCommand(command);
  if (customCommand) {
    return {
      response: customCommand.output,
      isMultiTwitch: customCommand.is_multi_twitch,
    };
  }
  return null;
}

// ─── Multi-twitch broadcast ───────────────────────────────────────────────────

interface SessionCacheEntry {
  sessionId: string | null;
  expiry: number;
}
const SESSION_CACHE_TTL_MS = 30_000;
const SHORT_RETRY_TTL_MS = 5_000;
export const sessionCache = new Map<string, SessionCacheEntry>();
const inFlightRefreshes = new Map<string, Promise<void>>();

/** Remove all entries whose TTL has elapsed. Called by the cleanup interval and exported for tests. */
export function purgeExpiredSessionCache(): void {
  const now = Date.now();
  for (const [userId, entry] of sessionCache) {
    if (now > entry.expiry) sessionCache.delete(userId);
  }
}

// Purge expired entries so the cache does not grow without bound over long uptimes.
setInterval(purgeExpiredSessionCache, SESSION_CACHE_TTL_MS).unref();

/**
 * Resolves the shared-chat session ID for a Twitch user, caching results for
 * SESSION_CACHE_TTL_MS. A cache hit past its TTL is still returned immediately
 * (stale-while-revalidate) and triggers at most one background refresh per
 * user via `inFlightRefreshes`; a failed refresh keeps the last known value
 * but shortens the retry window to SHORT_RETRY_TTL_MS.
 */
export async function resolveSharedChatSessionId(userId: string): Promise<string | null> {
  const now = Date.now();
  const cached = sessionCache.get(userId);

  if (cached) {
    if (now < cached.expiry) return cached.sessionId;
    // Stale: serve cached value and trigger a single background refresh
    if (!inFlightRefreshes.has(userId)) {
      const lastKnown = cached.sessionId;
      const refresh = getSharedChatSession(userId)
        .then((s) => { sessionCache.set(userId, { sessionId: s?.session_id ?? null, expiry: Date.now() + SESSION_CACHE_TTL_MS }); })
        .catch(() => { sessionCache.set(userId, { sessionId: lastKnown, expiry: Date.now() + SHORT_RETRY_TTL_MS }); })
        .finally(() => { inFlightRefreshes.delete(userId); });
      inFlightRefreshes.set(userId, refresh);
    }
    return cached.sessionId;
  }

  try {
    const session = await getSharedChatSession(userId);
    const sessionId = session?.session_id ?? null;
    sessionCache.set(userId, { sessionId, expiry: now + SESSION_CACHE_TTL_MS });
    return sessionId;
  } catch {
    sessionCache.set(userId, { sessionId: null, expiry: now + SHORT_RETRY_TTL_MS });
    return null;
  }
}

/**
 * Sends a multi-twitch custom command's output to every active channel that has the
 * command registered and is part of the source channel's multi-twitch group (falling
 * back to the source channel only if it isn't currently in a group). Channels that
 * share a Twitch shared-chat session are de-duplicated so only one message is sent
 * per session. Returns true if at least one channel received the message.
 */
async function broadcastToActiveChannels(sourceChannel: string, command: string, output: string): Promise<boolean> {
  if (!_twitchRuntime) return false;

  const { send, getActiveChannels, getLoginUserIds } = _twitchRuntime;
  const activeChannels = getActiveChannels();
  const loginUserIds = getLoginUserIds();
  const repliedSessionIds = new Set<string>();

  // Build ordered list: source channel first, then the rest
  const candidates = [sourceChannel, ...Array.from(activeChannels).filter((ch) => ch !== sourceChannel)];

  // Only send to channels where the command is registered (in-memory cache lookup)
  const registrationResults = await Promise.all(candidates.map((ch) => getCustomCommandForTwitchChannel(ch, command)));
  const registered = candidates.filter((_, i) => registrationResults[i] !== null);

  // Restrict to the active multi-twitch group. When the source channel is not in an
  // active group (e.g. offline), fall back to the source channel only so the command
  // does not broadcast to unrelated channels.
  const groupInfo = getMultiTwitchDataForChannel(sourceChannel);
  const groupParticipantSet = groupInfo ? new Set(groupInfo.participants) : null;
  const targets = registered.filter((ch) =>
    ch === sourceChannel || (groupParticipantSet !== null && groupParticipantSet.has(ch)),
  );

  // Pre-resolve all session IDs in parallel to avoid serial Helix calls per channel
  const userIds = [...new Set(targets.map((ch) => loginUserIds.get(ch)).filter((id): id is string => id !== undefined))];
  const resolvedIds = await Promise.all(userIds.map((uid) => resolveSharedChatSessionId(uid)));
  const sessionIdByUserId = new Map(userIds.map((uid, i) => [uid, resolvedIds[i]]));

  let anySent = false;
  for (const channel of targets) {
    const userId = loginUserIds.get(channel);
    const sessionId = userId ? (sessionIdByUserId.get(userId) ?? null) : null;

    if (sessionId && repliedSessionIds.has(sessionId)) continue;

    try {
      await send(channel, output);
      if (sessionId) repliedSessionIds.add(sessionId);
      anySent = true;
    } catch (err) {
      log.error(`Failed to send to ${channel}:`, err);
    }
  }
  return anySent;
}

// ─── Execute functions ────────────────────────────────────────────────────────

/**
 * Checks a Discord message against the custom command catalog and replies if a match is found.
 *
 * Guild context is resolved in priority order: the explicit `guildId` argument, then
 * `message.guildId`. Returns without action when no guild context is available.
 * The guild's per-guild override overlay is applied before the reply (disabled commands
 * are skipped; output overrides replace the catalog text). Discord not-found errors
 * (e.g. message deleted before the reply lands) are silently swallowed.
 *
 * Before sending, the matched response is run through {@link fillTemplate} with
 * `{user}` (the invoking username), `{args}` (the raw text after the command token),
 * and `{arg}` (the first whitespace-delimited word of `{args}`) substituted in —
 * unknown placeholders resolve to an empty string. The filled text is what's both
 * sent and recorded via `recordCommandTestEntry`, so the monitor panel shows the
 * resolved response rather than the raw template.
 *
 * @param message - The Discord message to inspect and, if matched, reply to.
 * @param username - Display name for the monitoring entry and `{user}` substitution; null or omitted if unknown.
 * @param guildId - Explicit guild ID for override-aware lookup; falls back to message.guildId.
 * @returns Resolves when the command is handled (or skipped).
 */
export async function executeCustomCommandForDiscord(
  message: Message,
  username?: string | null,
  guildId?: string,
): Promise<void> {
  const command = extractCommand(message.content);
  if (!command) return;

  // Prefer the explicitly threaded guildId; fall back to the message's own guild.
  // The Discord lookup applies that guild's per-guild override overlay.
  const resolvedGuildId = guildId ?? message.guildId;
  if (!resolvedGuildId) return;

  const result = await lookupCommand(command, (cmd) => getCustomCommandForDiscord(cmd, resolvedGuildId));
  if (!result) return;

  const args = extractArgs(message.content);
  const filledResponse = fillTemplate(result.response, {
    user: username ?? '',
    args,
    arg: args.split(/\s+/)[0] ?? '',
  });

  recordCommandTestEntry({
    source: 'discord',
    command,
    response: filledResponse,
    channel: null,
    user: username ?? null,
  });

  try {
    await message.reply(filledResponse);
    log.info(`[Discord] Sent custom command '${command}' (recorded for monitoring).`);
  } catch (err) {
    if (!isDiscordNotFoundError(err)) {
      log.error(`[Discord] Failed to reply to message ${message.id} for command '${command}':`, err);
    }
  }
}

/**
 * Checks a Twitch chat message against the custom command catalog for `channel`
 * and, if matched, sends the response — broadcasting to other active channels
 * sharing a multi-twitch group when the command is flagged multi-twitch.
 *
 * Before sending, the matched response is run through {@link fillTemplate} with
 * `{user}` (the invoking username), `{args}` (the raw text after the command token),
 * and `{arg}` (the first whitespace-delimited word of `{args}`) substituted in —
 * unknown placeholders resolve to an empty string. The filled text is what's
 * recorded via `recordCommandTestEntry` and what's sent; for multi-twitch broadcasts
 * the same filled string is reused for every target channel (no per-channel re-fill).
 *
 * @param channel - Twitch channel login the message was received on.
 * @param rawMessage - Raw chat message text.
 * @param username - Display name for the monitoring entry and `{user}` substitution; null or omitted if unknown.
 * @returns Resolves when the command is handled (or skipped).
 */
export async function executeCustomCommandForTwitch(
  channel: string,
  rawMessage: string,
  username?: string | null,
): Promise<void> {
  const command = extractCommand(rawMessage);
  if (!command) return;

  const result = await lookupCommand(command, (cmd) => getCustomCommandForTwitchChannel(channel, cmd));
  if (!result) return;

  const args = extractArgs(rawMessage);
  const filledResponse = fillTemplate(result.response, {
    user: username ?? '',
    args,
    arg: args.split(/\s+/)[0] ?? '',
  });

  recordCommandTestEntry({
    source: 'twitch',
    command,
    response: filledResponse,
    channel,
    user: username ?? null,
  });

  const runtime = _twitchRuntime;
  if (runtime) {
    if (result.isMultiTwitch) {
      try {
        const sent = await broadcastToActiveChannels(channel, command, filledResponse);
        if (sent) {
          log.info(`[Twitch] Sent custom command '${command}' in ${channel} (recorded for monitoring).`);
        } else {
          log.info(`[Twitch] Broadcast custom command '${command}' in ${channel} reached no channels (recorded for monitoring).`);
        }
      } catch (err) {
        log.error(`[Twitch] Failed to broadcast custom command '${command}' in ${channel}:`, err);
      }
    } else {
      try {
        await runtime.send(channel, filledResponse);
        log.info(`[Twitch] Sent custom command '${command}' in ${channel} (recorded for monitoring).`);
      } catch (err) {
        log.error(`[Twitch] Failed to send custom command '${command}' in ${channel}:`, err);
      }
    }
  }
}
