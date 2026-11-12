/**
 * Background sync of shared overlay videos into the overlay's own storage (#917). The queue, diff
 * and resume decisions live here as plain functions over injected storage and fetch layers, so they
 * can be tested outside a browser; shared-overlay-storage.js supplies the real Cache Storage and
 * IndexedDB layers.
 */

/** Bytes requested per range request while storing a video. */
const SHARED_SYNC_CHUNK_BYTES = 2 * 1024 * 1024;
/** Pause between chunks, spreading the load (the server-side speed limit is the hard cap). */
const SHARED_SYNC_CHUNK_PAUSE_MS = 1000;
/** How long to wait before trying again after a failed download, and how often to re-check a pause. */
const SHARED_SYNC_RETRY_MS = 10000;
const SHARED_SYNC_PAUSE_POLL_MS = 500;
/** A failed download is retried with a doubling wait, capped here, for as long as the video stays on the list. */
const SHARED_SYNC_MAX_RETRY_MS = 300000;
/** While every queued video is waiting to be retried, the drain sleeps at most this long at a time, so a new list or push is noticed. */
const SHARED_SYNC_WAIT_POLL_MS = 1000;
/** Longest to wait for the stored copy of a video before streaming it instead. */
const SHARED_SOURCE_LOOKUP_MS = 1500;

/**
 * Works out what a new video list needs: the videos to download (in the list's order, which is
 * newest first, as those are the most likely to be triggered soon) and the stored or half-stored
 * videos that are no longer on the list.
 * @param {Array<{url: string}>} list - The current enabled video list.
 * @param {string[]} storedUrls - URLs of the videos already stored in full.
 * @param {string[]} partialUrls - URLs that have downloaded chunks but are not complete.
 * @returns {{download: Array<{url: string}>, remove: string[]}} Videos to fetch, and URLs to delete.
 */
function planSharedSync(list, storedUrls, partialUrls) {
  const wanted = new Set(list.map(function (v) { return v.url; }));
  const stored = new Set(storedUrls);
  const remove = storedUrls.concat(partialUrls).filter(function (url, i, all) {
    return !wanted.has(url) && all.indexOf(url) === i;
  });
  return { download: list.filter(function (v) { return !stored.has(v.url); }), remove: remove };
}

/**
 * Byte range of the chunk to request next, resuming after the chunks already stored.
 * @param {number} chunkCount - Number of consecutive chunks (from 0) already stored.
 * @param {number} chunkBytes - Size of each chunk in bytes.
 * @returns {{start: number, end: number}} Inclusive byte range of the next chunk.
 */
function nextSharedChunkRange(chunkCount, chunkBytes) {
  return { start: chunkCount * chunkBytes, end: (chunkCount + 1) * chunkBytes - 1 };
}

/**
 * Waits while a shared video is triggered or playing, polling.
 * @param {object} s - The syncer's state (see {@link createSharedSyncer}).
 * @returns {Promise<void>} Resolves once no longer paused.
 */
async function waitWhileSyncPaused(s) {
  while (s.deps.isPaused()) await s.deps.sleep(SHARED_SYNC_PAUSE_POLL_MS);
}

/**
 * Checks a 206 answer covers the bytes asked for and returns the file's total size. A proxy or
 * server that answered a different range, or cut the body short, must not have its bytes stored
 * as if they were the requested chunk.
 * @param {string|null} contentRange - The response's Content-Range header.
 * @param {number} bodyBytes - Length of the response body.
 * @param {number} start - First byte asked for.
 * @param {number} end - Last byte asked for (inclusive; the answer ends at the file's last byte if that comes first).
 * @returns {number} The file's total size in bytes.
 */
function checkedRangeTotal(contentRange, bodyBytes, start, end) {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange || '');
  if (!match) throw new Error('No usable Content-Range: ' + contentRange);
  const first = Number(match[1]);
  const last = Number(match[2]);
  const total = Number(match[3]);
  if (first !== start || last !== Math.min(end, total - 1)) {
    throw new Error('Range answered ' + contentRange + ' for bytes ' + start + '-' + end);
  }
  if (bodyBytes !== last - first + 1) throw new Error('Range body was ' + bodyBytes + ' bytes, expected ' + (last - first + 1));
  return total;
}

/**
 * Downloads the next chunk of a video and stores it.
 * @param {object} s - The syncer's state.
 * @param {{url: string}} entry - The video being stored.
 * @param {number} count - Number of chunks stored so far.
 * @param {number} generation - The video's removal count when this download started.
 * @returns {Promise<number|null>} The video's total size in bytes, as the server reports it, or
 *   null when the video was taken off the list (and maybe put back) while the chunk was in flight,
 *   so the chunk was dropped rather than stored beside chunks of a different download.
 */
