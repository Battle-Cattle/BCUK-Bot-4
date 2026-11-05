/* global chunkedFetch, ChunkedUploadStop */
// Resuming and replacing unfinished chunked uploads (see chunkedUpload.js): the page remembers
// each upload it starts, with a fingerprint of the file, so after a reload the same file resumes,
// and a different file can cancel the unfinished upload instead of waiting for it to expire.

/** Bytes hashed from each end of a file to tell it apart from another with the same name, size and date. */
var FINGERPRINT_SAMPLE_BYTES = 64 * 1024;

/**
 * The localStorage key remembering a page's upload in progress, so a reload can resume it.
 * @param {string} base - The form's upload path (its `action`).
 * @returns {string} The key.
 */
function chunkedResumeKey(base) {
  return 'chunkedUpload:' + base;
}

/**
 * Remembers (or, with null, forgets) the upload in progress for this form; storage failures
 * (private windows, blocked storage) are ignored, since resuming is only a convenience.
 * @param {string} base - The form's upload path (its `action`).
 * @param {{id: string, name: string, size: number, lastModified: number}|null} record - What to remember.
 * @returns {void}
 */
function rememberChunkedUpload(base, record) {
  try {
    if (record) window.localStorage.setItem(chunkedResumeKey(base), JSON.stringify(record));
    else window.localStorage.removeItem(chunkedResumeKey(base));
  } catch {
    // Storage unavailable: a reload just can't resume.
  }
}

/**
 * A SHA-256 of the first and last {@link FINGERPRINT_SAMPLE_BYTES} of `file`, so a resume can tell
 * the file it started apart from a different one with the same name, size and date.
 * @param {File} file - The chosen file.
 * @returns {Promise<string|null>} The hex digest, or null where the browser can't hash
 *   (no `crypto.subtle` outside a secure context), in which case nothing is resumed.
 */
async function fileFingerprint(file) {
  try {
    var head = new Uint8Array(await file.slice(0, FINGERPRINT_SAMPLE_BYTES).arrayBuffer());
    var tail = new Uint8Array(await file.slice(Math.max(0, file.size - FINGERPRINT_SAMPLE_BYTES)).arrayBuffer());
    var joined = new Uint8Array(head.length + tail.length);
    joined.set(head, 0);
    joined.set(tail, head.length);
    var digest = new Uint8Array(await window.crypto.subtle.digest('SHA-256', joined));
    return Array.prototype.map.call(digest, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  } catch {
    return null;
  }
}

/**
 * True if a remembered upload was of `file`: same name, size, modification time and fingerprint.
 * @param {{name: string, size: number, lastModified: number, fingerprint: string}} saved - The remembered upload.
 * @param {File} file - The chosen file.
 * @param {string|null} fingerprint - The chosen file's {@link fileFingerprint}.
 * @returns {boolean} Whether they match.
 */
function isSameFile(saved, file, fingerprint) {
  var sameDetails = saved.name === file.name && saved.size === file.size && saved.lastModified === file.lastModified;
  return sameDetails && fingerprint !== null && saved.fingerprint === fingerprint;
}

/**
 * The upload ID to resume for `file`, if the server's running upload is one this browser
 * started for the same file.
 * @param {string} base - The form's upload path (its `action`).
 * @param {File} file - The chosen file.
 * @param {{activeId: string, fingerprint: string|null}} running - The user's running upload, as
 *   the server reported it, and the chosen file's fingerprint.
 * @returns {string|null} `activeId` when it's this file's, otherwise null.
 */
function resumableUploadId(base, file, running) {
  try {
    var saved = JSON.parse(window.localStorage.getItem(chunkedResumeKey(base)) || 'null');
    return saved && saved.id === running.activeId && isSameFile(saved, file, running.fingerprint) ? running.activeId : null;
  } catch {
    return null;
  }
}

/**
 * Cancels the user's unfinished upload so a different file can start.
 * @param {string} base - The form's upload path (its `action`).
 * @param {string} id - The unfinished upload's ID.
 * @returns {Promise<boolean>} True once it's gone (already gone counts too).
 */
async function cancelChunkedUpload(base, id) {
  try {
    var res = await chunkedFetch(base + '/' + id, { method: 'DELETE' });
    return res.ok || res.status === 404;
  } catch (err) {
    if (err instanceof ChunkedUploadStop) throw err;
    return false;
  }
}

/**
 * Deals with the user's other unfinished upload in this area: resumes it when it's this browser's
 * upload of the same file, otherwise offers to cancel it.
 * @param {string} base - The form's upload path (its `action`).
 * @param {File} file - The chosen file.
 * @param {{activeId: string, fingerprint: string|null}} running - The running upload and the chosen file's fingerprint.
 * @returns {Promise<string|null>} The ID to resume; or `''` once the other upload was cancelled
 *   (start again); or null to give up with `upload_busy`.
 */
async function handleRunningUpload(base, file, running) {
  var resumeId = resumableUploadId(base, file, running);
  if (resumeId) return resumeId;
  var replace = window.confirm('An earlier upload here has not finished. Cancel it and upload this file instead?');
  return replace && (await cancelChunkedUpload(base, running.activeId)) ? '' : null;
}
