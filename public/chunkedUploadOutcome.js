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
