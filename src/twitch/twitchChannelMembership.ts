import type { ChatClient } from '@twurple/chat';
import { setTwitchChannel } from '../shared/statusStore';
import { getTwitchEnabledChannels } from '../db';
import { normalizeTwitchChannelName } from './twitchChannelName';
import { getUsers } from './twitchApi';
import { createMutationQueue } from '../shared/mutationQueue';
import { withTimeout } from './twitchSendQueue';
import { createLogger } from '../shared/logger';
import { throttledJoin, compensateIfStale, resetJoinGate, partAsync, JOIN_PART_TIMEOUT_MS, MembershipDeps } from './twitchChannelNetworkOps';

const log = createLogger('Twitch');

let _client: ChatClient | null = null;
let _connected = false;

const activeChannels = new Set<string>();
const activeChannelUserIds = new Map<string, string>();
const membershipMutationQueue = createMutationQueue();
let _onChannelJoined: ((channel: string) => void) | null = null;

/**
 * Channels this module has itself confirmed joined (a `client.join()` call actually succeeded)
 * for the *current* connection. This is the source of truth for "is this channel actually joined
 * right now" — {@link isChannelJoined} reads it instead of Twurple's own `ChatClient#currentChannels`.
 *
 * That's deliberate, not a style choice: `currentChannels` is backed by `ircv3`'s `IrcClient`,
 * which only clears its internal joined-channel set from `IrcClient#connect()` — called once, at
 * this bot's startup. An automatic reconnect (the common case: a dropped socket, e.g. a `1006`)
 * happens entirely inside Twurple's `PersistentConnection`, which reconnects the underlying
 * transport without ever calling `IrcClient#connect()` again — so `currentChannels` is never
 * cleared by a reconnect and keeps reporting the *previous* connection's joined channels forever,
 * even though the new connection isn't actually joined to any of them yet server-side. Trusting it
 * after a reconnect made {@link reconcileJoinedChannels} believe every previously-joined channel
 * was still joined and skip rejoining all of them — silently, with no join call and no error to
 * log — leaving the bot's actual per-channel membership up to whatever Twitch's IRC servers
 * happened to do with the old session (observed in production as some channels going dead after a
 * reconnect and others not, with nothing in the logs to explain why).
 *
 * Cleared entirely on every disconnect (see {@link setConnected}), so a reconnect always starts
 * from "nothing confirmed joined" and {@link reconcileJoinedChannels} actually rejoins everything.
 */
const confirmedJoinedChannels = new Set<string>();

/**
 * Increments every time {@link setConnected} transitions to disconnected — i.e. once per
 * connection episode. Exists so a join/part call issued on one episode can't have its eventual
 * outcome (however late) applied to {@link confirmedJoinedChannels} after a *later* episode has
 * already started: `_connected` alone can't distinguish "still on the episode this call was
 * issued during" from "reconnected since, coincidentally connected again" — only a monotonically
 * increasing counter can. See {@link markJoinedIfCurrent}/{@link markPartedIfCurrent}.
 */
let connectionGeneration = 0;

/**
 * Records `channel` as confirmed joined, but only if `generation` still matches the current
 * {@link connectionGeneration} — i.e. no disconnect has happened since the caller captured it.
 * Without this, a join issued before a disconnect that only *settles* (successfully) after a
 * subsequent reconnect would re-poison {@link confirmedJoinedChannels} with a join that actually
 * happened (if at all) on the old, now-dead connection — reintroducing the exact "reconcile
 * believes it's already joined and skips rejoining" bug {@link confirmedJoinedChannels} exists to
 * prevent, just via this race instead of via Twurple's stale `currentChannels`.
 * @param channel - The channel a join call resolved for.
 * @param generation - The {@link connectionGeneration} captured when that join call was issued.
 */
function markJoinedIfCurrent(channel: string, generation: number): void {
  if (generation === connectionGeneration) confirmedJoinedChannels.add(channel);
}

/** See {@link markJoinedIfCurrent} — the corresponding part-side update. */
function markPartedIfCurrent(channel: string, generation: number): void {
  if (generation === connectionGeneration) confirmedJoinedChannels.delete(channel);
}

