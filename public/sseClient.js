/**
 * Opens an EventSource to `path` and keeps it alive with exponential-backoff reconnect
 * (by default 2s → 4s → 8s → cap 30s) whenever the connection drops, rather than relying on the
 * browser's fixed ~3s retry, so a persistent failure doesn't hammer the endpoint. Each message's
 * JSON payload is parsed and passed to `onMessage`; a message that fails to parse is silently
 * dropped, but an exception thrown by `onMessage` itself is not swallowed. Shared by every
 * page that needs a self-healing stream (browser-source overlays, overlay connection status,
 * channel-points live pricing) so the reconnect plumbing only needs to be gotten right once.
 * @param {string} path - SSE endpoint path, e.g. '/overlay/channel/events'.
 * @param {function(any): void} onMessage - Called with each message's parsed JSON payload.
 * @param {{ baseMs?: number, maxMs?: number }} [options] - First reconnect delay and its cap.
 * @returns {void}
 */
function connectSse(path, onMessage, options) {
  const baseMs = (options && options.baseMs) || 2000;
  const maxMs = (options && options.maxMs) || 30000;
  let delayMs = baseMs;

  /** Opens one EventSource, scheduling a fresh one (with backoff) when it errors. */
  function connect() {
    const es = new EventSource(path);

    es.onmessage = function (e) {
      let data;
      try {
        data = JSON.parse(e.data);
      } catch (_) {
        return;
      }
      onMessage(data);
    };

    es.onerror = function () {
      es.close();
      setTimeout(connect, delayMs);
      delayMs = Math.min(maxMs, delayMs * 2);
    };

    es.onopen = function () {
      delayMs = baseMs;
    };
  }

  connect();
}
