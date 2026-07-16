/**
 * Opens an EventSource to `path` and keeps it alive with exponential-backoff reconnect
 * (2s → 4s → 8s → cap 30s) whenever the connection drops. Each message's JSON payload is
 * parsed and passed to `onMessage`; a message that fails to parse is silently dropped. Shared
 * by every browser-source overlay (reward-video overlay, alerts overlay) so the reconnect
 * plumbing only needs to be gotten right in one place.
 * @param {string} path - SSE endpoint path, e.g. '/overlay/channel/events'.
 * @param {function(any): void} onMessage - Called with each message's parsed JSON payload.
 * @returns {void}
 */
function connectSse(path, onMessage) {
  function connect() {
    const es = new EventSource(path);

    es.onmessage = function (e) {
      try {
        onMessage(JSON.parse(e.data));
      } catch (_) {}
    };

    es.onerror = function () {
      es.close();
      const delay = Math.min(30000, (connect.retryMs = (connect.retryMs || 1000) * 2));
      setTimeout(connect, delay);
    };

    es.onopen = function () {
      connect.retryMs = 1000;
    };
  }

  connect();
}
