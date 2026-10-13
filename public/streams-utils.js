/** Removes every child node of an element. */
function clearChildren(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/** Creates a `<td>` with the given text and optional class. */
function makeCell(text, className) {
  var td = document.createElement('td');
  if (className) td.className = className;
  td.textContent = text;
  return td;
}

/** Stringifies a value for display, using `fallback` (default '—') for null/undefined/empty. */
function formatValue(value, fallback) {
  if (value === null || value === undefined || value === '') {
    return fallback === undefined || fallback === null
      ? '—'
      : String(fallback);
  }
  return String(value);
}

/** Builds a label/value pair for a live detail metadata grid. */
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

/**
 * Normalises a URL and returns it only if it is http(s) (https only with `requireHttps`).
 * @param {unknown} url - The candidate URL; protocol-relative URLs are treated as https.
 * @param {{ requireHttps?: boolean }} [options] - Restrict to https.
 * @returns {string|null} The safe absolute URL, or null.
 */
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

/** Builds a new-tab link for a safe URL, or a muted '—' placeholder when the URL is unsafe/missing. */
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
