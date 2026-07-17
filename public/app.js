/* ── Dashboard initialisation ────────────────────────────── */

// Apply server-provided initial status without inline script execution.
const initialStatusRaw = document.body?.dataset?.initialStatus;
const csrfToken = document.body?.dataset?.csrfToken || '';
if (initialStatusRaw) {
  try {
    applyStatus(JSON.parse(initialStatusRaw));
  } catch {
    fetchStatus(); // Malformed initial payload — fall back to a fresh fetch.
  }
}

loadVoiceChannels();

// Live-push status updates over SSE rather than polling; the browser's built-in
// EventSource auto-reconnect handles transient disconnects.
const statusSource = new EventSource('/dashboard/status/events');
statusSource.onmessage = (msg) => {
  try {
    applyStatus(JSON.parse(msg.data));
  } catch {
    // Ignore malformed payloads.
  }
};
statusSource.onerror = () => {
  // fetchStatus's own consecutive-failure tracking flags the UI as stale if the
  // one-off fallback fetch also fails; EventSource itself keeps retrying the stream.
  fetchStatus();
};

// Safety-net poll, far less frequent than the 5s poll this replaced: a connection can
// stay technically open while the server-side push silently stops (e.g. no status change
// occurs for a long time), which never fires `onerror` and would otherwise leave the
// dashboard frozen with no self-healing. SSE remains the primary, low-latency update path.
setInterval(fetchStatus, 60_000);
