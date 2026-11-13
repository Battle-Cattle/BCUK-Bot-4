/* global findUploadProgress, nameUploadProgress, showUploadProgress, pollProcessingProgress, newUploadId */
/* global fileFingerprint, rememberChunkedUpload, handleRunningUpload, errorOutcome, outcomeFromUrl, outcomePath */
/* global smallerPiece, rateLimitWaitMs, delay, sendPacedPiece, completeChunkedUpload */
// Chunked, resumable uploads for every web panel upload form (issue #912): registerUploadFormHandler
// in utils.js hands each upload form to submitChunkedUpload, which sends the chosen file in pieces
// to the routes `src/web/routes/chunkedUploadRoutes.ts` mounts under the form's `action`.

/** Attempts at sending one piece before the upload gives up (a dropped connection is retried). */
var CHUNK_SEND_ATTEMPTS = 6;

/** Piece size; matches the server's `CHUNK_MAX_BYTES` (8 MB). */
var CHUNK_PIECE_BYTES = 8 * 1024 * 1024;

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
 * Headers every chunked-upload request carries: the page's CSRF token, and a JSON Accept so the
 * routes answer with JSON rather than a page.
 * @returns {{'X-CSRF-Token': string, Accept: string}} The headers.
 */
function chunkedHeaders() {
  return { 'X-CSRF-Token': (document.body && document.body.dataset.csrfToken) || '', Accept: 'application/json' };
}

/**
 * Sends one chunked-upload request with the CSRF token, turning a redirect (a page-level guard
 * such as `not_a_streamer`) into a {@link ChunkedUploadStop} with the outcome it carries.
 * @param {string} url - Request URL.
 * @param {RequestInit} init - Fetch options; the CSRF and Accept headers are added.
 * @returns {Promise<Response>} The response, unless it redirected.
 */
async function chunkedFetch(url, init) {
  var headers = Object.assign(chunkedHeaders(), init.headers || {});
  var res = await fetch(url, Object.assign({}, init, { headers: headers, credentials: 'same-origin' }));
  if (res.redirected) throw new ChunkedUploadStop(outcomeFromUrl(res.url));
  return res;
}

/**
 * The parts of a fetch `Response` the piece sender reads, for a finished XMLHttpRequest.
 * @param {XMLHttpRequest} xhr - The finished request.
 * @returns {{ok: boolean, status: number, headers: {get: function(string): (string|null)}, json: function(): Promise<unknown>}}
 *   Its status, headers and JSON body (`json` rejects on a body that isn't JSON).
 */
function xhrResponse(xhr) {
  return {
    ok: xhr.status >= 200 && xhr.status < 300,
    status: xhr.status,
    headers: { get: function (name) { return xhr.getResponseHeader(name); } },
    json: async function () { return JSON.parse(xhr.responseText); },
  };
}

/**
 * PUTs one piece with XMLHttpRequest rather than fetch, which reports no upload progress, so the
 * bar can move while a piece is on its way. Same headers and redirect handling as {@link chunkedFetch}.
 * @param {string} url - The piece's URL.
 * @param {Blob} body - The piece.
 * @param {function(number): void} onSent - Called with the bytes of this piece sent so far.
 * @returns {Promise<ReturnType<typeof xhrResponse>>} The answer; rejects when the request fails
 *   outright (a dropped connection), or with a {@link ChunkedUploadStop} when it redirected.
 */
