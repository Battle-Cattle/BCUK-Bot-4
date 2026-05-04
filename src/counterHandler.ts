import type { Message } from 'discord.js';
import { CUSTOM_COMMANDS_LIVE_REPLIES, COUNTER_LIVE_WRITES } from './config';
import { findCounterByCommand, incrementCounter } from './db';
import { recordCommandTestEntry } from './commandMonitorStore';
import { extractCommand } from './commandUtils';

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
  monitorResponse: string;
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
  let didIncrement = false;

  if (isTrigger && COUNTER_LIVE_WRITES) {
    try {
      displayValue = await incrementCounter(counter.id);
      didIncrement = true;
    } catch (err) {
      console.error(`${errorPrefix} Failed to increment counter ${counter.id} for command '${command}':`, err);
      const response = formatCounterMessage(counter.increment_message, displayValue);
      return {
        response,
        monitorResponse: `${response} (write error — counter not incremented)`,
        label,
        canReply: false,
      };
    }
  }

  const response = isTrigger
    ? formatCounterMessage(counter.increment_message, displayValue)
    : formatCounterMessage(counter.message, displayValue);

  const monitorResponse = isTrigger && !didIncrement
    ? `${response} (preview only — counter not incremented)`
    : response;

  return { response, monitorResponse, label, canReply: true };
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
    response: result.monitorResponse,
    channel: null,
    user: username ?? null,
  });

  if (!result.canReply) return;

  if (CUSTOM_COMMANDS_LIVE_REPLIES) {
    try {
      await message.reply(result.response);
      console.log(`[Discord] Sent ${result.label} '${command}' (recorded for monitoring).`);
    } catch (err) {
      console.error(`[Discord] Failed to reply to message ${message.id} for ${result.label} '${command}':`, err);
    }
  } else {
    console.log(`[Discord] Preview ${result.label} '${command}' (recorded for monitoring).`);
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
    response: result.monitorResponse,
    channel,
    user: username ?? null,
  });

  if (!result.canReply) return;

  const runtime = _twitchRuntime;
  if (CUSTOM_COMMANDS_LIVE_REPLIES && runtime) {
    try {
      await runtime.send(channel, result.response);
      console.log(`[Twitch] Sent ${result.label} '${command}' in ${channel} (recorded for monitoring).`);
    } catch (err) {
      console.error(`[Twitch] Failed to send ${result.label} '${command}' in ${channel}:`, err);
    }
  } else {
    console.log(`[Twitch] Preview ${result.label} '${command}' in ${channel} (recorded for monitoring).`);
  }
}
