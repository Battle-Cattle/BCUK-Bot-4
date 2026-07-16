import { createLogger } from '../../shared/logger';
import { getAllEventSubStreamers, clearStreamerToken, getEnabledAlertEventTypesBatch, DEFAULT_EVENT_CONFIG } from '../../db';
import type { DbStreamerEventSub, EventSubConfig, AlertEventType } from '../../db';
import { getUsers } from '../twitchApi';
import { getActiveChannels } from '../twitchChannelMembership';
import { normalizeTwitchChannelName } from '../twitchChannelName';
import { createEventSubSubscription, listEventSubSubscriptions, deleteEventSubSubscription, getValidToken, TwitchAuthError } from './twitchApiEventSub';
import {
  handleFollow, handleSub, handleResub, handleGiftSub, handleRaid, handleRedemption,
  handleStreamOnline, handleStreamOffline, handleChannelUpdate,
  FollowEvent, SubEvent, ResubEvent, GiftSubEvent, RaidEvent, RedemptionEvent,
} from './twitchEventSubHandler';

const log = createLogger('EventSub');


/** Describes a single EventSub subscription to create. */
export interface SubSpec { type: string; version: string; condition: Record<string, string> }

/** In-memory streamer info keyed by broadcaster user ID. */
export interface StreamerInfo { login: string; streamerId: number; config: EventSubConfig | null }
const streamerMap = new Map<string, StreamerInfo>();

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

// Maps EventSub notification types to their handler functions.
// Using Map instead of a plain object prevents prototype-chain lookup on user-controlled keys.
type NotificationHandler = (login: string, event: unknown, config: EventSubConfig, streamerId: number) => Promise<void>;
const notificationHandlers = new Map<string, NotificationHandler>([
  ['channel.follow',                                   (l, e, c, sid) => handleFollow(l, e as FollowEvent, c, sid)],
  ['channel.subscribe',                                (l, e, c, sid) => handleSub(l, e as SubEvent, c, sid)],
  ['channel.subscription.message',                     (l, e, c, sid) => handleResub(l, e as ResubEvent, c, sid)],
  ['channel.subscription.gift',                        (l, e, c, sid) => handleGiftSub(l, e as GiftSubEvent, c, sid)],
  ['channel.raid',                                     (l, e, c, sid) => handleRaid(l, e as RaidEvent, c, sid)],
  ['channel.channel_points_custom_reward_redemption.add',  (l, e, c, sid) => handleRedemption(l, e as RedemptionEvent, c, sid)],
  ['stream.online',                                    (l) => handleStreamOnline(l)],
  ['stream.offline',                                   (l) => handleStreamOffline(l)],
  ['channel.update',                                    (l) => handleChannelUpdate(l)],
]);

