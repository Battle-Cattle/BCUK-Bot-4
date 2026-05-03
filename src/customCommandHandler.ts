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

async function resolveSharedChatSessionId(broadcasterId: string): Promise<string | null> {
  try {
    const session = await getSharedChatSession(broadcasterId);
    return session?.session_id ?? null;
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

  for (const channel of targets) {
    const userId = loginUserIds.get(channel);
    if (userId) {
      const sessionId = await resolveSharedChatSessionId(userId);
      if (sessionId) {
        if (repliedSessionIds.has(sessionId)) continue;
        repliedSessionIds.add(sessionId);
      }
    }

    try {
      await send(channel, output);
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

  const label = result.logType === 'counter-check'
    ? 'counter check'
    : result.logType === 'counter-command'
      ? 'counter command'
      : 'custom command';
  console.log(`[Discord] Preview ${label} '${command}' matched (recorded for monitoring).`);

  if (CUSTOM_COMMANDS_LIVE_REPLIES) {
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

  const label = result.logType === 'counter-check'
    ? 'counter check'
    : result.logType === 'counter-command'
      ? 'counter command'
      : 'custom command';
  console.log(`[Twitch] Preview ${label} '${command}' matched in ${channel} (recorded for monitoring).`);

  if (CUSTOM_COMMANDS_LIVE_REPLIES && _twitchRuntime) {
    if (result.isMultiTwitch) {
      await broadcastToActiveChannels(channel, result.response);
    } else {
      await _twitchRuntime.send(channel, result.response);
    }
  }
}
