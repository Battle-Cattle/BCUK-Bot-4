// Companion confirmation for channel-point redemptions. A reward can require the streamer's
// companion app to confirm it ran the reward's actions: its redemptions are recorded `pending`
// and pushed with `ackRequired`, and the app acknowledges over `POST /api/companion/rewards/ack`.
// Success marks the redemption FULFILLED on Twitch. A failure, a missing companion app, or no
// acknowledgement within REDEMPTION_ACK_TIMEOUT_MS cancels it on Twitch (refunding the viewer)
// and takes its increment back off the reward's dynamic price. `claimRedemptionAck` only matches
// a pending row, so whichever of those happens first wins and the rest are no-ops. While the app is
// still running a long reward's actions it can send progress pings
// (`POST /api/companion/rewards/progress`), each restarting the timeout, up to ACK_MAX_HOLD_MS.
//
// Twitch only lets an app fulfil or cancel redemptions of rewards it created, and only while
// they're UNFULFILLED, so these rewards must not skip the request queue (the Channel Points page
// turns that off when confirmation is switched on).
//
// The timers live in memory (single bot instance, see CLAUDE.md); anything still pending at
// startup lost its timer in the restart and is refunded by `sweepPendingRedemptionAcks`.
import {
  claimRedemptionAck, releaseRedemptionAck, updateRedemptionAckStatus, listPendingRedemptionAcks,
  isCompanionConfirmationRequired, recordPendingRedemptionAck, getStreamerById,
  type PendingRedemptionAck, type RedemptionRefundReason,
} from '../../db';
import { ackTimerDelayMs, canExtendAckHold } from '../../shared/ackHold';
import { createLogger } from '../../shared/logger';
import { sweepPendingAcks } from '../../shared/pendingAckSweep';
import { getValidToken } from '../twitchUserTokens';
import { updateRedemptionStatus, TwitchRedemptionNotFoundError, TwitchRewardUnsupportedError, TwitchRewardAuthError } from '../twitchRewardsApi';
import { revertRedemptionPricing } from '../pricing/rewardPricingService';
import { companionRuntimeRegistry, twitchRuntimeRegistry, type CompanionRedemptionEvent } from './twitchEventSubRuntime';

const log = createLogger('RedemptionAcks');

/**
 * How long a companion app has to confirm a redemption before the viewer is refunded. The app only
 * acknowledges once every mapped action has finished, and actions can take a while (Delay actions,
 * slow devices), so this is generous. It only applies while an app is connected but silent: no app
 * connected, or a failure the app reports, refunds straight away.
 */
export const REDEMPTION_ACK_TIMEOUT_MS = 3 * 60_000;

/** Delay between attempts to mark a confirmed redemption FULFILLED on Twitch. */
const FULFIL_RETRY_DELAY_MS = 30_000;

/** Chat wording for each refund reason. */
const REFUND_REASON_TEXT: Record<RedemptionRefundReason, string> = {
  no_companion: "the streamer's companion app isn't connected",
  companion_error: "the streamer's companion app couldn't run it",
  no_ack: "the streamer's companion app didn't respond",
  restart: 'the bot restarted',
};

/**
 * A pending acknowledgement or refund retry: its timer, refund reason and notice channel (if known).
 * `armedAt` (when its acknowledgement timer was first armed) is set only while the redemption still
 * awaits the companion app's acknowledgement; a refund retry has none, so progress pings can't
 * postpone it.
 */
interface PendingAck {
  timer: ReturnType<typeof setTimeout>;
  reason: RedemptionRefundReason;
  channel: string | undefined;
  armedAt?: number;
}

/** Pending acknowledgements and refund retries, by redemption id. */
const pendingAcks = new Map<string, PendingAck>();

/** The redemption fields needed to start waiting for its confirmation. */
export interface ConfirmableRedemption {
  id: string;
  rewardId: string;
  rewardTitle: string;
  userLogin: string;
}

/**
 * Where a redemption stands on companion confirmation: `none` (its reward doesn't require it),
 * `pending` (waiting for the companion app), or `resolved` (a retry of a redemption whose earlier
 * attempt was already fulfilled or refunded — it must not be pushed to the companion app again).
 */
export type RedemptionConfirmation = 'none' | 'pending' | 'resolved';