function putPiece(url, body, onSent) {
  return new Promise(function (resolve, reject) {
    var xhr = new XMLHttpRequest();
    var requested = new URL(url, window.location.href).href;
    xhr.open('PUT', url);
    var headers = Object.assign(chunkedHeaders(), { 'Content-Type': 'application/octet-stream' });
    Object.keys(headers).forEach(function (name) { xhr.setRequestHeader(name, headers[name]); });
    xhr.upload.addEventListener('progress', function (event) { onSent(event.loaded); });
    xhr.addEventListener('load', function () {
      if (xhr.responseURL && xhr.responseURL !== requested) reject(new ChunkedUploadStop(outcomeFromUrl(xhr.responseURL)));
      else resolve(xhrResponse(xhr));
    });
    ['error', 'abort', 'timeout'].forEach(function (type) {
      xhr.addEventListener(type, function () { reject(new Error('Piece request ' + type)); });
    });
    xhr.send(body);
  });
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
 * @param {function(number): void} [onSent] - Called as the piece goes out with how far into the
 *   file it has got (a display hint only: the server's answer is what counts).
 * @returns {Promise<{received?: number, error?: string, retryAfterMs?: number}>} The server's
 *   answer; `{}` when the request failed outright (a dropped connection) or with a server error,
 *   to be retried; or how long to wait when the session's request limit was reached (429).
 */
async function sendPiece(base, id, file, piece, onSent) {
  try {
    var res = await putPiece(
      base + '/' + id + '/chunk?offset=' + piece.offset,
      file.slice(piece.offset, piece.offset + piece.size),
      function (loaded) { if (onSent) onSent(piece.offset + loaded); },
    );
    if (res.ok) return await res.json();
    if (res.status === 429) return { retryAfterMs: rateLimitWaitMs(res) };
    return res.status >= 500 ? {} : await chunkedError(res);
  } catch (err) {
    if (err instanceof ChunkedUploadStop) throw err;
    return {};
  }
}

/**
 * Sends the next piece, retrying a dropped one with backoff (and, from then on, smaller pieces,
 * down to `smallestPiece` in chunkedUploadPacing.js) and resuming from the server's confirmed offset; a
 * piece the server refuses for any other reason ends the upload.
 * @param {{base: string, id: string, file: File, chunkSize: number, onSent?: function(number): void}} upload - The upload.
 * @param {number} offset - Where the next piece starts.
 * @returns {Promise<number>} The confirmed offset after the piece.
 */
async function sendNextPiece(upload, offset) {
  for (var attempt = 0; attempt < CHUNK_SEND_ATTEMPTS; attempt++) {
    var answer = await sendPacedPiece(upload, { offset: offset, size: upload.chunkSize });
    if (typeof answer.received === 'number') return answer.received;
    // The bar shows only what the server holds while this piece is retried.
    if (upload.onSent) upload.onSent(offset);
    if (answer.error && answer.error !== 'bad_offset') {
      var code = answer.error === 'not_found' ? 'upload_expired' : answer.error;
      throw new ChunkedUploadStop(errorOutcome(code));
    }
    if (!answer.error) upload.chunkSize = smallerPiece(upload.chunkSize, upload.file.size);
    await delay(CHUNK_RETRY_BASE_MS * Math.pow(2, attempt));
    var confirmed = await confirmedOffset(upload.base, upload.id);
    if (confirmed !== null && confirmed !== offset) return confirmed;
  }
  throw new ChunkedUploadStop(errorOutcome('upload_failed'));
}

/**
 * Returns a function showing how much of a file has been sent, as "Uploading… N%".
 * @param {{box: HTMLElement, bar: HTMLProgressElement|null, label: HTMLElement|null}|null} progress - The display.
 * @param {number} size - The file's size in bytes.
 * @returns {function(number): void} Shows `bytes` sent of `size`, touching the display only when
 *   the whole-number percentage changes.
 */
function uploadedBytesDisplay(progress, size) {
  var shown = -1;
  return function (bytes) {
    var percent = size > 0 ? Math.floor((Math.min(bytes, size) / size) * 100) : 100;
    if (percent === shown) return;
    shown = percent;
    showUploadProgress(progress, percent, 'Uploading… ' + percent + '%');
  };
}

/**
 * Sends a file piece by piece from the server's confirmed offset, updating the progress display
 * as each piece goes out (dropping back to the confirmed offset when one fails) and showing 100%
 * once every byte is confirmed.
 * @param {{base: string, id: string, file: File, chunkSize: number}} upload - The upload.
 * @param {{box: HTMLElement, bar: HTMLProgressElement|null, label: HTMLElement|null}|null} progress - The display.
 * @returns {Promise<void>} Resolves once every byte is confirmed.
 */
async function sendAllPieces(upload, progress) {
  var show = uploadedBytesDisplay(progress, upload.file.size);
  upload.onSent = show;
  var offset = (await confirmedOffset(upload.base, upload.id)) || 0;
  while (offset < upload.file.size) {
    show(offset);
    offset = await sendNextPiece(upload, offset);
  }
  show(upload.file.size);
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
