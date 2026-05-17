function toggleGroupEdit(id) {
  var row = document.getElementById('group-edit-' + id);
  if (!row) return;
  row.classList.toggle('is-hidden');
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

function createMetadataItem(label, value, extraClass) {
  var item = document.createElement('div');
  item.className = 'live-meta-item';
  var labelSpan = document.createElement('span');
  labelSpan.className = 'live-meta-label';
  labelSpan.textContent = label;
  var valueSpan = document.createElement('span');
  valueSpan.className = 'live-meta-value' + (extraClass ? ' ' + extraClass : '');
  valueSpan.textContent = formatValue(value);
  item.appendChild(labelSpan);
  item.appendChild(valueSpan);
  return item;
}

function sanitizeUrl(url, options) {
  var raw = url ? String(url).trim() : '';
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
  var allowed = requireHttps
    ? protocol === 'https:'
    : protocol === 'https:' || protocol === 'http:';
  return allowed ? parsed.href : null;
}

function createLink(url, label) {
  var safeUrl = sanitizeUrl(url);
  if (!safeUrl) {
    var muted = document.createElement('span');
    muted.className = 'muted';
    muted.textContent = '—';
    return muted;
  }
  var a = document.createElement('a');
  a.href = safeUrl;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.textContent = label || safeUrl;
  return a;
}
