/* ── Reload the dashboard when its stream's context changes ───── */
// A dashboard stream is closed by the server when the page's context changes: the account signs out its other
// sessions, the session is destroyed, or it switches guild or loses access to one. The server writes a
// `context-changed` frame just before closing. Without a reload, the stream either reconnects into the new context
// while the page still shows the old one (another tab after a guild switch), or the reconnect gets the login page as
// HTML, which EventSource treats as a permanent failure, leaving a stale page.

/** The sessionStorage key holding when this tab last reloaded because of a context change. */
const CONTEXT_RELOAD_KEY = 'dashboardContextReloadAt';
/** The shortest gap between two context reloads of one tab, so a stream that keeps failing can't cause a reload loop. */
const CONTEXT_RELOAD_MIN_INTERVAL_MS = 30000;
/** How long a reload waits after the server's frame, so the session change that caused it (a new guild, a re-issued session cookie) has been saved and delivered first: the server writes the frame as it closes the stream, before the response that carries the change has reached the browser. */
const CONTEXT_SETTLE_MS = 1500;
/** EventSource.readyState once the browser has given up on the stream for good. */
const EVENT_SOURCE_CLOSED = 2;

/** True once the page has started navigating away (a Logout click or a guild switch), when a reload must not override it. */
let contextPageLeaving = false;
/** A reload waiting out the settle delay or the rate-limit window. */
let contextReloadTimer = null;
/** True when the server asked for a reload while the page was leaving: if the page comes back from the back/forward cache, it still owes that reload. */
let contextReloadPending = false;
/** True while the signed-in probe after a closed stream is in flight. */
let contextProbing = false;
window.addEventListener('beforeunload', () => { contextPageLeaving = true; });
// A page restored from the back/forward cache is live again, and a cancelled navigation never unloads it.
window.addEventListener('pageshow', (event) => {
  if (!event.persisted) return;
  contextPageLeaving = false;
  if (contextReloadPending) {
    contextReloadPending = false;
    reloadForContextChange(true);
  }
});

/**
 * How long until a context reload is allowed: the rest of CONTEXT_RELOAD_MIN_INTERVAL_MS since the last one.
 * @returns Milliseconds to wait (0 when a reload may go ahead now), or null when sessionStorage is unavailable and the rate limit can't be known.
 */
function contextReloadWaitMs() {
  try {
    const last = Number(window.sessionStorage.getItem(CONTEXT_RELOAD_KEY));
    return last > 0 ? Math.max(0, CONTEXT_RELOAD_MIN_INTERVAL_MS - (Date.now() - last)) : 0;
  } catch {
    return null;
  }
}

/**
 * Reloads the page so it renders under its new context, unless a navigation is under way. A reload inside the rate-limit
 * window is held until the window ends when the server asked for it (a real context change must not be lost), and
 * dropped otherwise. With sessionStorage blocked the limit can't be recorded, so only the server's request goes ahead.
 * @param serverRequested - True for the server's `context-changed` frame, false for a closed stream found to be signed out.
 */
function reloadForContextChange(serverRequested) {
  if (contextPageLeaving) {
    if (serverRequested) contextReloadPending = true;
    return;
  }
  if (contextReloadTimer !== null) return;
  const waitMs = contextReloadWaitMs();
  if (waitMs === null && !serverRequested) return;
  if (waitMs !== null && waitMs > 0) {
    if (serverRequested) {
      contextReloadTimer = setTimeout(() => {
        contextReloadTimer = null;
        reloadForContextChange(true);
      }, waitMs);
    }
    return;
  }
  try {
    window.sessionStorage.setItem(CONTEXT_RELOAD_KEY, String(Date.now()));
  } catch {
    // The write failed (storage blocked, or full while reads still work): nothing records this reload, so only the server's frame goes ahead.
    if (!serverRequested) return;
  }
  contextPageLeaving = true;
  window.location.reload();
}

/**
 * After the browser gives up on a stream, reloads only if the session no longer fits this page: /api/status answers a
 * signed-out session, or one that lost its guild, with a redirect (or a 401). Anything else (a full connection cap, a
 * restart behind the proxy) is not a context change and must not reload the page, since each reload renews the session.
 * An unreachable server is left alone too.
 */
async function reloadIfSessionChanged() {
  if (contextProbing) return;
  contextProbing = true;
  try {
    const res = await fetch('/api/status', { credentials: 'same-origin', cache: 'no-store' });
    if (res.redirected || res.status === 401) reloadForContextChange(false);
  } catch {
    // Unreachable: leave the page as it is.
  } finally {
    contextProbing = false;
  }
}

/**
 * Handles the server's `context-changed` frame: closes the stream, so it can't reconnect into the new context, and
 * reloads once CONTEXT_SETTLE_MS has passed.
 * @param source - The dashboard's EventSource that received the frame.
 */
function onContextChangedFrame(source) {
  source.close();
  if (contextReloadTimer !== null) return;
  contextReloadTimer = setTimeout(() => {
    contextReloadTimer = null;
    reloadForContextChange(true);
  }, CONTEXT_SETTLE_MS);
}

/**
 * Reloads the page when a dashboard stream reports a context change, or when the browser gives up on it and the
 * session turns out to have changed. The stream is closed on the frame, so it can't reconnect into the new context
 * while a held-back reload waits. An ordinary error with the stream still reconnecting is left to the caller's own `onerror`.
 * @param source - The dashboard's EventSource.
 */
function watchStreamContext(source) {
  source.addEventListener('context-changed', () => onContextChangedFrame(source));
  source.addEventListener('error', () => {
    if (source.readyState === EVENT_SOURCE_CLOSED) void reloadIfSessionChanged();
  });
}
