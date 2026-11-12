/* global SHARED_SYNC_CHUNK_PAUSE_MS */
/**
 * Pacing of a shared video download (#917): how long it waits between chunks, and when it gives
 * way to a Manager-pushed video. Plain functions over the syncer's state (see createSharedSyncer
 * in shared-overlay-sync.js).
 */

/** Pause between chunks while the streamer is offline: faster, the server budget still caps the total. */
const SHARED_SYNC_CHUNK_PAUSE_OFFLINE_MS = 250;

/**
 * Pause between chunks for the streamer's live state: slow while they stream, faster while offline.
 * @param {boolean} live - Whether the streamer is live (treat as live until told otherwise).
 * @returns {number} Milliseconds to wait between chunks.
 */
function chunkPauseFor(live) {
  return live ? SHARED_SYNC_CHUNK_PAUSE_MS : SHARED_SYNC_CHUNK_PAUSE_OFFLINE_MS;
}

/**
 * The pause to take after a chunk right now.
 * @param {object} s - The syncer's state.
 * @returns {number} Milliseconds; the configured pause may be a function giving it each time.
 */
function syncChunkPauseMs(s) {
  return typeof s.chunkPauseMs === 'function' ? s.chunkPauseMs() : s.chunkPauseMs;
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
 * What a download does between chunks: nothing after the last one; otherwise it gives way to a
 * Manager-pushed video waiting in the queue, or pauses (a pushed video does not pause).
 * @param {object} s - The syncer's state.
 * @param {{url: string}} entry - The video being downloaded.
 * @param {boolean} more - Whether the video has more chunks to fetch.
 * @returns {Promise<boolean>} True if the download should stop for now (it was put back in the queue).
 */
async function pauseAfterSyncChunk(s, entry, more) {
  if (!more) return false;
  if (syncYieldsToPush(s, entry)) return true;
  if (!s.fast.has(entry.url)) await s.deps.sleep(syncChunkPauseMs(s));
  return false;
}
