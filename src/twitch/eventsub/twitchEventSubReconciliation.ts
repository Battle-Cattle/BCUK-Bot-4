import { createLogger } from '../../shared/logger';
import { getStreamerById, DEFAULT_EVENT_CONFIG } from '../../db';
import { getAllStreamerInfo, type StreamerInfo } from './twitchEventSubDispatch';
import { getValidToken } from './twitchApiEventSub';
import { getCustomRewards, getRewardRedemptions, TwitchRewardRedemption } from '../twitchApi';
import { handleRedemption, RedemptionEvent } from './twitchEventSubHandler';
import { REDEMPTION_DEDUP_TTL_MS } from './twitchEventSubRedemptionDedup';

const log = createLogger('EventSubReconciliation');

const POLL_INTERVAL_MS = 60_000;

/**
 * Reconciliation cursor per `${broadcasterUserId}:${twitchRewardId}`,
 * tracked purely in memory (mirrors the existing WebSocket/redemption dedup caches). A key's
 * first poll looks back only one {@link POLL_INTERVAL_MS} instead of the reward's full history —
 * this poll exists to catch redemptions missed *while the bot was running* (a WebSocket
 * reconnect gap, a keepalive timeout, a session migration window, including the window right
 * after startup), not to backfill everything that ever happened for a reward.
 */
const lastSeenRedeemedAt = new Map<string, ReconciliationCursor>();

/** A reward's reconciliation cursor and what, if anything, is holding it back. */
interface ReconciliationCursor {
  /** Only redemptions redeemed strictly after this (epoch ms) are fetched next tick. */
  at: number;
  /**
   * Why {@link at} hasn't advanced: `'handler'` — it sits just before a redemption whose handler
   * failed, so that redemption is retried; `'fetch'` — the redemptions after it couldn't be
   * fetched (Helix error listing the reward or its redemptions); null — it's simply the latest
   * success (or the initial lookback).
   */
  pinnedBy: 'handler' | 'fetch' | null;
}

/**
 * The furthest behind "now" a reconciliation cutoff may sit. Resuming from an old cursor also
 * replays the redemptions after it that already succeeded, and those are only suppressed while
 * the dedup cache still remembers them — an entry lives {@link REDEMPTION_DEDUP_TTL_MS} from when
 * the redemption was handled, which is never before it was redeemed. Capping the lookback one poll
 * interval inside that TTL means every replayed success is still deduped, at the cost of no longer
 * retrying a redemption that has kept failing for longer than this. Enforced twice: on the cutoff
 * when a tick picks it ({@link resolveCutoff}), and again per redemption right before it's handled
 * ({@link replayRedemptions}), since a slow fetch can age a redemption past the cap in between.
 */
export const MAX_CURSOR_LAG_MS = REDEMPTION_DEDUP_TTL_MS - POLL_INTERVAL_MS;

/**
 * How long a broadcaster's cursors survive while they're missing from the streamer snapshot. A
 * brief absence (EventSub reconnect, token refresh) must not discard a cursor pinned just before a
 * failed redemption, or that redemption falls outside the fresh one-interval lookback and is never
 * retried. Kept below {@link REDEMPTION_DEDUP_TTL_MS}: resuming from a pinned cursor also replays
 * the redemptions after it that already succeeded, and the dedup cache only suppresses those while
 * it still remembers them.
 */
export const CURSOR_RETENTION_MS = Math.min(5 * POLL_INTERVAL_MS, REDEMPTION_DEDUP_TTL_MS / 2);

/** When each broadcaster user id was last present in a tick's streamer snapshot (epoch ms). */
const uidLastSeenAt = new Map<string, number>();

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
 * Computes a reward's next reconciliation cursor: just before the earliest failure (so it's
 * retried next tick), else the latest success, else unchanged. Every redemption fetched this tick
 * has redeemedAt > cutoff, so `failedMin - 1` never moves the cursor backwards past where it was.
 * @param cutoff - The cursor this tick fetched from.
 * @param succeededMax - Latest successfully-handled `redeemed_at`, or null.
 * @param failedMin - Earliest failed `redeemed_at`, or null.
 * @returns The new cursor (epoch ms).
 */
export function nextCursor(cutoff: number, succeededMax: number | null, failedMin: number | null): number {
  if (failedMin !== null) return failedMin - 1;
  return succeededMax ?? cutoff;
}

