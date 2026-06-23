/* global expandedLiveRows, liveItemsByKey, hydrateLivePreviewGrid, setLiveTableMessage, renderLiveRows, toggleGroupEdit, confirmSubmit */

document.addEventListener('click', function (event) {
  var target = event.target;
  if (!(target instanceof Element)) return;

  var toggleBtn = target.closest('.btn-toggle-group-edit');
  if (toggleBtn instanceof HTMLElement) {
    var id = toggleBtn.dataset.groupId;
    if (id) toggleGroupEdit(id);
    return;
  }

  var liveToggleBtn = target.closest('.btn-toggle-live-details');
  if (liveToggleBtn instanceof HTMLElement) {
    var liveKey = liveToggleBtn.dataset.liveKey;
    if (!liveKey) return;
    expandedLiveRows[liveKey] = !expandedLiveRows[liveKey];

    var detailRow = document.querySelector('tr.live-detail-row[data-live-key="' + CSS.escape(liveKey) + '"]');
    if (detailRow instanceof HTMLElement) {
      detailRow.style.display = expandedLiveRows[liveKey] ? 'table-row' : 'none';
    }

    if (expandedLiveRows[liveKey]) {
      hydrateLivePreviewGrid(liveKey);
    }

    liveToggleBtn.textContent = expandedLiveRows[liveKey] ? '▼' : '▶';
    liveToggleBtn.setAttribute('aria-expanded', expandedLiveRows[liveKey] ? 'true' : 'false');
  }
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
