/**
 * Pure helpers for the shared overlay video sync (#917): what a video list needs, which byte
 * range comes next, and whether a range answer can be trusted. They take and return plain data,
 * so they are tested without a browser; shared-overlay-sync.js drives them.
 */

/**
 * Works out what a new video list needs: the videos to download (in the list's order, which is
 * newest first, as those are the most likely to be triggered soon) and the stored or half-stored
 * videos that are no longer on the list, and the chunks left behind by a video that is stored in
 * full (the page closed between storing it and clearing them).
 * @param {Array<{url: string}>} list - The current enabled video list.
 * @param {string[]} storedUrls - URLs of the videos already stored in full.
 * @param {string[]} partialUrls - URLs that have downloaded chunks.
 * @returns {{download: Array<{url: string}>, remove: string[], clear: string[]}} Videos to fetch,
 *   URLs to delete, and wanted stored URLs whose leftover chunks should be cleared.
 */
function planSharedSync(list, storedUrls, partialUrls) {
  const wanted = new Set(list.map(function (v) { return v.url; }));
  const stored = new Set(storedUrls);
  const remove = storedUrls.concat(partialUrls).filter(function (url, i, all) {
    return !wanted.has(url) && all.indexOf(url) === i;
  });
  const clear = partialUrls.filter(function (url) { return wanted.has(url) && stored.has(url); });
  return { download: list.filter(function (v) { return !stored.has(v.url); }), remove: remove, clear: clear };
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
 * Fetches one inclusive byte range of a video, giving up if the headers and body together take
 * longer than a deadline (a stalled body would otherwise hold the single download worker for good),
 * and checks the answer covers the bytes asked for.
 * @param {function(string, object): Promise<Response>} fetchFn - The fetch to use.
 * @param {string} url - The video's URL path.
 * @param {number} start - First byte, inclusive.
 * @param {number} end - Last byte, inclusive.
 * @param {number} deadlineMs - Longest the whole request may take, in milliseconds.
 * @returns {Promise<{buffer: ArrayBuffer, total: number}>} The bytes and the file's total size.
 */
async function fetchSharedRange(fetchFn, url, start, end, deadlineMs) {
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, deadlineMs);
  try {
    const res = await fetchFn(url, { headers: { Range: 'bytes=' + start + '-' + end }, signal: controller.signal });
    if (res.status !== 206) throw new Error('Range request answered ' + res.status);
    const buffer = await res.arrayBuffer();
    return { buffer: buffer, total: checkedRangeTotal(res.headers.get('Content-Range'), buffer.byteLength, start, end) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Lets only one overlay page at a time run the background sync. Pages of the same browser share
 * one set of stored videos and chunks, so two syncing at once could clear each other's chunks or
 * store an incomplete video over a finished one. The page holding the lock syncs; the others wait
 * and take over if it closes. Without the Web Locks API the page just starts.
 * @param {{request: function(string, function(): Promise<void>): Promise<*>}|undefined} locks - `navigator.locks`, if any.
 * @param {string} name - The lock's name.
 * @param {function(): void} start - Starts this page's syncing; called once it owns the lock.
 * @returns {void}
 */
function holdSyncOwnership(locks, name, start) {
  if (!locks || typeof locks.request !== 'function') { start(); return; }
  let started = false;
  const begin = function () { if (!started) { started = true; start(); } };
  // The returned promise never settles, so the lock is held until the page goes away.
  Promise.resolve(locks.request(name, function () { begin(); return new Promise(function () {}); }))
    .catch(begin);
}
