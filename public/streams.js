function toggleGroupEdit(id) {
  var row = document.getElementById('group-edit-' + id);
  if (!row) return;
  row.style.display = row.style.display === 'none' ? 'table-row' : 'none';
}

function clearChildren(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

function makeCell(text, className) {
  var td = document.createElement('td');
  if (className) td.className = className;
  td.textContent = text;
  return td;
}

function setLiveTableMessage(text) {
  var tbody = document.getElementById('live-tbody');
  if (!tbody) return;
  clearChildren(tbody);
  var tr = document.createElement('tr');
  var td = document.createElement('td');
  td.colSpan = 5;
  td.className = 'empty-msg';
  td.textContent = text;
  tr.appendChild(td);
  tbody.appendChild(tr);
}

function renderLiveRows(enabled, streams) {
  var tbody = document.getElementById('live-tbody');
  if (!tbody) return;
  clearChildren(tbody);

  for (var i = 0; i < streams.length; i++) {
    var item = streams[i];
    var tr = document.createElement('tr');

    tr.appendChild(makeCell(String(item.login || ''), 'mono'));
    tr.appendChild(makeCell(String(item.groupName || '')));
    tr.appendChild(makeCell(String(item.currentGame || '—')));
    tr.appendChild(makeCell(String(item.title || '—')));

    var postTd = document.createElement('td');
    if (!enabled) {
      var disabledSpan = document.createElement('span');
      disabledSpan.style.color = 'var(--muted)';
      disabledSpan.textContent = '— disabled';
      postTd.appendChild(disabledSpan);
    } else if (item.messageId) {
      var postedBadge = document.createElement('span');
      postedBadge.className = 'badge badge-active';
      postedBadge.textContent = '✓ posted';
      postTd.appendChild(postedBadge);
    } else {
      var noneSpan = document.createElement('span');
      noneSpan.style.color = 'var(--muted)';
      noneSpan.textContent = '— none';
      postTd.appendChild(noneSpan);
    }
    tr.appendChild(postTd);
    tbody.appendChild(tr);
  }
}

document.addEventListener('click', function (event) {
  var target = event.target;
  if (!(target instanceof Element)) return;

  var toggleBtn = target.closest('.btn-toggle-group-edit');
  if (toggleBtn instanceof HTMLElement) {
    var id = toggleBtn.dataset.groupId;
    if (id) toggleGroupEdit(id);
  }
});

document.addEventListener('submit', function (event) {
  var target = event.target;
  if (!(target instanceof HTMLFormElement)) return;

  if (target.classList.contains('js-confirm-remove-group')) {
    var groupName = target.dataset.groupName || 'this group';
    if (!window.confirm('Remove group "' + groupName + '" and all its streamers?')) {
      event.preventDefault();
    }
    return;
  }

  if (target.classList.contains('js-confirm-remove-streamer')) {
    var streamerName = target.dataset.streamerName || 'this streamer';
    if (!window.confirm('Remove streamer "' + streamerName + '"?')) {
      event.preventDefault();
    }
  }
});

var liveNowInflight = false;

function refreshLiveNow() {
  if (liveNowInflight) return;
  liveNowInflight = true;
  fetch('/admin/streams/live')
    .then(function(r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function(data) {
      liveNowInflight = false;
      var enabled = data.enabled;
      var streams = data.streams;
      if (!streams || !streams.length) {
        setLiveTableMessage('No streamers currently live.');
      } else {
        renderLiveRows(enabled, streams);
      }
      var el = document.getElementById('live-updated');
      if (el) el.textContent = 'Updated ' + new Date().toLocaleTimeString();
    })
    .catch(function() {
      liveNowInflight = false;
      setLiveTableMessage('Failed to load live data.');
    });
}

refreshLiveNow();
setInterval(refreshLiveNow, 15000);
