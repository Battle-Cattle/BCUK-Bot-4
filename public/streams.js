function toggleGroupEdit(id) {
  var row = document.getElementById('group-edit-' + id);
  if (!row) return;
  row.classList.toggle('is-hidden');
}

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

function clearChildren(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

function makeCell(text, className) {
  var td = document.createElement('td');
  if (className) td.className = className;
  td.textContent = text;
  return td;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatValue(value, fallback) {
  if (value === null || value === undefined || value === '') {
    return fallback === undefined || fallback === null
      ? '—'
      : String(fallback);
  }
  return String(value);
}

function renderBadge(label, className) {
  return '<span class="badge ' + className + '">' + escapeHtml(label) + '</span>';
}

function renderMetadataItem(label, value, extraClass) {
  return '' +
    '<div class="live-meta-item">' +
      '<span class="live-meta-label">' + escapeHtml(label) + '</span>' +
      '<span class="live-meta-value' + (extraClass ? ' ' + extraClass : '') + '">' + escapeHtml(formatValue(value)) + '</span>' +
    '</div>';
}

function sanitizeUrl(url, options) {
  if (!url) return null;
  var raw = String(url).trim();
  if (!raw) return null;

  // Twitch/CDN URLs may occasionally arrive protocol-relative (//host/path).
  if (raw.indexOf('//') === 0) {
    raw = 'https:' + raw;
  }

  var parsed;
  try {
    parsed = new URL(raw);
  } catch (_err) {
    return null;
  }

  var protocol = parsed.protocol.toLowerCase();
  var requireHttps = !!(options && options.requireHttps);
  if (requireHttps) {
    return protocol === 'https:' ? parsed.href : null;
  }

  if (protocol === 'https:' || protocol === 'http:') return parsed.href;
  return null;
}

function renderLink(url, label) {
  var safeUrl = sanitizeUrl(url);
  if (!safeUrl) return '<span class="muted">—</span>';
  return '<a href="' + escapeHtml(safeUrl) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(label || safeUrl) + '</a>';
}

function renderEmbedFields(fields) {
  if (!Array.isArray(fields) || fields.length === 0) {
    return '<div class="discord-embed-field"><span class="muted">No embed fields</span></div>';
  }

  return fields.map(function(field) {
    return '' +
      '<div class="discord-embed-field">' +
        '<div class="discord-embed-field-name">' + escapeHtml(formatValue(field.name)) + '</div>' +
        '<div class="discord-embed-field-value">' + escapeHtml(formatValue(field.value)) + '</div>' +
      '</div>';
  }).join('');
}

function renderMessagePreview(title, preview) {
  var embed = preview && preview.embed ? preview.embed : null;
  var content = preview ? formatValue(preview.content, '') : '';
  var safeEmbedUrl = embed ? sanitizeUrl(embed.url) : null;
  var safeImageUrl = embed ? sanitizeUrl(embed.imageUrl, { requireHttps: true }) : null;

  return '' +
    '<section class="live-message-preview">' +
      '<h4 class="live-message-title">' + escapeHtml(title) + '</h4>' +
      '<div class="discord-message-box">' +
        '<div class="discord-message-content">' + (content ? escapeHtml(content) : '<span class="muted">No message content</span>') + '</div>' +
        (embed ? '' +
          '<div class="discord-embed-preview">' +
            '<div class="discord-embed-accent"></div>' +
            '<div class="discord-embed-body">' +
              '<div class="discord-embed-title">' + (safeEmbedUrl
                ? '<a href="' + escapeHtml(safeEmbedUrl) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(formatValue(embed.title)) + '</a>'
                : escapeHtml(formatValue(embed.title))) + '</div>' +
              '<div class="discord-embed-fields">' + renderEmbedFields(embed.fields) + '</div>' +
              '<div class="discord-embed-image">' + (safeImageUrl
                ? '<img src="' + escapeHtml(safeImageUrl) + '" alt="Stream thumbnail preview" loading="lazy" referrerpolicy="no-referrer">'
                : '<span class="muted">Thumbnail unavailable</span>') + '</div>' +
              (safeImageUrl
                ? '<div class="discord-embed-footer">Image: ' + renderLink(safeImageUrl, 'open thumbnail') + '</div>'
                : '') +
              (embed.footer ? '<div class="discord-embed-footer">' + escapeHtml(embed.footer) + '</div>' : '<div class="discord-embed-footer muted">No footer</div>') +
            '</div>' +
          '</div>' : '') +
      '</div>' +
    '</section>';
}

function getLiveRowKey(item) {
  return String(item.streamerId || '') + ':' + String(item.groupId || '');
}

function renderMultiTwitchDetails(multiTwitch) {
  var participants = multiTwitch && multiTwitch.participants && multiTwitch.participants.length
    ? multiTwitch.participants.join(', ')
    : '—';
  var footerState = multiTwitch && multiTwitch.renderedFooter
    ? renderBadge('Footer active', 'badge-active')
    : '<span class="muted">No footer rendered</span>';

  return '' +
    '<section class="live-detail-section">' +
      '<h4 class="live-message-title">Multi-Twitch</h4>' +
      '<div class="live-meta-grid">' +
        renderMetadataItem('Setting', multiTwitch && multiTwitch.enabled ? 'Enabled' : 'Disabled') +
        renderMetadataItem('Applicable Now', multiTwitch && multiTwitch.applicable ? 'Yes' : 'No') +
        renderMetadataItem('Participants', participants, 'mono') +
        renderMetadataItem('Footer', multiTwitch && multiTwitch.renderedFooter ? multiTwitch.renderedFooter : '—', 'mono') +
      '</div>' +
      '<div class="live-link-row">' +
        '<span class="live-meta-label">Computed link</span>' +
        '<span class="live-meta-value mono">' + renderLink(multiTwitch ? multiTwitch.url : null, multiTwitch && multiTwitch.url ? multiTwitch.url : '—') + '</span>' +
      '</div>' +
      '<div class="live-footer-state">' + footerState + '</div>' +
    '</section>';
}

function createDetailRow(item) {
  var key = getLiveRowKey(item);
  var detailTr = document.createElement('tr');
  detailTr.className = 'files-row live-detail-row';
  detailTr.dataset.liveKey = key;
  detailTr.style.display = expandedLiveRows[key] ? 'table-row' : 'none';

  var detailTd = document.createElement('td');
  detailTd.colSpan = getLiveTableColumns();
  detailTd.innerHTML = '' +
    '<div class="live-detail-shell">' +
      '<div class="live-detail-grid">' +
        '<section class="live-detail-section">' +
          '<h4 class="live-message-title">Current Details</h4>' +
          '<div class="live-meta-grid">' +
            renderMetadataItem('Streamer ID', item.streamerId, 'mono') +
            renderMetadataItem('Group ID', item.groupId, 'mono') +
            renderMetadataItem('Group', item.groupName) +
            renderMetadataItem('Target Discord Channel', item.groupDiscordChannelId, 'mono') +
            renderMetadataItem('Posted Channel', item.channelId, 'mono') +
            renderMetadataItem('Discord Message ID', item.messageId, 'mono') +
            renderMetadataItem('Delete Old Posts', item.deleteOldPosts ? 'Yes' : 'No') +
            renderMetadataItem('Current Game', item.currentGame) +
          '</div>' +
          '<div class="live-link-row">' +
            '<span class="live-meta-label">Twitch</span>' +
            '<span class="live-meta-value mono">' + renderLink(item.twitchUrl, item.twitchUrl) + '</span>' +
          '</div>' +
        '</section>' +
        renderMultiTwitchDetails(item.multiTwitch) +
      '</div>' +
      '<div class="live-preview-grid" data-live-key="' + escapeHtml(key) + '" data-hydrated="false"></div>' +
    '</div>';
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

  grid.innerHTML = '' +
    renderMessagePreview('Live Announcement Preview', item.liveMessagePreview) +
    renderMessagePreview('Game Change Preview', item.gameChangePreview);
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

function renderLiveRows(enabled, streams) {
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
        expandedLiveRows = Object.create(null);
        liveItemsByKey = Object.create(null);
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
