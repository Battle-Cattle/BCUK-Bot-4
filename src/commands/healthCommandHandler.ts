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

/**
 * Builds the plain-text `!health` summary from a health snapshot: Discord/Twitch chat
 * connection state, the last DB ping, every tracked EventSub streamer's connection status,
 * the last monitor poll, every tracked scheduler's last run, and the most recent errors
 * (newest first, capped at {@link RECENT_ERROR_COUNT}).
 * @param snapshot - The health snapshot to summarize (see `healthStore.getHealthSnapshot`).
 * @returns The formatted summary text.
 */
function formatHealthSummary(snapshot: HealthSnapshot): string {
  const lines: string[] = ['**Bot Health**'];

  lines.push(`Discord: ${snapshot.discordConnected ? '🟢 connected' : '🔴 disconnected'}`);
  lines.push(`Twitch chat: ${snapshot.twitchChatConnected ? '🟢 connected' : '🔴 disconnected'}`);
  lines.push(
    `DB: ${snapshot.db.lastPingOk ? '🟢 ok' : '🔴 failing'} (last ping ${formatDate(snapshot.db.lastPingAt)}${
      snapshot.db.lastError ? `, last error: ${snapshot.db.lastError}` : ''
    })`,
  );

  const eventsubEntries = Object.entries(snapshot.eventsub);
  if (eventsubEntries.length > 0) {
    lines.push('EventSub:');
    for (const [streamer, health] of eventsubEntries) {
      lines.push(
        `  ${streamer}: ${health.connected ? '🟢 connected' : '🔴 disconnected'} (reconnect attempts: ${health.reconnectAttempts})`,
      );
    }
  }

  lines.push(
    `Monitor: ${snapshot.monitor.lastPollOk ? '🟢 ok' : '🔴 failing'} (last poll ${formatDate(snapshot.monitor.lastPollAt)}${
      snapshot.monitor.lastError ? `, last error: ${snapshot.monitor.lastError}` : ''
    })`,
  );

  const schedulerEntries = Object.entries(snapshot.schedulers);
  if (schedulerEntries.length > 0) {
    lines.push('Schedulers:');
    for (const [name, health] of schedulerEntries) {
      if (!health) continue;
      lines.push(`  ${name}: ${health.lastRunOk ? '🟢 ok' : '🔴 failing'} (last run ${formatDate(health.lastRunAt)})`);
    }
  }

  if (snapshot.errors.length > 0) {
    lines.push('Recent errors:');
    const recent = snapshot.errors.slice(-RECENT_ERROR_COUNT).reverse();
    for (const err of recent) {
      lines.push(`  [${formatDate(err.timestamp)}] ${err.module}: ${err.message}`);
    }
  }

  return lines.join('\n');
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
