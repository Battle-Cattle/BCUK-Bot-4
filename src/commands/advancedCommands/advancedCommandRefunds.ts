// Companion-app acknowledgements and refunds for advanced commands. A use with the companion
// effect is recorded `pending`; the companion app then acknowledges it (success or failure) over
// `POST /api/companion/commands/ack`. A failure, a missing companion app, or no acknowledgement
// within ACK_TIMEOUT_MS refunds the viewer. `resolveAdvancedCommandUsage` only matches a pending
// row, so whichever of those happens first wins and the rest are no-ops. While the app is still
// running a long command's actions it can send progress pings
// (`POST /api/companion/commands/progress`), each restarting the timeout, up to ACK_MAX_HOLD_MS.
//
// The timers live in memory (single bot instance, see CLAUDE.md); anything still pending at
// startup lost its timer in the restart and is refunded by `sweepPendingAdvancedCommandUsage`.
import {
  listPendingAdvancedCommandUsage,
  resolveAdvancedCommandUsage,
  type AdvancedCommandRefundReason,
} from '../../db';
import { ackTimerDelayMs, canExtendAckHold } from '../../shared/ackHold';
import { createLogger } from '../../shared/logger';
import { sweepPendingAcks } from '../../shared/pendingAckSweep';
import { advancedCommandRuntimeRegistry } from './advancedCommandRuntime';

const log = createLogger('AdvancedCommands');

/**
 * How long a companion app has to acknowledge a command before the viewer is refunded. The app only
 * acknowledges once every mapped action has finished, and actions can take a while (Delay actions,
 * slow devices), so this is generous. It only applies while an app is connected but silent: no app
 * connected, or a failure the app reports, refunds straight away. Matches the channel-point
 * redemption timeout (`REDEMPTION_ACK_TIMEOUT_MS`).
 */
export const ACK_TIMEOUT_MS = 3 * 60_000;

/** Chat wording for each refund reason. */
const REFUND_REASON_TEXT: Record<AdvancedCommandRefundReason, string> = {
  no_companion: "the streamer's companion app isn't connected",
  companion_error: "the streamer's companion app couldn't run it",
  no_ack: "the streamer's companion app didn't respond",
  restart: 'the bot restarted',
};

/**
 * A pending acknowledgement or refund retry: its timer, refund reason and notice channel (if known).
 * `armedAt` (when its acknowledgement timer was first armed) is set only while the use still awaits
 * the companion app's acknowledgement; a refund retry has none, so progress pings can't postpone it.
 */
interface PendingAck {
  timer: ReturnType<typeof setTimeout>;
  reason: AdvancedCommandRefundReason;
  channel: string | undefined;
  armedAt?: number;
}

/** Pending acknowledgements and refund retries, by event id. */
const pendingAcks = new Map<string, PendingAck>();

/**
 * Refunds a pending use: marks it refunded (only if still pending) and credits the points back in
 * one transaction (see `resolveAdvancedCommandUsage`), then tells the viewer in chat when a
 * channel is known.
 * @param eventId - The use's event id.
 * @param reason - Why it's being refunded.
 * @param options - The channel for the chat notice, and the companion app's error text.
 * @returns True if this call refunded it; false if it was already resolved.
 */
export async function refundAdvancedCommandUse(
  eventId: string,
  reason: AdvancedCommandRefundReason,
  options: { channel?: string; errorMessage?: string | null } = {},
): Promise<boolean> {
  const resolved = await resolveAdvancedCommandUsage(eventId, { status: 'refunded', refundReason: reason, errorMessage: options.errorMessage });
  if (!resolved) return false;
  const { twitchUsername, pointsSpent, commandName } = resolved;
  if (pointsSpent <= 0 || !twitchUsername) return true;

  log.info(`Refunded ${pointsSpent} points to ${twitchUsername} for '${commandName}' (${reason})`);
  const runtime = advancedCommandRuntimeRegistry.get();
  if (options.channel && runtime) {
    const message = `@${twitchUsername} refunded ${pointsSpent} points for ${commandName}: ${REFUND_REASON_TEXT[reason]}.`;
    await runtime.send(options.channel, message).catch((err: unknown) => log.error('Failed to send refund notice:', err));
  }
  return true;
}

/**
 * Schedules a refund of a pending use after ACK_TIMEOUT_MS. If that refund fails (the use stays
 * pending), it schedules itself again, so a transient DB error never strands the points.
 * @param eventId - The use's event id.
 * @param reason - The refund reason to record.
 * @param channel - The streamer's channel for the refund notice, if known.
 * @param armedAt - Set while the use awaits the companion app's acknowledgement: when its timer was
 *   first armed (epoch ms), so progress pings can extend it but never past ACK_MAX_HOLD_MS. Omitted
 *   for a refund retry, which pings can't extend.
 */