/**
 * Fetches recent redemptions for one reward (both UNFULFILLED — still in the queue — and
 * FULFILLED — including rewards with `should_redemptions_skip_request_queue` set, which never
 * appear as UNFULFILLED) and replays any redeemed after the reward's tracked cursor through
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
    const [unfulfilled, fulfilled] = await Promise.all([
      fetchRedemptionsNewerThan(uid, rewardId, 'UNFULFILLED', token, cutoff),
      fetchRedemptionsNewerThan(uid, rewardId, 'FULFILLED', token, cutoff),
    ]);
    redemptions = [...unfulfilled, ...fulfilled];
  } catch (err) {
    log.error(`Failed to fetch redemptions for reward ${rewardId} (${info.login}):`, err);
    markFetchFailed(key, cutoff);
    return;
  }

  const { succeededMax, failedMin } = await replayRedemptions(info, redemptions);
  lastSeenRedeemedAt.set(key, { at: nextCursor(cutoff, succeededMax, failedMin), pinnedBy: failedMin === null ? null : 'handler' });
}

/**
 * Records that the redemptions after a reward's cursor couldn't be fetched, so if the cap later
 * moves the cursor past that window, {@link resolveCutoff} logs the skipped window instead of
 * treating it as quiet. A handler pin still at `cutoff` is kept (it's the more specific reason);
 * one the cap already moved past was abandoned, so the new pin is `'fetch'`.
 * @param key - The `${broadcasterUserId}:${twitchRewardId}` cursor key.
 * @param cutoff - The cursor the failed fetch started from (epoch ms).
 * @returns Nothing — mutates {@link lastSeenRedeemedAt} in place.
 */
function markFetchFailed(key: string, cutoff: number): void {
  const prev = lastSeenRedeemedAt.get(key);
  const pinnedBy = prev?.at === cutoff && prev.pinnedBy ? prev.pinnedBy : 'fetch';
  lastSeenRedeemedAt.set(key, { at: cutoff, pinnedBy });
}

/**
 * Picks the cutoff a reward's reconciliation fetches from this tick. A reward seen for the first
 * time looks back one poll interval rather than its full history — this still covers the window
 * right after the bot (re)started or first subscribed for this streamer, instead of leaving it as
 * a permanent blind spot. A stored cursor is floored at `now - MAX_CURSOR_LAG_MS` (see
 * {@link MAX_CURSOR_LAG_MS}); when that floor moves a pinned cursor, a warning is logged — either
 * a failing redemption is abandoned, or a window that couldn't be fetched is skipped. A success
 * cursor on a quiet reward also gets floored, silently — every redemption before the floor was
 * already fetched by an earlier tick.
 * @param key - The `${broadcasterUserId}:${twitchRewardId}` cursor key.
 * @param login - Streamer login, for the warning.
 * @param now - The current time (epoch ms).
 * @returns The cutoff (epoch ms); redemptions redeemed strictly after it are fetched.
 */
function resolveCutoff(key: string, login: string, now: number): number {
  const stored = lastSeenRedeemedAt.get(key);
  if (!stored) return now - POLL_INTERVAL_MS;
  const floor = now - MAX_CURSOR_LAG_MS;
  if (stored.at >= floor) return stored.at;
  const reward = key.slice(key.indexOf(':') + 1);
  const minutes = MAX_CURSOR_LAG_MS / 60_000;
  if (stored.pinnedBy === 'handler') {
    log.warn(
      `Abandoning reconciliation retry for reward ${reward} (${login}): a redemption at `
      + `${new Date(stored.at + 1).toISOString()} has kept failing for longer than ${minutes} minutes`,
    );
  } else if (stored.pinnedBy === 'fetch') {
    log.warn(
      `Skipping unreconciled redemptions for reward ${reward} (${login}): redemptions after `
      + `${new Date(stored.at).toISOString()} couldn't be fetched for longer than ${minutes} minutes`,
    );
  }
  return floor;
}

/**
 * Drops `lastSeenRedeemedAt` entries for broadcasters that have been missing from the streamer
 * snapshot for longer than {@link CURSOR_RETENTION_MS} — e.g. a streamer removed from monitoring.
 * Without this, the map grows by one entry per reward for every streamer that ever connected, even
 * after they stop being reconciled. A shorter absence keeps the cursors, so a failed redemption's
 * retry position survives a reconnect. The expiry check runs against each broadcaster's previous
 * last-seen time before this tick's snapshot refreshes it, so a gap between ticks (e.g. polling
 * paused by {@link stopEventSubReconciliation}) counts toward the window too. Broadcasters present
 * for a pass are marked seen again when it ends, so a slow pass doesn't make its own freshly
 * written cursors look stale.
 * @param currentUids - Broadcaster user ids from this tick's {@link getAllStreamerInfo} snapshot.
 * @param now - The tick's current time (epoch ms).
 * @returns Nothing — mutates {@link lastSeenRedeemedAt} and {@link uidLastSeenAt} in place.
 */