async function deleteStaleSubscriptions(uid: string, desired: Set<string>, userToken: string | null): Promise<void> {
  if (!userToken) return;
  try {
    const existing = await listEventSubSubscriptions(userToken);
    for (const sub of existing) {
      if (!desired.has(sub.type)) await deleteEventSubSubscription(sub.id, userToken);
    }
  } catch (err) {
    log.error(`Subscription cleanup failed for uid ${uid}:`, err);
  }
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

/** One gated group of EventSub subscriptions: created together whenever `isGroupEnabled` passes. */
interface SubscriptionGroup {
  /**
   * Alert event types that share this group's subscription(s) — declaring these as data (rather
   * than each group hand-writing its own `enabledAlerts.has('literal')` checks) lets
   * `getAlertTypesCoveredBySubscriptionGroups` verify every {@link AlertEventType} is wired to a
   * group; a test in `twitchEventSubSubscriptions.test.ts` fails if a new alert type is added
   * without adding it here, instead of the gap silently compiling.
   */
  alertTypes: AlertEventType[];
  /**
   * Returns true if this group's subscriptions should be created based on the streamer's
   * chat-message configuration alone. Independent of `alertTypes` — `isGroupEnabled` ORs the
   * alerts-overlay gating in generically, since a streamer can want the subscription created
   * purely to drive a browser-source alert, with chat messages off.
   * @param config - The streamer's event response configuration, or null if unset.
   */
  chatEnabled: (config: EventSubConfig | null) => boolean;
  /**
   * Builds this group's subscription specs.
   * @param uid - The broadcaster's Twitch user ID.
   * @returns The subscription specs to create for this group.
   */
  specs: (uid: string) => SubSpec[];
}

/**
 * Returns true if `group`'s subscriptions should be created: either its chat-message config
 * enables it, or any of its `alertTypes` has an enabled alerts-overlay config.
 * @param group - The subscription group to evaluate.
 * @param config - The streamer's event response configuration, or null if unset.
 * @param enabledAlerts - Event types with an enabled alerts-overlay config row for this streamer.
 */
function isGroupEnabled(
  group: SubscriptionGroup,
  config: EventSubConfig | null,
  enabledAlerts: ReadonlySet<AlertEventType>,
): boolean {
  return group.chatEnabled(config) || group.alertTypes.some((type) => enabledAlerts.has(type));
}

// Every group also requires a broadcaster token (WebSocket transport only works with a user
// token, not an app token — see createSubscriptionsForStreamer's upfront `!token` check).
const SUBSCRIPTION_GROUPS: SubscriptionGroup[] = [
  {
    alertTypes: ['follow'],
    chatEnabled: (config) => Boolean(config?.follow_enabled),
    specs: (uid) => [{ type: 'channel.follow', version: '2', condition: { broadcaster_user_id: uid, moderator_user_id: uid } }],
  },
  {
    alertTypes: ['sub', 'resub', 'giftsub'],
    chatEnabled: (config) => Boolean(config?.sub_enabled),
    specs: (uid) => [
      { type: 'channel.subscribe', version: '1', condition: { broadcaster_user_id: uid } },
      { type: 'channel.subscription.message', version: '1', condition: { broadcaster_user_id: uid } },
      { type: 'channel.subscription.gift', version: '1', condition: { broadcaster_user_id: uid } },
    ],
  },
  {
    // Subscribe when the welcome message, the auto-shoutout toggle, or the raid alert is on —
    // handleRaid gates its three behaviours independently, but the subscription itself must
    // exist for any of them to fire.
    alertTypes: ['raid'],
    chatEnabled: (config) => Boolean(config?.raid_enabled || config?.raid_shoutout_enabled),
    specs: (uid) => [{ type: 'channel.raid', version: '1', condition: { to_broadcaster_user_id: uid } }],
  },
  {
    // Gated on config (not just token): this group carries no alertTypes, so — unlike the
    // alert-driven groups above — there's no alert-only path that needs the subscription without
    // a real config row. Requiring one is a proxy for "this streamer completed the full
    // EventSub/chat-message setup" (dispatchNotification itself no longer early-exits without
    // config — it falls back to DEFAULT_EVENT_CONFIG for alert-only streamers — but that's moot
    // here since this group never subscribes for one).
    alertTypes: [],
    chatEnabled: (config) => Boolean(config),
    specs: (uid) => [{ type: 'channel.channel_points_custom_reward_redemption.add', version: '1', condition: { broadcaster_user_id: uid } }],
  },
  {
    // stream.online/offline and channel.update require no scope beyond a valid token — but,
    // like the redemption group above, still gated on config as a proxy for "fully set up"
    // (see that group's comment; dispatchNotification no longer early-exits without config).
    // This drives an immediate live-check that supplements (not replaces) the 60s poller.
    // Not tied to any alert type.
    alertTypes: [],
    chatEnabled: (config) => Boolean(config),
    specs: (uid) => [
      { type: 'stream.online', version: '1', condition: { broadcaster_user_id: uid } },
      { type: 'stream.offline', version: '1', condition: { broadcaster_user_id: uid } },
      { type: 'channel.update', version: '2', condition: { broadcaster_user_id: uid } },
    ],
  },
];

/**
 * Returns the set of alert event types covered by at least one subscription group. Exported for
 * the exhaustiveness test in `twitchEventSubSubscriptions.test.ts`, which asserts this covers
 * every member of `ALERT_EVENT_TYPES` — catching a new alert type being added without also being
 * wired into a subscription group's `alertTypes` (which would otherwise compile fine and only
 * surface as "the subscription is never created" at runtime).
 */
export function getAlertTypesCoveredBySubscriptionGroups(): Set<AlertEventType> {
  return new Set(SUBSCRIPTION_GROUPS.flatMap((group) => group.alertTypes));
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

/** Creates all desired EventSub subscriptions for a single streamer and returns the desired-types set. */
async function createSubscriptionsForStreamer(
  sessionId: string, data: StreamerEventSubData,
): Promise<Set<string>> {
  const { uid, token, name, config, enabledAlerts = new Set<AlertEventType>() } = data;
  const normalizedName = normalizeTwitchChannelName(name) ?? name.toLowerCase();
  if (!getActiveChannels().has(normalizedName)) {
    log.info(`Skipping EventSub subscriptions for ${name} — bot not in channel`);
    return new Set();
  }

  const desired = new Set<string>();
  if (!token) return desired;

  for (const group of SUBSCRIPTION_GROUPS) {
    if (!isGroupEnabled(group, config, enabledAlerts)) continue;
    for (const spec of group.specs(uid)) {
      desired.add(spec.type);
      await subscribe(sessionId, spec, token, name);
    }
  }

  return desired;
}

/**
 * Fetches all streamers from the DB, resolves their broadcaster IDs and valid tokens. Alert-gating
 * state for every streamer is fetched in a single batched query (`getEnabledAlertEventTypesBatch`)
 * up front, rather than one query per streamer, mirroring `getAllEventSubStreamers`'s own
 * bulk-JOIN fetch of `streamer_event_config`.
 */
export async function loadStreamersForEventSub(): Promise<StreamerEventSubData[]> {
  const streamers = await getAllEventSubStreamers();
  const alertsByStreamer = await getEnabledAlertEventTypesBatch(streamers.map((s) => s.id));
  const result: StreamerEventSubData[] = [];
  for (const streamer of streamers) {
    const token = await getValidToken(streamer);
    const config = streamer.config;
    const uid = await resolveBroadcasterId(streamer, config);
    if (!uid) continue;
    const enabledAlerts = alertsByStreamer.get(streamer.id) ?? new Set<AlertEventType>();
    result.push({ uid, token, name: streamer.twitch_name ?? '', config, streamerId: streamer.id, enabledAlerts });
  }
  return result;
}

/** Creates all subscriptions for one streamer on their dedicated session, updates streamerMap,
 *  and cleans up stale subscriptions. Returns the count of desired subscriptions. */
export async function subscribeForStreamer(
  sessionId: string, data: StreamerEventSubData,
): Promise<number> {
  const { uid, token, name, config, streamerId } = data;
  streamerMap.set(uid, { login: name, streamerId, config });
  const desired = await createSubscriptionsForStreamer(sessionId, data);
  await deleteStaleSubscriptions(uid, desired, token);
  return desired.size;
}

/** Removes a streamer from the in-memory map (called when their connection is stopped). */
export function removeStreamerFromMap(uid: string): void {
  streamerMap.delete(uid);
}

async function subscribe(sessionId: string, spec: SubSpec, token: string, login: string): Promise<void> {
  const skipKey = `${login}:${spec.type}:${token}`;
  if (authFailedSubs.has(skipKey)) return;
  try {
    const id = await createEventSubSubscription(spec.type, spec.version, spec.condition, sessionId, token);
    if (id !== null) {
      authFailedSubs.delete(skipKey);
      log.info(`Subscribed to ${spec.type} for ${login}`);
    }
  } catch (err) {
    if (err instanceof TwitchAuthError) {
      authFailedSubs.add(skipKey);
      log.warn(`Skipping ${spec.type} for ${login} — authorization missing, user must reconnect Twitch`);
    } else {
      log.error(`Failed to subscribe to ${spec.type} for ${login}:`, err);
    }
  }
}


/**
 * Routes an EventSub notification to the appropriate handler based on subscription type.
 * A streamer with no `streamer_event_config` row (`info.config` null) — e.g. one who has only
 * ever enabled a browser-source alert and never completed the chat-message OAuth setup — still
 * dispatches, using `DEFAULT_EVENT_CONFIG` (every chat-message flag disabled) in place of the
 * missing config, so their alert-only subscriptions aren't silently discarded here. Without
 * this fallback, `isGroupEnabled`'s alert-driven subscription creation and this dispatch gate
 * would disagree: the subscription would exist but every notification for it would be dropped.
 */
export function dispatchNotification(type: string, event: Record<string, unknown>, condition: Record<string, string>): void {
  const broadcasterId = condition.broadcaster_user_id ?? condition.to_broadcaster_user_id;
  if (!broadcasterId) return;

  const info = streamerMap.get(broadcasterId);
  if (!info) return;
  const config = info.config ?? DEFAULT_EVENT_CONFIG;

  const handler = notificationHandlers.get(type);
  if (!handler) {
    log.warn(`Unsupported EventSub notification type: ${type}`);
    return;
  }
  // TypeScript has already narrowed handler to NotificationHandler here, but the explicit
  // typeof check is required for CodeQL's taint analysis to trust the call is safe.
  if (typeof handler !== 'function') {
    log.warn(`Invalid EventSub handler for type: ${type}`);
    return;
  }
  handler(info.login, event, config, info.streamerId)
    .catch((err) => log.error(`${type} handler error:`, err));
}

/** Handles a subscription revocation message, clearing the broadcaster's token if authorisation was revoked. */
export function handleRevocation(sub: { type: string; status: string; condition: Record<string, string> }): void {
  log.warn(`Subscription revoked: type=${sub.type} status=${sub.status}`);

  if (sub.status === 'authorization_revoked' || sub.status === 'user_removed') {
    const broadcasterId = sub.condition.broadcaster_user_id ?? sub.condition.to_broadcaster_user_id;
    if (broadcasterId) {
      const info = streamerMap.get(broadcasterId);
      if (info) {
        clearStreamerToken(info.streamerId)
          .catch((err) => log.error('Clear token error:', err));
        log.warn(`Cleared token for ${info.login} (${sub.status})`);
      }
    }
  }
}
