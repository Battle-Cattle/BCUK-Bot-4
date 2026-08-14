import tmi from 'tmi.js';
import { setTwitchChannel } from '../shared/statusStore';
import { getTwitchEnabledChannels } from '../db';
import { normalizeTwitchChannelName } from './twitchChannelName';
import { getUsers } from './twitchApi';
import { createMutationQueue } from '../shared/mutationQueue';
import { withTimeout } from './twitchSendQueue';
import { createLogger } from '../shared/logger';

const log = createLogger('Twitch');

let _client: tmi.Client | null = null;
let _connected = false;

const activeChannels = new Set<string>();
const activeChannelUserIds = new Map<string, string>();
const membershipMutationQueue = createMutationQueue();
// Twitch rate-limits JOIN to 20 per 10 s (2/s). 600 ms ≈ 1.67/s, ~83% of the ceiling.
const JOIN_THROTTLE_MS = 600;

/**
 * Like `client.say()`, tmi.js's `client.join()`/`client.part()` have no built-in timeout and can
 * hang indefinitely on a stalled socket. Both calls are made from inside a serializing
 * queue/gate ({@link joinGate}, {@link membershipMutationQueue}), so an unbounded hang here would
 * wedge every later join/part — across every channel — forever. Bounding it guarantees those
 * always free up, even though the underlying call may still be stuck.
 */
const JOIN_PART_TIMEOUT_MS = 10_000;
let _onChannelJoined: ((channel: string) => void) | null = null;

// A chain of promises gating client.join() calls so they're spaced JOIN_THROTTLE_MS apart
// globally — across both the reconnect-reconciliation path and ad-hoc single joins (e.g. from
// the admin panel) — since those are only serialised per-channel by membershipMutationQueue and
// could otherwise collectively exceed Twitch's IRC JOIN rate limit.
let joinGate: Promise<void> = Promise.resolve();

/**
 * Watches `call` — a `client.join()`/`client.part()` promise — for a late successful settlement
 * that arrives only after its caller has already stopped waiting on it via
 * {@link JOIN_PART_TIMEOUT_MS}. Detected directly from `call`'s own timing (settling at or past
 * the timeout window means the caller's `withTimeout` race already gave up on it) rather than
 * tracking a separate "newer operation" marker, so this catches a timed-out call landing late
 * even when nothing else has since touched the channel — e.g. the timed-out `joinTwitchChannel`
 * call's own rollback of `activeChannels` is itself enough to make a late join stale.
 *
 * A late rejection needs no compensation (the call never took effect). A late *success* did take
 * effect on the real Twitch-side membership, so if it no longer matches what `activeChannels`
 * wants, this reconciles it: reverts a stale late join by parting again, or restores a stale late
 * part by rejoining. Runs detached from the caller's own await, which already observed the
 * timeout race independently. The corrective action itself goes through
 * {@link membershipMutationQueue} so it can't interleave with a concurrent legitimate operation
 * on the same channel.
 * @param channel - The channel the call was for.
 * @param call - The raw (un-timed-out) `client.join()`/`client.part()` promise to watch.
 * @param kind - Which operation `call` performed.
 * @returns Nothing — returns immediately without waiting on `call`. Reconciliation (if any) runs
 *   asynchronously in the background whenever `call` eventually settles.
 */
function compensateIfStale(channel: string, call: Promise<unknown>, kind: 'join' | 'part'): void {
  const startedAt = Date.now();
  call.then(() => {
    // Settled within the normal window — the caller's own withTimeout race never gave up on
    // this call, so there's nothing to reconcile.
    if (Date.now() - startedAt < JOIN_PART_TIMEOUT_MS) return;
    void membershipMutationQueue.run(channel, async () => {
      if (!_client || !_connected) return;
      const desiredJoined = activeChannels.has(channel);
      if (kind === 'join' && !desiredJoined && isChannelJoined(channel)) {
        log.warn(`[Twitch] Stale join for ${channel} landed after it was no longer desired active — reverting`);
        await withTimeout(_client.part(channel), JOIN_PART_TIMEOUT_MS, 'Twitch part');
      } else if (kind === 'part' && desiredJoined && !isChannelJoined(channel) && _client) {
        log.warn(`[Twitch] Stale part for ${channel} landed while it was still desired active — rejoining`);
        await throttledJoin(_client, channel);
      }
    }).catch((err) => log.error(`Failed to reconcile stale ${kind} for ${channel}:`, err));
  }, () => {});
}

