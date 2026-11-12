/**
 * Pure helpers for the shared overlay video sync (#917): what a video list needs, which byte
 * range comes next, and whether a range answer can be trusted. They take and return plain data,
 * so they are tested without a browser; shared-overlay-sync.js drives them.
 */

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
