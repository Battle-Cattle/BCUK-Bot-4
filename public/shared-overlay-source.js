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

/**
 * Switches a video that failed to play from its stored copy to the normal route, once: a stored
 * copy that is truncated or can't be decoded would otherwise fail every trigger, as the sync never
 * replaces a copy it already holds.
 * @param {{source: {src: string, release: function(): void}}} handle - The video's handle; its source is replaced.
 * @param {string} url - The video's URL path (the route).
 * @param {function(string): void} setSrc - Points the video element at a new source.
 * @returns {boolean} True if it switched to the route; false if it was on the route already, so the caller gives up.
 */
function fallBackToRoute(handle, url, setSrc) {
  if (handle.source.src === url) return false;
  handle.source.release();
  handle.source = { src: url, release: function () {} };
  setSrc(url);
  return true;
}

/**
 * Starts playing a video and reports a failure of that attempt. A rejection is ignored when the
 * video's source has been replaced since (a fallback to the route reloads the element, which
 * aborts the pending play() with an AbortError: that is not a failure of the new source).
 * @param {{v: {play: function(): Promise<void>}, source: object}} handle - The video's handle.
 * @param {function(): void} onFailure - Called when playing the current source fails.
 * @returns {void}
 */
function playSource(handle, onFailure) {
  const attempt = handle.source;
  handle.v.play().catch(function () {
    if (handle.source === attempt) onFailure();
  });
}
