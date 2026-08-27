import { createLogger } from '../../shared/logger';
import { getAllEventSubStreamers, getEnabledAlertEventTypesBatch } from '../../db';
import type { DbStreamerEventSub, EventSubConfig, AlertEventType } from '../../db';
import { getUsers } from '../twitchApi';
import { getActiveChannels } from '../twitchChannelMembership';
import { normalizeTwitchChannelName } from '../twitchChannelName';
import { createEventSubSubscription, listEventSubSubscriptions, deleteEventSubSubscription, getValidToken, TwitchAuthError } from './twitchApiEventSub';
import { SubSpec, SUBSCRIPTION_GROUPS, isGroupEnabled } from './twitchEventSubSubscriptionGroups';
import { setStreamerInfo } from './twitchEventSubDispatch';

const log = createLogger('EventSub');

export { dispatchNotification, handleRevocation, removeStreamerFromMap, getAllStreamerInfo } from './twitchEventSubDispatch';
export { getAlertTypesCoveredBySubscriptionGroups } from './twitchEventSubSubscriptionGroups';

// Tracks "login:type:token" triples that failed with 403 — skipped until bot restarts or token changes
const authFailedSubs = new Set<string>();

/** Returns true if any subscription for the given login has previously failed with a 403. */
export function hasAuthFailedSubs(login: string): boolean {
  const prefix = `${login}:`;
  for (const key of authFailedSubs) if (key.startsWith(prefix)) return true;
  return false;
}

/** Clears all auth-failed subscription records for the given login. */
export function clearAuthFailedSubs(login: string): void {
  const prefix = `${login}:`;
  for (const key of authFailedSubs) if (key.startsWith(prefix)) authFailedSubs.delete(key);
}

/** True if `condition` identifies `uid` as the broadcaster — every {@link SubSpec} in
 *  `SUBSCRIPTION_GROUPS` sets one of these two fields to the target streamer's uid. Used to
 *  filter `listEventSubSubscriptions`' result down to this streamer's own subscriptions: that
 *  call is scoped by the streamer's *user token*, which Twitch also matches against subscriptions
 *  where the token's user is a moderator (e.g. `channel.follow`'s `moderator_user_id`) rather than
 *  the broadcaster — so without this filter, another broadcaster's subscription (on a channel this
 *  streamer moderates) could be mistaken for this streamer's own and wrongly kept or deleted. */
function isOwnSubscription(condition: Record<string, string>, uid: string): boolean {
  return condition.broadcaster_user_id === uid || condition.to_broadcaster_user_id === uid;
}

/**
 * Deletes subscriptions that shouldn't be active any more: those whose type isn't in
 * `desired` at all (e.g. the streamer turned off raid alerts), and — for types that were
 * freshly (re)created this round — any *other* existing subscription of that same type, i.e.
 * a duplicate left over from a session whose owning process died without calling
 * `StreamerConnection.stop()` (crash, container restart, redeploy). Twitch eventually revokes
 * an orphaned WebSocket subscription on its own, but not instantaneously — until then it stays
 * "enabled" and delivers notifications alongside the new one, double-firing the type's handler
 * for every event (e.g. `handleRedemption` recording two dashboard entries for one redemption).
 * `createSubscriptionsForStreamer` now proactively deletes a stale subscription (bound to a
 * session id other than the live one) before recreating it, so a type only ends up missing from
 * `created` here on a genuine race (another process/tab recreated it between our list and create
 * calls) — in that rare case it's left untouched, since we can't tell which one Twitch considers
 * the live one without risking deleting the subscription actually receiving events.
 *
 * @param uid - Broadcaster's Twitch user ID; used only for logging here — `existing` is already
 *   filtered down to this streamer's own subscriptions by {@link listOwnSubscriptions}.
 * @param desired - Subscription types that should exist after this call.
 * @param created - Type → subscription id for subscriptions freshly created this round (see
 *   {@link createSubscriptionsForStreamer}); a type present here has any other existing
 *   subscription of that type pruned as a stale duplicate.
 * @param userToken - Broadcaster's valid user token; no-ops if null (no token to authenticate with).
 * @param existing - This streamer's own existing subscriptions, already fetched (and filtered via
 *   {@link isOwnSubscription}) by {@link createSubscriptionsForStreamer} via
 *   {@link listOwnSubscriptions} — reused here instead of re-fetching the same paginated Helix
 *   listing a second time for this same subscribe pass.
 */
