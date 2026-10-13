/**
 * Asks for confirmation before a form carrying `className` submits, cancelling the submit if
 * the user declines. Call from a delegated document-level 'submit' listener.
 * @param {SubmitEvent} event - The delegated submit event.
 * @param {string} className - CSS class marking the forms this confirmation applies to.
 * @param {function(HTMLFormElement): string} buildMessage - Builds the prompt from the form.
 * @returns {boolean} True if the form matched `className` (whatever the user answered), so
 *   callers checking several classes can stop at the first match.
 */
function confirmSubmit(event, className, buildMessage) {
  var target = event.target;
  if (!(target instanceof HTMLFormElement)) return false;
  if (!target.classList.contains(className)) return false;
  if (!window.confirm(buildMessage(target))) event.preventDefault();
  return true;
}

/**
 * Wires a button to copy the text content of another element to the clipboard,
 * with brief "Copied!" feedback and a fallback alert when the Clipboard API is
 * unavailable or the write is rejected.
 * @param {string} buttonId - ID of the button element to attach the click handler to.
 * @param {string} sourceId - ID of the element whose textContent will be copied.
 * @param {string} idleLabel - Label to restore on the button after the "Copied!" feedback.
 * @returns {void}
 */
function registerCopyToClipboardHandler(buttonId, sourceId, idleLabel) {
  var button = document.getElementById(buttonId);
  if (!button) return;
  button.addEventListener('click', function () {
    var sourceEl = document.getElementById(sourceId);
    var text = sourceEl ? sourceEl.textContent : '';
    if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
      alert('Could not copy automatically — please copy it manually.');
      return;
    }
    navigator.clipboard.writeText(text).then(function () {
      button.textContent = 'Copied!';
      setTimeout(function () { button.textContent = idleLabel; }, 2000);
    }).catch(function () { alert('Could not copy automatically — please copy it manually.'); });
  });
}

/**
 * Registers a global 'submit' listener that intercepts forms carrying `formClassName`,
 * submitting them via fetch with the CSRF token in an X-CSRF-Token header instead of the
 * page's normal multipart POST — so the session token is never placed in the URL (browser
 * history/Referer). csrfProtection validates the header before Multer parses the multipart
 * body. fetch follows the server redirect; on success we then navigate to the resulting page.
 * A second submit (Enter key, double-click) while the first is still pending is ignored.
 * Shared by every file-upload admin page (SFX sounds, overlay videos, alert images/sounds).
 * @param {string} formClassName - CSS class marking a form as one this handler should intercept.
 * @param {string} fallbackPath - Path to navigate to on success if the response wasn't a
 *   redirect, or on a network/parsing failure (with `?error=upload_failed` appended).
 * @returns {void}
 */
function registerUploadFormHandler(formClassName, fallbackPath) {
  document.addEventListener('submit', function (event) {
    var form = event.target;
    if (!(form instanceof HTMLFormElement) || !form.classList.contains(formClassName)) return;
    event.preventDefault();
    // Disabling the button alone doesn't block an Enter-key or scripted resubmit.
    if (form.dataset.submitting === 'true') return;
    form.dataset.submitting = 'true';

    var token = (document.body && document.body.dataset.csrfToken) || '';
    var submitBtn = form.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.disabled = true;

    fetch(form.action, {
      method: 'POST',
      headers: { 'X-CSRF-Token': token },
      body: new FormData(form),
    })
      .then(function (res) {
        // Only follow an actual server redirect (success/error → `fallbackPath?…`).
        // A non-redirect response (e.g. 403 CSRF, 500) keeps res.url at the POST-only
        // upload route, so treat any non-OK response as a failure instead.
        if (res.redirected && res.url) {
          window.location.assign(res.url);
          return;
        }
        if (!res.ok) throw new Error('Upload failed');
        window.location.assign(fallbackPath);
      })
      .catch(function () {
        window.location.assign(fallbackPath + '?error=upload_failed');
      })
      .finally(function () {
        delete form.dataset.submitting;
      });
  });
}

/**
 * Applies a deterministic hue (derived by hashing the element's Discord ID) to one user badge,
 * via the CSSOM (`element.style`) rather than an inline `style=""` attribute so it works under
 * CSP `style-src` without `'unsafe-inline'`.
 * @param {HTMLElement} el - Badge element carrying a `data-user-hue` Discord ID.
 * @returns {void}
 */
function applyUserHueBadge(el) {
  var discordId = el.dataset.userHue;
  var h = 5381;
  for (var i = 0; i < discordId.length; i++) {
    h = ((h << 5) + h) ^ discordId.charCodeAt(i);
    h >>>= 0;
  }
  el.style.setProperty('--hue', h % 360);
}

/**
 * Colors every `.badge-user-hue[data-user-hue]` element on the page — see {@link applyUserHueBadge}.
 * Shared by every page that lists per-user assignment badges (Commands, Timers).
 * @returns {void}
 */
function registerUserHueBadges() {
  document.querySelectorAll('.badge-user-hue[data-user-hue]').forEach(applyUserHueBadge);
}

/**
 * Registers a delegated click handler that toggles the inline edit row for the item a
 * `buttonClass` button points at (`rowPrefix` + the button's `idAttr` value), keeping the
 * opener button's `aria-expanded` in sync when it has one.
 * @param {string} buttonClass - CSS class of the toggle buttons.
 * @param {string} idAttr - Attribute on the button holding the item id, e.g. 'data-counter-id'.
 * @param {string} rowPrefix - ID prefix of the edit rows, e.g. 'counter-edit-'.
 * @returns {void}
 */
function registerToggleEditHandler(buttonClass, idAttr, rowPrefix) {
  document.addEventListener('click', function (event) {
    var target = event.target;
    if (!(target instanceof Element)) return;

    var button = target.closest('.' + buttonClass);
    if (!(button instanceof HTMLElement)) return;

    var itemId = button.getAttribute(idAttr);
    if (!itemId) return;

    var row = document.getElementById(rowPrefix + itemId);
    if (!(row instanceof HTMLElement)) return;

    row.classList.toggle('is-hidden');

    var isOpen = !row.classList.contains('is-hidden');
    var openerButton = document.querySelector(
      '.' + buttonClass + '[aria-expanded][' + idAttr + '="' + itemId + '"]'
    );
    if (openerButton instanceof HTMLElement) {
      openerButton.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    }
  });
}