async function downloadSyncChunk(s, entry, count, generation) {
  const range = nextSharedChunkRange(count, s.chunkBytes);
  const part = await s.deps.fetchRange(entry.url, range.start, range.end);
  if ((s.removals.get(entry.url) || 0) !== generation) return null;
  await s.deps.storage.putChunk(entry.url, count, part.buffer, part.total);
  return part.total;
}

/**
 * Joins a video's finished chunks into the stored copy and clears them. Removal is checked again
 * after the store, because a video taken off the list while its last chunk or the store was in
 * flight must not stay stored.
 * @param {object} s - The syncer's state.
 * @param {string} url - The video's URL path.
 * @returns {Promise<void>} Resolves once stored, or once the removed video's data is gone.
 */
async function storeCompletedVideo(s, url) {
  const storage = s.deps.storage;
  if (s.wanted.has(url)) await storage.putVideo(url, await storage.getChunks(url));
  if (!s.wanted.has(url)) await storage.deleteVideo(url);
  await storage.clearChunks(url);
}

/**
 * Downloads one video chunk by chunk, resuming after stored chunks, then joins and stores it.
 * Stops early (clearing its chunks) if the video leaves the list meanwhile, and does nothing if
 * it is already stored: a plan made from an older storage read can queue a video that has
 * finished since.
 * @param {object} s - The syncer's state.
 * @param {{url: string}} entry - The video to store.
 * @returns {Promise<void>} Resolves once stored, abandoned or found already stored.
 */
async function downloadSyncVideo(s, entry) {
  if ((await s.deps.storage.listVideos()).indexOf(entry.url) !== -1) return;
  const generation = s.removals.get(entry.url) || 0;
  let count = await s.deps.storage.countChunks(entry.url);
  // The total size is stored with the chunks, so chunks that already cover the file (the page was
  // closed before the video was joined) are finished without another request past the end.
  let total = count > 0 ? await s.deps.storage.chunkTotal(entry.url) : null;
  if (total === null) total = Infinity;
  while (count * s.chunkBytes < total) {
    await waitWhileSyncPaused(s);
    if (!s.wanted.has(entry.url)) { await s.deps.storage.clearChunks(entry.url); return; }
    total = await downloadSyncChunk(s, entry, count, generation);
    if (total === null) return restartSyncDownload(s, entry);
    count++;
    if (count * s.chunkBytes < total) await s.deps.sleep(s.chunkPauseMs);
  }
  await storeCompletedVideo(s, entry.url);
}

/**
 * Drops the chunks of a download that was invalidated (its video left the list while a chunk was
 * in flight) and, if the video is back on the list, starts it again from the beginning.
 * @param {object} s - The syncer's state.
 * @param {{url: string}} entry - The video whose download was invalidated.
 * @returns {Promise<void>} Resolves once the chunks are cleared and any fresh download is done.
 */
async function restartSyncDownload(s, entry) {
  await s.deps.storage.clearChunks(entry.url);
  if (s.wanted.has(entry.url)) await downloadSyncVideo(s, entry);
}

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

/**
 * Drains the queue one video at a time. A failed video waits for its retry time at the back of
 * the queue while the others carry on; when only waiting videos remain, it sleeps until one is due.
 * @param {object} s - The syncer's state.
 * @returns {Promise<void>} Resolves once the queue is empty.
 */
async function drainSyncQueue(s) {
  while (s.queue.length > 0) {
    const entry = takeReadyEntry(s);
    if (!entry) { await s.deps.sleep(msUntilNextRetry(s)); continue; }
    s.active = entry.url;
    try {
      await downloadSyncVideo(s, entry);
      forgetSyncRetry(s, entry.url);
    } catch (err) {
      handleSyncFailure(s, entry, err);
    }
    s.active = null;
  }
  s.running = null;
}

/**
 * Applies one video list: deletes stored and half-stored videos that left it and queues the missing
 * ones. Does nothing when a newer list has arrived (before or during the storage reads), as that
 * list's own plan is the one to apply and this one is stale.
 * @param {object} s - The syncer's state.
 * @param {Array<{url: string}>} list - The video list to apply.
 * @param {number} seq - This list's sequence number.
 * @returns {Promise<void>} Resolves once the queue is updated and draining.
 */
async function applyVideoList(s, list, seq) {
  if (seq !== s.syncSeq) return;
  const plan = planSharedSync(list, await s.deps.storage.listVideos(), await s.deps.storage.listPartial());
  if (seq !== s.syncSeq) return;
  for (const url of plan.remove) {
    if (s.wanted.has(url)) continue;
    await s.deps.storage.deleteVideo(url);
    await s.deps.storage.clearChunks(url);
    forgetSyncRetry(s, url);
  }
  // The video being downloaded is not stored yet, so it is in the plan; queueing it again would fetch it twice.
  s.queue = plan.download.filter(function (e) { return e.url !== s.active; });
  if (!s.running && s.queue.length > 0) s.running = drainSyncQueue(s);
}

