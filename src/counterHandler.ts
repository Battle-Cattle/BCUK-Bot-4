import type { Message } from 'discord.js';
import { CUSTOM_COMMANDS_LIVE_REPLIES, COUNTER_LIVE_WRITES } from './config';
import { findCounterByCommand, incrementCounter } from './db';
import { recordCommandTestEntry } from './commandMonitorStore';

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

function extractCommand(rawMessage: string): string | null {
  const trimmed = rawMessage.trim();
  if (!trimmed) return null;
  return trimmed.split(/\s+/)[0]?.toLowerCase() ?? null;
}

function formatCounterMessage(template: string, value: number): string {
  return template.replace(/%d/g, String(value));
}

// ─── Execute functions ────────────────────────────────────────────────────────

export async function executeCounterCommandForDiscord(
  message: Message,
  username?: string | null,
): Promise<void> {
  const command = extractCommand(message.content);
  if (!command) return;

  const counter = await findCounterByCommand(command);
  if (!counter) return;

  const isTrigger = counter.matchType === 'trigger';
  const label = isTrigger ? 'counter command' : 'counter check';

  let displayValue = counter.current_value;
  let didIncrement = false;

  if (isTrigger && COUNTER_LIVE_WRITES) {
    try {
      displayValue = await incrementCounter(counter.id);
      didIncrement = true;
    } catch (err) {
      console.error(`[Discord] Failed to increment counter ${counter.id} for command '${command}':`, err);
      return;
    }
  }

  const response = isTrigger
    ? formatCounterMessage(counter.increment_message, displayValue)
    : formatCounterMessage(counter.message, displayValue);

  const monitorResponse = isTrigger && !didIncrement
    ? `${response} (preview only — counter not incremented)`
    : response;

  recordCommandTestEntry({
    source: 'discord',
    command,
    response: monitorResponse,
    channel: null,
    user: username ?? null,
  });

  if (CUSTOM_COMMANDS_LIVE_REPLIES) {
    try {
      await message.reply(response);
      console.log(`[Discord] Sent ${label} '${command}' (recorded for monitoring).`);
    } catch (err) {
      console.error(`[Discord] Failed to reply to message ${message.id} for ${label} '${command}':`, err);
    }
  } else {
    console.log(`[Discord] Preview ${label} '${command}' (recorded for monitoring).`);
  }
}

export async function executeCounterCommandForTwitch(
  channel: string,
  rawMessage: string,
  username?: string | null,
): Promise<void> {
  const command = extractCommand(rawMessage);
  if (!command) return;

  const counter = await findCounterByCommand(command);
  if (!counter) return;

  const isTrigger = counter.matchType === 'trigger';
  const label = isTrigger ? 'counter command' : 'counter check';

  let displayValue = counter.current_value;
  let didIncrement = false;

  if (isTrigger && COUNTER_LIVE_WRITES) {
    try {
      displayValue = await incrementCounter(counter.id);
      didIncrement = true;
    } catch (err) {
      console.error(`[Twitch] Failed to increment counter ${counter.id} for command '${command}' in ${channel}:`, err);
      return;
    }
  }

  const response = isTrigger
    ? formatCounterMessage(counter.increment_message, displayValue)
    : formatCounterMessage(counter.message, displayValue);

  const monitorResponse = isTrigger && !didIncrement
    ? `${response} (preview only — counter not incremented)`
    : response;

  recordCommandTestEntry({
    source: 'twitch',
    command,
    response: monitorResponse,
    channel,
    user: username ?? null,
  });

  const runtime = _twitchRuntime;
  if (CUSTOM_COMMANDS_LIVE_REPLIES && runtime) {
    try {
      await runtime.send(channel, response);
      console.log(`[Twitch] Sent ${label} '${command}' in ${channel} (recorded for monitoring).`);
    } catch (err) {
      console.error(`[Twitch] Failed to send ${label} '${command}' in ${channel}:`, err);
    }
  } else {
    console.log(`[Twitch] Preview ${label} '${command}' in ${channel} (recorded for monitoring).`);
  }
}
