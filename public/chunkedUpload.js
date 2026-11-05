/* global findUploadProgress, nameUploadProgress, showUploadProgress, pollProcessingProgress, newUploadId */
// Chunked, resumable uploads for every web panel upload form (issue #912): registerUploadFormHandler
// in utils.js hands each upload form to submitChunkedUpload, which sends the chosen file in pieces
// to the routes `src/web/routes/chunkedUploadRoutes.ts` mounts under the form's `action`.

/** Attempts at sending one piece before the upload gives up (a dropped connection is retried). */
var CHUNK_SEND_ATTEMPTS = 6;

/** Piece size; matches the server's `CHUNK_MAX_BYTES` (8 MB). */
var CHUNK_PIECE_BYTES = 8 * 1024 * 1024;

/**
 * Smallest piece the page falls back to: each failed piece halves the piece size down to this, so
 * a slow connection still gets a piece through within the server's 5-minute request timeout.
 */
var CHUNK_MIN_PIECE_BYTES = 512 * 1024;

/** Bytes hashed from each end of a file to tell it apart from another with the same name, size and date. */
var FINGERPRINT_SAMPLE_BYTES = 64 * 1024;

/** Wait before the first retry of a failed piece, doubled for each further one. */
var CHUNK_RETRY_BASE_MS = 1000;

/**
 * Error raised when the server refuses a chunked-upload step, carrying where to send the browser.
 * @param {string} destination - The URL to navigate to.
 * @returns {void}
 */
function ChunkedUploadStop(destination) {
  this.destination = destination;
}

/**
 * Resolves after `ms` milliseconds.
 * @param {number} ms - How long to wait.
 * @returns {Promise<void>} Resolves once the time has passed.
 */
function delay(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

/**
 * Sends one chunked-upload request with the CSRF token, turning a redirect (a page-level guard
 * such as `not_a_streamer`) into a {@link ChunkedUploadStop} for its destination.
 * @param {string} url - Request URL.
 * @param {RequestInit} init - Fetch options; the CSRF and Accept headers are added.
 * @returns {Promise<Response>} The response, unless it redirected.
 */
async function chunkedFetch(url, init) {
  var headers = Object.assign({ 'X-CSRF-Token': (document.body && document.body.dataset.csrfToken) || '', Accept: 'application/json' }, init.headers || {});
  var res = await fetch(url, Object.assign({}, init, { headers: headers, credentials: 'same-origin' }));
  if (res.redirected) throw new ChunkedUploadStop(res.url);
  return res;
}

/**
 * Reads a refused response's error code.
 * @param {Response} res - The non-OK response.
 * @returns {Promise<{error: string, received?: number, activeId?: string}>} Its JSON body, or
 *   `upload_failed` when it has none.
 */
async function chunkedError(res) {
  try {
    var body = await res.json();
    if (body && typeof body.error === 'string') return body;
  } catch {
    // Not JSON (e.g. a proxy's error page): reported as a plain failure below.
  }
  return { error: 'upload_failed' };
}

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

/**
 * Starts (or resumes) the chunked upload of `file`. When the user has a different unfinished
 * upload here, offers once to cancel it and start this one instead.
 * @param {string} base - The form's upload path (its `action`).
 * @param {File} file - The chosen file.
 * @param {string} fallbackPath - Page to return to with an error.
 * @param {boolean} [retried] - True on the start after cancelling another upload (no second offer).
 * @returns {Promise<string>} The upload ID.
 */
async function startChunkedUpload(base, file, fallbackPath, retried) {
  var fingerprint = await fileFingerprint(file);
  var res = await chunkedFetch(base + '/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: file.name, size: file.size, type: file.type }),
  });
  if (res.ok) {
    var id = (await res.json()).id;
    rememberChunkedUpload(base, { id: id, name: file.name, size: file.size, lastModified: file.lastModified, fingerprint: fingerprint });
    return id;
  }
  var failure = await chunkedError(res);
  var running = failure.error === 'upload_busy' && failure.activeId && !retried
    ? await handleRunningUpload(base, file, { activeId: failure.activeId, fingerprint: fingerprint })
    : null;
  if (running === '') return startChunkedUpload(base, file, fallbackPath, true);
  if (running) return running;
  throw new ChunkedUploadStop(fallbackPath + '?error=' + encodeURIComponent(failure.error));
}

/**
 * Asks the server how many bytes of an upload it holds.
 * @param {string} base - The form's upload path (its `action`).
 * @param {string} id - The upload ID.
 * @returns {Promise<number|null>} The confirmed offset, or null if it couldn't be read.
 */
async function confirmedOffset(base, id) {
  try {
    var res = await chunkedFetch(base + '/' + id, { method: 'GET' });
    return res.ok ? (await res.json()).received : null;
  } catch (err) {
    if (err instanceof ChunkedUploadStop) throw err;
    return null;
  }
}

