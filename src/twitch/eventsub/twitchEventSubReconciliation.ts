import { createLogger } from '../../shared/logger';
import { getStreamerById, DEFAULT_EVENT_CONFIG, pruneRedemptionLedger } from '../../db';
import { getAllStreamerInfo, type StreamerInfo } from './twitchEventSubDispatch';
import { getValidToken } from '../twitchUserTokens';
import { getCustomRewards, getRewardRedemptions, TwitchRewardRedemption } from '../twitchApi';
import { handleRedemption, RedemptionEvent } from './twitchEventSubHandler';
import {
  RECONCILIATION_POLL_INTERVAL_MS,
  MAX_CURSOR_LAG_MS,
  resolveCutoff,
  markFetchFailed,
  markStreamerFetchFailed,
  recordReplayOutcome,
  pruneStaleReconciliationCursors,
  markBroadcastersSeen,
  __resetReconciliationCursorStateForTests,
  REDEMPTION_LEDGER_RETENTION_MS,
} from './twitchEventSubReconciliationCursors';

// Cursor state (where each reward resumes from, and when each broadcaster was last present) lives
// in twitchEventSubReconciliationCursors.ts; this module fetches, replays and runs the tick.

const log = createLogger('EventSubReconciliation');

/** How often the reconciliation tick prunes the `redemption_handled` ledger (ms). */
const LEDGER_PRUNE_INTERVAL_MS = 10 * 60 * 1000;

/** When the ledger was last pruned (epoch ms), or null if not yet this process. */
let ledgerLastPrunedAt: number | null = null;

let tickTimer: ReturnType<typeof setInterval> | null = null;
let tickRunning = false;
let currentTickPromise: Promise<void> = Promise.resolve();

/** Maps a Helix redemption row to the shape `handleRedemption` expects from a live EventSub notification. */
function toRedemptionEvent(broadcasterLogin: string, r: TwitchRewardRedemption): RedemptionEvent {
  return {
    id: r.id,
    user_login: r.user_login,
    user_name: r.user_name,
    broadcaster_user_login: broadcasterLogin,
    reward: { id: r.reward.id, title: r.reward.title },
    user_input: r.user_input,
  };
}

/**
 * Fetches every redemption for one reward+status newer than `cutoff`, paging (newest first)
 * until a page contains a redemption at or before `cutoff` — everything after that point, and on
 * every later page, is even older, so pagination stops there rather than walking the reward's
 * entire history. This bounds the call count even for a reward with heavy redemption volume: a
 * long-lived reward with thousands of past redemptions only ever pages through however many are
 * actually newer than the cursor, typically zero or one page at the normal poll cadence.
 *
 * @param uid - Broadcaster's Twitch user ID.
 * @param rewardId - Twitch reward UUID.
 * @param status - Redemption status to query (see {@link getRewardRedemptions}).
 * @param token - Broadcaster's currently-valid OAuth user token.
 * @param cutoff - Epoch ms; only redemptions redeemed strictly after this are returned.
 */
async function fetchRedemptionsNewerThan(
  uid: string, rewardId: string, status: 'UNFULFILLED' | 'FULFILLED', token: string, cutoff: number,
): Promise<TwitchRewardRedemption[]> {
  const result: TwitchRewardRedemption[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await getRewardRedemptions(uid, rewardId, status, token, after);
    let hitCutoff = false;
    for (const r of page.redemptions) {
      const redeemedAt = Date.parse(r.redeemed_at);
      if (!Number.isFinite(redeemedAt) || redeemedAt <= cutoff) { hitCutoff = true; break; }
      result.push(r);
    }
    if (hitCutoff || !page.cursor || page.redemptions.length === 0) break;
    after = page.cursor;
  }
  return result;
}

/**
 * Replays each fetched redemption through {@link handleRedemption} (its own dedup makes an
 * already-delivered redemption a no-op), logging genuine catches and per-redemption failures.
 * Redemptions with an unparseable `redeemed_at` are skipped.
 * @param info - Dispatch info for the redemption's streamer.
 * @param redemptions - Redemptions fetched for one reward this tick.
 * @returns The latest `redeemed_at` (epoch ms) that was handled successfully and the earliest one
 *   that failed, each null if there were none.
 */
