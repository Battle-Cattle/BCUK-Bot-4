import { createLogger } from '../shared/logger';
import type { Message } from 'discord.js';
import { findCounterByCommand, incrementCounter } from '../db';

const log = createLogger('Counter');
import { recordCommandTestEntry } from './commandMonitorStore';
import { extractCommand } from './commandUtils';
import { isDiscordNotFoundError } from '../discord/discordUtils';
import { createRuntimeRegistry, type TwitchSendRuntime } from './twitchRuntime';

// ─── Twitch runtime (registered from index.ts before startTwitchBot) ─────────
//
// Same pattern as customCommandHandler.ts to avoid a circular import between
// twitchBot.ts and counterHandler.ts.

const counterRuntime = createRuntimeRegistry<TwitchSendRuntime>();

/** Stores the Twitch chat runtime used to send counter responses. Call once from index.ts after the Twitch bot is ready. */
export function registerCounterTwitchRuntime(runtime: TwitchSendRuntime): void {
  counterRuntime.register(runtime);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Replaces every `%d` placeholder in `template` with `value`. */
function formatCounterMessage(template: string, value: number): string {
  return template.replace(/%d/g, String(value));
}

interface CounterResult {
  response: string;
  label: string;
  canReply: boolean;
}

/**
 * Looks up a counter by `command`, increments it if it's a trigger-type counter,
 * and formats the resulting response message. Shared by the Discord and Twitch
 * counter handlers so the lookup/increment/format logic isn't duplicated.
 *
 * @param command - The full command string (e.g. `!clap`) used to find the counter.
 * @param errorPrefix - Log-line prefix identifying the calling platform (e.g. `[Discord]`).
 * @returns The response text, display label, and whether it's safe to send it; null if no counter matches `command`.
 */
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

/**
 * Handles a Discord message that may be a counter command or check: extracts the
 * command, builds the counter response, records it for the monitor panel, and
 * replies in-channel if the counter was safely resolved.
 *
 * @param message - The Discord message to check for a counter command.
 * @param username - Display name of the sender, for monitor-panel logging.
 * @returns Resolves once the reply (or a no-op) has completed.
 */
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

/**
 * Handles a Twitch chat message that may be a counter command or check: extracts
 * the command, builds the counter response, records it for the monitor panel, and
 * sends it to the channel via the registered Twitch runtime if safely resolved.
 *
 * @param channel - Twitch channel the message was sent in (also the send target).
 * @param rawMessage - Raw chat message text.
 * @param username - Twitch login of the sender, for monitor-panel logging.
 * @returns Resolves once the send (or a no-op) has completed.
 */
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

  const runtime = counterRuntime.get();
  if (runtime) {
    try {
      await runtime.send(channel, result.response);
      log.info(`[Twitch] Sent ${result.label} '${command}' in ${channel} (recorded for monitoring).`);
    } catch (err) {
      log.error(`[Twitch] Failed to send ${result.label} '${command}' in ${channel}:`, err);
    }
  }
}
