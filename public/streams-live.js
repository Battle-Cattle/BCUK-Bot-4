var expandedLiveRows = Object.create(null);
var liveItemsByKey = Object.create(null);

var liveTableColumnsCache = null;

function getLiveTableColumns() {
  if (liveTableColumnsCache !== null) return liveTableColumnsCache;

  var headerRow = document.querySelector('#live-table thead tr');
  liveTableColumnsCache = headerRow && headerRow.children
    ? headerRow.children.length
    : 1;
  return liveTableColumnsCache;
}

function getLiveRowKey(item) {
  return String(item.streamerId || '') + ':' + String(item.groupId || '');
}

function createMultiTwitchSection(multiTwitch) {
  var participants = multiTwitch && multiTwitch.participants && multiTwitch.participants.length
    ? multiTwitch.participants.join(', ')
    : '—';

  var section = document.createElement('section');
  section.className = 'live-detail-section';

  var title = document.createElement('h4');
  title.className = 'live-message-title';
  title.textContent = 'Multi-Twitch';
  section.appendChild(title);

  var metaGrid = document.createElement('div');
  metaGrid.className = 'live-meta-grid';
  metaGrid.appendChild(createMetadataItem('Setting', multiTwitch && multiTwitch.enabled ? 'Enabled' : 'Disabled'));
  metaGrid.appendChild(createMetadataItem('Applicable Now', multiTwitch && multiTwitch.applicable ? 'Yes' : 'No'));
  metaGrid.appendChild(createMetadataItem('Participants', participants, 'mono'));
  section.appendChild(metaGrid);

  var linkRow = document.createElement('div');
  linkRow.className = 'live-link-row';
  var linkLabel = document.createElement('span');
  linkLabel.className = 'live-meta-label';
  linkLabel.textContent = 'Computed link';
  var linkValue = document.createElement('span');
  linkValue.className = 'live-meta-value mono';
  linkValue.appendChild(createLink(multiTwitch ? multiTwitch.url : null, multiTwitch && multiTwitch.url ? multiTwitch.url : '—'));
  linkRow.appendChild(linkLabel);
  linkRow.appendChild(linkValue);
  section.appendChild(linkRow);

  return section;
}

function createDetailRow(item) {
  var key = getLiveRowKey(item);
  var detailTr = document.createElement('tr');
  detailTr.className = 'files-row live-detail-row';
  detailTr.dataset.liveKey = key;
  detailTr.style.display = expandedLiveRows[key] ? 'table-row' : 'none';

  var detailTd = document.createElement('td');
  detailTd.colSpan = getLiveTableColumns();

  var shell = document.createElement('div');
  shell.className = 'live-detail-shell';

  var grid = document.createElement('div');
  grid.className = 'live-detail-grid';

  var detailsSection = document.createElement('section');
  detailsSection.className = 'live-detail-section';

  var detailTitle = document.createElement('h4');
  detailTitle.className = 'live-message-title';
  detailTitle.textContent = 'Current Details';
  detailsSection.appendChild(detailTitle);

  var metaGrid = document.createElement('div');
  metaGrid.className = 'live-meta-grid';
  metaGrid.appendChild(createMetadataItem('Streamer ID', item.streamerId, 'mono'));
  metaGrid.appendChild(createMetadataItem('Group ID', item.groupId, 'mono'));
  metaGrid.appendChild(createMetadataItem('Group', item.groupName));
  metaGrid.appendChild(createMetadataItem('Target Discord Channel', item.groupDiscordChannelId, 'mono'));
  metaGrid.appendChild(createMetadataItem('Posted Channel', item.channelId, 'mono'));
  metaGrid.appendChild(createMetadataItem('Discord Message ID', item.messageId, 'mono'));
  metaGrid.appendChild(createMetadataItem('Delete Old Posts', item.deleteOldPosts ? 'Yes' : 'No'));
  metaGrid.appendChild(createMetadataItem('Current Game', item.currentGame));
  detailsSection.appendChild(metaGrid);

  var twitchLinkRow = document.createElement('div');
  twitchLinkRow.className = 'live-link-row';
  var twitchLabel = document.createElement('span');
  twitchLabel.className = 'live-meta-label';
  twitchLabel.textContent = 'Twitch';
  var twitchValue = document.createElement('span');
  twitchValue.className = 'live-meta-value mono';
  twitchValue.appendChild(createLink(item.twitchUrl, item.twitchUrl));
  twitchLinkRow.appendChild(twitchLabel);
  twitchLinkRow.appendChild(twitchValue);
  detailsSection.appendChild(twitchLinkRow);

  grid.appendChild(detailsSection);
  grid.appendChild(createMultiTwitchSection(item.multiTwitch));
  shell.appendChild(grid);

  var previewGrid = document.createElement('div');
  previewGrid.className = 'live-preview-grid';
  previewGrid.dataset.liveKey = key;
  previewGrid.dataset.hydrated = 'false';
  shell.appendChild(previewGrid);

  detailTd.appendChild(shell);
  detailTr.appendChild(detailTd);
  return detailTr;
}

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

    var detailRow = document.querySelector('tr.live-detail-row[data-live-key="' + liveKey + '"]');
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

document.addEventListener('submit', function (event) {
  if (confirmSubmit(event, 'js-confirm-remove-group', function (t) {
    return 'Remove group "' + (t.dataset.groupName || 'this group') + '" and all its streamers?';
  })) return;
  confirmSubmit(event, 'js-confirm-remove-streamer', function (t) {
    return 'Remove streamer "' + (t.dataset.streamerName || 'this streamer') + '"?';
  });
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
      liveNowInflight = false;
      setLiveTableMessage('Failed to load live data.');
    });
}

refreshLiveNow();
setInterval(refreshLiveNow, 15000);
