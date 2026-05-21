import { createLogger } from './logger';
import type { Message } from 'discord.js';
import { findCounterByCommand, incrementCounter } from './db';

const log = createLogger('Counter');
import { recordCommandTestEntry } from './commandMonitorStore';
import { extractCommand } from './commandUtils';
import { isDiscordNotFoundError } from './discordUtils';

// ─── Twitch runtime (registered from index.ts before startTwitchBot) ─────────
//
// Same pattern as customCommandHandler.ts to avoid a circular import between
// twitchBot.ts and counterHandler.ts.

interface TwitchSendRuntime {
  send: (channel: string, message: string) => Promise<void>;
}

let _twitchRuntime: TwitchSendRuntime | null = null;

export function registerCounterTwitchRuntime(runtime: TwitchSendRuntime): void {
  _twitchRuntime = runtime;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatCounterMessage(template: string, value: number): string {
  return template.replace(/%d/g, String(value));
}

interface CounterResult {
  response: string;
  label: string;
  canReply: boolean;
}

async function _buildCounterResponse(
  command: string,
  errorPrefix: string,
): Promise<CounterResult | null> {
  const counter = await findCounterByCommand(command);
  if (!counter) return null;

  const isTrigger = counter.matchType === 'trigger';
  const label = isTrigger ? 'counter command' : 'counter check';

  let displayValue = counter.current_value;

  if (isTrigger) {
    try {
      displayValue = await incrementCounter(counter.id);
    } catch (err) {
      log.error(`[${errorPrefix}] Failed to increment counter ${counter.id} for command '${command}':`, err);
      // Invariant: canReply must be false here so the stale pre-increment
      // displayValue is never sent to chat.
      return {
        response: formatCounterMessage(counter.increment_message, displayValue),
        label,
        canReply: false,
      };
    }
  }

  const response = isTrigger
    ? formatCounterMessage(counter.increment_message, displayValue)
    : formatCounterMessage(counter.message, displayValue);

  return { response, label, canReply: true };
}

// ─── Execute functions ────────────────────────────────────────────────────────

export async function executeCounterCommandForDiscord(
  message: Message,
  username?: string | null,
): Promise<void> {
  const command = extractCommand(message.content);
  if (!command) return;

  const result = await _buildCounterResponse(command, '[Discord]');
  if (!result) return;

  recordCommandTestEntry({
    source: 'discord',
    command,
    response: result.response,
    channel: null,
    user: username ?? null,
  });

  if (!result.canReply) return;

  try {
    await message.reply(result.response);
    log.info(`[Discord] Sent ${result.label} '${command}' (recorded for monitoring).`);
  } catch (err) {
    if (!isDiscordNotFoundError(err)) {
      log.error(`[Discord] Failed to reply to message ${message.id} for ${result.label} '${command}':`, err);
    }
  }
}

export async function executeCounterCommandForTwitch(
  channel: string,
  rawMessage: string,
  username?: string | null,
): Promise<void> {
  const command = extractCommand(rawMessage);
  if (!command) return;

  const result = await _buildCounterResponse(command, `[Twitch:${channel}]`);
  if (!result) return;

  recordCommandTestEntry({
    source: 'twitch',
    command,
    response: result.response,
    channel,
    user: username ?? null,
  });

  if (!result.canReply) return;

  const runtime = _twitchRuntime;
  if (runtime) {
    try {
      await runtime.send(channel, result.response);
      log.info(`[Twitch] Sent ${result.label} '${command}' in ${channel} (recorded for monitoring).`);
    } catch (err) {
      log.error(`[Twitch] Failed to send ${result.label} '${command}' in ${channel}:`, err);
    }
  }
}
