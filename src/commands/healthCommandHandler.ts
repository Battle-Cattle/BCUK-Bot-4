import type { Message } from 'discord.js';
import { createLogger } from '../shared/logger';
import { extractCommand } from './commandUtils';
import { findOwnerUser } from '../db';
import { getHealthSnapshot, type HealthSnapshot } from '../shared/healthStore';
import { isDiscordNotFoundError } from '../discord/discordUtils';

const log = createLogger('HealthCommand');

const TRIGGER = '!health';

/** Number of most-recent error entries shown in the `!health` summary (newest first). */
const RECENT_ERROR_COUNT = 5;

/**
 * Discord's per-message character cap. {@link formatHealthSummary}'s output is truncated to
 * stay comfortably under this, since both the owner DM and (if ever sent in-channel) a reply
 * share the same limit.
 */
const DISCORD_MESSAGE_LIMIT = 2000;

/** Length {@link formatHealthSummary}'s output is truncated to before appending the truncation marker, leaving headroom under {@link DISCORD_MESSAGE_LIMIT}. */
const SUMMARY_TRUNCATE_LENGTH = 1900;

/** Appended to a truncated `!health` summary (see {@link formatHealthSummary}). */
const TRUNCATION_MARKER = '\n… (truncated)';

/** Formats a `Date | null` for display, or `'—'` if absent. */
function formatDate(date: Date | null): string {
  return date ? date.toLocaleString() : '—';
}

/** Formats the Discord/Twitch-chat/DB connectivity lines for the `!health` summary. */
function formatConnectivityLines(snapshot: HealthSnapshot): string[] {
  return [
    `Discord: ${snapshot.discordConnected ? '🟢 connected' : '🔴 disconnected'}`,
    `Twitch chat: ${snapshot.twitchChatConnected ? '🟢 connected' : '🔴 disconnected'}`,
    `DB: ${snapshot.db.lastPingOk ? '🟢 ok' : '🔴 failing'} (last ping ${formatDate(snapshot.db.lastPingAt)}${
      snapshot.db.lastError ? `, last error: ${snapshot.db.lastError}` : ''
    })`,
  ];
}

/** Formats one line per tracked EventSub streamer, or `[]` if none are tracked yet. */
function formatEventSubLines(snapshot: HealthSnapshot): string[] {
  const entries = Object.entries(snapshot.eventsub);
  if (entries.length === 0) return [];
  return [
    'EventSub:',
    ...entries.map(
      ([streamer, health]) =>
        `  ${streamer}: ${health.connected ? '🟢 connected' : '🔴 disconnected'} (reconnect attempts: ${health.reconnectAttempts})`,
    ),
  ];
}

/** Formats the Twitch stream-monitor's last-poll line for the `!health` summary. */
function formatMonitorLine(snapshot: HealthSnapshot): string {
  return `Monitor: ${snapshot.monitor.lastPollOk ? '🟢 ok' : '🔴 failing'} (last poll ${formatDate(snapshot.monitor.lastPollAt)}${
    snapshot.monitor.lastError ? `, last error: ${snapshot.monitor.lastError}` : ''
  })`;
}

/** Formats one line per tracked scheduler, or `[]` if none are tracked yet. */
function formatSchedulerLines(snapshot: HealthSnapshot): string[] {
  const entries = Object.entries(snapshot.schedulers).filter(([, health]) => health !== undefined);
  if (entries.length === 0) return [];
  return [
    'Schedulers:',
    ...entries.map(
      ([name, health]) =>
        `  ${name}: ${health!.lastRunOk ? '🟢 ok' : '🔴 failing'} (last run ${formatDate(health!.lastRunAt)})`,
    ),
  ];
}

/** Formats the most recent errors (newest first, capped at {@link RECENT_ERROR_COUNT}), or `[]` if none. */
function formatRecentErrorLines(snapshot: HealthSnapshot): string[] {
  if (snapshot.errors.length === 0) return [];
  const recent = snapshot.errors.slice(-RECENT_ERROR_COUNT).reverse();
  return ['Recent errors:', ...recent.map((err) => `  [${formatDate(err.timestamp)}] ${err.module}: ${err.message}`)];
}

/**
 * Builds the plain-text `!health` summary from a health snapshot: Discord/Twitch chat
 * connection state, the last DB ping, every tracked EventSub streamer's connection status,
 * the last monitor poll, every tracked scheduler's last run, and the most recent errors
 * (newest first, capped at {@link RECENT_ERROR_COUNT}).
 * @param snapshot - The health snapshot to summarize (see `healthStore.getHealthSnapshot`).
 * @returns The formatted summary text.
 */
function formatHealthSummary(snapshot: HealthSnapshot): string {
  const full = [
    '**Bot Health**',
    ...formatConnectivityLines(snapshot),
    ...formatEventSubLines(snapshot),
    formatMonitorLine(snapshot),
    ...formatSchedulerLines(snapshot),
    ...formatRecentErrorLines(snapshot),
  ].join('\n');
  if (full.length <= DISCORD_MESSAGE_LIMIT) return full;
  return full.slice(0, SUMMARY_TRUNCATE_LENGTH) + TRUNCATION_MARKER;
}

/**
 * Handles the `!health` Discord command: matched as the literal first word of the message
 * (no prefix stripping — see `CLAUDE.md`'s command-matching convention), owner-only.
 * Silently no-ops for a non-match, a missing owner row, or an author who isn't the owner, so
 * the command's existence isn't revealed to anyone else. Owner match sends the full summary of
 * the current `healthStore` snapshot via DM — never into the (possibly public) guild channel it
 * was triggered from, since the summary includes DB/EventSub/scheduler/recent-error details.
 * When triggered from a guild channel, also posts a minimal, non-sensitive acknowledgement reply
 * there so the owner knows to check their DMs. If the DM itself fails (e.g. the owner has DMs
 * closed), that's logged and swallowed rather than thrown. The acknowledgement reply is likewise
 * swallowed on failure (e.g. the triggering message was deleted before it could be sent).
 * @param message - The Discord message to check and, if it's an owner-issued `!health`, respond to.
 * @returns Resolves once the command has been handled (or ignored as a non-match).
 */
export async function executeHealthCommandForDiscord(message: Message): Promise<void> {
  if (extractCommand(message.content) !== TRIGGER) return;

  let owner;
  try {
    owner = await findOwnerUser();
  } catch (err) {
    log.error('Failed to resolve owner user for !health command:', err);
    return;
  }
  if (!owner || message.author.id !== owner.discord_id) return;

  try {
    await message.author.send(formatHealthSummary(getHealthSnapshot()));
  } catch (err) {
    log.error('Failed to DM health summary to owner:', err);
    return;
  }

  if (message.guild) {
    try {
      await message.reply('📬 Sent you the health report via DM.');
    } catch (err) {
      if (!isDiscordNotFoundError(err)) {
        log.error('Failed to acknowledge !health command in channel:', err);
      }
    }
  }
}
