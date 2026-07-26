/**
 * In-memory per-channel Twitch chat message counter. Used by timer commands' `min_messages`
 * gate to tell how much chat activity has happened since a timer's last fire. Deliberately
 * ephemeral (not DB-persisted) — like `twitchMonitor.ts`'s live-state map, a bot restart just
 * resets the baseline rather than replaying history.
 */
const messageCounts = new Map<string, number>();

/** Records one chat message seen in `channel`, incrementing its running total. */
export function recordChatMessage(channel: string): void {
  messageCounts.set(channel, (messageCounts.get(channel) ?? 0) + 1);
}

/** Returns the running chat message count for `channel`, or 0 if none have been recorded yet. */
export function getMessageCount(channel: string): number {
  return messageCounts.get(channel) ?? 0;
}

/** Clears all recorded chat activity. Test-only. */
export function clearChatActivity(): void {
  messageCounts.clear();
}