/**
 * Captures the current {@link connectionGeneration}, for a later staleness check via
 * {@link isGenerationStale} once an async join/part call issued now has settled. Purely a naming
 * aid over reading `connectionGeneration` directly — see {@link connectionGeneration}'s doc for
 * why this snapshot-and-recheck exists at all.
 * @returns The connection generation at the moment of the call.
 */
function captureGeneration(): number {
  return connectionGeneration;
}

/**
 * True if `generation` — captured earlier via {@link captureGeneration} — no longer matches the
 * current {@link connectionGeneration}, i.e. a disconnect happened while the caller's async call
 * was in flight and its outcome should be treated as no longer reflecting the current connection.
 * @param generation - The connection generation captured before the async call was issued.
 * @returns True if a disconnect has happened since `generation` was captured.
 */
function isGenerationStale(generation: number): boolean {
  return generation !== connectionGeneration;
}

/**
 * Bundles this module's live client/membership state for {@link compensateIfStale} — see
 * `twitchChannelNetworkOps.ts`'s {@link MembershipDeps}. Built fresh at each join/part call site
 * so `runExclusive` closes over the current `channel`, and so `markJoined`/`markParted` close over
 * the {@link connectionGeneration} at the moment the call was issued (see
 * {@link markJoinedIfCurrent}) — but its other accessor functions still read
 * `_client`/`_connected`/`activeChannels` live, not a snapshot, since reconciliation can run long
 * after this bundle was built.
 */
function membershipDeps(): MembershipDeps {
  const generation = connectionGeneration;
  return {
    getClient: () => _client,
    isConnected: () => _connected,
    isChannelJoined,
    isDesiredJoined: (channel) => activeChannels.has(channel),
    runExclusive: (channel, op) => membershipMutationQueue.run(channel, op),
    markJoined: (channel) => markJoinedIfCurrent(channel, generation),
    markParted: (channel) => markPartedIfCurrent(channel, generation),
  };
}

/**
 * Sets the active Twurple chat client instance (called from twitchBot after connect).
 * @param c - The connected chat client, or `null` to clear it (e.g. on shutdown).
 * @returns Nothing — mutates the module-level `_client` reference in place.
 */
export function setChatClient(c: ChatClient | null): void {
  _client = c;
}

/**
 * Updates the connected flag (called from twitchBot on connect/disconnect events). Going
 * disconnected also clears {@link confirmedJoinedChannels} and advances
 * {@link connectionGeneration} — see their docs for why nothing can be trusted as still-joined
 * across a reconnect, including a join/part call issued before this disconnect that only settles
 * afterward.
 */
export function setConnected(v: boolean): void {
  _connected = v;
  if (!v) {
    confirmedJoinedChannels.clear();
    connectionGeneration++;
  }
}

/** Registers a callback fired each time the bot successfully joins a channel. */
export function setChannelJoinedHook(fn: (channel: string) => void): void {
  _onChannelJoined = fn;
}

/**
 * Whether `channel` is currently joined: connected, and present in {@link confirmedJoinedChannels}.
 * @param channel - The already-normalized channel name to check.
 * @returns True if the client is connected and this module has itself confirmed `channel` joined.
 */
function isChannelJoined(channel: string): boolean {
  if (!_client || !_connected) return false;
  return confirmedJoinedChannels.has(channel);
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
 * Parts `channel` via the Twurple chat client if it's currently joined but no longer in
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
    confirmedJoinedChannels.delete(channel);
    setTwitchChannel(channel, false);
    return;
  }
  const generation = captureGeneration();
  const partCall = partAsync(_client, channel);
  compensateIfStale(membershipDeps(), channel, partCall, 'part');
  await withTimeout(partCall, JOIN_PART_TIMEOUT_MS, 'Twitch part');
  markPartedIfCurrent(channel, generation);
  setTwitchChannel(channel, false);
  log.info(`Parted stale channel after reconnect: ${channel}`);
}

