import { getMessageCount } from '../twitchChatActivity';
import { isChannelLive } from '../monitor/twitchMonitor';

/** A timer's in-memory firing state — never persisted, so a restart simply restarts the countdown. */
export interface TimerRuntimeState {
  lastFiredAt: number;
  messagesAtLastFire: number;
}

/**
 * Decides whether a timer should fire right now, given its config and current in-memory state.
 * Does not account for the Shared Chat group cooldown or cross-command channel floor — those are
 * applied separately, across the rows this already clears, by `timerCommandScheduler.ts` /
 * `timerCommandCooldowns.ts`.
 * @param row - The timer's config, joined with its Twitch channel.
 * @param state - The timer's current in-memory firing state.
 * @param now - Current time in epoch ms.
 * @returns True if the row is clear to fire right now.
 */
export function shouldFire(
  row: { interval_seconds: number; min_messages: number; require_live: boolean; channel: string },
  state: TimerRuntimeState,
  now: number,
): boolean {
  if (row.require_live && !isChannelLive(row.channel)) return false;
  if (now - state.lastFiredAt < row.interval_seconds * 1000) return false;
  if (row.min_messages > 0 && getMessageCount(row.channel) - state.messagesAtLastFire < row.min_messages) return false;
  return true;
}
