/**
 * What the shared overlay plays a video from (#917): the stored copy when there is one in time,
 * else the normal route. A plain function over injected layers, so it can be tested outside a browser.
 */

/** Longest to wait for the stored copy of a video before streaming it instead. */
const SHARED_SOURCE_LOOKUP_MS = 1500;

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
