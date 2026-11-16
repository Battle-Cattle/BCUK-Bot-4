/* global expandedLiveRows:writable, liveItemsByKey:writable, findLiveDetailRow, setLiveToggleState, hydrateLivePreviewGrid, setLiveTableMessage, renderLiveRows, registerToggleEditHandler, confirmSubmit */

registerToggleEditHandler('btn-toggle-group-edit', 'data-group-id', 'group-edit-');

/** Expands/collapses a live stream's detail row when its ▶/▼ toggle is clicked. */
document.addEventListener('click', function (event) {
  var target = event.target;
  if (!(target instanceof Element)) return;

  var liveToggleBtn = target.closest('.btn-toggle-live-details');
  if (!(liveToggleBtn instanceof HTMLElement)) return;
  var liveKey = liveToggleBtn.dataset.liveKey;
  if (!liveKey) return;

  var expanded = !expandedLiveRows[liveKey];
  expandedLiveRows[liveKey] = expanded;

  var detailRow = findLiveDetailRow(liveKey);
  if (detailRow instanceof HTMLElement) {
    detailRow.style.display = expanded ? 'table-row' : 'none';
  }
  if (expanded) hydrateLivePreviewGrid(liveKey);
  setLiveToggleState(liveToggleBtn, expanded);
});

/**
 * Returns the confirmation message for disconnecting a streamer's Twitch connection.
 * @param t - The submitted form; its `data-twitch-name` names the streamer.
 * @returns The text shown in the disconnect-Twitch confirm() prompt.
 */
function getDisconnectTwitchConfirmationMessage(t) {
  return 'Disconnect Twitch for ' + (t.dataset.twitchName || 'this streamer') + '?';
}

/**
 * What removing a streamer deletes along with them (#1008): every per-streamer table cascades from
 * the streamer row, so the prompt says so rather than looking like an announcement-list edit.
 */
var STREAMER_REMOVAL_LOSES =
  'This permanently deletes everything tied to them: their loyalty points settings and every viewer\'s balance, '
  + 'overlay videos and reward mappings, alerts, advanced commands, dynamic pricing, event log, and their Twitch '
  + 'connection (they would have to reconnect). To change their group, use Move instead.';

/**
 * Returns the confirmation message for removing a stream group and its streamers.
 * @param t - The submitted form; its `data-group-name` names the group.
 * @returns The text shown in the remove-group confirm() prompt.
 */
function getRemoveGroupConfirmationMessage(t) {
  return 'Remove group "' + (t.dataset.groupName || 'this group') + '" and all its streamers?\n\n'
    + 'For each of its streamers: ' + STREAMER_REMOVAL_LOSES;
}

/**
 * Returns the confirmation message for removing one streamer.
 * @param t - The submitted form; its `data-streamer-name` names the streamer.
 * @returns The text shown in the remove-streamer confirm() prompt.
 */
function getRemoveStreamerConfirmationMessage(t) {
  return 'Remove streamer "' + (t.dataset.streamerName || 'this streamer') + '"?\n\n' + STREAMER_REMOVAL_LOSES;
}

/** Confirms group/streamer removal and Twitch disconnects before the forms submit. */
document.addEventListener('submit', function (event) {
  if (confirmSubmit(event, 'js-confirm-remove-group', getRemoveGroupConfirmationMessage)) return;
  if (confirmSubmit(event, 'js-confirm-remove-streamer', getRemoveStreamerConfirmationMessage)) return;
  confirmSubmit(event, 'js-confirm-disconnect-twitch', getDisconnectTwitchConfirmationMessage);
});

var liveNowInflight = false;
var liveNowPollTimer = null;

/**
 * Tells whether a live-streams response means the session has expired: requireAuth redirects the
 * request to the login page (which fetch follows), or a JSON gate answers 401.
 * @param {Response} r - The /admin/streams/live response.
 * @returns {boolean} True when the panel session is gone and further polls would fail the same way.
 */
function isSessionExpiredResponse(r) {
  return r.status === 401 || (r.redirected && new URL(r.url).pathname === '/auth/login');
}

/**
 * Fetches the currently-live streams and re-renders the live table (skips if one is in flight).
 * Stops polling once the session has expired, so a tab left open overnight doesn't keep hitting
 * the login page every 15s until its IP reaches the panel's rate limits.
 */
function refreshLiveNow() {
  if (liveNowInflight) return;
  liveNowInflight = true;
  var controller = new AbortController();
  var timeoutId = setTimeout(function() { controller.abort(); }, 10000);
  fetch('/admin/streams/live', { signal: controller.signal })
    .then(function(r) {
      if (isSessionExpiredResponse(r)) {
        clearInterval(liveNowPollTimer);
        setLiveTableMessage('Session expired \u2014 reload to log in.');
        return null;
      }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function(data) {
      if (!data) return;
      var streams = data.streams;
      if (!streams || !streams.length) {
        expandedLiveRows = Object.create(null);
        liveItemsByKey = Object.create(null);
        setLiveTableMessage('No streamers currently live.');
      } else {
        renderLiveRows(streams);
      }
      var el = document.getElementById('live-updated');
      if (el) el.textContent = 'Updated ' + new Date().toLocaleTimeString();
    })
    .catch(function() {
      setLiveTableMessage('Failed to load live data.');
    })
    .then(function() {
      clearTimeout(timeoutId);
      liveNowInflight = false;
    });
}

refreshLiveNow();
liveNowPollTimer = setInterval(refreshLiveNow, 15000);
