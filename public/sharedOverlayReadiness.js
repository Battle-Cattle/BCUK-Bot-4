/* global connectSse */
/**
 * Formats when an overlay last reported.
 * @param {number|null} reportedAt - Epoch ms of the last report, or null.
 * @returns {string} A short description such as "last report 12:30:01", or "no report yet".
 */
function formatReportTime(reportedAt) {
  return reportedAt ? 'last report ' + new Date(reportedAt).toLocaleTimeString() : 'no report yet';
}

/**
 * Describes one overlay for the per-overlay list.
 * @param {{login: string, online: boolean, stored: number, total: number, downloading: ({name: string, percent: number}|null), reportedAt: (number|null)}} o - The overlay's row.
 * @returns {string} For example "bob — online — 10/12 stored, downloading Clap 40%".
 */
function describeOverlay(o) {
  const parts = [o.login, o.online ? 'online' : 'offline (' + formatReportTime(o.reportedAt) + ')', o.stored + '/' + o.total + ' stored'];
  if (o.downloading) parts.push('downloading ' + o.downloading.name + ' ' + o.downloading.percent + '%');
  return parts.join(' — ');
}

/**
 * Describes one video for the per-video list.
 * @param {{name: string, ready: number, online: number, missing: Array<{login: string, percent: (number|null)}>, allReady: boolean}} v - The video's row.
 * @returns {string} For example "✅ Clap — ready on 5/5 connected overlays", or which overlays miss it.
 */
function describeVideo(v) {
  const head = (v.allReady ? '✅ ' : '') + v.name + ' — ready on ' + v.ready + '/' + v.online + ' connected overlays';
  if (v.missing.length === 0) return head;
  const missing = v.missing.map(function (m) { return m.login + (m.percent === null ? '' : ' (' + m.percent + '%)'); });
  return head + '; missing on ' + missing.join(', ');
}

/**
 * Builds the "Push to overlays" form for one video: it POSTs with the page's CSRF token, and its
 * button is greyed out when every connected overlay already has the video (or none is connected).
 * @param {{id: number, allReady: boolean, online: number}} v - The video's row.
 * @returns {HTMLFormElement} The form.
 */
function buildPushForm(v) {
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = '/overlay/shared/settings/videos/' + v.id + '/push';
  const token = document.createElement('input');
  token.type = 'hidden';
  token.name = '_csrf';
  token.value = document.body.dataset.csrfToken;
  const button = document.createElement('button');
  button.type = 'submit';
  button.className = 'btn btn-ghost btn-sm';
  button.textContent = 'Push to overlays';
  button.disabled = v.allReady || v.online === 0;
  form.appendChild(token);
  form.appendChild(button);
  return form;
}

/**
 * Replaces a list's items with one line per entry.
 * @param {HTMLElement} list - The `ul` to fill.
 * @param {string[]} lines - The text of each item.
 * @param {string} emptyText - Shown when there are no lines.
 * @param {HTMLElement[]} [extras] - An element appended to each item, in order (optional).
 * @returns {void}
 */
function fillList(list, lines, emptyText, extras) {
  list.replaceChildren();
  const texts = lines.length > 0 ? lines : [emptyText];
  texts.forEach(function (text, i) {
    const item = document.createElement('li');
    item.textContent = text;
    if (extras && lines.length > 0) item.appendChild(extras[i]);
    list.appendChild(item);
  });
}

/**
 * Shows or clears the "connection lost" state: the lists keep the last snapshot, but the page says
 * it may be out of date until the next snapshot arrives.
 * @param {boolean} stale - True when the stream has dropped.
 * @returns {void}
 */
function setReadinessStale(stale) {
  document.getElementById('readiness-status').hidden = !stale;
  for (const id of ['readiness-overlays', 'readiness-videos']) {
    document.getElementById(id).classList.toggle('stale', stale);
  }
}

/**
 * Renders a readiness snapshot into the page's two lists (and clears any stale marking).
 * @param {{overlays: Array<object>, videos: Array<object>}} snapshot - The snapshot from the stream.
 * @returns {void}
 */
function renderReadiness(snapshot) {
  setReadinessStale(false);
  fillList(document.getElementById('readiness-overlays'), snapshot.overlays.map(describeOverlay), 'No shared overlays have connected yet.');
  fillList(document.getElementById('readiness-videos'), snapshot.videos.map(describeVideo), 'No enabled shared videos.', snapshot.videos.map(buildPushForm));
}

if (document.getElementById('readiness-overlays')) {
  connectSse('/overlay/shared/settings/readiness/events', renderReadiness, { onError: function () { setReadinessStale(true); } });
}