/**
 * Sends the piece of `file` starting at `offset`.
 * @param {string} base - The form's upload path (its `action`).
 * @param {string} id - The upload ID.
 * @param {File} file - The chosen file.
 * @param {{offset: number, size: number}} piece - Where the piece starts and its largest size.
 * @returns {Promise<{received?: number, error?: string}>} The server's answer, or `{}` when
 *   the request failed outright (a dropped connection) or with a server error, to be retried.
 */
async function sendPiece(base, id, file, piece) {
  try {
    var res = await chunkedFetch(base + '/' + id + '/chunk?offset=' + piece.offset, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file.slice(piece.offset, piece.offset + piece.size),
    });
    if (res.ok) return await res.json();
    return res.status >= 500 ? {} : await chunkedError(res);
  } catch (err) {
    if (err instanceof ChunkedUploadStop) throw err;
    return {};
  }
}

/**
 * Sends the next piece, retrying a dropped one with backoff (and, from then on, smaller pieces,
 * down to {@link CHUNK_MIN_PIECE_BYTES}) and resuming from the server's confirmed offset; a
 * piece the server refuses for any other reason ends the upload.
 * @param {{base: string, id: string, file: File, chunkSize: number, fallbackPath: string}} upload - The upload.
 * @param {number} offset - Where the next piece starts.
 * @returns {Promise<number>} The confirmed offset after the piece.
 */
async function sendNextPiece(upload, offset) {
  for (var attempt = 0; attempt < CHUNK_SEND_ATTEMPTS; attempt++) {
    var answer = await sendPiece(upload.base, upload.id, upload.file, { offset: offset, size: upload.chunkSize });
    if (typeof answer.received === 'number') return answer.received;
    if (answer.error && answer.error !== 'bad_offset') {
      var code = answer.error === 'not_found' ? 'upload_expired' : answer.error;
      throw new ChunkedUploadStop(upload.fallbackPath + '?error=' + encodeURIComponent(code));
    }
    if (!answer.error) upload.chunkSize = Math.max(CHUNK_MIN_PIECE_BYTES, Math.floor(upload.chunkSize / 2));
    await delay(CHUNK_RETRY_BASE_MS * Math.pow(2, attempt));
    var confirmed = await confirmedOffset(upload.base, upload.id);
    if (confirmed !== null && confirmed !== offset) return confirmed;
  }
  throw new ChunkedUploadStop(upload.fallbackPath + '?error=upload_failed');
}

/**
 * Sends a file piece by piece from the server's confirmed offset, updating the progress display.
 * @param {{base: string, id: string, file: File, chunkSize: number, fallbackPath: string}} upload - The upload.
 * @param {{box: HTMLElement, bar: HTMLProgressElement|null, label: HTMLElement|null}|null} progress - The display.
 * @returns {Promise<void>} Resolves once every byte is confirmed.
 */
async function sendAllPieces(upload, progress) {
  var offset = (await confirmedOffset(upload.base, upload.id)) || 0;
  while (offset < upload.file.size) {
    var percent = Math.floor((offset / upload.file.size) * 100);
    showUploadProgress(progress, percent, 'Uploading… ' + percent + '%');
    offset = await sendNextPiece(upload, offset);
  }
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
 * @returns {Promise<string>} The page the server redirected to.
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
    if (res.redirected) return res.url;
    // A response that didn't redirect is an error page (e.g. a 403 CSRF or 500) unless it's OK.
    if (!res.ok) throw new Error('Upload completion failed with HTTP ' + res.status);
    return null;
  } finally {
    stopPolling();
  }
}

/**
 * Sends one upload form as a chunked, resumable upload to the routes under its `action`: starts it (or
 * resumes this browser's upload of the same file), sends the file in pieces (re-sending a
 * dropped piece from the server's confirmed offset), then completes it with the form's other
 * fields and navigates to the page the server redirected to.
 * @param {HTMLFormElement} form - The upload form.
 * @param {string} fallbackPath - Page to return to without a redirect, or with an error.
 * @returns {Promise<void>} Resolves once the browser has been sent on.
 */
async function submitChunkedUpload(form, fallbackPath) {
  var base = form.getAttribute('action');
  var input = form.querySelector('input[type="file"]');
  var file = input && input.files && input.files[0];
  var progress = findUploadProgress(form);
  var destination = fallbackPath + '?error=invalid_file';
  try {
    if (file) {
      nameUploadProgress(progress, 'Upload progress');
      showUploadProgress(progress, 0, 'Uploading… 0%');
      var id = await startChunkedUpload(base, file, fallbackPath);
      await sendAllPieces({ base: base, id: id, file: file, chunkSize: CHUNK_PIECE_BYTES, fallbackPath: fallbackPath }, progress);
      destination = (await completeChunkedUpload(form, base, id, progress)) || fallbackPath;
      // Only now: a completion that never reached the server leaves the upload resumable.
      rememberChunkedUpload(base, null);
    }
  } catch (err) {
    destination = err instanceof ChunkedUploadStop ? err.destination : fallbackPath + '?error=upload_failed';
  }
  delete form.dataset.submitting;
  window.location.assign(destination);
}
