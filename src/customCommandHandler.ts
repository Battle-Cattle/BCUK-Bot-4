import type { Message } from 'discord.js';
import { getCustomCommandForDiscord, getCustomCommandForTwitchChannel } from './db';
import { recordCommandTestEntry } from './commandMonitorStore';
import { getSharedChatSession } from './twitchApi';
import { extractCommand } from './commandUtils';
import { isDiscordNotFoundError } from './discordUtils';

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

export function registerTwitchChatRuntime(runtime: TwitchChatRuntime): void {
  _twitchRuntime = runtime;
}

// ─── Lookup ───────────────────────────────────────────────────────────────────

interface LookupResult {
  response: string;
  isMultiTwitch: boolean;
}

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
const sessionCache = new Map<string, SessionCacheEntry>();
const inFlightRefreshes = new Map<string, Promise<void>>();

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
  const targets = candidates.filter((_, i) => registrationResults[i] !== null);

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
      console.error(`[CustomCmd] Failed to send to ${channel}:`, err);
    }
  }
  return anySent;
}

// ─── Execute functions ────────────────────────────────────────────────────────

export async function executeCustomCommandForDiscord(
  message: Message,
  username?: string | null,
): Promise<void> {
  const command = extractCommand(message.content);
  if (!command) return;

  const result = await lookupCommand(command, getCustomCommandForDiscord);
  if (!result) return;

  recordCommandTestEntry({
    source: 'discord',
    command,
    response: result.response,
    channel: null,
    user: username ?? null,
  });

  try {
    await message.reply(result.response);
    console.log(`[Discord] Sent custom command '${command}' (recorded for monitoring).`);
  } catch (err) {
    if (!isDiscordNotFoundError(err)) {
      console.error(`[Discord] Failed to reply to message ${message.id} for command '${command}':`, err);
    }
  }
}

export async function executeCustomCommandForTwitch(
  channel: string,
  rawMessage: string,
  username?: string | null,
): Promise<void> {
  const command = extractCommand(rawMessage);
  if (!command) return;

  const result = await lookupCommand(command, (cmd) => getCustomCommandForTwitchChannel(channel, cmd));
  if (!result) return;

  recordCommandTestEntry({
    source: 'twitch',
    command,
    response: result.response,
    channel,
    user: username ?? null,
  });

  const runtime = _twitchRuntime;
  if (runtime) {
    if (result.isMultiTwitch) {
      try {
        const sent = await broadcastToActiveChannels(channel, command, result.response);
        if (sent) {
          console.log(`[Twitch] Sent custom command '${command}' in ${channel} (recorded for monitoring).`);
        } else {
          console.log(`[Twitch] Broadcast custom command '${command}' in ${channel} reached no channels (recorded for monitoring).`);
        }
      } catch (err) {
        console.error(`[Twitch] Failed to broadcast custom command '${command}' in ${channel}:`, err);
      }
    } else {
      try {
        await runtime.send(channel, result.response);
        console.log(`[Twitch] Sent custom command '${command}' in ${channel} (recorded for monitoring).`);
      } catch (err) {
        console.error(`[Twitch] Failed to send custom command '${command}' in ${channel}:`, err);
      }
    }
  }
}
