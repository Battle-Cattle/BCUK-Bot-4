/* global expandedLiveRows, liveItemsByKey, findLiveDetailRow, setLiveToggleState, hydrateLivePreviewGrid, setLiveTableMessage, renderLiveRows, registerToggleEditHandler, confirmSubmit */

registerToggleEditHandler('btn-toggle-group-edit', 'data-group-id', 'group-edit-');

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

/** Returns the confirmation message for disconnecting a streamer's Twitch connection. */
function getDisconnectTwitchConfirmationMessage(t) {
  return 'Disconnect Twitch for ' + (t.dataset.twitchName || 'this streamer') + '?';
}

document.addEventListener('submit', function (event) {
  if (confirmSubmit(event, 'js-confirm-remove-group', function (t) {
    return 'Remove group "' + (t.dataset.groupName || 'this group') + '" and all its streamers?';
  })) return;
  if (confirmSubmit(event, 'js-confirm-remove-streamer', function (t) {
    return 'Remove streamer "' + (t.dataset.streamerName || 'this streamer') + '"?';
  })) return;
  confirmSubmit(event, 'js-confirm-disconnect-twitch', getDisconnectTwitchConfirmationMessage);
});

var liveNowInflight = false;

function refreshLiveNow() {
  if (liveNowInflight) return;
  liveNowInflight = true;
  var controller = new AbortController();
  var timeoutId = setTimeout(function() { controller.abort(); }, 10000);
  fetch('/admin/streams/live', { signal: controller.signal })
    .then(function(r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function(data) {
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
setInterval(refreshLiveNow, 15000);
