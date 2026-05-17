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