async function replayRedemptions(
  info: StreamerInfo, redemptions: TwitchRewardRedemption[],
): Promise<{ succeededMax: number | null; failedMin: number | null }> {
  let succeededMax: number | null = null;
  let failedMin: number | null = null;
  for (const r of redemptions) {
    const redeemedAt = Date.parse(r.redeemed_at);
    if (!Number.isFinite(redeemedAt)) continue;
    // Re-check the cap at handling time: a slow fetch (or a slow handler earlier in this batch)
    // can age a redemption past it after the cutoff was chosen, and its dedup entry may be gone.
    if (Date.now() - redeemedAt > MAX_CURSOR_LAG_MS) {
      log.warn(`Skipping reconciliation replay of redemption ${r.id} (${info.login}): redeemed more than ${MAX_CURSOR_LAG_MS / 60_000} minutes ago, outside the dedup window`);
      continue;
    }
    try {
      const processed = await handleRedemption(info.login, toRedemptionEvent(info.login, r), info.config ?? DEFAULT_EVENT_CONFIG, info.streamerId);
      // Only log as a genuine catch when handleRedemption actually processed it — its own
      // dedup means most redemptions in this window were already delivered live, and logging
      // those as "missed" would be false (see reconcileReward's doc comment).
      if (processed) {
        log.warn(`Reconciliation caught a redemption missed by EventSub: "${r.reward.title}" (id=${r.id}) for ${info.login}`);
      }
      succeededMax = Math.max(succeededMax ?? redeemedAt, redeemedAt);
    } catch (err) {
      log.error(`Reconciled-redemption handler error for redemption ${r.id} (${info.login}):`, err);
      failedMin = Math.min(failedMin ?? redeemedAt, redeemedAt);
    }
  }
  return { succeededMax, failedMin };
}

/**
 * Fetches recent redemptions for one reward (both UNFULFILLED — still in the queue — and
 * FULFILLED — including rewards with `should_redemptions_skip_request_queue` set, which never
 * appear as UNFULFILLED — sequentially in that order, so a redemption fulfilled mid-fetch isn't
 * missed) and replays any redeemed after the reward's tracked cursor through
 * {@link handleRedemption}. `handleRedemption` itself dedupes on the redemption id and reports
 * back whether it actually processed the redemption or dropped it as a duplicate — a redemption
 * already delivered live via the WebSocket is a safe no-op here, and is not logged as a catch,
 * since this poll's lookback window routinely re-fetches redemptions the WebSocket already
 * handled fine.
 *
 * The cursor advances independently per outcome: past every redemption that `handleRedemption`
 * actually succeeded for, but never past a redemption that failed to handle. This matters when a
 * tick has a mix of successes and failures (e.g. a transient failure partway through a batch) —
 * only the failed (and anything newer) redemptions are retried on the next tick, rather than
 * re-replaying already-succeeded ones. Re-replaying a success is not always a safe no-op: it's
 * only deduped by `handleRedemption`'s redemption-id TTL, which a sustained run of failures could
 * outlast, so keeping the cursor pinned in front of anything unhandled — instead of freezing it
 * for the whole tick — bounds how far behind an already-succeeded redemption can fall. A failure
 * that persists past {@link MAX_CURSOR_LAG_MS} is abandoned (see {@link resolveCutoff}) rather
 * than letting the replay window outgrow the dedup cache.
 *
 * @param info - Dispatch info for the redemption's streamer (login/streamerId/config).
 * @param uid - Broadcaster's Twitch user ID.
 * @param token - Broadcaster's currently-valid OAuth user token.
 * @param rewardId - Twitch reward UUID to reconcile.
 */
async function reconcileReward(info: StreamerInfo, uid: string, token: string, rewardId: string): Promise<void> {
  const key = `${uid}:${rewardId}`;
  const cutoff = resolveCutoff(key, info.login, Date.now());

  let redemptions: TwitchRewardRedemption[];
  try {
    // Sequential, UNFULFILLED first: a redemption is only ever moved UNFULFILLED → FULFILLED, so
    // one that flips between the two requests is still caught by the later FULFILLED fetch. Fetched
    // in parallel, the FULFILLED request could run first and miss it for this tick.
    const unfulfilled = await fetchRedemptionsNewerThan(uid, rewardId, 'UNFULFILLED', token, cutoff);
    const fulfilled = await fetchRedemptionsNewerThan(uid, rewardId, 'FULFILLED', token, cutoff);
    redemptions = [...unfulfilled, ...fulfilled];
  } catch (err) {
    log.error(`Failed to fetch redemptions for reward ${rewardId} (${info.login}):`, err);
    markFetchFailed(key, cutoff);
    return;
  }

  const { succeededMax, failedMin } = await replayRedemptions(info, redemptions);
  recordReplayOutcome(key, cutoff, succeededMax, failedMin);
}

/**
 * Reconciles one streamer: resolves their broadcaster token, lists their custom rewards, and
 * reconciles each one via {@link reconcileReward}. If the streamer has no usable token (nothing
 * to authenticate the Helix calls with), the token lookup itself fails (e.g. a DB error), or
 * their rewards can't be listed, nothing is fetched and their tracked cursors are marked
 * fetch-pinned (see {@link markStreamerFetchFailed}).
 *
 * @param uid - Broadcaster's Twitch user ID (the streamer map's key).
 * @param info - Dispatch info for this streamer.
 */
