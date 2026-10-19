// Shared by the companion-acknowledgement ledgers (advanced-command uses and channel-point
// redemptions): how long a companion app may keep a pending acknowledgement alive with progress
// pings while it's still running a long event's actions (e.g. Delay actions).

/**
 * The longest a companion app can hold one event pending with progress pings, counted from when
 * its acknowledgement timer was first armed. A ping after this no longer restarts the timeout, so
 * an app that pings forever without ever acknowledging can't strand the viewer's points.
 */
export const ACK_MAX_HOLD_MS = 2 * 60 * 60_000;

/**
 * Whether a progress ping may still restart an event's acknowledgement timeout.
 * @param armedAtMs - When the event's acknowledgement timer was first armed (epoch ms).
 * @param nowMs - The current time (epoch ms).
 * @returns True while the event has been held for less than {@link ACK_MAX_HOLD_MS}.
 */
export function canExtendAckHold(armedAtMs: number, nowMs = Date.now()): boolean {
  return nowMs - armedAtMs < ACK_MAX_HOLD_MS;
}

/**
 * How long an event's acknowledgement timer should run: the usual timeout, cut short so the event
 * is never held past {@link ACK_MAX_HOLD_MS} from when its timer was first armed.
 * @param timeoutMs - The ledger's acknowledgement timeout.
 * @param armedAtMs - When the event's acknowledgement timer was first armed (epoch ms).
 * @param nowMs - The current time (epoch ms).
 * @returns The timer delay in ms (never negative).
 */
export function ackTimerDelayMs(timeoutMs: number, armedAtMs: number, nowMs = Date.now()): number {
  return Math.max(0, Math.min(timeoutMs, armedAtMs + ACK_MAX_HOLD_MS - nowMs));
}