/**
 * Calls `client.join(channel)`, globally throttled to JOIN_THROTTLE_MS between joins across all
 * channels. Bounded by {@link JOIN_PART_TIMEOUT_MS} so a stalled join can't wedge {@link joinGate}
 * — and every join queued behind it — forever. A join that times out but later actually succeeds
 * is reconciled against `activeChannels` by {@link compensateIfStale} instead of being trusted
 * blindly.
 * @param client - The connected tmi.js client to join with.
 * @param channel - The already-normalized channel name to join.
 * @returns Resolves once the join call itself has completed (not once the throttle window has
 *   elapsed — the throttle only delays the *next* queued join). Rejects if the join times out.
 */
async function throttledJoin(client: tmi.Client, channel: string): Promise<void> {
  const previousGate = joinGate;
  let releaseGate!: () => void;
  joinGate = new Promise((resolve) => { releaseGate = resolve; });
  await previousGate;
  const joinCall = client.join(channel);
  compensateIfStale(channel, joinCall, 'join');
  try {
    await withTimeout(joinCall, JOIN_PART_TIMEOUT_MS, 'Twitch join');
  } finally {
    setTimeout(releaseGate, JOIN_THROTTLE_MS);
  }
}

/** Sets the active tmi.js client instance (called from twitchBot after connect). */
export function setTmiClient(c: tmi.Client | null): void {
  _client = c;
}

/** Updates the connected flag (called from twitchBot on connect/disconnect events). */
export function setConnected(v: boolean): void {
  _connected = v;
}

/** Registers a callback fired each time the bot successfully joins a channel. */
export function setChannelJoinedHook(fn: (channel: string) => void): void {
  _onChannelJoined = fn;
}

function isChannelJoined(channel: string): boolean {
  if (!_client || !_connected) return false;
  return _client.getChannels().some((ch) => normalizeTwitchChannelName(ch) === channel);
}

function cacheChannelUserId(channel: string): void {
  getUsers([channel])
    .then(([u]) => { if (u && activeChannels.has(channel)) activeChannelUserIds.set(channel, u.id); })
    .catch((err) => { log.warn(`Failed to cache user ID for channel ${channel}:`, err); });
}

function fireChannelJoinedHook(channel: string): void {
  try { _onChannelJoined?.(channel); } catch (err) { log.error('Channel joined hook error:', err); }
}

/**
 * Parts `channel` via the tmi.js client if it's currently joined but no longer in
 * `activeChannels` (a "stale" membership left over from before a reconnect); otherwise just
 * syncs the status store. Bounded by {@link JOIN_PART_TIMEOUT_MS} so a stalled part can't wedge
 * {@link membershipMutationQueue} for this channel forever.
 * @param channel - The already-normalized channel name to reconcile.
 * @returns Resolves once the channel's status has been synced (and parted, if it was stale).
 *   Rejects if the part call fails or times out — the channel's status is not synced in that case.
 */
async function partStaleChannel(channel: string): Promise<void> {
  if (activeChannels.has(channel)) {
    setTwitchChannel(channel, true);
    cacheChannelUserId(channel);
    return;
  }
  if (!_client || !_connected || !isChannelJoined(channel)) {
    setTwitchChannel(channel, false);
    return;
  }
  const partCall = _client.part(channel);
  compensateIfStale(channel, partCall, 'part');
  await withTimeout(partCall, JOIN_PART_TIMEOUT_MS, 'Twitch part');
  setTwitchChannel(channel, false);
  log.info(`Parted stale channel after reconnect: ${channel}`);
}

async function joinMissingChannel(channel: string): Promise<void> {
  if (!activeChannels.has(channel)) return;
  if (!_client || !_connected) {
    setTwitchChannel(channel, false);
    return;
  }
  if (isChannelJoined(channel)) {
    setTwitchChannel(channel, true);
    cacheChannelUserId(channel);
    return;
  }
  await throttledJoin(_client, channel);
  setTwitchChannel(channel, true);
  cacheChannelUserId(channel);
  fireChannelJoinedHook(channel);
  log.info(`Joined queued channel after reconnect: ${channel}`);
}

/** Parts channels no longer in activeChannels and joins any queued but unjoined channels. */
export async function reconcileJoinedChannels(): Promise<void> {
  if (!_client || !_connected) return;

  const joinedChannels = _client.getChannels()
    .map((channel) => normalizeTwitchChannelName(channel))
    .filter((channel): channel is string => channel !== null);
  const joinedChannelSet = new Set(joinedChannels);

  for (const channel of joinedChannels) {
    try {
      await membershipMutationQueue.run(channel, () => partStaleChannel(channel));
    } catch (err) {
      log.error(`Failed to part stale channel ${channel}:`, err);
    }
  }

  for (const channel of activeChannels) {
    if (joinedChannelSet.has(channel)) continue;
    try {
      await membershipMutationQueue.run(channel, () => joinMissingChannel(channel));
    } catch (err) {
      setTwitchChannel(channel, false);
      log.error(`Failed to join queued channel ${channel}:`, err);
    }
  }
}