async function reconcileStreamer(uid: string, info: StreamerInfo): Promise<void> {
  let token: string | null;
  try {
    const streamer = await getStreamerById(info.streamerId);
    token = streamer ? await getValidToken(streamer) : null;
  } catch (err) {
    log.error(`Failed to resolve the broadcaster token for ${info.login}:`, err);
    markStreamerFetchFailed(uid);
    return;
  }
  if (!token) {
    // Nothing to fetch with, so this tick's window goes unreconciled like any other fetch failure.
    markStreamerFetchFailed(uid);
    return;
  }

  let rewards;
  try {
    // Twitch only serves redemptions of rewards this app created (403 for any other), so listing
    // the rest would just spend two wasted Helix calls per reward on every tick.
    rewards = await getCustomRewards(uid, token, { onlyManageable: true });
  } catch (err) {
    log.error(`Failed to list custom rewards for ${info.login}:`, err);
    markStreamerFetchFailed(uid);
    return;
  }

  await Promise.allSettled(rewards.map((reward) => reconcileReward(info, uid, token, reward.id)));
}

/**
 * Runs one reconciliation pass across every streamer currently connected via EventSub with a
 * completed setup (`info.config` non-null — the same gate `hasCompletedEventSubSetup` uses to
 * decide whether the channel-points redemption subscription itself exists; a streamer without
 * it was never subscribed, so there's nothing for this poll to have missed). Streamers are
 * reconciled concurrently and independently — one streamer's failure can't block another's.
 */
export async function runReconciliationTick(): Promise<void> {
  if (tickRunning) return currentTickPromise;
  tickRunning = true;
  currentTickPromise = (async () => {
    try {
      const allStreamerInfo = [...getAllStreamerInfo()];
      const presentUids = new Set(allStreamerInfo.map(([uid]) => uid));
      pruneStaleReconciliationCursors(presentUids, Date.now());
      const entries = allStreamerInfo.filter(([, info]) => info.config !== null);
      await Promise.allSettled(entries.map(([uid, info]) => reconcileStreamer(uid, info)));
      // A pass can run long (e.g. Helix rate-limit waits). These broadcasters were present for all
      // of it and any cursor this pass wrote is fresh, so date their last-seen to when the pass
      // ended — otherwise the next tick could expire a cursor written moments earlier.
      markBroadcastersSeen(presentUids, Date.now());
      await maybePruneRedemptionLedger(Date.now());
    } finally {
      tickRunning = false;
    }
  })();
  return currentTickPromise;
}

/**
 * Prunes `redemption_handled` rows older than {@link REDEMPTION_LEDGER_RETENTION_MS}, at most once
 * per {@link LEDGER_PRUNE_INTERVAL_MS}. Runs from the reconciliation tick so it shares that
 * lifecycle (started after EventSub, stopped before the DB pool closes). A failure is logged and
 * retried on a later tick; it never fails the tick.
 * @param now - The current time (epoch ms).
 * @returns Resolves once the prune ran (or was skipped).
 */
async function maybePruneRedemptionLedger(now: number): Promise<void> {
  if (ledgerLastPrunedAt !== null && now - ledgerLastPrunedAt < LEDGER_PRUNE_INTERVAL_MS) return;
  ledgerLastPrunedAt = now;
  try {
    const deleted = await pruneRedemptionLedger(REDEMPTION_LEDGER_RETENTION_MS);
    if (deleted > 0) log.debug(`Pruned ${deleted} expired redemption ledger row(s)`);
  } catch (err) {
    log.error('Failed to prune the redemption ledger:', err);
  }
}

/**
 * Starts the periodic redemption-reconciliation interval. Call once at bot startup, after
 * EventSub has started (so `getAllStreamerInfo()` has something to iterate).
 * No-ops if already started, so a second call can't leak the original interval handle.
 */
export function startEventSubReconciliation(): void {
  if (tickTimer) return;
  tickTimer = setInterval(() => {
    runReconciliationTick().catch((err: unknown) => log.error('Reconciliation tick error:', err));
  }, RECONCILIATION_POLL_INTERVAL_MS);
  log.info(`Started — redemption reconciliation every ${RECONCILIATION_POLL_INTERVAL_MS / 1000}s`);
}

/** Stops the periodic reconciliation interval and awaits any in-flight tick before returning. */
export async function stopEventSubReconciliation(): Promise<void> {
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  await currentTickPromise;
}

/** Test-only: clears the in-memory cursor, last-seen and ledger-prune state so each test starts from a clean slate. */
export function __resetReconciliationCursorsForTests(): void {
  __resetReconciliationCursorStateForTests();
  ledgerLastPrunedAt = null;
}
