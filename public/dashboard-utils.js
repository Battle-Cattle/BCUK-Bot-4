/* ── Dashboard utilities ─────────────────────────────────── */

/** Formats a timestamp as "just now", "42s ago", "5m ago", "3h ago" or "2d ago" ("—" when missing). */
function relativeTime(isoString) {
  if (!isoString) return '—';
  const s = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000);
  const thresholds = [
    [5,     'just now'],
    [60,    `${s}s ago`],
    [3600,  `${Math.floor(s / 60)}m ago`],
    [86400, `${Math.floor(s / 3600)}h ago`],
  ];
  const match = thresholds.find(([limit]) => s < limit);
  return match ? match[1] : `${Math.floor(s / 86400)}d ago`;
}

/** Sets an element's text, showing "—" for an empty value; does nothing if the element is missing. */
function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value || '—';
}

/** Replaces an element's `dot--*` status classes with `className`'s; does nothing if the element is missing. */
function setClass(id, className) {
  const el = document.getElementById(id);
  if (!el) return;
  el.className = el.className.replace(/dot--\S+/g, '').trim();
  for (const cls of className.split(' ')) {
    if (cls) el.classList.add(cls);
  }
}

/** Removes every child of `el`. */
function clearChildren(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}