/** Loads enabled channels from the DB, populates activeChannels, and pre-resolves user IDs. */
export async function initializeActiveChannels(): Promise<void> {
  const configuredChannels = await getTwitchEnabledChannels();
  for (const ch of configuredChannels) {
    const normalized = normalizeTwitchChannelName(ch);
    if (!normalized) {
      log.error(`Skipping invalid enabled channel in DB: ${ch}`);
      continue;
    }
    activeChannels.add(normalized);
    setTwitchChannel(normalized, false);
  }

  if (activeChannels.size === 0) {
    log.warn('No enabled Twitch channels found in DB; connecting with no joined channels.');
    return;
  }

  try {
    const users = await getUsers([...activeChannels]);
    for (const u of users) activeChannelUserIds.set(u.login.toLowerCase(), u.id);
  } catch (err) {
    log.error('Failed to resolve channel user IDs (shared-chat dedup unavailable):', err);
  }
}

/** Joins a Twitch channel, throttled to respect Twitch rate limits. Serialised via mutationQueue. */
export async function joinTwitchChannel(channel: string): Promise<void> {
  const normalized = normalizeTwitchChannelName(channel);
  if (!normalized) {
    throw new Error(`[Twitch] Invalid channel name: ${channel}`);
  }

  await membershipMutationQueue.run(normalized, async () => {
    // Check inside the mutex so no concurrent join can race between the check
    // and the actual client.join() call.
    if (isChannelJoined(normalized)) {
      // Already joined — sync local tracking so status store and activeChannels
      // agree with the live tmi.js state.
      activeChannels.add(normalized);
      setTwitchChannel(normalized, true);
      cacheChannelUserId(normalized);
      fireChannelJoinedHook(normalized);
      return;
    }

    if (!_client || !_connected) {
      // Queue the desired membership locally so reconnect reconciliation can join
      // it once the Twitch client is available again.
      activeChannels.add(normalized);
      setTwitchChannel(normalized, false);
      cacheChannelUserId(normalized);
      return;
    }

    activeChannels.add(normalized);
    setTwitchChannel(normalized, false);
    try {
      await throttledJoin(_client, normalized);
      setTwitchChannel(normalized, true);
      cacheChannelUserId(normalized);
    } catch (err) {
      // Roll back local state; reconnect reconciliation will retry via activeChannels.
      activeChannels.delete(normalized);
      setTwitchChannel(normalized, false);
      log.error(`Failed to join channel ${normalized}:`, err);
      throw err;
    }
    fireChannelJoinedHook(normalized);
  });
}

/**
 * Parts a Twitch channel and removes it from active tracking. Serialised per-channel via
 * {@link membershipMutationQueue}; the underlying `client.part()` call is bounded by
 * {@link JOIN_PART_TIMEOUT_MS} so a stalled part can't wedge that channel's queue forever.
 * @param channel - The channel name to part (normalized internally; a no-op if invalid).
 * @returns Resolves once local tracking is updated and, if applicable, the client has parted —
 *   or the part attempt has timed out. Rejects if the underlying part call fails or times out.
 */
export async function partTwitchChannel(channel: string): Promise<void> {
  const normalized = normalizeTwitchChannelName(channel);
  if (!normalized) return;

  await membershipMutationQueue.run(normalized, async () => {
    if (!activeChannels.has(normalized) && !isChannelJoined(normalized)) return;

    if (!_client || !_connected) {
      // We remove local state immediately and let reconcileJoinedChannels() part
      // any stale tmi.js channel memberships on the next successful connect.
      activeChannels.delete(normalized);
      activeChannelUserIds.delete(normalized);
      setTwitchChannel(normalized, false);
      return;
    }

    try {
      activeChannels.delete(normalized);
      activeChannelUserIds.delete(normalized);
      setTwitchChannel(normalized, false);
      if (isChannelJoined(normalized)) {
        const partCall = _client.part(normalized);
        compensateIfStale(normalized, partCall, 'part');
        await withTimeout(partCall, JOIN_PART_TIMEOUT_MS, 'Twitch part');
      }
    } catch (err) {
      // Keep desired membership removed so later reconciliation can retry
      // parting any stale runtime join without restoring admin intent here.
      log.error(`Failed to part channel ${normalized}:`, err);
      throw err;
    }
  });
}

/** Returns the set of channels the bot is currently tracking as active. */
export function getActiveChannels(): ReadonlySet<string> {
  return activeChannels;
}

/** Returns a map of channel login → Twitch user ID for all active channels. */
export function getActiveChannelUserIds(): ReadonlyMap<string, string> {
  return activeChannelUserIds;
}

/** Clears all active channel and user ID state, and resets the join throttle gate (used in tests). */
export function clearMembershipState(): void {
  activeChannels.clear();
  activeChannelUserIds.clear();
  joinGate = Promise.resolve();
}