function scheduleRefund(eventId: string, reason: AdvancedCommandRefundReason, channel: string | undefined, armedAt?: number): void {
  const delay = armedAt === undefined ? ACK_TIMEOUT_MS : ackTimerDelayMs(ACK_TIMEOUT_MS, armedAt);
  const timer = setTimeout(() => {
    pendingAcks.delete(eventId);
    refundAdvancedCommandUse(eventId, reason, { channel }).catch((err: unknown) => {
      log.error(`Failed to refund advanced command ${eventId} (${reason}); retrying:`, err);
      scheduleRefund(eventId, reason, channel);
    });
  }, delay);
  timer.unref();
  pendingAcks.set(eventId, { timer, reason, channel, armedAt });
}

/**
 * Starts waiting for the companion app to acknowledge a use; refunds it if none arrives in time.
 * If that refund fails (the use stays pending), it's retried after another timeout.
 * @param eventId - The use's event id.
 * @param channel - The streamer's channel, for the refund notice.
 */
export function trackAdvancedCommandAck(eventId: string, channel: string): void {
  scheduleRefund(eventId, 'no_ack', channel, Date.now());
}

/**
 * Applies a companion app's progress ping for a use whose actions are still running: restarts its
 * ACK_TIMEOUT_MS countdown, so long actions (Delay actions) aren't refunded mid-run. The caller has
 * already checked the use belongs to the pinging streamer.
 * @param eventId - The use's event id.
 * @returns True if the countdown was restarted; false if the use isn't waiting for an acknowledgement
 *   (already resolved, timed out and awaiting a refund retry, or unknown to this process) or has
 *   already been held for ACK_MAX_HOLD_MS.
 */
export function extendAdvancedCommandAck(eventId: string): boolean {
  const pending = pendingAcks.get(eventId);
  if (pending?.armedAt === undefined || !canExtendAckHold(pending.armedAt)) return false;
  clearTimeout(pending.timer);
  scheduleRefund(eventId, pending.reason, pending.channel, pending.armedAt);
  return true;
}

/**
 * Applies a companion app's acknowledgement: success marks the use succeeded, failure refunds it.
 * The caller has already checked the use belongs to the acknowledging streamer. If applying it
 * throws (the use stays pending), the timeout is re-armed so the use still gets resolved.
 * @param eventId - The use's event id.
 * @param ack - Whether the companion app's actions succeeded, and its error text if not.
 * @returns True if the acknowledgement resolved the use; false if it was already resolved (a
 *   duplicate, or one that arrived after the timeout).
 */
export async function acknowledgeAdvancedCommandUse(
  eventId: string,
  ack: { ok: boolean; error?: string | null },
): Promise<boolean> {
  const pending = pendingAcks.get(eventId);
  if (pending) clearTimeout(pending.timer);
  pendingAcks.delete(eventId);
  try {
    if (ack.ok) return (await resolveAdvancedCommandUsage(eventId, { status: 'succeeded' })) !== null;
    return await refundAdvancedCommandUse(eventId, 'companion_error', { channel: pending?.channel, errorMessage: ack.error });
  } catch (err) {
    if (pending) scheduleRefund(eventId, 'no_ack', pending.channel);
    throw err;
  }
}

/**
 * Refunds every use still pending from before a restart. Call once at startup, before the Twitch
 * bot connects, so no new pending use can be swept by mistake. A refund that fails is retried
 * after a timeout.
 * @returns How many uses were refunded.
 */
export async function sweepPendingAdvancedCommandUsage(): Promise<number> {
  const refunded = await sweepPendingAcks({
    pendingIds: await listPendingAdvancedCommandUsage(),
    isTracked: (eventId) => pendingAcks.has(eventId),
    refund: (eventId) => refundAdvancedCommandUse(eventId, 'restart'),
    onFailure: (eventId, err) => {
      log.error(`Failed to refund pending advanced command ${eventId} at startup; retrying:`, err);
      scheduleRefund(eventId, 'restart', undefined);
    },
  });
  if (refunded > 0) log.info(`Refunded ${refunded} advanced command use(s) left pending by a restart`);
  return refunded;
}

/** Cancels every pending acknowledgement timer (shutdown and tests); the uses stay pending in the DB. */
export function clearAdvancedCommandAcks(): void {
  for (const { timer } of pendingAcks.values()) clearTimeout(timer);
  pendingAcks.clear();
}