async function deleteStaleSubscriptions(
  uid: string, desired: Set<string>, created: ReadonlyMap<string, string>, userToken: string | null,
  existing: ReadonlyArray<{ id: string; type: string; condition: Record<string, string> }>,
): Promise<void> {
  if (!userToken) return;
  // Each deletion is isolated (and run concurrently, since they target different
  // subscriptions) so one failure (e.g. a transient Twitch API error) doesn't abort the rest
  // of the cleanup — leaving a still-undeleted stale duplicate would keep delivering
  // notifications and double-firing the type's handler, the exact failure this cleanup targets.
  const staleSubs = existing.filter((sub) => {
    const keptId = created.get(sub.type);
    const isStaleDuplicate = keptId !== undefined && sub.id !== keptId;
    return !desired.has(sub.type) || isStaleDuplicate;
  });
  await Promise.allSettled(
    staleSubs.map((sub) =>
      deleteEventSubSubscription(sub.id, userToken).catch((err) => {
        log.error(`Failed to delete subscription ${sub.id} (${sub.type}) for uid ${uid}:`, err);
      })),
  );
}

/** Resolves the broadcaster's Twitch user ID. Uses the stored OAuth ID if available;
 *  falls back to a Helix lookup for raid-only streamers (welcome message and/or
 *  auto-shoutout) who haven't connected OAuth. */
async function resolveBroadcasterId(streamer: DbStreamerEventSub, config: EventSubConfig | null): Promise<string | null> {
  if (streamer.twitch_user_id) return streamer.twitch_user_id;
  if (!config?.raid_enabled && !config?.raid_shoutout_enabled) return null;
  if (!streamer.twitch_name) return null;
  try {
    const users = await getUsers([streamer.twitch_name]);
    return users[0]?.id ?? null;
  } catch (err) {
    log.error(`Failed to resolve Twitch user ID for ${streamer.twitch_name}:`, err);
    return null;
  }
}

/** Data bundle passed to a StreamerConnection for setting up EventSub subscriptions. */
export interface StreamerEventSubData {
  uid: string;
  token: string | null;
  name: string;
  config: EventSubConfig | null;
  streamerId: number;
  /** Event types with an enabled alerts-overlay config row for this streamer. Defaults to
   *  empty when omitted (e.g. by callers that don't care about the alerts overlay). */
  enabledAlerts?: ReadonlySet<AlertEventType>;
}

/** Desired subscription types alongside the ones freshly created this round, keyed by type,
 *  and this streamer's own existing subscriptions as already fetched (see
 *  {@link createSubscriptionsForStreamer}). */
interface SubscriptionResult {
  desired: Set<string>;
  created: Map<string, string>;
  ownSubscriptions: Array<{ id: string; type: string; condition: Record<string, string> }>;
}

/** True if `a` and `b` have exactly the same keys and values — used to tell "the subscription
 *  this spec wants" apart from a same-type subscription with a different condition (e.g. a
 *  leftover from an older API version whose condition shape has since changed), which type-only
 *  matching would otherwise mistake for it. */
function conditionsEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  return aKeys.every((key) => a[key] === b[key]);
}

/**
 * Creates all desired EventSub subscriptions for a single streamer. Before creating each spec,
 * checks whether Twitch already has a subscription matching both its type *and* condition
 * exactly: if it's bound to the live `sessionId` and `enabled`, it's kept as-is (no redundant
 * create call); otherwise — bound to any other session id (a duplicate left over from a dead/prior
 * connection, e.g. after `onError`/`forceReconnect` tore down a socket without a clean close, so
 * Twitch hadn't yet revoked its subscriptions) or bound to the live session but not `enabled`
 * (e.g. `authorization_revoked`) — it's deleted first so the fresh create can't 409 against it and
 * leave the *new* session with no working subscription for that spec.
 * @returns The desired-types set, a type → id map of subscriptions actually created (or
 *   confirmed already-live on this session) this round (a type is absent from `created` only on a
 *   genuine race — see {@link deleteStaleSubscriptions}), and this streamer's own existing
 *   subscriptions as fetched at the start of this call (with any id already deleted above removed)
 *   — reused by {@link deleteStaleSubscriptions} instead of it re-fetching the same listing.
 */