function pruneStaleReconciliationCursors(currentUids: ReadonlySet<string>, now: number): void {
  // Expire before refreshing: a broadcaster present again this tick but last seen longer ago than
  // the retention window (e.g. absent, then polling paused, then back) must still lose their stale
  // cursors, so a returning broadcaster can't resume from one that outlived the dedup cache.
  for (const [uid, seenAt] of uidLastSeenAt) {
    if (now - seenAt > CURSOR_RETENTION_MS) uidLastSeenAt.delete(uid);
  }
  for (const key of lastSeenRedeemedAt.keys()) {
    const uid = key.slice(0, key.indexOf(':'));
    if (!uidLastSeenAt.has(uid)) lastSeenRedeemedAt.delete(key);
  }
  markBroadcastersSeen(currentUids, now);
}

/**
 * Records `uids` as present in the streamer snapshot at `now`.
 * @param uids - Broadcaster user ids to mark.
 * @param now - Time to record (epoch ms).
 * @returns Nothing — mutates {@link uidLastSeenAt} in place.
 */
function markBroadcastersSeen(uids: ReadonlySet<string>, now: number): void {
  for (const uid of uids) uidLastSeenAt.set(uid, now);
}

/**
 * Reconciles one streamer: resolves their broadcaster token, lists their custom rewards, and
 * reconciles each one via {@link reconcileReward}. No-ops silently if the streamer has no
 * usable token (nothing to authenticate the Helix calls with — the same condition that would
 * already be blocking their EventSub subscriptions from existing).
 *
 * @param uid - Broadcaster's Twitch user ID (the streamer map's key).
 * @param info - Dispatch info for this streamer.
 */
async function reconcileStreamer(uid: string, info: StreamerInfo): Promise<void> {
  const streamer = await getStreamerById(info.streamerId);
  const token = streamer ? await getValidToken(streamer) : null;
  if (!token) return;

  let rewards;
  try {
    rewards = await getCustomRewards(uid, token);
  } catch (err) {
    log.error(`Failed to list custom rewards for ${info.login}:`, err);
    markStreamerFetchFailed(uid);
    return;
  }

  await Promise.allSettled(rewards.map((reward) => reconcileReward(info, uid, token, reward.id)));
}

/**
 * Marks every tracked reward cursor of a broadcaster as fetch-pinned (see {@link markFetchFailed})
 * when their rewards couldn't be listed, so none of those windows is later skipped silently.
 * @param uid - Broadcaster's Twitch user ID.
 * @returns Nothing — mutates {@link lastSeenRedeemedAt} in place.
 */
function markStreamerFetchFailed(uid: string): void {
  for (const [key, cursor] of lastSeenRedeemedAt) {
    if (key.startsWith(`${uid}:`)) markFetchFailed(key, cursor.at);
  }
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
    } finally {
      tickRunning = false;
    }
  })();
  return currentTickPromise;
}

/**
 * Starts the periodic redemption-reconciliation interval. Call once at bot startup, after
 * EventSub has started (so `getAllStreamerInfo()` has something to iterate).
 * No-ops if already started, so a second call can't leak the original interval handle.
 */
export function startEventSubReconciliation(): void {
  if (tickTimer) return;
  tickTimer = setInterval(() => {
    runReconciliationTick().catch((err) => log.error('Reconciliation tick error:', err));
  }, POLL_INTERVAL_MS);
  log.info(`Started — redemption reconciliation every ${POLL_INTERVAL_MS / 1000}s`);
}

/** Stops the periodic reconciliation interval and awaits any in-flight tick before returning. */
export async function stopEventSubReconciliation(): Promise<void> {
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  await currentTickPromise;
}

/** Test-only: clears the in-memory cursor and last-seen caches so each test starts from a clean slate. */
export function __resetReconciliationCursorsForTests(): void {
  lastSeenRedeemedAt.clear();
  uidLastSeenAt.clear();
}
