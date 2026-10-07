import { createLogger } from '../../shared/logger';

// Reconciliation cursor state: where each reward's redemption reconciliation resumes from, what
// (if anything) is holding it back, and when each broadcaster was last present. Split out of
// twitchEventSubReconciliation.ts, which only orchestrates (fetches, replays, runs the tick) and
// never touches these maps directly. Shares its logger name so log output is unchanged.
const log = createLogger('EventSubReconciliation');

/**
 * How far back EventSub reconciliation may replay redemptions (ms). Replays older than the
 * in-memory `REDEMPTION_DEDUP_TTL_MS` (`twitchEventSubRedemptionDedup.ts`) are kept safe by the
 * durable `redemption_handled` ledger that `handleRedemption` checks, not by that cache.
 */
export const REDEMPTION_RECOVERY_WINDOW_MS = 60 * 60 * 1000;

/**
 * How long `redemption_handled` ledger rows are kept (ms). Must comfortably exceed
 * {@link REDEMPTION_RECOVERY_WINDOW_MS}: a replay that no longer finds its redemption's row would
 * process it again.
 */
export const REDEMPTION_LEDGER_RETENTION_MS = 6 * 60 * 60 * 1000;

/** How often the reconciliation tick runs (ms), and how far a reward's first poll looks back. */
export const RECONCILIATION_POLL_INTERVAL_MS = 60_000;

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
  /**
   * Set once {@link resolveCutoff} has warned that the cap is skipping this cursor's unfetched
   * window, so a fetch outage that outlasts the cap warns once rather than on every tick. Carried
   * across further fetch failures by {@link markFetchFailed}; any successful fetch writes a fresh
   * cursor without it, so the next, separate outage warns again.
   */
  skipWarned?: boolean;
}

/**
 * Reconciliation cursor per `${broadcasterUserId}:${twitchRewardId}`,
 * tracked purely in memory (mirrors the existing WebSocket/redemption dedup caches). A key's
 * first poll looks back only one {@link RECONCILIATION_POLL_INTERVAL_MS} instead of the reward's
 * full history — this poll exists to catch redemptions missed *while the bot was running* (a
 * WebSocket reconnect gap, a keepalive timeout, a session migration window, including the window
 * right after startup), not to backfill everything that ever happened for a reward.
 */
const lastSeenRedeemedAt = new Map<string, ReconciliationCursor>();

/** When each broadcaster user id was last present in a tick's streamer snapshot (epoch ms). */
const uidLastSeenAt = new Map<string, number>();

/**
 * The furthest behind "now" a reconciliation cutoff may sit: the recovery window
 * ({@link REDEMPTION_RECOVERY_WINDOW_MS}, 1 hour). Resuming from an old cursor also replays the
 * redemptions after it that already succeeded; those are skipped by `handleRedemption`'s durable
 * `redemption_handled` ledger (kept `REDEMPTION_LEDGER_RETENTION_MS`, well beyond this), not
 * only by the 10-minute in-memory dedup cache. A redemption that keeps failing, or can't be
 * fetched, for longer than this is abandoned with a warning. Enforced twice: on the cutoff when a
 * tick picks it ({@link resolveCutoff}), and again per redemption right before it's handled
 * (`replayRedemptions` in twitchEventSubReconciliation.ts), since a slow fetch can age a
 * redemption past the cap in between.
 */
export const MAX_CURSOR_LAG_MS = REDEMPTION_RECOVERY_WINDOW_MS;

/**
 * How long a broadcaster's cursors survive while they're missing from the streamer snapshot. A
 * brief absence (EventSub reconnect, token refresh) must not discard a cursor pinned just before a
 * failed redemption, or that redemption falls outside the fresh one-interval lookback and is never
 * retried. Longer absences are treated as the streamer having left monitoring. (Replaying the
 * successes after a resumed cursor is safe either way: `handleRedemption`'s durable ledger skips
 * them.)
 */
export const CURSOR_RETENTION_MS = 5 * RECONCILIATION_POLL_INTERVAL_MS;

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
 * Records a reward's cursor after its redemptions were fetched and replayed this tick (see
 * {@link nextCursor}): pinned just before the earliest failure, if any, so it's retried. Writes a
 * fresh cursor, which also clears any earlier fetch pin and its skip-warning mark.
 * @param key - The `${broadcasterUserId}:${twitchRewardId}` cursor key.
 * @param cutoff - The cursor this tick fetched from.
 * @param succeededMax - Latest successfully-handled `redeemed_at`, or null.
 * @param failedMin - Earliest failed `redeemed_at`, or null.
 * @returns Nothing — mutates the cursor map in place.
 */
export function recordReplayOutcome(key: string, cutoff: number, succeededMax: number | null, failedMin: number | null): void {
  lastSeenRedeemedAt.set(key, { at: nextCursor(cutoff, succeededMax, failedMin), pinnedBy: failedMin === null ? null : 'handler' });
}

