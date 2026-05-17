/* global expandedLiveRows, liveItemsByKey, getLiveRowKey, getLiveTableColumns, createDetailRow, clearChildren, makeCell, createMessagePreview */

function hydrateLivePreviewGrid(liveKey) {
  var detailRow = document.querySelector('tr.live-detail-row[data-live-key="' + liveKey + '"]');
  if (!(detailRow instanceof HTMLElement)) return;

  var grid = detailRow.querySelector('.live-preview-grid');
  if (!(grid instanceof HTMLElement)) return;
  if (grid.dataset.hydrated === 'true') return;

  var item = liveItemsByKey[liveKey];
  if (!item) return;

  clearChildren(grid);
  grid.appendChild(createMessagePreview('Live Announcement Preview', item.liveMessagePreview));
  grid.appendChild(createMessagePreview('Game Change Preview', item.gameChangePreview));
  grid.dataset.hydrated = 'true';
}

function setLiveTableMessage(text) {
  var tbody = document.getElementById('live-tbody');
  if (!tbody) return;
  clearChildren(tbody);
  var tr = document.createElement('tr');
  var td = document.createElement('td');
  td.colSpan = getLiveTableColumns();
  td.className = 'empty-msg';
  td.textContent = text;
  tr.appendChild(td);
  tbody.appendChild(tr);
}

function renderLiveRows(streams) {
  var tbody = document.getElementById('live-tbody');
  if (!tbody) return;
  clearChildren(tbody);
  liveItemsByKey = Object.create(null);
  var nextExpandedLiveRows = Object.create(null);

  for (var i = 0; i < streams.length; i++) {
    var item = streams[i];
    var key = getLiveRowKey(item);
    liveItemsByKey[key] = item;
    if (expandedLiveRows[key]) {
      nextExpandedLiveRows[key] = true;
    }
    var tr = document.createElement('tr');
    tr.className = 'sfx-row';
    tr.dataset.liveKey = key;

    var toggleTd = document.createElement('td');
    var toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'btn btn-sm btn-ghost btn-toggle-live-details';
    toggleBtn.dataset.liveKey = key;
    toggleBtn.setAttribute('aria-expanded', expandedLiveRows[key] ? 'true' : 'false');
    toggleBtn.setAttribute('aria-label', 'Toggle stream details for ' + String(item.login || 'stream'));
    toggleBtn.title = 'Toggle stream details';
    toggleBtn.textContent = expandedLiveRows[key] ? '▼' : '▶';
    toggleTd.appendChild(toggleBtn);
    tr.appendChild(toggleTd);

    tr.appendChild(makeCell(String(item.login || ''), 'mono'));
    tr.appendChild(makeCell(String(item.groupName || '')));
    tr.appendChild(makeCell(String(item.currentGame || '—')));
    tr.appendChild(makeCell(String(item.title || '—')));

    var postTd = document.createElement('td');
    if (item.messageId) {
      var postedBadge = document.createElement('span');
      postedBadge.className = 'badge badge-active';
      postedBadge.textContent = '✓ posted';
      postTd.appendChild(postedBadge);
    } else {
      var noneSpan = document.createElement('span');
      noneSpan.className = 'muted';
      noneSpan.textContent = '— none';
      postTd.appendChild(noneSpan);
    }
    tr.appendChild(postTd);
    tbody.appendChild(tr);
    tbody.appendChild(createDetailRow(item));

    if (nextExpandedLiveRows[key]) {
      hydrateLivePreviewGrid(key);
    }
  }

  expandedLiveRows = nextExpandedLiveRows;
}
