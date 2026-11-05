/* global nameUploadProgress, showUploadProgress, pollProcessingProgress, newUploadId */
// What a chunked upload (chunkedUpload.js) shows when it ends: the browser always returns to the
// upload page itself with a `?success=` or `?error=` code, rebuilt from a checked code rather than
// any URL the upload passed through.

/** An outcome code the page will put in its URL: lowercase letters, digits and underscores. */
var OUTCOME_CODE_RE = /^[a-z0-9_]{1,64}$/;

/**
 * An error outcome for the upload page.
 * @param {string} code - The error code.
 * @returns {{key: string, code: string}} The outcome.
 */
function errorOutcome(code) {
  return { key: 'error', code: code };
}

/**
 * The outcome a server redirect carries in its `success` or `error` query parameter. The page
 * only ever returns to its own upload page, so nothing else of the redirect's URL is used.
 * @param {string} url - Where the redirect ended up.
 * @returns {{key: string, code: string}|null} Its outcome, or null when it carries none.
 */
function outcomeFromUrl(url) {
  try {
    var params = new URL(url, window.location.href).searchParams;
    if (params.has('success')) return { key: 'success', code: params.get('success') };
    if (params.has('error')) return errorOutcome(params.get('error'));
  } catch {
    // Not a URL at all: no outcome.
  }
  return null;
}

/**
 * The upload page's URL showing `outcome`: always the page's own path, with a `success` or
 * `error` code that's checked against {@link OUTCOME_CODE_RE} (anything else shows `upload_failed`).
 * @param {string} fallbackPath - The upload page's own path.
 * @param {{key: string, code: string}|null} outcome - What to show, or null for nothing.
 * @returns {string} The path to navigate to.
 */
function outcomePath(fallbackPath, outcome) {
  if (!outcome) return fallbackPath;
  var key = outcome.key === 'success' ? 'success' : 'error';
  var code = String(outcome.code);
  if (!OUTCOME_CODE_RE.test(code)) return fallbackPath + '?error=upload_failed';
  return fallbackPath + '?' + key + '=' + code;
}

/**
 * The form's fields other than its files, for the complete request.
 * @param {HTMLFormElement} form - The upload form.
 * @returns {URLSearchParams} The fields.
 */
function nonFileFields(form) {
  var fields = new URLSearchParams();
  new FormData(form).forEach(function (value, key) {
    if (typeof value === 'string') fields.append(key, value);
  });
  return fields;
}

/**
 * Completes the upload with the form's other fields, polling processing progress meanwhile.
 * @param {HTMLFormElement} form - The upload form.
 * @param {string} base - The form's upload path (its `action`).
 * @param {string} id - The upload ID.
 * @param {{box: HTMLElement, bar: HTMLProgressElement|null, label: HTMLElement|null}|null} progress - The display.
 * @returns {Promise<{key: string, code: string}|null>} The outcome the server's redirect carries
 *   (null when it didn't redirect or carries none).
 */
async function completeChunkedUpload(form, base, id, progress) {
  var progressId = newUploadId();
  nameUploadProgress(progress, 'Processing progress');
  showUploadProgress(progress, null, form.dataset.processingLabel || 'Processing…');
  var stopPolling = pollProcessingProgress(form, progressId, progress);
  try {
    var res = await fetch(base + '/' + id + '/complete', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'X-CSRF-Token': (document.body && document.body.dataset.csrfToken) || '', 'X-Upload-Id': progressId },
      body: nonFileFields(form),
    });
    if (res.redirected) return outcomeFromUrl(res.url);
    // A response that didn't redirect is an error page (e.g. a 403 CSRF or 500) unless it's OK.
    if (!res.ok) throw new Error('Upload completion failed with HTTP ' + res.status);
    return null;
  } finally {
    stopPolling();
  }
}
