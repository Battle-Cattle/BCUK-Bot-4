/* global registerUploadFormHandler, confirmSubmit */
/* ── SFX table search ──────────────────────────────────── */

const searchInput = document.getElementById('sfx-search');
const sfxTable    = document.getElementById('sfx-table');
const noResults   = document.getElementById('no-results');
const cmdCount    = document.getElementById('cmd-count');

/**
 * Syncs a detail-row opener button's aria-expanded state, and its "▶/▼ Sounds" label when it
 * is the Sounds toggle (the Edit toggle's label never changes).
 * @param {Element} button The opener button (the one carrying aria-expanded).
 * @param {boolean} expanded Whether its detail row is now shown.
 * @returns {void}
 */
function setOpenerState(button, expanded) {
  button.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  if (button.classList.contains('btn-toggle-files')) {
    button.textContent = expanded ? '▼ Sounds' : '▶ Sounds';
  }
}

/**
 * Collapse every expandable detail row belonging to a trigger and reset its toggle buttons.
 * @param {HTMLElement} row The trigger's `.sfx-row`.
 * @returns {void}
 */
function collapseDetailRows(row) {
  const triggerId = CSS.escape(row.dataset.triggerId || '');
  sfxTable.querySelectorAll('.detail-row[data-parent="' + triggerId + '"]').forEach((detail) => {
    detail.classList.add('is-hidden');
  });
  row.querySelectorAll('[aria-expanded]').forEach((btn) => setOpenerState(btn, false));
}

if (searchInput && sfxTable) {
  /** Filters the SFX table by command/category, collapsing detail rows of hidden triggers. */
  searchInput.addEventListener('input', () => {
    const q = searchInput.value.toLowerCase().trim();
    let visible = 0;

    sfxTable.querySelectorAll('tr.sfx-row').forEach((row) => {
      const match = !q || (row.dataset.command || '').includes(q) || (row.dataset.category || '').includes(q);
      // Only collapse on the keystroke that hides the row, not on every keystroke after it.
      if (!match && row.style.display !== 'none') collapseDetailRows(row);
      row.style.display = match ? '' : 'none';
      if (match) visible++;
    });

    if (noResults) noResults.classList.toggle('is-hidden', visible !== 0);
    if (cmdCount)  cmdCount.textContent = String(visible);
  });
}

/* ── Toggle expandable rows (sounds + edit panels) ─────────── */

/**
 * Toggle the detail row targeted by a clicked `.btn-toggle-files`/`.btn-toggle-detail`
 * button (the opener, or the edit panel's Cancel button), keeping the opener's
 * aria-expanded state and label in sync.
 * @param {Event} event The delegated click event.
 * @returns {void}
 */
document.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const toggleBtn = target.closest('.btn-toggle-files, .btn-toggle-detail');
  if (!(toggleBtn instanceof HTMLElement)) return;

  const id = toggleBtn.dataset.target;
  if (!id) return;
  const row = document.getElementById(id);
  if (!row) return;

  const expanded = row.classList.toggle('is-hidden') === false;
  const opener = document.querySelector('[data-target="' + CSS.escape(id) + '"][aria-expanded]');
  if (opener) setOpenerState(opener, expanded);
});

/* ── Sound upload (CSRF token via header, not URL) ─────────── */

registerUploadFormHandler('js-sfx-upload', '/sfx');

/* ── Confirm destructive actions ───────────────────────────── */

/**
 * Intercept submits of the destructive-action forms (remove trigger/file/category)
 * and require a confirmation prompt before they proceed.
 * @param {Event} event The delegated submit event.
 * @returns {void}
 */
document.addEventListener('submit', (event) => {
  if (confirmSubmit(event, 'js-confirm-remove-trigger', (t) =>
    'Remove trigger ' + (t.dataset.triggerCommand || 'this trigger') + ' and all its sounds?')) return;
  if (confirmSubmit(event, 'js-confirm-remove-file', (t) =>
    'Remove sound ' + (t.dataset.fileName || 'this sound') + '?')) return;
  confirmSubmit(event, 'js-confirm-remove-category', (t) =>
    'Remove category ' + (t.dataset.categoryName || 'this category') + '? Its triggers stay, but become uncategorised.');
});
