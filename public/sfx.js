/* ── SFX table search ──────────────────────────────────── */

const searchInput = document.getElementById('sfx-search');
const sfxTable    = document.getElementById('sfx-table');
const noResults   = document.getElementById('no-results');
const cmdCount    = document.getElementById('cmd-count');

/**
 * Collapse every expandable detail row belonging to a trigger and reset its toggle buttons.
 * @param {string} triggerId The trigger id whose detail rows should be collapsed.
 * @returns {void}
 */
function collapseDetailRows(triggerId) {
  document.querySelectorAll('.detail-row[data-parent="' + triggerId + '"]').forEach((row) => {
    row.classList.add('is-hidden');
  });
  document
    .querySelectorAll('.sfx-row[data-trigger-id="' + triggerId + '"] [aria-expanded]')
    .forEach((btn) => {
      btn.setAttribute('aria-expanded', 'false');
      if (btn.classList.contains('btn-toggle-files')) btn.textContent = '▶ Sounds';
    });
}

if (searchInput && sfxTable) {
  searchInput.addEventListener('input', () => {
    const q = searchInput.value.toLowerCase().trim();
    const rows = sfxTable.querySelectorAll('tr.sfx-row');
    let visible = 0;

    rows.forEach((row) => {
      const cmd = row.dataset.command || '';
      const cat = row.dataset.category || '';
      const match = !q || cmd.includes(q) || cat.includes(q);
      const triggerId = row.dataset.triggerId;

      if (match) {
        row.style.display = '';
        visible++;
      } else {
        row.style.display = 'none';
        if (triggerId) collapseDetailRows(triggerId);
      }
    });

    if (noResults) noResults.classList.toggle('is-hidden', visible !== 0);
    if (cmdCount)  cmdCount.textContent = String(visible);
  });
}

/* ── Toggle expandable rows (sounds + edit panels) ─────────── */

/**
 * Toggle the detail row targeted by a clicked `.btn-toggle-files`/`.btn-toggle-detail`
 * button, keeping the opener's aria-expanded state and label in sync.
 * @param {Event} event The delegated click event.
 * @returns {void}
 */
document.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const toggleBtn = target.closest('.btn-toggle-files, .btn-toggle-detail');
  if (!(toggleBtn instanceof HTMLElement)) return;

  const id = toggleBtn.getAttribute('data-target');
  if (!id) return;
  const row = document.getElementById(id);
  if (!(row instanceof HTMLElement)) return;

  const shown = !row.classList.contains('is-hidden');
  row.classList.toggle('is-hidden', shown);

  // Keep the opener button (the one with aria-expanded) in sync.
  const opener = document.querySelector('.btn-toggle-files[data-target="' + id + '"][aria-expanded], .btn-toggle-detail[data-target="' + id + '"][aria-expanded]');
  if (opener instanceof HTMLElement) {
    opener.setAttribute('aria-expanded', shown ? 'false' : 'true');
    if (opener.classList.contains('btn-toggle-files')) {
      opener.textContent = shown ? '▶ Sounds' : '▼ Sounds';
    }
  }
});

/* ── Sound upload (CSRF token via header, not URL) ─────────── */

// The upload form carries no _csrf in its action so the session token never
// lands in the URL/history/Referer. We submit via fetch with the token in an
// X-CSRF-Token header, which csrfProtection validates before Multer parses the
// multipart body. fetch follows the server's redirect; we then navigate to the
// resulting /sfx?success=… or ?error=… page.
/**
 * Submit a `.js-sfx-upload` form via fetch with the CSRF token in an X-CSRF-Token
 * header (never the URL), then navigate to the server's redirect target.
 * @param {Event} event The delegated submit event.
 * @returns {void}
 */
document.addEventListener('submit', (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || !form.classList.contains('js-sfx-upload')) return;
  event.preventDefault();
  // Guard against a second submit (Enter key, double-click, scripted resubmit) while
  // the fetch above is still pending — disabling the button alone doesn't block those.
  if (form.dataset.submitting === 'true') return;
  form.dataset.submitting = 'true';

  const token = (document.body && document.body.dataset.csrfToken) || '';
  const submitBtn = form.querySelector('button[type="submit"]');
  if (submitBtn) submitBtn.disabled = true;

  fetch(form.action, {
    method: 'POST',
    headers: { 'X-CSRF-Token': token },
    body: new FormData(form),
  })
    .then((res) => {
      // Only follow an actual server redirect (success/error → /sfx?…). A
      // non-redirect response (e.g. 403 CSRF, 500) keeps res.url at the POST-only
      // upload route, so treat any non-OK response as a failure instead.
      if (res.redirected && res.url) {
        window.location.assign(res.url);
        return;
      }
      if (!res.ok) throw new Error('Upload failed');
      window.location.assign('/sfx');
    })
    .catch(() => {
      window.location.assign('/sfx?error=upload_failed');
    })
    .finally(() => {
      delete form.dataset.submitting;
    });
});

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
