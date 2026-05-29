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

// Refresh immediately then poll every 5 seconds.
fetchStatus();
loadVoiceChannels();
setInterval(fetchStatus, 5000);
