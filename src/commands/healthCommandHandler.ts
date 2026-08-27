import type { Message } from 'discord.js';
import { createLogger } from '../shared/logger';
import { extractCommand } from './commandUtils';
import { findOwnerUser } from '../db';
import { getHealthSnapshot, type HealthSnapshot } from '../shared/healthStore';

const log = createLogger('HealthCommand');

const TRIGGER = '!health';

/** Number of most-recent error entries shown in the `!health` summary (newest first). */
const RECENT_ERROR_COUNT = 5;

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
  return [
    '**Bot Health**',
    ...formatConnectivityLines(snapshot),
    ...formatEventSubLines(snapshot),
    formatMonitorLine(snapshot),
    ...formatSchedulerLines(snapshot),
    ...formatRecentErrorLines(snapshot),
  ].join('\n');
}

/**
 * Handles the `!health` Discord command: matched as the literal first word of the message
 * (no prefix stripping — see `CLAUDE.md`'s command-matching convention), owner-only.
 * Silently no-ops for a non-match, a missing owner row, or an author who isn't the owner, so
 * the command's existence isn't revealed to anyone else. Owner match replies with a plain-text
 * summary of the current `healthStore` snapshot.
 * @param message - The Discord message to check and, if it's an owner-issued `!health`, reply to.
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

  await message.reply(formatHealthSummary(getHealthSnapshot()));
}
