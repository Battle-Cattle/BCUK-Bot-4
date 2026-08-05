import { createLogger } from '../../shared/logger';
import type { TimerCommandForScheduler } from '../../db';
import { getMessageCount } from '../twitchChatActivity';
import { isChannelLive } from '../monitor/twitchMonitor';

const log = createLogger('TimerCommandScheduler');

/** A timer's in-memory firing state — never persisted, so a restart simply restarts the countdown. */
export interface TimerRuntimeState {
  lastFiredAt: number;
  messagesAtLastFire: number;
}

/** Why a row didn't fire on a given tick — `null` means it's clear to fire. */
export type FireBlockReason = 'offline' | 'interval' | 'messages' | null;

/**
 * Evaluates whether a timer is currently blocked from firing, and why. Does not account for the
 * Shared Chat group cooldown — that's applied separately, across the rows this already clears,
 * by `timerCommandScheduler.ts`'s `pickRowsToFire`.
 * @param row - The timer's config, joined with its Twitch channel.
 * @param state - The timer's current in-memory firing state.
 * @param now - Current time in epoch ms.
 */
export function evaluateFireBlock(
  row: { interval_seconds: number; min_messages: number; require_live: boolean; channel: string },
  state: TimerRuntimeState,
  now: number,
): FireBlockReason {
  if (row.require_live && !isChannelLive(row.channel)) return 'offline';
  if (now - state.lastFiredAt < row.interval_seconds * 1000) return 'interval';
  if (row.min_messages > 0 && getMessageCount(row.channel) - state.messagesAtLastFire < row.min_messages) return 'messages';
  return null;
}

/**
 * Firing-block reason last logged for each (timer id, channel) — keyed the same way as the
 * scheduler's `timerState` (see `rowKey` there) — so a stuck gate (e.g. `min_messages` never
 * being met) is logged once when entered rather than every 15s tick, while still being visible
 * at all: previously a blocked timer produced no log output whatsoever, indistinguishable from a
 * healthy one that just hasn't reached its interval yet.
 */
const lastLoggedBlockReason = new Map<string, FireBlockReason>();

/**
 * Logs a timer's block reason the first tick it's seen — skips the routine `'interval'` wait
 * (expected on every row, every cycle) and only logs `'offline'`/`'messages'`, the two states
 * that can silently persist for hours if something upstream (live tracking, chat-activity
 * counting) is broken.
 * @param key - The row's `timerState` key (`"{id}::{channel}"`).
 * @param row - The timer's config, joined with its Twitch channel.
 * @param reason - This tick's block reason, from {@link evaluateFireBlock}.
 * @param state - The timer's current in-memory firing state.
 */
export function logBlockReasonChange(
  key: string,
  row: TimerCommandForScheduler,
  reason: FireBlockReason,
  state: TimerRuntimeState,
): void {
  const previous = lastLoggedBlockReason.get(key);
  lastLoggedBlockReason.set(key, reason);
  if (reason === previous || reason === 'interval' || reason === null) return;

  if (reason === 'offline') {
    log.info(`Timer ${row.id} (${row.channel}): waiting — channel not live`);
  } else if (reason === 'messages') {
    const have = getMessageCount(row.channel) - state.messagesAtLastFire;
    log.info(`Timer ${row.id} (${row.channel}): interval elapsed, waiting on chat activity (${have}/${row.min_messages} messages since last fire)`);
  }
}

/** Clears the logged block reason for one row — call once a row actually fires, so a future re-block logs fresh instead of staying suppressed by an unrelated, older block episode. */
export function forgetBlockReason(key: string): void {
  lastLoggedBlockReason.delete(key);
}

/** Drops logged-block-reason entries for any key no longer present in `currentKeys` — mirrors the scheduler's own `timerState` pruning. */
export function pruneBlockReasonLog(currentKeys: ReadonlySet<string>): void {
  for (const key of lastLoggedBlockReason.keys()) {
    if (!currentKeys.has(key)) lastLoggedBlockReason.delete(key);
  }
}

/** Clears all logged block-reason state. Call on scheduler stop. */
export function clearBlockReasonLog(): void {
  lastLoggedBlockReason.clear();
}
