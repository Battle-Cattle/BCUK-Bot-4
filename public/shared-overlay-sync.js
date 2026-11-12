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
 * Builds the readiness report sent to the server: the ids of the listed videos stored in full, and
 * the id and percentage of the video being downloaded, if any.
 * @param {Array<{id: number, url: string}>} list - The current enabled video list.
 * @param {string[]} storedUrls - URLs of the videos stored in full.
 * @param {{url: string, percent: number}|null} downloading - The current download, or null.
 * @returns {{stored: number[], downloading: ({id: number, percent: number}|null)}} The report body.
 */
function buildReadinessReport(list, storedUrls, downloading) {
  const stored = new Set(storedUrls);
  const current = downloading ? list.find(function (v) { return v.url === downloading.url; }) : undefined;
  return {
    stored: list.filter(function (v) { return stored.has(v.url); }).map(function (v) { return v.id; }),
    downloading: current ? { id: current.id, percent: downloading.percent } : null,
  };
}

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
 * @returns {Promise<number>} The video's total size in bytes, as the server reports it.
 */
async function downloadSyncChunk(s, entry, count) {
  const range = nextSharedChunkRange(count, s.chunkBytes);
  const part = await s.deps.fetchRange(entry.url, range.start, range.end, s.fast.has(entry.url));
  await s.deps.storage.putChunk(entry.url, count, part.buffer);
  return part.total;
}

/**
 * A pushed video waiting at the front of the queue takes over from a background download: the
 * background one goes back in the queue (its chunks are kept) and resumes afterwards.
 * @param {object} s - The syncer's state.
 * @param {{url: string}} entry - The video being downloaded.
 * @returns {boolean} True if `entry` was put back and its download should stop for now.
 */
function syncYieldsToPush(s, entry) {
  if (s.fast.has(entry.url) || s.queue.length === 0 || !s.fast.has(s.queue[0].url)) return false;
  s.queue.splice(1, 0, entry);
  return true;
}

/**
 * Downloads one video chunk by chunk, resuming after stored chunks, then joins and stores it.
 * Stops early (clearing its chunks) if the video leaves the list meanwhile.
 * @param {object} s - The syncer's state.
 * @param {{url: string}} entry - The video to store.
 * @returns {Promise<void>} Resolves once stored or abandoned.
 */
async function downloadSyncVideo(s, entry) {
  let count = await s.deps.storage.countChunks(entry.url);
  let total = Infinity;
  while (count * s.chunkBytes < total) {
    await waitWhileSyncPaused(s);
    if (!s.wanted.has(entry.url)) { await s.deps.storage.clearChunks(entry.url); return; }
    total = await downloadSyncChunk(s, entry, count);
    count++;
    emitSyncEvent(s, { type: 'progress', url: entry.url, percent: Math.min(100, Math.round((count * s.chunkBytes / total) * 100)) });
    if (count * s.chunkBytes < total && syncYieldsToPush(s, entry)) return;
    if (count * s.chunkBytes < total && !s.fast.has(entry.url)) await s.deps.sleep(s.chunkPauseMs);
  }
  await s.deps.storage.putVideo(entry.url, await s.deps.storage.getChunks(entry.url));
  await s.deps.storage.clearChunks(entry.url);
  emitSyncEvent(s, { type: 'stored', url: entry.url });
}

/**
 * Drains the queue one video at a time; a failed video waits a while and is retried by the next list.
 * @param {object} s - The syncer's state.
 * @returns {Promise<void>} Resolves once the queue is empty.
 */
async function drainSyncQueue(s) {
  while (s.queue.length > 0) {
    const entry = s.queue.shift();
    s.current = entry.url;
    try {
      await downloadSyncVideo(s, entry);
    } catch (err) {
      if (s.deps.log) s.deps.log('Shared video download failed: ' + entry.url, err);
      await s.deps.sleep(SHARED_SYNC_RETRY_MS);
    }
    s.fast.delete(entry.url);
    s.current = null;
  }
  s.running = null;
  emitSyncEvent(s, { type: 'idle' });
}

/**
 * Takes a new video list: deletes stored and half-stored videos that left it and queues the missing ones.
 * @param {object} s - The syncer's state.
 * @param {Array<{url: string}>} list - The current enabled video list.
 * @returns {Promise<void>} Resolves once the queue is updated and draining.
 */
async function syncVideoList(s, list) {
  s.wanted = new Set(list.map(function (v) { return v.url; }));
  const plan = planSharedSync(list, await s.deps.storage.listVideos(), await s.deps.storage.listPartial());
  for (const url of plan.remove) {
    await s.deps.storage.deleteVideo(url);
    await s.deps.storage.clearChunks(url);
    emitSyncEvent(s, { type: 'removed', url: url });
  }
  s.queue = plan.download;
  if (!s.running && s.queue.length > 0) s.running = drainSyncQueue(s);
}

/**
 * Handles a Manager push: makes sure a video is stored, at full speed, without playing it.
 * @param {object} s - The syncer's state.
 * @param {{url: string}} entry - The pushed video.
 * @returns {Promise<string>} `ignored` if already stored, `finishing` if its background download
 *   is under way (now sped up, keeping its chunks), or `fetching` if it was missing (the
 *   background queue pauses behind it and resumes afterwards).
 */
async function fetchSyncNow(s, entry) {
  if ((await s.deps.storage.listVideos()).indexOf(entry.url) !== -1) return 'ignored';
  s.wanted.add(entry.url);
  s.fast.add(entry.url);
  if (s.current === entry.url) return 'finishing';
  s.queue = s.queue.filter(function (e) { return e.url !== entry.url; });
  s.queue.unshift(entry);
  if (!s.running) s.running = drainSyncQueue(s);
  return 'fetching';
}

/**
 * Creates the background syncer.
 * @param {object} deps - Injected layers.
 * @param {object} deps.storage - `listVideos()`, `listPartial()`, `countChunks(url)`, `getChunks(url)`,
 *   `putChunk(url, index, buffer)`, `putVideo(url, chunks)`, `deleteVideo(url)`, `clearChunks(url)`.
 * @param {function(string, number, number, boolean): Promise<{buffer: ArrayBuffer, total: number}>} deps.fetchRange -
 *   Fetches an inclusive byte range, reporting the file's total size. The last argument is true for
 *   a Manager-pushed video, which downloads at full speed instead of through the preload limit.
 * @param {function(): boolean} deps.isPaused - True while a shared video is triggered or playing.
 * @param {function(number): Promise<void>} deps.sleep - Resolves after the given milliseconds.
 * @param {function(string, *): void} [deps.log] - Reports a failed download.
 * @param {function({type: string, url?: string, percent?: number}): void} [deps.onEvent] - Told when a
 *   chunk arrives (`progress`, with the percentage), a video is stored (`stored`) or deleted
 *   (`removed`), and when the queue drains (`idle`), so the page can report readiness.
 * @param {number} [deps.chunkBytes] - Bytes per chunk (defaults to the constant above).
 * @param {number} [deps.chunkPauseMs] - Pause between chunks (defaults to the constant above).
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
    queue: [],
    running: null,
    current: null, // url being downloaded now
    fast: new Set(), // urls to download at full speed (Manager push)
  };
  return {
    sync: function (list) { return syncVideoList(s, list); },
    fetchNow: function (entry) { return fetchSyncNow(s, entry); },
    idle: function () { return s.running || Promise.resolve(); },
  };
}
