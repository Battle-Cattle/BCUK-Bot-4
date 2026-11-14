/* global sendPiece */
// Keeps a chunked upload (chunkedUpload.js) within the server's limits: pieces shrink after a
// failure so a slow connection gets one through within the 5-minute request timeout, but never so
// small that a large file needs more requests than the session's request limit allows, and a 429
// from that limit is waited out rather than failing the upload.

/** Smallest piece the page ever sends (a failed piece halves the piece size down to this). */
var CHUNK_MIN_PIECE_BYTES = 512 * 1024;

/**
 * Most pieces one file is split into, however often pieces fail. The panel's session limit is
 * 600 requests per 15 minutes; this leaves room for the upload's own status checks and retries
 * and for the rest of the page.
 */
var MAX_PIECE_REQUESTS = 300;

/** Times one piece waits out the session's request limit before the upload gives up. */
var MAX_RATE_LIMIT_WAITS = 3;

/** Wait after a 429 that names no `Retry-After`. */
var DEFAULT_RETRY_AFTER_MS = 60 * 1000;

/** Longest single wait after a 429: the session limit's whole window. */
var MAX_RETRY_AFTER_MS = 15 * 60 * 1000;

/**
 * The smallest piece a file of `fileSize` bytes is sent in: {@link CHUNK_MIN_PIECE_BYTES}, or
 * larger when needed to keep the file within {@link MAX_PIECE_REQUESTS} pieces.
 * @param {number} fileSize - The file's size in bytes.
 * @returns {number} The smallest piece size in bytes.
 */
function smallestPiece(fileSize) {
  return Math.max(CHUNK_MIN_PIECE_BYTES, Math.ceil(fileSize / MAX_PIECE_REQUESTS));
}

/**
 * The piece size to use after a piece failed: half the current one, but never below
 * {@link smallestPiece} for this file.
 * @param {number} current - The piece size that failed.
 * @param {number} fileSize - The file's size in bytes.
 * @returns {number} The next piece size in bytes.
 */
function smallerPiece(current, fileSize) {
  return Math.max(smallestPiece(fileSize), Math.floor(current / 2));
}

/**
 * How long to wait after the session's request limit answered 429: its `Retry-After` seconds,
 * kept within {@link MAX_RETRY_AFTER_MS}, or {@link DEFAULT_RETRY_AFTER_MS} when it names none.
 * @param {{headers: {get: function(string): (string|null)}}} res - The 429 response.
 * @returns {number} Milliseconds to wait.
 */
function rateLimitWaitMs(res) {
  var seconds = Number(res.headers && res.headers.get ? res.headers.get('Retry-After') : NaN);
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_RETRY_AFTER_MS;
  return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
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
 * Sends a piece, waiting out the session's request limit (a 429 says how long) up to
 * {@link MAX_RATE_LIMIT_WAITS} times instead of failing the upload.
 * @param {{base: string, id: string, file: File, onSent?: function(number): void}} upload - The
 *   upload; `onSent` is told how far into the file each attempt has got, and is set back to the
 *   piece's start while a 429 is waited out.
 * @param {{offset: number, size: number}} piece - Where the piece starts and its largest size.
 * @returns {Promise<{received?: number, error?: string}>} As {@link sendPiece}, with a limit
 *   that never lifts reported as `upload_failed`.
 */
async function sendPacedPiece(upload, piece) {
  for (var waits = 0; ; waits++) {
    var answer = await sendPiece(upload.base, upload.id, upload.file, piece, upload.onSent);
    if (!answer.retryAfterMs) return answer;
    // The refused piece wasn't stored: show only what the server holds while waiting.
    if (upload.onSent) upload.onSent(piece.offset);
    if (waits >= MAX_RATE_LIMIT_WAITS) return { error: 'upload_failed' };
    await delay(answer.retryAfterMs);
  }
}