/**
 * If the redemption's reward requires companion confirmation, records the redemption as pending and
 * arms its refund timer straight away, so every pending row has a timer even if a later step of
 * `handleRedemption` (such as the `handled` write) keeps failing and the redemption is never pushed.
 * Part of `handleRedemption`'s required chain (a DB failure here retries the redemption), and runs
 * after the pricing increment, so a refund always has an increment to take back off. A retry of a
 * redemption already recorded keeps its existing row: still pending, it re-arms the timer; already
 * resolved (e.g. refunded by the timer while the `handled` write kept failing), it arms nothing.
 * @param redemption - The redemption.
 * @param streamerId - DB row id of the streamer.
 * @param channel - The streamer's channel, for the refund notice.
 * @returns Where the redemption stands on confirmation.
 */
export async function prepareRedemptionConfirmation(
  redemption: ConfirmableRedemption, streamerId: number, channel: string,
): Promise<RedemptionConfirmation> {
  if (!(await isCompanionConfirmationRequired(streamerId, redemption.rewardId))) return 'none';
  const pending = await recordPendingRedemptionAck({
    redemptionId: redemption.id,
    streamerId,
    twitchRewardId: redemption.rewardId,
    rewardTitle: redemption.rewardTitle,
    userLogin: redemption.userLogin,
    redeemedAtMs: Date.now(),
  });
  if (!pending) return 'resolved';
  trackRedemptionAck(redemption.id, channel);
  return 'pending';
}

/**
 * Sets a claimed redemption's status on Twitch.
 * @param ack - The claimed redemption.
 * @param status - `FULFILLED` or `CANCELED`.
 * @returns Null on success, or why Twitch refused for good (no usable broadcaster token, the
 *   reward wasn't created by this app, or the redemption is no longer unfulfilled).
 * @throws On a transient failure (network, 5xx), so the caller can release the claim and retry.
 */
async function setTwitchRedemptionStatus(ack: PendingRedemptionAck, status: 'FULFILLED' | 'CANCELED'): Promise<string | null> {
  const streamer = await getStreamerById(ack.streamerId);
  const token = streamer ? await getValidToken(streamer) : null;
  if (!streamer?.twitch_user_id || !token) return 'No valid broadcaster token';
  try {
    await updateRedemptionStatus(streamer.twitch_user_id, ack.twitchRewardId, ack.redemptionId, status, token);
    return null;
  } catch (err) {
    const permanent = err instanceof TwitchRedemptionNotFoundError
      || err instanceof TwitchRewardUnsupportedError
      || err instanceof TwitchRewardAuthError;
    if (permanent) return err.message;
    throw err;
  }
}

/**
 * Takes a refunded redemption's increment back off the reward's dynamic price. Best-effort: a
 * failure is logged, and the price simply decays back down over time.
 * @param ack - The refunded redemption.
 */
async function revertPricing(ack: PendingRedemptionAck): Promise<void> {
  try {
    await revertRedemptionPricing(ack.streamerId, ack.twitchRewardId, ack.redeemedAtMs);
  } catch (err) {
    log.error(`Failed to revert dynamic pricing for refunded redemption ${ack.redemptionId}:`, err);
  }
}

/**
 * Cancels a pending redemption on Twitch, refunding the viewer, takes its increment back off the
 * reward's dynamic price, and tells the viewer in chat when a channel is known. The pricing revert
 * happens even when Twitch refuses the refund for good (recorded as `refund_failed`), since the
 * redemption didn't happen either way. A transient Twitch failure puts the redemption back to
 * pending and rethrows, so the caller can retry.
 * @param redemptionId - Twitch's redemption id.
 * @param reason - Why it's being refunded.
 * @param options - The channel for the chat notice, and the companion app's error text.
 * @returns True if this call resolved it; false if it was already resolved.
 */
export async function refundRedemption(
  redemptionId: string,
  reason: RedemptionRefundReason,
  options: { channel?: string; errorMessage?: string | null } = {},
): Promise<boolean> {
  const ack = await claimRedemptionAck(redemptionId, { status: 'refunded', refundReason: reason, errorMessage: options.errorMessage });
  if (!ack) return false;

  let refusal: string | null;
  try {
    refusal = await setTwitchRedemptionStatus(ack, 'CANCELED');
  } catch (err) {
    await releaseRedemptionAck(redemptionId);
    throw err;
  }
  await revertPricing(ack);

  if (refusal) {
    log.warn(`Couldn't refund redemption ${redemptionId} of "${ack.rewardTitle}" (${reason}): ${refusal}`);
    await updateRedemptionAckStatus(redemptionId, 'refund_failed', refusal);
    return true;
  }
  log.info(`Refunded ${ack.userLogin}'s "${ack.rewardTitle}" redemption (${reason})`);
  const runtime = twitchRuntimeRegistry.get();
  if (options.channel && runtime) {
    const message = `@${ack.userLogin} your "${ack.rewardTitle}" redemption was refunded: ${REFUND_REASON_TEXT[reason]}.`;
    await runtime.send(options.channel, message).catch((err: unknown) => log.error('Failed to send redemption refund notice:', err));
  }
  return true;
}

