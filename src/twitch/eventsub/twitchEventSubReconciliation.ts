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
 * first poll only records the current time as a baseline instead of replaying history — this
 * poll exists to catch redemptions missed *while the bot was running* (a WebSocket reconnect
 * gap, a keepalive timeout, a session migration window), not to backfill everything that
 * happened before this process started or before a reward was first seen.
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
 * Fetches recent redemptions for one reward (both UNFULFILLED — still in the queue — and
 * FULFILLED — including rewards with `should_redemptions_skip_request_queue` set, which never
 * appear as UNFULFILLED) and replays any redeemed after the reward's tracked cursor through
 * {@link handleRedemption}. `handleRedemption` itself dedupes on the redemption id, so a
 * redemption already delivered live via the WebSocket is a safe no-op here — this only ever
 * has an effect for a redemption the WebSocket never delivered at all.
 *
 * @param info - Dispatch info for the redemption's streamer (login/streamerId/config).
 * @param uid - Broadcaster's Twitch user ID.
 * @param token - Broadcaster's currently-valid OAuth user token.
 * @param rewardId - Twitch reward UUID to reconcile.
 */
async function reconcileReward(info: StreamerInfo, uid: string, token: string, rewardId: string): Promise<void> {
  const key = `${uid}:${rewardId}`;
  const cutoff = lastSeenRedeemedAt.get(key);
  if (cutoff === undefined) {
    lastSeenRedeemedAt.set(key, Date.now());
    return;
  }

  let redemptions: TwitchRewardRedemption[];
  try {
    const [unfulfilled, fulfilled] = await Promise.all([
      getRewardRedemptions(uid, rewardId, 'UNFULFILLED', token),
      getRewardRedemptions(uid, rewardId, 'FULFILLED', token),
    ]);
    redemptions = [...unfulfilled, ...fulfilled];
  } catch (err) {
    log.error(`Failed to fetch redemptions for reward ${rewardId} (${info.login}):`, err);
    return;
  }

  let maxSeen = cutoff;
  for (const r of redemptions) {
    const redeemedAt = Date.parse(r.redeemed_at);
    if (!Number.isFinite(redeemedAt) || redeemedAt <= cutoff) continue;
    if (redeemedAt > maxSeen) maxSeen = redeemedAt;
    log.warn(`Reconciliation caught a redemption missed by EventSub: "${r.reward.title}" (id=${r.id}) for ${info.login}`);
    try {
      await handleRedemption(info.login, toRedemptionEvent(info.login, r), info.config ?? DEFAULT_EVENT_CONFIG, info.streamerId);
    } catch (err) {
      log.error(`Reconciled-redemption handler error for redemption ${r.id} (${info.login}):`, err);
    }
  }
  lastSeenRedeemedAt.set(key, maxSeen);
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
