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
 * Creates the background syncer.
 * @param {object} deps - Injected layers.
 * @param {object} deps.storage - `listVideos()`, `listPartial()`, `countChunks(url)`, `getChunks(url)`,
 *   `putChunk(url, index, buffer)`, `putVideo(url, chunks)`, `deleteVideo(url)`, `clearChunks(url)`.
 * @param {function(string, number, number): Promise<{buffer: ArrayBuffer, total: number}>} deps.fetchRange -
 *   Fetches an inclusive byte range, reporting the file's total size.
 * @param {function(): boolean} deps.isPaused - True while a shared video is triggered or playing.
 * @param {function(number): Promise<void>} deps.sleep - Resolves after the given milliseconds.
 * @param {function(string, *): void} [deps.log] - Reports a failed download.
 * @param {function({type: string, url?: string, percent?: number}): void} [deps.onEvent] - Told when a
 *   chunk arrives (`progress`, with the percentage), a video is stored (`stored`) or deleted
 *   (`removed`), and when the queue drains (`idle`), so the page can report readiness.
 * @param {number} [deps.chunkBytes] - Bytes per chunk (defaults to the constant above).
 * @param {number} [deps.chunkPauseMs] - Pause between chunks (defaults to the constant above).
 * @returns {{sync: function(Array<{url: string}>): Promise<void>, idle: function(): Promise<void>}}
 *   `sync` takes a new list (queueing downloads and deleting removed videos); `idle` resolves once
 *   the queue has drained.
 */
function createSharedSyncer(deps) {
  const chunkBytes = deps.chunkBytes || SHARED_SYNC_CHUNK_BYTES;
  const chunkPauseMs = deps.chunkPauseMs === undefined ? SHARED_SYNC_CHUNK_PAUSE_MS : deps.chunkPauseMs;
  let wanted = new Set();
  let queue = [];
  let running = null;

  /**
   * Passes an event to the page, if it listens.
   * @param {object} event - The event.
   * @returns {void}
   */
  function emit(event) {
    if (deps.onEvent) deps.onEvent(event);
  }

  /**
   * Waits while paused, polling.
   * @returns {Promise<void>} Resolves once no longer paused.
   */
  async function waitWhilePaused() {
    while (deps.isPaused()) await deps.sleep(SHARED_SYNC_PAUSE_POLL_MS);
  }

  /**
   * Downloads one video chunk by chunk, resuming after stored chunks, then joins and stores it.
   * Stops early (clearing its chunks) if the video leaves the list meanwhile.
   * @param {{url: string}} entry - The video to store.
   * @returns {Promise<void>} Resolves once stored or abandoned.
   */
  async function downloadOne(entry) {
    let count = await deps.storage.countChunks(entry.url);
    let total = Infinity;
    while (count * chunkBytes < total) {
      await waitWhilePaused();
      if (!wanted.has(entry.url)) { await deps.storage.clearChunks(entry.url); return; }
      const range = nextSharedChunkRange(count, chunkBytes);
      const part = await deps.fetchRange(entry.url, range.start, range.end);
      total = part.total;
      await deps.storage.putChunk(entry.url, count, part.buffer);
      count++;
      emit({ type: 'progress', url: entry.url, percent: Math.min(100, Math.round((count * chunkBytes / total) * 100)) });
      if (count * chunkBytes < total) await deps.sleep(chunkPauseMs);
    }
    await deps.storage.putVideo(entry.url, await deps.storage.getChunks(entry.url));
    await deps.storage.clearChunks(entry.url);
    emit({ type: 'stored', url: entry.url });
  }

  /**
   * Drains the queue one video at a time; a failed video waits a while and is retried by the next list.
   * @returns {Promise<void>} Resolves once the queue is empty.
   */
  async function drain() {
    while (queue.length > 0) {
      const entry = queue.shift();
      try {
        await downloadOne(entry);
      } catch (err) {
        if (deps.log) deps.log('Shared video download failed: ' + entry.url, err);
        await deps.sleep(SHARED_SYNC_RETRY_MS);
      }
    }
    running = null;
    emit({ type: 'idle' });
  }

  return {
    sync: async function (list) {
      wanted = new Set(list.map(function (v) { return v.url; }));
      const plan = planSharedSync(list, await deps.storage.listVideos(), await deps.storage.listPartial());
      for (const url of plan.remove) {
        await deps.storage.deleteVideo(url);
        await deps.storage.clearChunks(url);
        emit({ type: 'removed', url: url });
      }
      queue = plan.download;
      if (!running && queue.length > 0) running = drain();
    },
    idle: function () { return running || Promise.resolve(); },
  };
}
