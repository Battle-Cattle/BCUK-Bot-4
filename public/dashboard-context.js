/* ── Reload the dashboard when its stream's context changes ───── */
// A dashboard stream is closed by the server when the page's context changes: the session ends, the account signs
// out its other sessions, or the session switches guild or loses access to one. The server writes a
// `context-changed` frame just before closing. Without a reload, the stream either reconnects into the new context
// while the page still shows the old one (another tab after a guild switch), or the reconnect gets the login page as
// HTML, which EventSource treats as a permanent failure, leaving a stale page.

/** The sessionStorage key holding when this tab last reloaded because of a context change. */
const CONTEXT_RELOAD_KEY = 'dashboardContextReloadAt';
/** The shortest gap between two context reloads of one tab, so a stream that keeps failing can't cause a reload loop. */
const CONTEXT_RELOAD_MIN_INTERVAL_MS = 30000;
/** EventSource.readyState once the browser has given up on the stream for good. */
const EVENT_SOURCE_CLOSED = 2;

/** True once the page has started navigating away (a Logout click or a guild switch), when a reload must not override it. */
let contextPageLeaving = false;
window.addEventListener('beforeunload', () => { contextPageLeaving = true; });

/**
 * Whether a context reload may happen now: not while the page is already navigating, and not within
 * CONTEXT_RELOAD_MIN_INTERVAL_MS of the last one. With sessionStorage blocked the rate limit can't be recorded,
 * so only a reload the server asked for (the frame, which needs a real state change) goes ahead.
 * @param serverRequested - True for the server's `context-changed` frame, false for the browser giving up on the stream.
 * @returns True when the reload is allowed (and it has been recorded as done).
 */
function claimContextReload(serverRequested) {
  if (contextPageLeaving) return false;
  const now = Date.now();
  let recorded = false;
  try {
    const last = Number(window.sessionStorage.getItem(CONTEXT_RELOAD_KEY));
    if (last > 0 && now - last < CONTEXT_RELOAD_MIN_INTERVAL_MS) return false;
    window.sessionStorage.setItem(CONTEXT_RELOAD_KEY, String(now));
    recorded = true;
  } catch {
    // Storage blocked: recorded stays false.
  }
  if (!recorded && !serverRequested) return false;
  contextPageLeaving = true;
  return true;
}

/**
 * Reloads the page so it renders under its new context, unless a navigation is under way or it reloaded a moment ago.
 * @param serverRequested - True when the server's `context-changed` frame asked for it.
 */
function reloadForContextChange(serverRequested) {
  if (claimContextReload(serverRequested)) window.location.reload();
}

/**
 * Reloads the page when a dashboard stream reports a context change, or when the browser gives up on the stream.
 * An ordinary error with the stream still reconnecting is not a context change: it is left to the caller's own `onerror`.
 * @param source - The dashboard's EventSource.
 */
function watchStreamContext(source) {
  source.addEventListener('context-changed', () => reloadForContextChange(true));
  source.addEventListener('error', () => {
    if (source.readyState === EVENT_SOURCE_CLOSED) reloadForContextChange(false);
  });
}
