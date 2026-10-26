import type { AlertEventType, StreamerEventType, TextAnimation } from '../../db';
import { createRuntimeRegistry } from '../../shared/runtimeRegistry';

// Runtime injection for the overlay push function — avoids a direct import of the
// web layer from core Twitch handler code.  registerEventSubOverlayRuntime is called
// from index.ts before startWebPanel(), which is safe because pushOverlayEvent is
// just a function reference and does not require the HTTP server to be running.
/**
 * Public contract for the overlay runtime injection.
 * Passed to {@link registerEventSubOverlayRuntime} from index.ts.
 */
interface EventSubOverlayRuntime {
  /**
   * Push an overlay event to the named channel's SSE stream.
   * @param login - Broadcaster login name.
   * @param videoPath - Server-relative path of the video to display.
   */
  pushOverlayEvent: (login: string, videoPath: string) => void;
}

export const overlayRuntimeRegistry = createRuntimeRegistry<EventSubOverlayRuntime>();

/**
 * Register the overlay push function. Called from index.ts before startWebPanel().
 * @param runtime - The {@link EventSubOverlayRuntime} to store.
 * @returns void
 */
export function registerEventSubOverlayRuntime(runtime: EventSubOverlayRuntime): void {
  overlayRuntimeRegistry.register(runtime);
}

// Runtime injection for the companion app push function — same rationale as
// EventSubOverlayRuntime above. Registered from index.ts before startWebPanel(),
// since pushCompanionEvent is just a function reference and doesn't require the
// HTTP server to be running yet.
/**
 * Public contract for the companion app runtime injection.
 * Passed to {@link registerEventSubCompanionRuntime} from index.ts.
 */
// Payload types for the companion-app SSE stream. They live here, with the runtime that carries
// them, so the EventSub handler that builds them doesn't import the web route that serves them.
/** Non-redemption streamer activity types forwarded to the companion app. */
export type CompanionActivityEventType = Exclude<StreamerEventType, 'redemption'>;

/**
 * A channel-point reward redemption forwarded to a user's companion app. When `ackRequired` is
 * set (the reward requires companion confirmation), the app must acknowledge it
 * (`POST /api/companion/rewards/ack`) or the redemption is cancelled and the viewer refunded.
 */
export interface CompanionRedemptionEvent {
  type: 'channel_points_redemption';
  /** Twitch's redemption id; the acknowledgement quotes it back. */
  id: string;
  rewardId: string;
  rewardTitle: string;
  userLogin: string;
  userName: string;
  userInput: string;
  ackRequired: boolean;
  redeemedAt: string;
}

/** A follow/sub/resub/giftsub/raid activity event forwarded to a user's companion app. */
export interface CompanionActivityEvent {
  type: CompanionActivityEventType;
  /** Stable `streamer_event_log.id`, unique across both this live push and the `/events/recent`
   *  backfill — lets the client dedupe/order exactly instead of by `occurredAt` heuristic. */
  id: number;
  displayName: string;
  detail: string | null;
  occurredAt: string;
}

/**
 * An advanced command use forwarded to the streamer's companion app. When `ackRequired` is set,
 * the app must acknowledge it (`POST /api/companion/commands/ack`) or the viewer is refunded.
 */
interface CompanionAdvancedCommandEvent {
  type: 'advanced_command';
  /** Unique per use (`advanced_command_usage.event_id`); the acknowledgement quotes it back. */
  id: string;
  commandId: number;
  commandName: string;
  source: 'chat' | 'streamdeck';
  /** The viewer's Twitch login and display name; null for a Stream Deck trigger. */
  userLogin: string | null;
  userName: string | null;
  /** Text after the trigger in chat, or null when there was none. */
  args: string | null;
  pointsSpent: number;
  /** The command's key/value parameters. */
  parameters: Record<string, string>;
  ackRequired: boolean;
  triggeredAt: string;
}

/** An event forwarded to a user's companion app over the `/api/companion/events` SSE stream. */
export type CompanionEvent = CompanionRedemptionEvent | CompanionActivityEvent | CompanionAdvancedCommandEvent;

interface EventSubCompanionRuntime {
  /**
   * Push a companion event to the named Discord user's SSE stream.
   * @param discordId - Discord snowflake of the streamer who owns the redemption.
   * @param event - The companion event payload to deliver.
   */
  pushCompanionEvent: (discordId: string, event: CompanionEvent) => void;
  /**
   * True if the Discord user has at least one companion app connected. A redemption that needs
   * confirmation is refunded straight away when nothing is connected. When omitted, a push is
   * assumed delivered and an unanswered one is refunded once its acknowledgement times out.
   */
  hasCompanionConnection?: (discordId: string) => boolean;
}

export const companionRuntimeRegistry = createRuntimeRegistry<EventSubCompanionRuntime>();

/**
 * Register the companion app push function. Called from index.ts before startWebPanel().
 * @param runtime - The {@link EventSubCompanionRuntime} to store.
 * @returns void
 */
