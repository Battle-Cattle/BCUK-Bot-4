/* ── Dashboard initialisation ────────────────────────────── */

// Apply server-provided initial status without inline script execution.
const initialStatusRaw = document.body?.dataset?.initialStatus;
const csrfToken = document.body?.dataset?.csrfToken || '';
if (initialStatusRaw) {
  try {
    applyStatus(JSON.parse(initialStatusRaw));
  } catch {
    // Fallback to fetchStatus below.
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
