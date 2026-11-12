/**
 * When a failed shared video download is tried again (#917): each failure waits twice as long as
 * the last, up to a cap, and the video goes to the back of the queue so later videos carry on at
 * once. Plain functions over the syncer's state (see createSharedSyncer in shared-overlay-sync.js).
 */

/** How long to wait before trying again after a first failed download. */
const SHARED_SYNC_RETRY_MS = 10000;
/** A failed download is retried with a doubling wait, capped here, for as long as the video stays on the list. */
const SHARED_SYNC_MAX_RETRY_MS = 300000;
/** While every queued video is waiting to be retried, the drain sleeps at most this long at a time, so a new list or push is noticed. */
const SHARED_SYNC_WAIT_POLL_MS = 1000;

/**
 * Handles a failed download: logs it and schedules a retry after a wait that doubles with each
 * failure up to a cap. The video goes to the back of the queue, so later videos carry on at once
 * rather than waiting out the delay; it is retried for as long as it stays on the list.
 * @param {object} s - The syncer's state.
 * @param {{url: string}} entry - The video that failed.
 * @param {*} err - What went wrong.
 * @returns {void}
 */
function handleSyncFailure(s, entry, err) {
  if (s.deps.log) s.deps.log('Shared video download failed: ' + entry.url, err);
  if (!s.wanted.has(entry.url)) { forgetSyncRetry(s, entry.url); return; }
  const attempts = (s.failures.get(entry.url) || 0) + 1;
  s.failures.set(entry.url, attempts);
  s.retryAt.set(entry.url, s.now() + Math.min(SHARED_SYNC_RETRY_MS * Math.pow(2, attempts - 1), SHARED_SYNC_MAX_RETRY_MS));
  if (!s.queue.some(function (q) { return q.url === entry.url; })) s.queue.push(entry);
}

/**
 * Clears a video's retry state (its failure count and retry time).
 * @param {object} s - The syncer's state.
 * @param {string} url - The video's URL path.
 * @returns {void}
 */
function forgetSyncRetry(s, url) {
  s.failures.delete(url);
  s.retryAt.delete(url);
}

/**
 * Takes the first queued video that is not waiting to be retried.
 * @param {object} s - The syncer's state.
 * @returns {{url: string}|null} The video, removed from the queue, or null when all are waiting.
 */
function takeReadyEntry(s) {
  const now = s.now();
  const i = s.queue.findIndex(function (e) { return (s.retryAt.get(e.url) || 0) <= now; });
  return i === -1 ? null : s.queue.splice(i, 1)[0];
}

/**
 * How long to sleep while every queued video is waiting to be retried: until the soonest one is
 * due, but never longer than the poll interval, so a new list or push is noticed promptly.
 * @param {object} s - The syncer's state.
 * @returns {number} Milliseconds to sleep (at least 1).
 */
function msUntilNextRetry(s) {
  const now = s.now();
  const waits = s.queue.map(function (e) { return (s.retryAt.get(e.url) || 0) - now; });
  return Math.min(SHARED_SYNC_WAIT_POLL_MS, Math.max(1, Math.min.apply(null, waits)));
}