/** How many times marking a confirmed redemption FULFILLED on Twitch is tried before giving up. */
const FULFIL_ATTEMPTS = 3;

/**
 * Marks a confirmed redemption FULFILLED on Twitch, retrying a transient failure after
 * FULFIL_RETRY_DELAY_MS, up to FULFIL_ATTEMPTS in all. A permanent refusal (e.g. the streamer
 * already fulfilled it by hand) is only logged. The ledger stays `fulfilled` throughout: the
 * actions already ran, so the viewer must never be refunded from here — giving up only leaves the
 * redemption in the streamer's request queue.
 * @param ack - The fulfilled redemption.
 * @param attempt - This attempt's number, starting at 1.
 * @returns Resolves once this attempt has run (a retry runs later, on its own timer).
 */
async function markFulfilledOnTwitch(ack: PendingRedemptionAck, attempt = 1): Promise<void> {
  try {
    const refusal = await setTwitchRedemptionStatus(ack, 'FULFILLED');
    if (refusal) log.warn(`Couldn't mark redemption ${ack.redemptionId} fulfilled on Twitch: ${refusal}`);
  } catch (err) {
    if (attempt >= FULFIL_ATTEMPTS) {
      log.error(`Gave up marking redemption ${ack.redemptionId} fulfilled on Twitch after ${attempt} attempts:`, err);
      return;
    }
    log.warn(`Couldn't mark redemption ${ack.redemptionId} fulfilled on Twitch; retrying:`, err);
    const timer = setTimeout(() => void markFulfilledOnTwitch(ack, attempt + 1), FULFIL_RETRY_DELAY_MS);
    timer.unref();
  }
}

/**
 * Marks a pending redemption fulfilled, here and on Twitch (see {@link markFulfilledOnTwitch}).
 * @param redemptionId - Twitch's redemption id.
 * @returns True if this call resolved it; false if it was already resolved.
 */
async function fulfilRedemption(redemptionId: string): Promise<boolean> {
  const ack = await claimRedemptionAck(redemptionId, { status: 'fulfilled' });
  if (!ack) return false;
  await markFulfilledOnTwitch(ack);
  return true;
}

/**
 * Schedules a refund of a pending redemption after REDEMPTION_ACK_TIMEOUT_MS. If that refund fails
 * (the redemption stays pending), it schedules itself again, so a transient error never strands
 * the points.
 * @param redemptionId - Twitch's redemption id.
 * @param reason - The refund reason to record.
 * @param channel - The streamer's channel for the refund notice, if known.
 * @param armedAt - Set while the redemption awaits the companion app's acknowledgement: when its
 *   timer was first armed (epoch ms), so progress pings can extend it but never past
 *   ACK_MAX_HOLD_MS. Omitted for a refund retry, which pings can't extend.
 */
function scheduleRefund(
  redemptionId: string, reason: RedemptionRefundReason, channel: string | undefined, armedAt?: number,
): void {
  const existing = pendingAcks.get(redemptionId);
  if (existing) clearTimeout(existing.timer);
  const delay = armedAt === undefined ? REDEMPTION_ACK_TIMEOUT_MS : ackTimerDelayMs(REDEMPTION_ACK_TIMEOUT_MS, armedAt);
  const timer = setTimeout(() => {
    pendingAcks.delete(redemptionId);
    refundRedemption(redemptionId, reason, { channel }).catch((err: unknown) => {
      log.error(`Failed to refund redemption ${redemptionId} (${reason}); retrying:`, err);
      scheduleRefund(redemptionId, reason, channel);
    });
  }, delay);
  timer.unref();
  pendingAcks.set(redemptionId, { timer, reason, channel, armedAt });
}

/**
 * Stops a redemption's timer and resolves it now with `resolve`. If that throws (the redemption
 * stays pending), the timer is re-armed with `retryReason` so the redemption still gets resolved.
 * @param redemptionId - Twitch's redemption id.
 * @param retryReason - The refund reason a re-armed timer records.
 * @param resolve - Resolves the redemption; gets the channel the timer had, if any.
 * @returns Whatever `resolve` returns.
 */
