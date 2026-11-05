/* global findUploadProgress, nameUploadProgress, showUploadProgress, pollProcessingProgress, newUploadId */
/* global fileFingerprint, rememberChunkedUpload, handleRunningUpload, errorOutcome, outcomeFromUrl, outcomePath */
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

/** Wait before the first retry of a failed piece, doubled for each further one. */
var CHUNK_RETRY_BASE_MS = 1000;

/**
 * Error raised when the server refuses a chunked-upload step, carrying the outcome to show.
 * @param {{key: string, code: string}|null} outcome - The `success`/`error` code for the upload
 *   page, or null for the page with no message.
 * @returns {void}
 */
function ChunkedUploadStop(outcome) {
  this.outcome = outcome;
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
 * such as `not_a_streamer`) into a {@link ChunkedUploadStop} with the outcome it carries.
 * @param {string} url - Request URL.
 * @param {RequestInit} init - Fetch options; the CSRF and Accept headers are added.
 * @returns {Promise<Response>} The response, unless it redirected.
 */
async function chunkedFetch(url, init) {
  var headers = Object.assign({ 'X-CSRF-Token': (document.body && document.body.dataset.csrfToken) || '', Accept: 'application/json' }, init.headers || {});
  var res = await fetch(url, Object.assign({}, init, { headers: headers, credentials: 'same-origin' }));
  if (res.redirected) throw new ChunkedUploadStop(outcomeFromUrl(res.url));
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
 * Starts (or resumes) the chunked upload of `file`. When the user has a different unfinished
 * upload here, offers once to cancel it and start this one instead.
 * @param {string} base - The form's upload path (its `action`).
 * @param {File} file - The chosen file.
 * @param {boolean} [retried] - True on the start after cancelling another upload (no second offer).
 * @returns {Promise<string>} The upload ID.
 */
async function startChunkedUpload(base, file, retried) {
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
  if (running === '') return startChunkedUpload(base, file, true);
  if (running) return running;
  throw new ChunkedUploadStop(errorOutcome(failure.error));
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
 * @param {{base: string, id: string, file: File, chunkSize: number}} upload - The upload.
 * @param {number} offset - Where the next piece starts.
 * @returns {Promise<number>} The confirmed offset after the piece.
 */
async function sendNextPiece(upload, offset) {
  for (var attempt = 0; attempt < CHUNK_SEND_ATTEMPTS; attempt++) {
    var answer = await sendPiece(upload.base, upload.id, upload.file, { offset: offset, size: upload.chunkSize });
    if (typeof answer.received === 'number') return answer.received;
    if (answer.error && answer.error !== 'bad_offset') {
      var code = answer.error === 'not_found' ? 'upload_expired' : answer.error;
      throw new ChunkedUploadStop(errorOutcome(code));
    }
    if (!answer.error) upload.chunkSize = Math.max(CHUNK_MIN_PIECE_BYTES, Math.floor(upload.chunkSize / 2));
    await delay(CHUNK_RETRY_BASE_MS * Math.pow(2, attempt));
    var confirmed = await confirmedOffset(upload.base, upload.id);
    if (confirmed !== null && confirmed !== offset) return confirmed;
  }
  throw new ChunkedUploadStop(errorOutcome('upload_failed'));
}

/**
 * Sends a file piece by piece from the server's confirmed offset, updating the progress display.
 * @param {{base: string, id: string, file: File, chunkSize: number}} upload - The upload.
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

/**
 * Sends one upload form as a chunked, resumable upload to the routes under its `action`: starts it (or
 * resumes this browser's upload of the same file), sends the file in pieces (re-sending a
 * dropped piece from the server's confirmed offset), then completes it with the form's other
 * fields and navigates to the page the server redirected to.
 * @param {HTMLFormElement} form - The upload form.
 * @param {string} fallbackPath - The upload page's own path, which the browser returns to with
 *   the upload's outcome.
 * @returns {Promise<void>} Resolves once the browser has been sent on.
 */
async function submitChunkedUpload(form, fallbackPath) {
  var base = form.getAttribute('action');
  var input = form.querySelector('input[type="file"]');
  var file = input && input.files && input.files[0];
  var progress = findUploadProgress(form);
  var outcome = errorOutcome('invalid_file');
  try {
    if (file) {
      nameUploadProgress(progress, 'Upload progress');
      showUploadProgress(progress, 0, 'Uploading… 0%');
      var id = await startChunkedUpload(base, file);
      await sendAllPieces({ base: base, id: id, file: file, chunkSize: CHUNK_PIECE_BYTES }, progress);
      outcome = await completeChunkedUpload(form, base, id, progress);
      // Only now: a completion that never reached the server leaves the upload resumable.
      rememberChunkedUpload(base, null);
    }
  } catch (err) {
    outcome = err instanceof ChunkedUploadStop ? err.outcome : errorOutcome('upload_failed');
  }
  delete form.dataset.submitting;
  window.location.assign(outcomePath(fallbackPath, outcome));
}
