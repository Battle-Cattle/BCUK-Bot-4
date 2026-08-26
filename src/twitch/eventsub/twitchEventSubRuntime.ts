import type { AlertEventType, TextAnimation } from '../../db';
import { createRuntimeRegistry } from '../../commands/twitchRuntime';

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
interface EventSubCompanionRuntime {
  /**
   * Push a companion event to the named Discord user's SSE stream.
   * @param discordId - Discord snowflake of the streamer who owns the redemption.
   * @param event - The companion event payload to deliver.
   */
  pushCompanionEvent: (discordId: string, event: import('../../web/routes/companionEvents').CompanionEvent) => void;
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
  /** Which event type this alert is for. */
  type: AlertEventType;
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
