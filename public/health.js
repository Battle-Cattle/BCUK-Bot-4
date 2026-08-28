/* ── Bot health dashboard ─────────────────────────────────────────────── */

/**
 * Formats an ISO/serialized date string for display, or '—' if absent.
 * @param {string|null} value - A date value as serialized by `JSON.stringify` (an ISO string), or null.
 * @returns {string} A locale-formatted date/time, or '—'.
 */
function formatHealthDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

/**
 * Builds one `<tr>` for the health table.
 * @param {string} component - Display name of the component.
 * @param {boolean} ok - Whether the component is currently healthy.
 * @param {string|null} lastEvent - Formatted last-event timestamp text.
 * @param {string|null} lastError - Last error message, or null/empty for none.
 * @returns {HTMLTableRowElement} The built row.
 */
function buildHealthRow(component, ok, lastEvent, lastError) {
  const tr = document.createElement('tr');
  const dot = ok ? '🟢' : '🔴';
  const state = ok ? 'OK' : 'Down';
  [component, dot + ' ' + state, lastEvent || '—', lastError || '—'].forEach(function (text) {
    const td = document.createElement('td');
    td.textContent = text;
    tr.appendChild(td);
  });
  return tr;
}

/**
 * Renders the full health table and recent-errors list from a health snapshot payload
 * (shaped like `healthStore.getHealthSnapshot()`, JSON-serialized).
 * @param {object} health - The health snapshot.
 * @returns {void}
 */
function applyHealth(health) {
  const body = document.getElementById('health-table-body');
  if (!body) return;
  body.innerHTML = '';

  body.appendChild(buildHealthRow('Discord', health.discordConnected, null, null));
  body.appendChild(buildHealthRow('Twitch chat', health.twitchChatConnected, null, null));
  body.appendChild(buildHealthRow('Database', health.db.lastPingOk, formatHealthDate(health.db.lastPingAt), health.db.lastError));

  Object.keys(health.eventsub || {}).forEach(function (streamer) {
    const entry = health.eventsub[streamer];
    body.appendChild(
      buildHealthRow(
        'EventSub: ' + streamer + ' (reconnects: ' + entry.reconnectAttempts + ')',
        entry.connected,
        formatHealthDate(entry.connected ? entry.lastConnectedAt : entry.lastDisconnectedAt),
        entry.lastError,
      ),
    );
  });

  body.appendChild(buildHealthRow('Stream monitor', health.monitor.lastPollOk, formatHealthDate(health.monitor.lastPollAt), health.monitor.lastError));

  Object.keys(health.schedulers || {}).forEach(function (name) {
    const entry = health.schedulers[name];
    if (!entry) return;
    body.appendChild(buildHealthRow('Scheduler: ' + name, entry.lastRunOk, formatHealthDate(entry.lastRunAt), entry.lastError));
  });

  const errorsList = document.getElementById('health-errors-list');
  const errorsEmpty = document.getElementById('health-errors-empty');
  if (errorsList && errorsEmpty) {
    errorsList.innerHTML = '';
    const errors = (health.errors || []).slice().reverse();
    errorsEmpty.style.display = errors.length === 0 ? '' : 'none';
    errors.forEach(function (err) {
      const li = document.createElement('li');
      li.textContent = '[' + formatHealthDate(err.timestamp) + '] ' + err.module + ': ' + err.message;
      errorsList.appendChild(li);
    });
  }
}

const initialHealthRaw = document.body && document.body.dataset ? document.body.dataset.initialHealth : null;
if (initialHealthRaw) {
  try {
    applyHealth(JSON.parse(initialHealthRaw));
  } catch (e) {
    // Malformed initial payload — the SSE stream below will populate the page shortly.
  }
}

// Live-push health updates over SSE; EventSource's own auto-reconnect handles transient drops.
const healthSource = new EventSource('/admin/health/events');
healthSource.onmessage = function (msg) {
  try {
    applyHealth(JSON.parse(msg.data));
  } catch (e) {
    // Ignore malformed payloads.
  }
};
