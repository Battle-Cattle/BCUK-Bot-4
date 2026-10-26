/* global createMetadataItem, createLink */

var expandedLiveRows = Object.create(null);

var liveTableColumnsCache = null;

/**
 * Returns (and caches) the live table's column count, used for full-width colspans.
 * @returns The number of columns in the live table's header row, or 1 when there is no header.
 */
function getLiveTableColumns() {
  if (liveTableColumnsCache !== null) return liveTableColumnsCache;

  var headerRow = document.querySelector('#live-table thead tr');
  liveTableColumnsCache = headerRow && headerRow.children
    ? headerRow.children.length
    : 1;
  return liveTableColumnsCache;
}

/**
 * Builds the stable key identifying a live stream row (streamer + group).
 * @param item - One stream from GET /admin/streams/live.
 * @returns The key, as "streamerId:groupId".
 */
function getLiveRowKey(item) {
  return String(item.streamerId || '') + ':' + String(item.groupId || '');
}

/**
 * Builds a "label: link" row for a live detail section; `text` is the link's visible label.
 * @param label - The row's label text.
 * @param url - The link target; an unsafe or missing URL renders a "—" placeholder.
 * @param text - The link text, or falsy to show the URL itself.
 * @returns The `.live-link-row` element.
 */
function createLinkRow(label, url, text) {
  var row = document.createElement('div');
  row.className = 'live-link-row';
  var labelSpan = document.createElement('span');
  labelSpan.className = 'live-meta-label';
  labelSpan.textContent = label;
  var valueSpan = document.createElement('span');
  valueSpan.className = 'live-meta-value mono';
  valueSpan.appendChild(createLink(url, text));
  row.appendChild(labelSpan);
  row.appendChild(valueSpan);
  return row;
}

/**
 * Builds a titled live detail section containing a grid of the given metadata items.
 * @param titleText - The section heading.
 * @param metaItems - Elements (from createMetadataItem) to place in the grid, in order.
 * @returns The `.live-detail-section` element.
 */
function createDetailSection(titleText, metaItems) {
  var section = document.createElement('section');
  section.className = 'live-detail-section';

  var title = document.createElement('h4');
  title.className = 'live-message-title';
  title.textContent = titleText;
  section.appendChild(title);

  var metaGrid = document.createElement('div');
  metaGrid.className = 'live-meta-grid';
  metaItems.forEach(function (metaItem) { metaGrid.appendChild(metaItem); });
  section.appendChild(metaGrid);
  return section;
}

/**
 * Builds the Multi-Twitch section of a live row's details.
 * @param multiTwitch - The stream's Multi-Twitch info (`enabled`, `applicable`, `participants`, `url`), or null when absent.
 * @returns The Multi-Twitch `.live-detail-section` element.
 */
function createMultiTwitchSection(multiTwitch) {
  var participants = multiTwitch && multiTwitch.participants && multiTwitch.participants.length
    ? multiTwitch.participants.join(', ')
    : '—';

  var url = multiTwitch ? multiTwitch.url : null;

  var section = createDetailSection('Multi-Twitch', [
    createMetadataItem('Setting', multiTwitch && multiTwitch.enabled ? 'Enabled' : 'Disabled'),
    createMetadataItem('Applicable Now', multiTwitch && multiTwitch.applicable ? 'Yes' : 'No'),
    createMetadataItem('Participants', participants, 'mono'),
  ]);
  section.appendChild(createLinkRow('Computed link', url, url || '—'));
  return section;
}

/**
 * Builds the expandable detail `<tr>` for a live stream; its message previews are filled in
 * lazily by hydrateLivePreviewGrid when first expanded.
 * @param {object} item - One stream from GET /admin/streams/live.
 * @returns {HTMLTableRowElement} The detail row.
 */
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

  var detailsSection = createDetailSection('Current Details', [
    createMetadataItem('Streamer ID', item.streamerId, 'mono'),
    createMetadataItem('Group ID', item.groupId, 'mono'),
    createMetadataItem('Group', item.groupName),
    createMetadataItem('Target Discord Channel', item.groupDiscordChannelId, 'mono'),
    createMetadataItem('Posted Channel', item.channelId, 'mono'),
    createMetadataItem('Discord Message ID', item.messageId, 'mono'),
    createMetadataItem('Delete Old Posts', item.deleteOldPosts ? 'Yes' : 'No'),
    createMetadataItem('Current Game', item.currentGame),
  ]);
  detailsSection.appendChild(createLinkRow('Twitch', item.twitchUrl, item.twitchUrl));

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
