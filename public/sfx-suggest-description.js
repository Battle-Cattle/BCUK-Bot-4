/* ── Suggest description (owner-only, needs OPENAI_API_KEY) ─── */

// Split out from sfx.js so this feature's request/response handling doesn't add to
// that file's complexity — the button/status markup only exists in the DOM at all
// when canSuggestDescriptions is true (views/sfx.ejs), so this is a safe no-op
// listener to load unconditionally otherwise.

/**
 * Applies a successful suggestion response to the description input and status text.
 * @param {HTMLElement | null} descriptionInput The trigger's description `<input>`, if found.
 * @param {Element | null} statusEl The status `<span>` next to the Suggest button, if found.
 * @param {unknown} data Parsed JSON response body.
 * @returns {boolean} Whether the response contained a usable description.
 */
function applySuggestedDescription(descriptionInput, statusEl, data) {
  if (!data || typeof data.description !== 'string') return false;
  if (descriptionInput instanceof HTMLInputElement) descriptionInput.value = data.description;
  if (statusEl) statusEl.textContent = 'Suggestion applied — review and Save Changes.';
  return true;
}

// Unlike the upload form in sfx.js, this endpoint returns JSON (not a redirect)
// since it just fills in a field rather than mutating a page — the mod still has
// to click "Save Changes" to persist whatever ends up in the description input.
/**
 * Handle a click on a `.js-suggest-description` button: POST the trigger id (and
 * its current command, sent as context only) to the suggest-description endpoint,
 * and fill the sibling description input with the result.
 * @param {Event} event The delegated click event.
 * @returns {void}
 */
document.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const button = target.closest('.js-suggest-description');
  if (!(button instanceof HTMLElement)) return;
  if (button.dataset.submitting === 'true') return;

  const triggerId = button.getAttribute('data-trigger-id');
  if (!triggerId) return;
  const descriptionInput = document.getElementById('description_' + triggerId);
  const statusEl = document.querySelector('.js-suggest-status[data-status-for="' + triggerId + '"]');
  const commandInput = document.getElementById('trigger_command_' + triggerId);
  const triggerCommand = commandInput instanceof HTMLInputElement ? commandInput.value : '';

  button.dataset.submitting = 'true';
  button.disabled = true;
  if (statusEl) statusEl.textContent = 'Thinking…';

  const token = (document.body && document.body.dataset.csrfToken) || '';

  fetch('/sfx/trigger/suggest-description', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
    body: JSON.stringify({ trigger_id: triggerId, trigger_command: triggerCommand }),
  })
    .then((res) => res.json().then((data) => ({ ok: res.ok, data })))
    .then(({ ok, data }) => {
      if (!ok || !applySuggestedDescription(descriptionInput, statusEl, data)) {
        if (statusEl) statusEl.textContent = 'Could not generate a suggestion. Try again.';
      }
    })
    .catch(() => {
      if (statusEl) statusEl.textContent = 'Could not generate a suggestion. Try again.';
    })
    .finally(() => {
      delete button.dataset.submitting;
      button.disabled = false;
    });
});
