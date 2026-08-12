import type { EventSubConfig, AlertEventType } from '../../db';

/** Describes a single EventSub subscription to create. */
export interface SubSpec { type: string; version: string; condition: Record<string, string> }

/** One gated group of EventSub subscriptions: created together whenever `isGroupEnabled` passes. */
interface SubscriptionGroup {
  /**
   * Alert event types that share this group's subscription(s) — declaring these as data (rather
   * than each group hand-writing its own `enabledAlerts.has('literal')` checks) lets
   * `getAlertTypesCoveredBySubscriptionGroups` verify every {@link AlertEventType} is wired to a
   * group; a test in `twitchEventSubSubscriptionGroups.test.ts` fails if a new alert type is added
   * without adding it here, instead of the gap silently compiling.
   */
  alertTypes: AlertEventType[];
  /**
   * Returns true if this group's subscriptions should be created based on the streamer's config
   * alone — either a genuine chat-message toggle, or (for a group with no `alertTypes`)
   * {@link hasCompletedEventSubSetup} as a proxy for "this streamer is set up enough to want this
   * subscription at all". Independent of `alertTypes` — `isGroupEnabled` ORs the alerts-overlay
   * gating in generically, since a streamer can want the subscription created purely to drive a
   * browser-source alert, with chat messages off.
   * @param config - The streamer's event response configuration, or null if unset.
   */
  configGate: (config: EventSubConfig | null) => boolean;
  /**
   * Builds this group's subscription specs.
   * @param uid - The broadcaster's Twitch user ID.
   * @returns The subscription specs to create for this group.
   */
  specs: (uid: string) => SubSpec[];
}

/**
 * Returns true if `group`'s subscriptions should be created: either its `configGate` passes, or
 * any of its `alertTypes` has an enabled alerts-overlay config.
 * @param group - The subscription group to evaluate.
 * @param config - The streamer's event response configuration, or null if unset.
 * @param enabledAlerts - Event types with an enabled alerts-overlay config row for this streamer.
 */
export function isGroupEnabled(
  group: SubscriptionGroup,
  config: EventSubConfig | null,
  enabledAlerts: ReadonlySet<AlertEventType>,
): boolean {
  return group.configGate(config) || group.alertTypes.some((type) => enabledAlerts.has(type));
}

/**
 * `configGate` for a group with no `alertTypes` — unlike the alert-driven groups, there's no
 * alert-only path that needs the subscription without a real config row, so a row's mere
 * existence is used as a proxy for "this streamer completed the full EventSub/chat-message
 * setup". (`dispatchNotification` itself no longer early-exits without config — it falls back to
 * `DEFAULT_EVENT_CONFIG` for alert-only streamers — but that's moot for these groups since they
 * never subscribe for one.)
 * @param config - The streamer's event response configuration, or null if unset.
 */
function hasCompletedEventSubSetup(config: EventSubConfig | null): boolean {
  return Boolean(config);
}

// Every group also requires a broadcaster token (WebSocket transport only works with a user
// token, not an app token — see createSubscriptionsForStreamer's upfront `!token` check).
export const SUBSCRIPTION_GROUPS: SubscriptionGroup[] = [
  {
    alertTypes: ['follow'],
    configGate: (config) => Boolean(config?.follow_enabled),
    specs: (uid) => [{ type: 'channel.follow', version: '2', condition: { broadcaster_user_id: uid, moderator_user_id: uid } }],
  },
  {
    alertTypes: ['sub', 'resub', 'giftsub'],
    configGate: (config) => Boolean(config?.sub_enabled),
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
    configGate: (config) => Boolean(config?.raid_enabled || config?.raid_shoutout_enabled),
    specs: (uid) => [{ type: 'channel.raid', version: '1', condition: { to_broadcaster_user_id: uid } }],
  },
  {
    alertTypes: [],
    configGate: hasCompletedEventSubSetup,
    specs: (uid) => [{ type: 'channel.channel_points_custom_reward_redemption.add', version: '1', condition: { broadcaster_user_id: uid } }],
  },
  {
    // stream.online/offline and channel.update require no scope beyond a valid token. This
    // drives an immediate live-check that supplements (not replaces) the 60s poller. Not tied to
    // any alert type.
    alertTypes: [],
    configGate: hasCompletedEventSubSetup,
    specs: (uid) => [
      { type: 'stream.online', version: '1', condition: { broadcaster_user_id: uid } },
      { type: 'stream.offline', version: '1', condition: { broadcaster_user_id: uid } },
      { type: 'channel.update', version: '2', condition: { broadcaster_user_id: uid } },
    ],
  },
];

/**
 * Returns the set of alert event types covered by at least one subscription group. Exported for
 * the exhaustiveness test in `twitchEventSubSubscriptionGroups.test.ts`, which asserts this covers
 * every member of `ALERT_EVENT_TYPES` — catching a new alert type being added without also being
 * wired into a subscription group's `alertTypes` (which would otherwise compile fine and only
 * surface as "the subscription is never created" at runtime).
 */
export function getAlertTypesCoveredBySubscriptionGroups(): Set<AlertEventType> {
  return new Set(SUBSCRIPTION_GROUPS.flatMap((group) => group.alertTypes));
}
