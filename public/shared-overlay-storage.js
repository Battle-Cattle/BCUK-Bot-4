/**
 * Browser storage layers for the shared overlay's video sync (#917): finished videos in Cache
 * Storage (it needs an HTTPS or localhost page, and unlike the HTTP cache it holds big files and
 * isn't cleared to make room) and half-downloaded chunks in IndexedDB, so an OBS restart resumes.
 */

const SHARED_CACHE_NAME = 'shared-overlay-videos';
const SHARED_DB_NAME = 'shared-overlay-chunks';
const SHARED_CHUNK_STORE = 'chunks';

/**
 * Whether the browser can store shared videos (Cache Storage and IndexedDB, HTTPS or localhost).
 * @returns {boolean} True when the storage layers are available.
 */
function sharedStorageAvailable() {
  return typeof caches !== 'undefined' && typeof indexedDB !== 'undefined';
}

/**
 * Wraps an IndexedDB request in a promise.
 * @param {IDBRequest} request - The request to wait for.
 * @returns {Promise<*>} Resolves with the request's result.
 */
function idbResult(request) {
  return new Promise(function (resolve, reject) {
    request.onsuccess = function () { resolve(request.result); };
    request.onerror = function () { reject(request.error); };
  });
}

/**
 * Opens the chunk database, creating its store on first use.
 * @returns {Promise<IDBDatabase>} The open database.
 */
function openChunkDb() {
  const open = indexedDB.open(SHARED_DB_NAME, 1);
  open.onupgradeneeded = function () {
    const store = open.result.createObjectStore(SHARED_CHUNK_STORE, { keyPath: ['url', 'index'] });
    store.createIndex('url', 'url');
  };
  return idbResult(open);
}

/**
 * Creates the storage layer the syncer uses.
 * @returns {object} `listVideos`, `listPartial`, `countChunks`, `getChunks`, `putChunk`, `putVideo`,
 *   `deleteVideo`, `clearChunks` and `getVideoBlob`, all promise-returning.
 */
function createSharedStorage() {
  const dbPromise = openChunkDb();

  /**
   * Runs one request against the chunk store.
   * @param {string} mode - `readonly` or `readwrite`.
   * @param {function(IDBObjectStore): IDBRequest} make - Builds the request from the store.
   * @returns {Promise<*>} The request's result.
   */
  async function chunkRequest(mode, make) {
    const db = await dbPromise;
    return idbResult(make(db.transaction(SHARED_CHUNK_STORE, mode).objectStore(SHARED_CHUNK_STORE)));
  }

  /**
   * Reads every chunk record of one video, in order.
   * @param {string} url - The video's URL.
   * @returns {Promise<Array<{index: number, buffer: ArrayBuffer}>>} The records sorted by index.
   */
  async function chunkRecords(url) {
    const records = await chunkRequest('readonly', function (s) { return s.index('url').getAll(url); });
    return records.sort(function (a, b) { return a.index - b.index; });
  }

  return {
    listVideos: async function () {
      const cache = await caches.open(SHARED_CACHE_NAME);
      return (await cache.keys()).map(function (r) { return new URL(r.url).pathname; });
    },
    listPartial: async function () {
      // An index's getAllKeys returns the records' primary keys ([url, index]); one url has many.
      const keys = await chunkRequest('readonly', function (s) { return s.index('url').getAllKeys(); });
      return Array.from(new Set(keys.map(function (k) { return k[0]; })));
    },
    countChunks: async function (url) {
      // Only an unbroken run from 0 counts, so a gap left by a crash is refetched.
      const records = await chunkRecords(url);
      let n = 0;
      while (n < records.length && records[n].index === n) n++;
      return n;
    },
    getChunks: async function (url) {
      return (await chunkRecords(url)).map(function (r) { return r.buffer; });
    },
    putChunk: function (url, index, buffer) {
      return chunkRequest('readwrite', function (s) { return s.put({ url: url, index: index, buffer: buffer }); });
    },
    putVideo: async function (url, chunks) {
      const cache = await caches.open(SHARED_CACHE_NAME);
      await cache.put(url, new Response(new Blob(chunks, { type: 'video/webm' })));
    },
    deleteVideo: async function (url) {
      const cache = await caches.open(SHARED_CACHE_NAME);
      await cache.delete(url);
    },
    clearChunks: async function (url) {
      // getAllKeys on an index returns the records' primary keys ([url, index]), which delete() takes.
      const keys = await chunkRequest('readonly', function (s) { return s.index('url').getAllKeys(IDBKeyRange.only(url)); });
      const db = await dbPromise;
      const store = db.transaction(SHARED_CHUNK_STORE, 'readwrite').objectStore(SHARED_CHUNK_STORE);
      await Promise.all(keys.map(function (k) { return idbResult(store.delete(k)); }));
    },
    getVideoBlob: async function (url) {
      const cache = await caches.open(SHARED_CACHE_NAME);
      const hit = await cache.match(url);
      return hit ? hit.blob() : null;
    },
  };
}