/**
 * Records that the redemptions after a reward's cursor couldn't be fetched, so if the cap later
 * moves the cursor past that window, {@link resolveCutoff} logs the skipped window instead of
 * treating it as quiet. A handler pin still at `cutoff` is kept (it's the more specific reason);
 * one the cap already moved past was abandoned, so the new pin is `'fetch'`. A `'fetch'` pin that
 * was already warned about keeps {@link ReconciliationCursor.skipWarned}: it's the same outage.
 * @param key - The `${broadcasterUserId}:${twitchRewardId}` cursor key.
 * @param cutoff - The cursor the failed fetch started from (epoch ms).
 * @returns Nothing — mutates the cursor map in place.
 */
export function markFetchFailed(key: string, cutoff: number): void {
  const prev = lastSeenRedeemedAt.get(key);
  const pinnedBy = prev?.at === cutoff && prev.pinnedBy ? prev.pinnedBy : 'fetch';
  const skipWarned = prev?.pinnedBy === 'fetch' && prev.skipWarned === true;
  lastSeenRedeemedAt.set(key, { at: cutoff, pinnedBy, skipWarned });
}

/**
 * Marks every tracked reward cursor of a broadcaster as fetch-pinned (see {@link markFetchFailed})
 * when nothing could be fetched for them this tick (no usable token, a failed token lookup, or
 * their rewards couldn't be listed), so none of those windows is later skipped silently.
 * @param uid - Broadcaster's Twitch user ID.
 * @returns Nothing — mutates the cursor map in place.
 */
export function markStreamerFetchFailed(uid: string): void {
  for (const [key, cursor] of lastSeenRedeemedAt) {
    if (key.startsWith(`${uid}:`)) markFetchFailed(key, cursor.at);
  }
}

/**
 * Picks the cutoff a reward's reconciliation fetches from this tick. A reward seen for the first
 * time looks back one poll interval rather than its full history — this still covers the window
 * right after the bot (re)started or first subscribed for this streamer, instead of leaving it as
 * a permanent blind spot. A stored cursor is floored at `now - MAX_CURSOR_LAG_MS` (see
 * {@link MAX_CURSOR_LAG_MS}); when that floor moves a pinned cursor, a warning is logged — either
 * a failing redemption is abandoned, or a window that couldn't be fetched is skipped (once per
 * outage: see {@link ReconciliationCursor.skipWarned}). A success
 * cursor on a quiet reward also gets floored, silently — every redemption before the floor was
 * already fetched by an earlier tick.
 * @param key - The `${broadcasterUserId}:${twitchRewardId}` cursor key.
 * @param login - Streamer login, for the warning.
 * @param now - The current time (epoch ms).
 * @returns The cutoff (epoch ms); redemptions redeemed strictly after it are fetched.
 */
export function resolveCutoff(key: string, login: string, now: number): number {
  const stored = lastSeenRedeemedAt.get(key);
  if (!stored) return now - RECONCILIATION_POLL_INTERVAL_MS;
  const floor = now - MAX_CURSOR_LAG_MS;
  if (stored.at >= floor) return stored.at;
  const reward = key.slice(key.indexOf(':') + 1);
  const minutes = MAX_CURSOR_LAG_MS / 60_000;
  if (stored.pinnedBy === 'handler') {
    log.warn(
      `Abandoning reconciliation retry for reward ${reward} (${login}): a redemption at `
      + `${new Date(stored.at + 1).toISOString()} has kept failing for longer than ${minutes} minutes`,
    );
  } else if (stored.pinnedBy === 'fetch' && !stored.skipWarned) {
    log.warn(
      `Skipping unreconciled redemptions for reward ${reward} (${login}): redemptions after `
      + `${new Date(stored.at).toISOString()} couldn't be fetched for longer than ${minutes} minutes`,
    );
    stored.skipWarned = true;
  }
  return floor;
}

/**
 * Drops cursors for broadcasters that have been missing from the streamer snapshot for longer
 * than {@link CURSOR_RETENTION_MS} — e.g. a streamer removed from monitoring. Without this, the
 * map grows by one entry per reward for every streamer that ever connected, even after they stop
 * being reconciled. A shorter absence keeps the cursors, so a failed redemption's retry position
 * survives a reconnect. The expiry check runs against each broadcaster's previous last-seen time
 * before this tick's snapshot refreshes it, so a gap between ticks (e.g. polling paused by
 * `stopEventSubReconciliation`) counts toward the window too. Broadcasters present for a pass are
 * marked seen again when it ends ({@link markBroadcastersSeen}), so a slow pass doesn't make its
 * own freshly written cursors look stale.
 * @param currentUids - Broadcaster user ids from this tick's streamer snapshot.
 * @param now - The tick's current time (epoch ms).
 * @returns Nothing — mutates the cursor and last-seen maps in place.
 */
export function pruneStaleReconciliationCursors(currentUids: ReadonlySet<string>, now: number): void {
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
 * @returns Nothing — mutates the last-seen map in place.
 */
export function markBroadcastersSeen(uids: ReadonlySet<string>, now: number): void {
  for (const uid of uids) uidLastSeenAt.set(uid, now);
}

/** Test-only: clears the cursor and last-seen maps so each test starts from a clean slate. */
export function __resetReconciliationCursorStateForTests(): void {
  lastSeenRedeemedAt.clear();
  uidLastSeenAt.clear();
}
