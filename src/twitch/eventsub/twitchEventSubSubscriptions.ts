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
 * @param uid - Broadcaster's Twitch user ID; also used to filter out another broadcaster's
 *   subscription that Twitch included only because this streamer moderates that channel (see
 *   {@link isOwnSubscription}) — never deleted, regardless of type or desired state.
 * @param desired - Subscription types that should exist after this call.
 * @param created - Type → subscription id for subscriptions freshly created this round (see
 *   {@link createSubscriptionsForStreamer}); a type present here has any other existing
 *   subscription of that type pruned as a stale duplicate.
 * @param userToken - Broadcaster's valid user token; no-ops if null (no token to authenticate with).
 */
async function deleteStaleSubscriptions(
  uid: string, desired: Set<string>, created: ReadonlyMap<string, string>, userToken: string | null,
): Promise<void> {
  if (!userToken) return;
  let existing: Array<{ id: string; type: string; condition: Record<string, string> }>;
  try {
    existing = await listEventSubSubscriptions(userToken);
  } catch (err) {
    log.error(`Subscription cleanup failed for uid ${uid}:`, err);
    return;
  }
  // Each deletion is isolated (and run concurrently, since they target different
  // subscriptions) so one failure (e.g. a transient Twitch API error) doesn't abort the rest
  // of the cleanup — leaving a still-undeleted stale duplicate would keep delivering
  // notifications and double-firing the type's handler, the exact failure this cleanup targets.
  const staleSubs = existing.filter((sub) => {
    if (!isOwnSubscription(sub.condition, uid)) return false;
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

/** Desired subscription types alongside the ones freshly created this round, keyed by type
 *  (see {@link createSubscriptionsForStreamer}). */
interface SubscriptionResult {
  desired: Set<string>;
  created: Map<string, string>;
}

/**
 * Creates all desired EventSub subscriptions for a single streamer. Before creating each type,
 * checks whether Twitch already has a subscription of that type: if it's bound to the live
 * `sessionId`, it's kept as-is (no redundant create call); if it's bound to any other session id
 * — a duplicate left over from a dead/prior connection (e.g. after `onError`/`forceReconnect`
 * tore down a socket without a clean close, so Twitch hadn't yet revoked its subscriptions) —
 * it's deleted first so the fresh create can't 409 against it and leave the *new* session with no
 * working subscription of that type.
 * @returns The desired-types set alongside a type → id map of subscriptions actually created (or
 *   confirmed already-live on this session) this round (a type is absent from `created` only on a
 *   genuine race — see {@link deleteStaleSubscriptions}).
 */
async function createSubscriptionsForStreamer(
  sessionId: string, data: StreamerEventSubData,
): Promise<SubscriptionResult> {
  const { uid, token, name, config, enabledAlerts = new Set<AlertEventType>() } = data;
  const normalizedName = normalizeTwitchChannelName(name) ?? name.toLowerCase();
  if (!getActiveChannels().has(normalizedName)) {
    log.info(`Skipping EventSub subscriptions for ${name} — bot not in channel`);
    return { desired: new Set(), created: new Map() };
  }

  const desired = new Set<string>();
  const created = new Map<string, string>();
  if (!token) return { desired, created };

  const existingByType = await listExistingSubscriptionsByType(token, uid, name);

  for (const group of SUBSCRIPTION_GROUPS) {
    if (!isGroupEnabled(group, config, enabledAlerts)) continue;
    for (const spec of group.specs(uid)) {
      desired.add(spec.type);
      const id = await ensureSubscription(sessionId, spec, token, name, existingByType.get(spec.type));
      if (id !== null) created.set(spec.type, id);
    }
  }

  return { desired, created };
}

/** Fetches existing EventSub subscriptions, filters out any that Twitch returned only because
 *  this streamer moderates a different broadcaster's channel (see {@link isOwnSubscription}), and
 *  indexes the rest by type. Returns an empty map (and logs) on failure — callers treat that the
 *  same as "nothing exists yet" and create fresh. */
async function listExistingSubscriptionsByType(
  token: string, uid: string, name: string,
): Promise<Map<string, { id: string; sessionId?: string }>> {
  try {
    const existing = await listEventSubSubscriptions(token);
    return new Map(
      existing
        .filter((sub) => isOwnSubscription(sub.condition, uid))
        .map((sub) => [sub.type, { id: sub.id, sessionId: sub.sessionId }]),
    );
  } catch (err) {
    log.error(`Failed to list existing EventSub subscriptions for ${name}:`, err);
    return new Map();
  }
}

/**
 * Ensures a single subscription type is live on the given session: keeps an existing
 * subscription that's already bound to `sessionId`, deletes one bound to any other (stale/dead)
 * session before recreating it, or creates fresh if none exists.
 * @returns The live subscription's id, or null if creation failed (see {@link subscribe}).
 */
async function ensureSubscription(
  sessionId: string, spec: SubSpec, token: string, name: string,
  existing: { id: string; sessionId?: string } | undefined,
): Promise<string | null> {
  if (existing && existing.sessionId === sessionId) return existing.id;
  if (existing) {
    log.warn(`Deleting stale ${spec.type} subscription (${existing.id}) for ${name} — bound to a different session`);
    await deleteEventSubSubscription(existing.id, token).catch((err) => {
      log.error(`Failed to delete stale ${spec.type} subscription for ${name}:`, err);
    });
  }
  return subscribe(sessionId, spec, token, name);
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
 *  desired subscriptions. */
export async function subscribeForStreamer(
  sessionId: string, data: StreamerEventSubData,
): Promise<number> {
  const { uid, token, name, config, streamerId } = data;
  setStreamerInfo(uid, { login: name, streamerId, config });
  const { desired, created } = await createSubscriptionsForStreamer(sessionId, data);
  await deleteStaleSubscriptions(uid, desired, created, token);
  return desired.size;
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