async function createSubscriptionsForStreamer(
  sessionId: string, data: StreamerEventSubData,
): Promise<SubscriptionResult> {
  const { uid, token, name, config, enabledAlerts = new Set<AlertEventType>() } = data;
  const normalizedName = normalizeTwitchChannelName(name) ?? name.toLowerCase();
  if (!getActiveChannels().has(normalizedName)) {
    log.info(`Skipping EventSub subscriptions for ${name} — bot not in channel`);
    return { desired: new Set(), created: new Map(), ownSubscriptions: [] };
  }

  const desired = new Set<string>();
  const created = new Map<string, string>();
  if (!token) return { desired, created, ownSubscriptions: [] };

  const ownSubscriptions = await listOwnSubscriptions(token, uid, name);
  // Tracks ids ensureSubscription already deleted this round (a stale-session duplicate deleted
  // before recreating) — excluded from the ownSubscriptions snapshot handed to
  // deleteStaleSubscriptions so it doesn't attempt to delete the same (already-gone) id again.
  const deletedThisRound = new Set<string>();

  for (const group of SUBSCRIPTION_GROUPS) {
    if (!isGroupEnabled(group, config, enabledAlerts)) continue;
    for (const spec of group.specs(uid)) {
      desired.add(spec.type);
      const match = ownSubscriptions.find(
        (sub) => sub.type === spec.type && conditionsEqual(sub.condition, spec.condition),
      );
      const { id, deleted } = await ensureSubscription(sessionId, spec, token, name, match);
      if (deleted && match) deletedThisRound.add(match.id);
      if (id !== null) created.set(spec.type, id);
    }
  }

  return { desired, created, ownSubscriptions: ownSubscriptions.filter((sub) => !deletedThisRound.has(sub.id)) };
}

/** Fetches existing EventSub subscriptions and filters out any that Twitch returned only because
 *  this streamer moderates a different broadcaster's channel (see {@link isOwnSubscription}).
 *  Returns an empty array (and logs) on failure — callers treat that the same as "nothing exists
 *  yet" and create fresh. Each returned subscription's `status` is Twitch's own subscription state
 *  (see {@link ensureSubscription}) — callers must not assume a matching type/condition/session is
 *  actually receiving notifications without also checking it. */
async function listOwnSubscriptions(
  token: string, uid: string, name: string,
): Promise<Array<{ id: string; type: string; condition: Record<string, string>; sessionId?: string; status?: string }>> {
  try {
    const existing = await listEventSubSubscriptions(token);
    return existing.filter((sub) => isOwnSubscription(sub.condition, uid));
  } catch (err) {
    log.error(`Failed to list existing EventSub subscriptions for ${name}:`, err);
    return [];
  }
}

/**
 * Ensures a single subscription type is live on the given session: keeps an existing
 * subscription that's already bound to `sessionId` *and* `enabled` — a subscription can be bound
 * to the live session yet not `enabled` (e.g. `authorization_revoked`, `notification_failures_exceeded`),
 * in which case it isn't actually receiving notifications and must not be counted as live — deletes
 * one that's stale (bound to a different session, or not enabled) before recreating it, or creates
 * fresh if none exists.
 * @returns The live subscription's id (or null if creation failed — see {@link subscribe}), and
 *   whether a stale `existing` subscription was actually deleted here — `false` on a failed delete
 *   attempt, so the caller knows not to treat that id as already gone (it must remain eligible for
 *   {@link deleteStaleSubscriptions} to retry in the same round).
 */
