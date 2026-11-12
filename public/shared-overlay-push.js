/* global forgetSyncRetry, drainSyncQueue */
/**
 * Manager pushes for the shared overlay video sync (#917): fetching a pushed video at full speed,
 * and the background download giving way to it. Plain functions over the syncer's state (see
 * createSharedSyncer in shared-overlay-sync.js).
 */

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
 * Handles a Manager push: makes sure a video is stored, at full speed, without playing it.
 * @param {object} s - The syncer's state.
 * @param {{url: string}} entry - The pushed video.
 * @returns {Promise<string>} `ignored` if already stored (or its video left the list meanwhile), `finishing` if its background download
 *   is under way (now sped up, keeping its chunks), or `fetching` if it was missing (the
 *   background queue pauses behind it and resumes afterwards).
 */
async function fetchSyncNow(s, entry) {
  const removedBefore = s.removals.get(entry.url) || 0;
  if ((await s.deps.storage.listVideos()).indexOf(entry.url) !== -1) return 'ignored';
  // The video left the list while the storage was being read: the push is stale, and adding the
  // video back would keep (and download) something the latest list removed.
  if ((s.removals.get(entry.url) || 0) !== removedBefore) return 'ignored';
  s.wanted.add(entry.url);
  s.fast.add(entry.url);
  forgetSyncRetry(s, entry.url); // a push is tried at once, whatever wait a failed background download was under
  if (s.current === entry.url) return 'finishing';
  s.queue = s.queue.filter(function (e) { return e.url !== entry.url; });
  s.queue.unshift(entry);
  if (!s.running) s.running = drainSyncQueue(s);
  return 'fetching';
}