/**
 * Takes a new video list. The wanted set switches at once (so a download in flight for a removed
 * video stops, and a removed video's retry wait is forgotten, so adding it back later starts
 * fresh), while applying the lists is serialised, so two lists can't act on each other's
 * half-read storage state.
 * @param {object} s - The syncer's state.
 * @param {Array<{url: string}>} list - The current enabled video list.
 * @returns {Promise<void>} Resolves once this list has been applied or superseded.
 */
function syncVideoList(s, list) {
  const seq = ++s.syncSeq;
  const next = new Set(list.map(function (v) { return v.url; }));
  // A video that leaves the list ends the download in flight for it, even if it comes back.
  s.wanted.forEach(function (url) { if (!next.has(url)) s.removals.set(url, (s.removals.get(url) || 0) + 1); });
  s.wanted = next;
  Array.from(s.failures.keys()).forEach(function (url) { if (!s.wanted.has(url)) forgetSyncRetry(s, url); });
  const applied = s.syncChain.then(function () { return applyVideoList(s, list, seq); });
  s.syncChain = applied.catch(function () {});
  return applied;
}

/**
 * Picks what to play a video from: its stored copy as an object URL, or the normal route when
 * there is none or the lookup doesn't answer in time (a stalled storage read must not delay
 * playback past its window).
 * @param {string} url - The video's URL path.
 * @param {object} deps - Injected layers.
 * @param {{getVideoBlob: function(string): Promise<Blob|null>}|null} deps.storage - The storage layer, or null when unavailable.
 * @param {function(Blob): string} deps.createObjectUrl - Makes an object URL for a blob.
 * @param {function(string): void} deps.revokeObjectUrl - Frees an object URL.
 * @param {function(number): Promise<void>} deps.sleep - Resolves after the given milliseconds.
 * @param {number} [deps.lookupMs] - How long to wait for the stored copy (defaults to the constant above).
 * @returns {Promise<{src: string, release: function(): void}>} The source and a function freeing it.
 */
async function resolveSharedSource(url, deps) {
  const route = { src: url, release: function () {} };
  if (!deps.storage) return route;
  const lookup = deps.storage.getVideoBlob(url).catch(function () { return null; });
  const timeout = deps.sleep(deps.lookupMs === undefined ? SHARED_SOURCE_LOOKUP_MS : deps.lookupMs).then(function () { return null; });
  const blob = await Promise.race([lookup, timeout]);
  if (!blob) return route;
  const objectUrl = deps.createObjectUrl(blob);
  return { src: objectUrl, release: function () { deps.revokeObjectUrl(objectUrl); } };
}

/**
 * Creates the background syncer.
 * @param {object} deps - Injected layers.
 * @param {object} deps.storage - `listVideos()`, `listPartial()`, `countChunks(url)`, `chunkTotal(url)`
 *   (the file size stored with the chunks, or null), `getChunks(url)`,
 *   `putChunk(url, index, buffer, total)`, `putVideo(url, chunks)`, `deleteVideo(url)`, `clearChunks(url)`.
 * @param {function(string, number, number): Promise<{buffer: ArrayBuffer, total: number}>} deps.fetchRange -
 *   Fetches an inclusive byte range, reporting the file's total size.
 * @param {function(): boolean} deps.isPaused - True while a shared video is triggered or playing.
 * @param {function(number): Promise<void>} deps.sleep - Resolves after the given milliseconds.
 * @param {function(string, *): void} [deps.log] - Reports a failed download.
 * @param {function(): number} [deps.now] - Current time in milliseconds (defaults to `Date.now`); schedules retries.
 * @param {number} [deps.chunkBytes] - Bytes per chunk (defaults to the constant above).
 * @param {number} [deps.chunkPauseMs] - Pause between chunks (defaults to the constant above).
 * @returns {{sync: function(Array<{url: string}>): Promise<void>, idle: function(): Promise<void>}}
 *   `sync` takes a new list (queueing downloads and deleting removed videos); `idle` resolves once
 *   the queue has drained.
 */
function createSharedSyncer(deps) {
  const s = {
    deps: deps,
    chunkBytes: deps.chunkBytes || SHARED_SYNC_CHUNK_BYTES,
    chunkPauseMs: deps.chunkPauseMs === undefined ? SHARED_SYNC_CHUNK_PAUSE_MS : deps.chunkPauseMs,
    wanted: new Set(),
    removals: new Map(), // URL -> times it left the list, so a download can tell it was invalidated
    queue: [],
    running: null,
    active: null, // URL of the video being downloaded
    failures: new Map(), // URL -> failed attempts so far
    retryAt: new Map(), // URL -> time a failed video may be tried again
    now: deps.now || function () { return Date.now(); },
    syncSeq: 0,
    syncChain: Promise.resolve(),
  };
  return {
    sync: function (list) { return syncVideoList(s, list); },
    idle: function () { return s.running || Promise.resolve(); },
  };
}