async function ensureSubscription(
  sessionId: string, spec: SubSpec, token: string, name: string,
  existing: { id: string; sessionId?: string; status?: string } | undefined,
): Promise<{ id: string | null; deleted: boolean }> {
  if (existing && existing.sessionId === sessionId && existing.status === 'enabled') return { id: existing.id, deleted: false };
  let deleted = false;
  if (existing) {
    log.warn(`Deleting stale ${spec.type} subscription (${existing.id}) for ${name} — bound to a different session or not enabled (status=${existing.status})`);
    try {
      await deleteEventSubSubscription(existing.id, token);
      deleted = true;
    } catch (err) {
      log.error(`Failed to delete stale ${spec.type} subscription for ${name}:`, err);
    }
  }
  const id = await subscribe(sessionId, spec, token, name);
  return { id, deleted };
}

/**
 * Fetches all streamers from the DB, resolves their broadcaster IDs and valid tokens. Alert-gating
 * state for every streamer is fetched in a single batched query (`getEnabledAlertEventTypesBatch`)
 * up front, rather than one query per streamer, mirroring `getAllEventSubStreamers`'s own
 * bulk-JOIN fetch of `streamer_event_config`. Per-streamer token refresh (`getValidToken`) and
 * broadcaster-ID resolution run concurrently across streamers via `Promise.all` — each streamer
 * is independent, so this doesn't wait on one streamer's token refresh before starting the next.
 */
export async function loadStreamersForEventSub(): Promise<StreamerEventSubData[]> {
  const streamers = await getAllEventSubStreamers();
  const alertsByStreamer = await getEnabledAlertEventTypesBatch(streamers.map((s) => s.id));
  const resolved = await Promise.all(streamers.map(async (streamer): Promise<StreamerEventSubData | null> => {
    const token = await getValidToken(streamer);
    const config = streamer.config;
    const uid = await resolveBroadcasterId(streamer, config);
    if (!uid) return null;
    const enabledAlerts = alertsByStreamer.get(streamer.id) ?? new Set<AlertEventType>();
    return { uid, token, name: streamer.twitch_name ?? '', config, streamerId: streamer.id, enabledAlerts };
  }));
  return resolved.filter((r): r is StreamerEventSubData => r !== null);
}

/** Creates all subscriptions for one streamer on their dedicated session, updates the
 *  dispatch-side streamer map, and cleans up stale subscriptions. Returns the count of
 *  subscriptions actually created or confirmed already-live this round — not merely desired —
 *  since callers (e.g. `StreamerConnection`'s zero-subscriptions self-stop check) rely on this
 *  to detect a connection with no working subscriptions, which `desired`'s count alone can't:
 *  every desired type could still fail to subscribe (e.g. a missing OAuth scope) while `desired`
 *  stays non-empty. */
export async function subscribeForStreamer(
  sessionId: string, data: StreamerEventSubData,
): Promise<number> {
  const { uid, token, name, config, streamerId } = data;
  setStreamerInfo(uid, { login: name, streamerId, config });
  const { desired, created, ownSubscriptions } = await createSubscriptionsForStreamer(sessionId, data);
  await deleteStaleSubscriptions(uid, desired, created, token, ownSubscriptions);
  return created.size;
}

/** Creates a single EventSub subscription. Returns the created subscription's id, or null if
 *  it was skipped (previously auth-failed), Twitch reported it already exists (409), or the
 *  create call failed — callers use a non-null id to identify "the subscription created this
 *  round" when pruning stale duplicates in {@link deleteStaleSubscriptions}. */
async function subscribe(sessionId: string, spec: SubSpec, token: string, login: string): Promise<string | null> {
  const skipKey = `${login}:${spec.type}:${token}`;
  if (authFailedSubs.has(skipKey)) return null;
  try {
    const id = await createEventSubSubscription(spec.type, spec.version, spec.condition, sessionId, token);
    if (id !== null) {
      authFailedSubs.delete(skipKey);
      log.info(`Subscribed to ${spec.type} for ${login}`);
    }
    return id;
  } catch (err) {
    if (err instanceof TwitchAuthError) {
      authFailedSubs.add(skipKey);
      log.warn(`Skipping ${spec.type} for ${login} — authorization missing, user must reconnect Twitch`);
    } else {
      log.error(`Failed to subscribe to ${spec.type} for ${login}:`, err);
    }
    return null;
  }
}
