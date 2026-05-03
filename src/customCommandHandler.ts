import type { Message } from 'discord.js';
import { CUSTOM_COMMANDS_LIVE_REPLIES } from './config';
import { findCounterByCommand, getCustomCommandForDiscord, getCustomCommandForTwitchChannel } from './db';
import { recordCommandTestEntry } from './commandMonitorStore';
import { getSharedChatSession } from './twitchApi';

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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractCommand(rawMessage: string): string | null {
  const trimmed = rawMessage.trim();
  if (!trimmed) return null;
  return trimmed.split(/\s+/)[0]?.toLowerCase() ?? null;
}

function formatCounterMessage(template: string, value: number): string {
  return template.replace(/%d/g, String(value));
}

// ─── Lookup ───────────────────────────────────────────────────────────────────

type LogType = 'custom-command' | 'counter-command' | 'counter-check';

interface LookupResult {
  response: string;
  logType: LogType;
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
      logType: 'custom-command',
      isMultiTwitch: customCommand.is_multi_twitch,
    };
  }

  const counter = await findCounterByCommand(command);
  if (counter) {
    const isTrigger = counter.matchType === 'trigger';
    return {
      response: isTrigger
        ? `${formatCounterMessage(counter.increment_message, counter.current_value)} (preview only — counter not incremented)`
        : formatCounterMessage(counter.message, counter.current_value),
      logType: isTrigger ? 'counter-command' : 'counter-check',
      isMultiTwitch: false,
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
const sessionCache = new Map<string, SessionCacheEntry>();

async function resolveSharedChatSessionId(userId: string): Promise<string | null> {
  const now = Date.now();
  const cached = sessionCache.get(userId);

  if (cached) {
    if (now < cached.expiry) return cached.sessionId;
    // Stale: serve cached value and refresh in background
    getSharedChatSession(userId)
      .then((s) => { sessionCache.set(userId, { sessionId: s?.session_id ?? null, expiry: Date.now() + SESSION_CACHE_TTL_MS }); })
      .catch(() => { sessionCache.delete(userId); });
    return cached.sessionId;
  }

  try {
    const session = await getSharedChatSession(userId);
    const sessionId = session?.session_id ?? null;
    sessionCache.set(userId, { sessionId, expiry: now + SESSION_CACHE_TTL_MS });
    return sessionId;
  } catch {
    return null;
  }
}

async function broadcastToActiveChannels(sourceChannel: string, output: string): Promise<void> {
  if (!_twitchRuntime) return;

  const { send, getActiveChannels, getLoginUserIds } = _twitchRuntime;
  const activeChannels = getActiveChannels();
  const loginUserIds = getLoginUserIds();
  const repliedSessionIds = new Set<string>();

  // Build ordered list: source channel first, then the rest
  const targets = [sourceChannel, ...Array.from(activeChannels).filter((ch) => ch !== sourceChannel)];

  // Pre-resolve all session IDs in parallel to avoid serial Helix calls per channel
  const userIds = targets.map((ch) => loginUserIds.get(ch)).filter((id): id is string => id !== undefined);
  const resolvedIds = await Promise.all(userIds.map((uid) => resolveSharedChatSessionId(uid)));
  const sessionIdByUserId = new Map(userIds.map((uid, i) => [uid, resolvedIds[i]]));

  for (const channel of targets) {
    const userId = loginUserIds.get(channel);
    const sessionId = userId ? (sessionIdByUserId.get(userId) ?? null) : null;

    if (sessionId && repliedSessionIds.has(sessionId)) continue;

    try {
      await send(channel, output);
      if (sessionId) repliedSessionIds.add(sessionId);
    } catch (err) {
      console.error(`[CustomCmd] Failed to send to ${channel}:`, err);
    }
  }
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

  const willSend = CUSTOM_COMMANDS_LIVE_REPLIES && result.logType === 'custom-command';
  const label = result.logType === 'counter-check'
    ? 'counter check'
    : result.logType === 'counter-command'
      ? 'counter command'
      : 'custom command';
  console.log(`[Discord] ${willSend ? 'Sent' : 'Preview'} ${label} '${command}' (recorded for monitoring).`);

  if (willSend) {
    await message.reply(result.response);
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
  const willSend = CUSTOM_COMMANDS_LIVE_REPLIES && !!runtime && result.logType === 'custom-command';
  const label = result.logType === 'counter-check'
    ? 'counter check'
    : result.logType === 'counter-command'
      ? 'counter command'
      : 'custom command';
  console.log(`[Twitch] ${willSend ? 'Sent' : 'Preview'} ${label} '${command}' in ${channel} (recorded for monitoring).`);

  if (willSend && runtime) {
    if (result.isMultiTwitch) {
      await broadcastToActiveChannels(channel, result.response);
    } else {
      await runtime.send(channel, result.response);
    }
  }
}