async function resolveTracked(
  redemptionId: string,
  retryReason: RedemptionRefundReason,
  resolve: (channel: string | undefined) => Promise<boolean>,
): Promise<boolean> {
  const pending = pendingAcks.get(redemptionId);
  if (pending) clearTimeout(pending.timer);
  pendingAcks.delete(redemptionId);
  try {
    return await resolve(pending?.channel);
  } catch (err) {
    if (pending) scheduleRefund(redemptionId, retryReason, pending.channel);
    throw err;
  }
}

/**
 * Starts waiting for the companion app to confirm a redemption; refunds it if none arrives in
 * time. Call before pushing the event, so the redemption is covered even if the push never
 * happens.
 * @param redemptionId - Twitch's redemption id.
 * @param channel - The streamer's channel, for the refund notice.
 */
export function trackRedemptionAck(redemptionId: string, channel: string): void {
  scheduleRefund(redemptionId, 'no_ack', channel, Date.now());
}

/**
 * Applies a companion app's progress ping for a redemption whose actions are still running:
 * restarts its REDEMPTION_ACK_TIMEOUT_MS countdown, so long actions (Delay actions) aren't
 * refunded mid-run. The caller has already checked the redemption belongs to the pinging streamer.
 * @param redemptionId - Twitch's redemption id.
 * @returns True if the countdown was restarted; false if the redemption isn't waiting for an
 *   acknowledgement (already resolved, timed out and awaiting a refund retry, or unknown to this
 *   process) or has already been held for ACK_MAX_HOLD_MS.
 */
export function extendRedemptionAck(redemptionId: string): boolean {
  const pending = pendingAcks.get(redemptionId);
  if (pending?.armedAt === undefined || !canExtendAckHold(pending.armedAt)) return false;
  scheduleRefund(redemptionId, pending.reason, pending.channel, pending.armedAt);
  return true;
}

/**
 * Pushes a redemption that needs confirmation to the streamer's companion app, or refunds it
 * straight away when no companion app is connected to receive it. Its refund timer is already
 * armed by {@link prepareRedemptionConfirmation}.
 * @param discordId - The streamer's Discord id (the companion stream key).
 * @param event - The companion event, with `ackRequired` set.
 * @returns Resolves once pushed or refunded.
 */
export async function pushRedemptionForConfirmation(discordId: string, event: CompanionRedemptionEvent): Promise<void> {
  const companion = companionRuntimeRegistry.get();
  if (companion && companion.hasCompanionConnection?.(discordId) !== false) {
    companion.pushCompanionEvent(discordId, event);
    return;
  }
  await resolveTracked(event.id, 'no_companion', (channel) => refundRedemption(event.id, 'no_companion', { channel }));
}

/**
 * Applies a companion app's acknowledgement: success fulfils the redemption, failure refunds it.
 * The caller has already checked the redemption belongs to the acknowledging streamer. If applying
 * it throws (the redemption stays pending), the timeout is re-armed so it still gets resolved.
 * @param redemptionId - Twitch's redemption id.
 * @param ack - Whether the companion app's actions succeeded, and its error text if not.
 * @returns True if the acknowledgement resolved the redemption; false if it was already resolved
 *   (a duplicate, or one that arrived after the timeout).
 */
export async function acknowledgeRedemption(redemptionId: string, ack: { ok: boolean; error?: string | null }): Promise<boolean> {
  return resolveTracked(redemptionId, 'no_ack', (channel) => (ack.ok
    ? fulfilRedemption(redemptionId)
    : refundRedemption(redemptionId, 'companion_error', { channel, errorMessage: ack.error })));
}

/**
 * Refunds every redemption still pending from before a restart. Call once at startup, before
 * EventSub starts, so no new pending redemption can be swept by mistake. A refund that fails is
 * retried after a timeout.
 * @returns How many redemptions were resolved.
 */
export async function sweepPendingRedemptionAcks(): Promise<number> {
  const resolved = await sweepPendingAcks({
    pendingIds: await listPendingRedemptionAcks(),
    isTracked: (id) => pendingAcks.has(id),
    refund: (id) => refundRedemption(id, 'restart'),
    onFailure: (id, err) => {
      log.error(`Failed to refund pending redemption ${id} at startup; retrying:`, err);
      scheduleRefund(id, 'restart', undefined);
    },
  });
  if (resolved > 0) log.info(`Refunded ${resolved} redemption(s) left waiting for companion confirmation by a restart`);
  return resolved;
}

/** Cancels every pending acknowledgement timer (shutdown and tests); the redemptions stay pending in the DB. */
export function clearRedemptionAcks(): void {
  for (const { timer } of pendingAcks.values()) clearTimeout(timer);
  pendingAcks.clear();
}