/**
 * Joins `channel` if it's still desired (in `activeChannels`) but not yet confirmed joined —
 * called from {@link reconcileJoinedChannels} for a channel that needs (re)joining on the current
 * connection. A no-op if the channel is no longer desired, the client isn't connected, or it's
 * already confirmed joined.
 * @param channel - The already-normalized channel name to join if needed.
 * @returns Resolves once the join has been attempted (or skipped) and local state synced.
 *   Rejects if the underlying join call fails or times out.
 */
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
  const generation = captureGeneration();
  await throttledJoin(_client, channel, (call) => compensateIfStale(membershipDeps(), channel, call, 'join'));
  if (isGenerationStale(generation)) {
    // The connection cycled while this join was in flight — its success no longer reflects the
    // current connection's real membership. Applying it here (status/hook/cache) would be
    // misleading; reconcileJoinedChannels() will retry this channel on its own on the current
    // connection. compensateIfStale's own markJoined (also generation-guarded) already skips
    // recording it in confirmedJoinedChannels.
    return;
  }
  confirmedJoinedChannels.add(channel);
  setTwitchChannel(channel, true);
  cacheChannelUserId(channel);
  fireChannelJoinedHook(channel);
  log.info(`Joined queued channel after reconnect: ${channel}`);
}

/**
 * Parts channels no longer in activeChannels and (re)joins any active channel not currently in
 * {@link confirmedJoinedChannels} — which, right after a reconnect, is *every* active channel,
 * since {@link setConnected} clears it on every disconnect. See {@link confirmedJoinedChannels}'s
 * doc for why this can't be driven off Twurple's own `currentChannels` instead.
 */
export async function reconcileJoinedChannels(): Promise<void> {
  if (!_client || !_connected) return;

  for (const channel of [...confirmedJoinedChannels]) {
    try {
      await membershipMutationQueue.run(channel, () => partStaleChannel(channel));
    } catch (err) {
      log.error(`Failed to part stale channel ${channel}:`, err);
    }
  }

  for (const channel of activeChannels) {
    if (confirmedJoinedChannels.has(channel)) continue;
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
      // agree with the live Twurple client state.
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
    const generation = captureGeneration();
    try {
      await throttledJoin(_client, normalized, (call) => compensateIfStale(membershipDeps(), normalized, call, 'join'));
    } catch (err) {
      // Roll back the optimistic add above so a failed join doesn't linger in activeChannels
      // as if it were still desired. This also means reconcileJoinedChannels() — which only
      // iterates activeChannels — will NOT retry this channel on its own; the rejection below
      // propagates to the caller, who owns retrying (e.g. the admin panel surfacing an error
      // for the user to try again).
      activeChannels.delete(normalized);
      setTwitchChannel(normalized, false);
      log.error(`Failed to join channel ${normalized}:`, err);
      throw err;
    }
    if (isGenerationStale(generation)) {
      // The connection cycled while this join was in flight — see joinMissingChannel's identical
      // guard for why applying it here would be misleading; reconcileJoinedChannels() will retry
      // this still-desired channel on the current connection.
      return;
    }
    confirmedJoinedChannels.add(normalized);
    setTwitchChannel(normalized, true);
    cacheChannelUserId(normalized);
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
      // any stale Twurple channel memberships on the next successful connect.
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
        const generation = captureGeneration();
        const partCall = partAsync(_client, normalized);
        compensateIfStale(membershipDeps(), normalized, partCall, 'part');
        await withTimeout(partCall, JOIN_PART_TIMEOUT_MS, 'Twitch part');
        // Guarded, not an unconditional delete: if the connection cycled while this part was in
        // flight and the channel has since been genuinely rejoined on the new connection, this
        // stale part settling must not undo that real join.
        markPartedIfCurrent(normalized, generation);
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
  confirmedJoinedChannels.clear();
  resetJoinGate();
}

/**
 * Test-only: seeds {@link confirmedJoinedChannels} directly, standing in for a real `client.join()`
 * having already succeeded — since it's no longer driven off the mock client's `currentChannels`
 * (see {@link confirmedJoinedChannels}'s doc for why production code doesn't trust that either).
 */
export function __setConfirmedJoinedChannelsForTests(channels: Iterable<string>): void {
  confirmedJoinedChannels.clear();
  for (const c of channels) confirmedJoinedChannels.add(c);
}