export function registerEventSubCompanionRuntime(runtime: EventSubCompanionRuntime): void {
  companionRuntimeRegistry.register(runtime);
}

// Runtime injection for the alerts overlay push function — same rationale as
// EventSubOverlayRuntime above. Registered from index.ts before startWebPanel(),
// since pushAlertEvent is just a function reference and doesn't require the HTTP
// server to be running yet.
/** A customisable alert (follow/sub/resub/giftsub/raid) pushed to a streamer's alerts browser source. */
export interface AlertPayload {
  /** Which event type this alert is for: a Twitch event, or an advanced command's own alert. */
  type: AlertEventType | 'advanced_command';
  /** On-screen text, already filled from the streamer's message template. */
  message: string;
  /** Server-relative URL of the configured image/GIF, or null if none is set. */
  imageUrl: string | null;
  /** Server-relative URL of the configured sound, or null if none is set. */
  soundUrl: string | null;
  /** How long (ms) the alert should stay on screen. */
  durationMs: number;
  /** On-screen text animation style to apply to `message`. */
  textAnimation: TextAnimation;
}

/**
 * Public contract for the alerts overlay runtime injection.
 * Passed to {@link registerEventSubAlertRuntime} from index.ts.
 */
interface EventSubAlertRuntime {
  /**
   * Push an alert to the named channel's alerts-overlay SSE stream.
   * @param login - Broadcaster login name.
   * @param alert - The alert payload to display.
   */
  pushAlertEvent: (login: string, alert: AlertPayload) => void;
}

export const alertRuntimeRegistry = createRuntimeRegistry<EventSubAlertRuntime>();

/**
 * Register the alerts overlay push function. Called from index.ts before startWebPanel().
 * @param runtime - The {@link EventSubAlertRuntime} to store.
 * @returns void
 */
export function registerEventSubAlertRuntime(runtime: EventSubAlertRuntime): void {
  alertRuntimeRegistry.register(runtime);
}

// Runtime injection for the dashboard "Recent Events" push function — same rationale as
// EventSubOverlayRuntime above. Registered from index.ts before startWebPanel(), since
// pushDashboardEvent is just a function reference and doesn't require the HTTP server to
// be running yet.
/**
 * Public contract for the dashboard events runtime injection.
 * Passed to {@link registerEventSubDashboardRuntime} from index.ts.
 */
interface EventSubDashboardRuntime {
  /**
   * Push a streamer activity event to the dashboard's "Recent Events" SSE stream.
   * @param streamerId - DB row ID of the streamer whose dashboard to push to.
   * @param event - The dashboard event payload to display.
   */
  pushDashboardEvent: (streamerId: number, event: import('../../web/routes/dashboardEvents').DashboardEvent) => void;
}

export const dashboardEventRuntimeRegistry = createRuntimeRegistry<EventSubDashboardRuntime>();

/**
 * Register the dashboard events push function. Called from index.ts before startWebPanel().
 * @param runtime - The {@link EventSubDashboardRuntime} to store.
 * @returns void
 */
export function registerEventSubDashboardRuntime(runtime: EventSubDashboardRuntime): void {
  dashboardEventRuntimeRegistry.register(runtime);
}

// Runtime injection for the Twitch chat send function — avoids a direct import
// of twitchBot from core EventSub handler code.  Registered from index.ts.
interface EventSubTwitchRuntime {
  send: (channel: string, message: string) => Promise<void>;
}

export const twitchRuntimeRegistry = createRuntimeRegistry<EventSubTwitchRuntime>();

/**
 * Register the Twitch chat send function. Called from index.ts during initialisation,
 * before startTwitchBot(), so the runtime is in place before the first event arrives.
 *
 * @param runtime - The {@link EventSubTwitchRuntime} to store; must supply a `send` function
 *   that delivers a chat message to the given channel.
 * @returns void
 */
export function registerEventSubTwitchRuntime(runtime: EventSubTwitchRuntime): void {
  twitchRuntimeRegistry.register(runtime);
}

// Runtime injection for triggering a full EventSub subscription reload — avoids a circular
// import back into twitchEventSub.ts, which itself imports (transitively, via
// twitchEventSubSubscriptions.ts) this module's own dispatch code. Registered from index.ts,
// same as every other runtime above.
interface EventSubReloadRuntime {
  /** Reloads every streamer's EventSub subscriptions from the DB, tearing down and recreating
   *  connections as needed — see `reloadEventSubSubscriptions` in `twitchEventSub.ts`. */
  triggerReload: () => void;
}

export const eventSubReloadRuntimeRegistry = createRuntimeRegistry<EventSubReloadRuntime>();

/**
 * Register the EventSub reload trigger. Called from index.ts.
 * @param runtime - The {@link EventSubReloadRuntime} to store.
 * @returns void
 */
export function registerEventSubReloadRuntime(runtime: EventSubReloadRuntime): void {
  eventSubReloadRuntimeRegistry.register(runtime);
}
