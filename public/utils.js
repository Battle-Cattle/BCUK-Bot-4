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

/** Milliseconds between polls of a form's processing-progress endpoint while the server works. */
var UPLOAD_PROGRESS_POLL_MS = 2000;

/** Milliseconds before a progress poll that hasn't answered is abandoned, so polling carries on. */
var UPLOAD_PROGRESS_FETCH_TIMEOUT_MS = 10000;

/**
 * Generates an ID for one upload, sent as `X-Upload-Id` so the page can ask the server how the
 * upload's processing is going. `crypto.getRandomValues` works on plain-HTTP pages too, unlike
 * `crypto.randomUUID`.
 * @returns {string} 16 random bytes as 32 lowercase hex characters.
 */
function newUploadId() {
  var bytes = new Uint8Array(16);
  window.crypto.getRandomValues(bytes);
  return Array.prototype.map.call(bytes, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
}

/**
 * Finds a form's optional progress display: an element with `data-upload-progress` holding a
 * `<progress>` bar and a `[data-upload-progress-label]` text element.
 * @param {HTMLFormElement} form - The upload form.
 * @returns {{box: HTMLElement, bar: HTMLProgressElement|null, label: HTMLElement|null}|null} The
 *   display's parts, or null when the form has none.
 */
function findUploadProgress(form) {
  var box = form.querySelector('[data-upload-progress]');
  if (!box) return null;
  return { box: box, bar: box.querySelector('progress'), label: box.querySelector('[data-upload-progress-label]') };
}

/**
 * Shows the progress display (if the form has one) at `percent` with `text` beside it.
 * @param {{box: HTMLElement, bar: HTMLProgressElement|null, label: HTMLElement|null}|null} progress -
 *   The display from {@link findUploadProgress}, or null to do nothing.
 * @param {number|null} percent - 0-100, or null for an indeterminate (animated) bar.
 * @param {string} text - The status text to show.
 * @returns {void}
 */
function showUploadProgress(progress, percent, text) {
  if (!progress) return;
  progress.box.classList.remove('is-hidden');
  if (progress.bar) {
    if (percent === null) progress.bar.removeAttribute('value');
    else progress.bar.value = percent;
  }
  if (progress.label) progress.label.textContent = text;
}

/**
 * Names the progress bar for assistive technology after the stage it's showing, since the same
 * bar shows the upload and then the server's processing.
 * @param {{box: HTMLElement, bar: HTMLProgressElement|null, label: HTMLElement|null}|null} progress -
 *   The display from {@link findUploadProgress}, or null to do nothing.
 * @param {string} name - The bar's accessible name, e.g. 'Upload progress'.
 * @returns {void}
 */
function nameUploadProgress(progress, name) {
  if (progress && progress.bar) progress.bar.setAttribute('aria-label', name);
}

/**
 * Turns the server's processing state for an upload into what the progress display shows.
 * @param {{stage: string, percent: (number|null)}|null} state - The progress endpoint's JSON
 *   (`queued`, `converting` or `none`), or null when it couldn't be read.
 * @param {string} fallbackText - Text for any other state, e.g. the form's `data-processing-label`.
 * @returns {{percent: (number|null), text: string}} The bar position and status text.
 */
function describeProcessing(state, fallbackText) {
  if (state && state.stage === 'queued') return { percent: null, text: 'Waiting for another conversion to finish…' };
  if (state && state.stage === 'converting') {
    if (typeof state.percent !== 'number') return { percent: null, text: 'Converting…' };
    return { percent: state.percent, text: 'Converting… ' + state.percent + '%' };
  }
  return { percent: null, text: fallbackText };
}

/**
 * Once the file has been sent, polls the form's `data-progress-url` endpoint (with the upload's
 * ID appended) every {@link UPLOAD_PROGRESS_POLL_MS} and shows what the server reports, until
 * the returned function is called. A poll that hasn't answered within
 * {@link UPLOAD_PROGRESS_FETCH_TIMEOUT_MS} is abandoned so the next one still runs. Does nothing for a form without that attribute or without a
 * progress display.
 * @param {HTMLFormElement} form - The upload form.
 * @param {string} uploadId - The upload's ID, as sent in `X-Upload-Id`.
 * @param {{box: HTMLElement, bar: HTMLProgressElement|null, label: HTMLElement|null}|null} progress -
 *   The form's progress display.
 * @returns {function(): void} Stops polling.
 */
function pollProcessingProgress(form, uploadId, progress) {
  var url = form.dataset.progressUrl;
  if (!url || !progress) return function () {};
  var fallbackText = form.dataset.processingLabel || 'Processing…';
  var stopped = false;
  var timer;
  /**
   * Fetches the current state once and schedules the next poll.
   * @returns {void}
   */
  function tick() {
    var controller = new AbortController();
    var deadline = setTimeout(function () { controller.abort(); }, UPLOAD_PROGRESS_FETCH_TIMEOUT_MS);
    fetch(url + '/' + uploadId, { headers: { Accept: 'application/json' }, signal: controller.signal })
      .then(function (res) { return res.ok ? res.json() : null; })
      .catch(function () { return null; })
      .then(function (state) {
        clearTimeout(deadline);
        if (stopped) return;
        var shown = describeProcessing(state, fallbackText);
        showUploadProgress(progress, shown.percent, shown.text);
        timer = setTimeout(tick, UPLOAD_PROGRESS_POLL_MS);
      });
  }
  tick();
  return function () {
    stopped = true;
    clearTimeout(timer);
  };
}

/**
 * Works out where to send the browser once an upload request has finished. XHR follows the
 * server's redirect (success/error → `fallbackPath?…`), and `responseURL` is where it ended
 * up; a response that didn't redirect, or a non-OK one (e.g. 403 CSRF, 500), keeps the POST-only
 * upload route's URL, so it can't be navigated to.
 * @param {XMLHttpRequest} xhr - The finished upload request.
 * @param {HTMLFormElement} form - The upload form (its `action` is the upload route).
 * @param {string} fallbackPath - The page to return to without a redirect to follow.
 * @returns {string} The URL to navigate to.
 */
function uploadDestination(xhr, form, fallbackPath) {
  var ok = xhr.status >= 200 && xhr.status < 300;
  if (ok && xhr.responseURL && xhr.responseURL !== form.action) return xhr.responseURL;
  return ok ? fallbackPath : fallbackPath + '?error=upload_failed';
}

/**
 * Sends one upload form with XHR (which, unlike fetch, reports upload progress): the CSRF token
 * goes in `X-CSRF-Token` and a fresh ID in `X-Upload-Id`. The form's progress display, if it has
 * one, shows the upload percentage and then, while the server processes the file, either the
 * form's `data-processing-label` or what its `data-progress-url` endpoint reports. When the
 * request finishes the browser navigates to the page the server redirected to.
 * @param {HTMLFormElement} form - The upload form.
 * @param {string} fallbackPath - Page to return to on success without a redirect, or on failure
 *   (with `?error=upload_failed` appended).
 * @returns {void}
 */
function submitUploadForm(form, fallbackPath) {
  var token = (document.body && document.body.dataset.csrfToken) || '';
  var uploadId = newUploadId();
  var progress = findUploadProgress(form);
  var stopPolling = function () {};
  var xhr = new XMLHttpRequest();
  xhr.open('POST', form.action);
  xhr.setRequestHeader('X-CSRF-Token', token);
  xhr.setRequestHeader('X-Upload-Id', uploadId);
  xhr.upload.addEventListener('progress', function (event) {
    if (!event.lengthComputable) return;
    var percent = Math.floor((event.loaded / event.total) * 100);
    showUploadProgress(progress, percent, 'Uploading… ' + percent + '%');
  });
  xhr.upload.addEventListener('load', function () {
    nameUploadProgress(progress, 'Processing progress');
    showUploadProgress(progress, null, form.dataset.processingLabel || 'Processing…');
    stopPolling = pollProcessingProgress(form, uploadId, progress);
  });
  xhr.addEventListener('load', function () { window.location.assign(uploadDestination(xhr, form, fallbackPath)); });
  xhr.addEventListener('error', function () { window.location.assign(fallbackPath + '?error=upload_failed'); });
  xhr.addEventListener('loadend', function () {
    stopPolling();
    delete form.dataset.submitting;
  });
  nameUploadProgress(progress, 'Upload progress');
  showUploadProgress(progress, 0, 'Uploading… 0%');
  xhr.send(new FormData(form));
}

/**
 * Registers a global 'submit' listener that intercepts forms carrying `formClassName` and sends
 * them with {@link submitUploadForm} instead of the page's normal multipart POST, so the session
 * token is never placed in the URL (browser history/Referer). csrfProtection validates the
 * header before Multer parses the multipart body. A second submit (Enter key, double-click)
 * while the first is still pending is ignored. Shared by every file-upload admin page (SFX
 * sounds, overlay videos, alert images/sounds).
 * @param {string} formClassName - CSS class marking a form as one this handler should intercept.
 * @param {string} fallbackPath - Path to navigate to on success if the response wasn't a
 *   redirect, or on a network failure (with `?error=upload_failed` appended).
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
    var submitBtn = form.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.disabled = true;
    submitUploadForm(form, fallbackPath);
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
