import { createLogger } from '../../shared/logger';
import { getStreamerById, DEFAULT_EVENT_CONFIG } from '../../db';
import { getAllStreamerInfo, type StreamerInfo } from './twitchEventSubDispatch';
import { getValidToken } from './twitchApiEventSub';
import { getCustomRewards, getRewardRedemptions, TwitchRewardRedemption } from '../twitchApi';
import { handleRedemption, RedemptionEvent } from './twitchEventSubHandler';

const log = createLogger('EventSubReconciliation');

const POLL_INTERVAL_MS = 60_000;

/**
 * Last-seen redemption timestamp (epoch ms) per `${broadcasterUserId}:${twitchRewardId}`,
 * tracked purely in memory (mirrors the existing WebSocket/redemption dedup caches). A key's
 * first poll looks back only one {@link POLL_INTERVAL_MS} instead of the reward's full history —
 * this poll exists to catch redemptions missed *while the bot was running* (a WebSocket
 * reconnect gap, a keepalive timeout, a session migration window, including the window right
 * after startup), not to backfill everything that ever happened for a reward.
 */
const lastSeenRedeemedAt = new Map<string, number>();

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
 * Fetches recent redemptions for one reward (both UNFULFILLED — still in the queue — and
 * FULFILLED — including rewards with `should_redemptions_skip_request_queue` set, which never
 * appear as UNFULFILLED) and replays any redeemed after the reward's tracked cursor through
 * {@link handleRedemption}. `handleRedemption` itself dedupes on the redemption id and reports
 * back whether it actually processed the redemption or dropped it as a duplicate — a redemption
 * already delivered live via the WebSocket is a safe no-op here, and is not logged as a catch,
 * since this poll's lookback window routinely re-fetches redemptions the WebSocket already
 * handled fine.
 *
 * The cursor only advances past a redemption once `handleRedemption` has actually succeeded for
 * it; if any redemption in this tick fails to handle, the cursor is left exactly where it was
 * before this tick, so every redemption fetched this tick (including ones that already
 * succeeded) is retried on the next tick. That reprocessing is safe: it lands well within
 * `handleRedemption`'s own redemption-id dedup TTL, so an already-handled redemption is a no-op
 * there rather than a real duplicate.
 *
 * @param info - Dispatch info for the redemption's streamer (login/streamerId/config).
 * @param uid - Broadcaster's Twitch user ID.
 * @param token - Broadcaster's currently-valid OAuth user token.
 * @param rewardId - Twitch reward UUID to reconcile.
 */
async function reconcileReward(info: StreamerInfo, uid: string, token: string, rewardId: string): Promise<void> {
  const key = `${uid}:${rewardId}`;
  // First time seeing this reward: look back one poll interval rather than the reward's full
  // history — this still covers the window right after the bot (re)started or first subscribed
  // for this streamer, instead of leaving it as a permanent blind spot.
  const cutoff = lastSeenRedeemedAt.get(key) ?? Date.now() - POLL_INTERVAL_MS;

  let redemptions: TwitchRewardRedemption[];
  try {
    const [unfulfilled, fulfilled] = await Promise.all([
      fetchRedemptionsNewerThan(uid, rewardId, 'UNFULFILLED', token, cutoff),
      fetchRedemptionsNewerThan(uid, rewardId, 'FULFILLED', token, cutoff),
    ]);
    redemptions = [...unfulfilled, ...fulfilled];
  } catch (err) {
    log.error(`Failed to fetch redemptions for reward ${rewardId} (${info.login}):`, err);
    return;
  }

  let maxSeen = cutoff;
  let hadFailure = false;
  for (const r of redemptions) {
    const redeemedAt = Date.parse(r.redeemed_at);
    if (!Number.isFinite(redeemedAt)) continue;
    try {
      const processed = await handleRedemption(info.login, toRedemptionEvent(info.login, r), info.config ?? DEFAULT_EVENT_CONFIG, info.streamerId);
      // Only log as a genuine catch when handleRedemption actually processed it — its own
      // dedup means most redemptions in this window were already delivered live, and logging
      // those as "missed" would be false (see the doc comment above).
      if (processed) {
        log.warn(`Reconciliation caught a redemption missed by EventSub: "${r.reward.title}" (id=${r.id}) for ${info.login}`);
      }
      if (redeemedAt > maxSeen) maxSeen = redeemedAt;
    } catch (err) {
      log.error(`Reconciled-redemption handler error for redemption ${r.id} (${info.login}):`, err);
      hadFailure = true;
    }
  }
  if (!hadFailure) lastSeenRedeemedAt.set(key, maxSeen);
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
      const entries = [...getAllStreamerInfo()].filter(([, info]) => info.config !== null);
      await Promise.allSettled(entries.map(([uid, info]) => reconcileStreamer(uid, info)));
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

/** Test-only: clears the in-memory per-reward cursor cache so each test starts from a clean slate. */
export function __resetReconciliationCursorsForTests(): void {
  lastSeenRedeemedAt.clear();
}
