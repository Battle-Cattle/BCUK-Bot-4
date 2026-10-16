// Companion-app acknowledgements and refunds for advanced commands. A use with the companion
// effect is recorded `pending`; the companion app then acknowledges it (success or failure) over
// `POST /api/companion/commands/ack`. A failure, a missing companion app, or no acknowledgement
// within ACK_TIMEOUT_MS refunds the viewer. `resolveAdvancedCommandUsage` only matches a pending
// row, so whichever of those happens first wins and the rest are no-ops.
//
// The timers live in memory (single bot instance, see CLAUDE.md); anything still pending at
// startup lost its timer in the restart and is refunded by `sweepPendingAdvancedCommandUsage`.
import {
  listPendingAdvancedCommandUsage,
  resolveAdvancedCommandUsage,
  type AdvancedCommandRefundReason,
} from '../../db';
import { createLogger } from '../../shared/logger';
import { advancedCommandRuntimeRegistry } from './advancedCommandRuntime';

const log = createLogger('AdvancedCommands');

/** How long a companion app has to acknowledge a command before the viewer is refunded. */
export const ACK_TIMEOUT_MS = 30_000;

/** Chat wording for each refund reason. */
const REFUND_REASON_TEXT: Record<AdvancedCommandRefundReason, string> = {
  no_companion: "the streamer's companion app isn't connected",
  companion_error: "the streamer's companion app couldn't run it",
  no_ack: "the streamer's companion app didn't respond",
  restart: 'the bot restarted',
};

/** Pending acknowledgements: event id → its timeout and the channel to post a refund notice in. */
const pendingAcks = new Map<string, { timer: ReturnType<typeof setTimeout>; channel: string }>();

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
 * Starts waiting for the companion app to acknowledge a use; refunds it if none arrives in time.
 * If that refund fails (the use stays pending), the timer is re-armed so it's retried.
 * @param eventId - The use's event id.
 * @param channel - The streamer's channel, for the refund notice.
 */
export function trackAdvancedCommandAck(eventId: string, channel: string): void {
  const timer = setTimeout(() => {
    pendingAcks.delete(eventId);
    refundAdvancedCommandUse(eventId, 'no_ack', { channel }).catch((err: unknown) => {
      log.error(`Failed to refund unacknowledged advanced command ${eventId}; retrying:`, err);
      trackAdvancedCommandAck(eventId, channel);
    });
  }, ACK_TIMEOUT_MS);
  timer.unref();
  pendingAcks.set(eventId, { timer, channel });
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
    if (pending) trackAdvancedCommandAck(eventId, pending.channel);
    throw err;
  }
}

/**
 * Refunds every use still pending from before a restart. Call once at startup, before the Twitch
 * bot connects, so no new pending use can be swept by mistake.
 * @returns How many uses were refunded.
 */
export async function sweepPendingAdvancedCommandUsage(): Promise<number> {
  let refunded = 0;
  for (const eventId of await listPendingAdvancedCommandUsage()) {
    if (pendingAcks.has(eventId)) continue;
    if (await refundAdvancedCommandUse(eventId, 'restart')) refunded++;
  }
  if (refunded > 0) log.info(`Refunded ${refunded} advanced command use(s) left pending by a restart`);
  return refunded;
}

/** Cancels every pending acknowledgement timer (shutdown and tests); the uses stay pending in the DB. */
export function clearAdvancedCommandAcks(): void {
  for (const { timer } of pendingAcks.values()) clearTimeout(timer);
  pendingAcks.clear();
}
