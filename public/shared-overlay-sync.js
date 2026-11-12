/* global pauseAfterSyncChunk, fetchSyncNow, planSharedSync, nextSharedChunkRange, checkedRangeTotal, handleSyncFailure, forgetSyncRetry, takeReadyEntry, msUntilNextRetry */
/**
 * Background sync of shared overlay videos into the overlay's own storage (#917). The queue, diff
 * and resume decisions live here as plain functions over injected storage and fetch layers, so they
 * can be tested outside a browser; shared-overlay-storage.js supplies the real Cache Storage and
 * IndexedDB layers, shared-overlay-retry.js the schedule for retrying a failed download, and
 * shared-overlay-source.js the choice of what to play a video from.
 */

/** Bytes requested per range request while storing a video. */
const SHARED_SYNC_CHUNK_BYTES = 2 * 1024 * 1024;
/** Pause between chunks, spreading the load (the server-side speed limit is the hard cap). */
const SHARED_SYNC_CHUNK_PAUSE_MS = 1000;
/** How often to re-check whether a shared video is still playing, while a download is paused. */
const SHARED_SYNC_PAUSE_POLL_MS = 500;

/**
 * Passes an event to the page, if it listens.
 * @param {object} s - The syncer's state.
 * @param {{type: string, url?: string, percent?: number}} event - The event.
 * @returns {void}
 */
function emitSyncEvent(s, event) {
  if (s.deps.onEvent) s.deps.onEvent(event);
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
  const part = await s.deps.fetchRange(entry.url, range.start, range.end, s.fast.has(entry.url));
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
 * @returns {Promise<boolean>} True when the video was stored and is still wanted; false when it was removed meanwhile.
 */
async function storeCompletedVideo(s, url) {
  const storage = s.deps.storage;
  if (s.wanted.has(url)) await storage.putVideo(url, await storage.getChunks(url));
  const kept = s.wanted.has(url);
  if (!kept) await storage.deleteVideo(url);
  await storage.clearChunks(url);
  return kept;
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
    if (!s.wanted.has(entry.url)) { await cleanUpRemovedDownload(s, entry); return; }
    total = await downloadSyncChunk(s, entry, count, generation);
    if (total === null) return restartSyncDownload(s, entry);
    count++;
    emitSyncEvent(s, { type: 'progress', url: entry.url, percent: Math.min(100, Math.round((count * s.chunkBytes / total) * 100)) });
    if (await pauseAfterSyncChunk(s, entry, count * s.chunkBytes < total)) return;
  }
  if (await storeCompletedVideo(s, entry.url)) emitSyncEvent(s, { type: 'stored', url: entry.url });
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
 * After a download ended because its video left the list (it failed, or was abandoned): clears the
 * half-downloaded chunks, and if the video is put back on the list while they are being cleared
 * (the list update skipped it, as it was still the active download) queues it again.
 * @param {object} s - The syncer's state.
 * @param {{url: string}} entry - The video whose download ended.
 * @returns {Promise<void>} Resolves once any cleanup and re-queueing is done.
 */
async function cleanUpRemovedDownload(s, entry) {
  if (s.wanted.has(entry.url)) return;
  await s.deps.storage.clearChunks(entry.url).catch(function () {});
  if (s.wanted.has(entry.url) && !s.queue.some(function (q) { return q.url === entry.url; })) s.queue.push(entry);
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
    s.current = entry.url;
    try {
      await downloadSyncVideo(s, entry);
      forgetSyncRetry(s, entry.url);
    } catch (err) {
      handleSyncFailure(s, entry, err);
      await cleanUpRemovedDownload(s, entry);
    }
    s.fast.delete(entry.url);
    s.current = null;
  }
  s.running = null;
  emitSyncEvent(s, { type: 'idle' });
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
    // Put back on the list during the delete: a download of it may have started over by now, and
    // clearing would wipe the chunks it has written since.
    if (s.wanted.has(url)) continue;
    await s.deps.storage.clearChunks(url);
    emitSyncEvent(s, { type: 'removed', url: url });
    forgetSyncRetry(s, url);
  }
  for (const url of plan.clear) {
    // Leftover chunks of a stored video; the one being stored right now clears its own.
    if (url !== s.active) await s.deps.storage.clearChunks(url);
  }
  // The video being downloaded is not stored yet, so it is in the plan; queueing it again would fetch it twice.
  s.queue = plan.download.filter(function (e) { return e.url !== s.current; });
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
 * Creates the background syncer.
 * @param {object} deps - Injected layers.
 * @param {object} deps.storage - `listVideos()`, `listPartial()`, `countChunks(url)`, `chunkTotal(url)`
 *   (the file size stored with the chunks, or null), `getChunks(url)`,
 *   `putChunk(url, index, buffer, total)`, `putVideo(url, chunks)`, `deleteVideo(url)`, `clearChunks(url)`.
 * @param {function(string, number, number, boolean): Promise<{buffer: ArrayBuffer, total: number}>} deps.fetchRange -
 *   Fetches an inclusive byte range, reporting the file's total size. The last argument is true for
 *   a Manager-pushed video, which downloads at full speed instead of through the preload limit.
 * @param {function(): boolean} deps.isPaused - True while a shared video is triggered or playing.
 * @param {function(number): Promise<void>} deps.sleep - Resolves after the given milliseconds.
 * @param {function(string, *): void} [deps.log] - Reports a failed download.
 * @param {function({type: string, url?: string, percent?: number}): void} [deps.onEvent] - Told when a
 *   chunk arrives (`progress`, with the percentage), a video is stored (`stored`) or deleted
 *   (`removed`), and when the queue drains (`idle`), so the page can report readiness.
 * @param {function(): number} [deps.now] - Current time in milliseconds (defaults to `Date.now`); schedules retries.
 * @param {number} [deps.chunkBytes] - Bytes per chunk (defaults to the constant above).
 * @param {number|function(): number} [deps.chunkPauseMs] - Pause between chunks, or a function giving
 *   it each time (defaults to the live-streamer constant above).
 * @returns {{sync: function(Array<{url: string}>): Promise<void>, fetchNow: function({url: string}): Promise<string>, idle: function(): Promise<void>}}
 *   `sync` takes a new list (queueing downloads and deleting removed videos); `fetchNow` handles a
 *   Manager push; `idle` resolves once the queue has drained.
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
    current: null, // url being downloaded now
    fast: new Set(), // urls to download at full speed (Manager push)
    failures: new Map(), // URL -> failed attempts so far
    retryAt: new Map(), // URL -> time a failed video may be tried again
    now: deps.now || function () { return Date.now(); },
    syncSeq: 0,
    syncChain: Promise.resolve(),
  };
  return {
    sync: function (list) { return syncVideoList(s, list); },
    fetchNow: function (entry) { return fetchSyncNow(s, entry); },
    idle: function () { return s.running || Promise.resolve(); },
  };
}
