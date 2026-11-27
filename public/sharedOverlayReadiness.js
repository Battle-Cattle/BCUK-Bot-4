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
 * Describes one video's readiness for its table row.
 * @param {{ready: number, online: number, missing: Array<{login: string, percent: (number|null)}>, allReady: boolean}} v - The video's row.
 * @returns {string} For example "✅ Ready on 5/5 connected overlays", or which overlays miss it.
 */
function describeVideo(v) {
  const head = (v.allReady ? '✅ ' : '') + 'Ready on ' + v.ready + '/' + v.online + ' connected overlays';
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
  form.className = 'm-0';
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
 * Writes the live connected-overlay sentence and the per-overlay list into the connection card.
 * @param {Array<object>} overlays - The overlay rows from the snapshot.
 * @returns {void}
 */
function renderOverlays(overlays) {
  const online = overlays.filter(function (o) { return o.online; }).length;
  document.getElementById('readiness-summary').textContent = overlays.length === 0
    ? 'No shared overlays have connected yet.'
    : online + ' shared overlay' + (online === 1 ? '' : 's') + ' connected right now.';
  const list = document.getElementById('readiness-overlays');
  list.replaceChildren();
  overlays.forEach(function (o) {
    const item = document.createElement('li');
    item.textContent = describeOverlay(o);
    list.appendChild(item);
  });
}

/**
 * Fills each enabled video's readiness cell and push cell from the snapshot. A row with no snapshot
 * entry (uploaded since the snapshot) shows a waiting note and no push button.
 * @param {Array<{id: number}>} videos - The enabled videos' rows from the snapshot.
 * @returns {void}
 */
function renderVideos(videos) {
  const byId = new Map(videos.map(function (v) { return [String(v.id), v]; }));
  document.querySelectorAll('[data-readiness-video]').forEach(function (cell) {
    const v = byId.get(cell.dataset.readinessVideo);
    cell.textContent = v ? describeVideo(v) : 'Waiting for the next update…';
  });
  document.querySelectorAll('[data-readiness-push]').forEach(function (cell) {
    const v = byId.get(cell.dataset.readinessPush);
    cell.replaceChildren();
    if (v) cell.appendChild(buildPushForm(v));
  });
}

/**
 * Shows or clears the "connection lost" state: the page keeps the last snapshot, but one note says
 * it may be out of date, and every place the data lives is marked stale until the next snapshot.
 * @param {boolean} stale - True when the stream has dropped.
 * @returns {void}
 */
function setReadinessStale(stale) {
  document.getElementById('readiness-status').hidden = !stale;
  document.getElementById('readiness-overlays').classList.toggle('stale', stale);
  document.getElementById('readiness-summary').classList.toggle('stale', stale);
  document.querySelectorAll('[data-readiness-video], [data-readiness-push]').forEach(function (cell) {
    cell.classList.toggle('stale', stale);
  });
}

/**
 * Renders a readiness snapshot into the connection card and the video table (and clears any stale marking).
 * @param {{overlays: Array<object>, videos: Array<object>}} snapshot - The snapshot from the stream.
 * @returns {void}
 */
function renderReadiness(snapshot) {
  setReadinessStale(false);
  renderOverlays(snapshot.overlays);
  renderVideos(snapshot.videos);
}

if (document.getElementById('readiness-overlays')) {
  connectSse('/overlay/shared/settings/readiness/events', renderReadiness, { onError: function () { setReadinessStale(true); } });
}
