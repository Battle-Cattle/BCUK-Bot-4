/* ── Dashboard utilities ─────────────────────────────────── */

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

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value || '—';
}

function setClass(id, className) {
  const el = document.getElementById(id);
  if (!el) return;
  el.className = el.className.replace(/dot--\S+/g, '').trim();
  for (const cls of className.split(' ')) {
    if (cls) el.classList.add(cls);
  }
}

function clearChildren(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}
