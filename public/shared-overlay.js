/* global connectSse, planSharedPlayback, buildReadinessReport, createSharedSyncer, createSharedStorage, sharedStorageAvailable */
(function () {
  const script = document.currentScript;
  const login = script ? script.dataset.login : '';
  if (!login) return;

  /** Random delay range before the first background sync, so overlays opened together don't all start at once. */
  const FIRST_SYNC_MIN_MS = 2000;
  const FIRST_SYNC_SPREAD_MS = 6000;

  let clockOffsetMs = 0; // server time minus local time
  let maxLateMs = 3000;
  let playing = false;
  let current = null; // handle of the video being loaded or played
  let syncer = null;
  let storage = null;
  let firstSyncDone = false;
  let currentList = [];
  let downloading = null; // { url, percent } while a background download runs
  let lastProgressReportAt = 0;

  /** Most often a progress report is sent while a download runs. */
  const PROGRESS_REPORT_MS = 3000;

  /**
   * Current time on the server's clock.
   * @returns {number} Estimated server epoch milliseconds.
   */
  function serverNow() {
    return Date.now() + clockOffsetMs;
  }

  /**
   * Fetches one inclusive byte range of a video from the normal route.
   * @param {string} url - The video's URL path.
   * @param {number} start - First byte, inclusive.
   * @param {number} end - Last byte, inclusive.
   * @returns {Promise<{buffer: ArrayBuffer, total: number}>} The bytes and the file's total size.
   */
  async function fetchRange(url, start, end) {
    const res = await fetch(url, { headers: { Range: 'bytes=' + start + '-' + end } });
    if (res.status !== 206) throw new Error('Range request answered ' + res.status);
    const match = /\/(\d+)$/.exec(res.headers.get('Content-Range') || '');
    if (!match) throw new Error('No total size in Content-Range');
    return { buffer: await res.arrayBuffer(), total: Number(match[1]) };
  }

  /**
   * Tells the server which videos are stored and how the current download is going, for the admin
   * page's readiness stats. Failures are ignored: the stats are best effort.
   * @returns {Promise<void>} Resolves once the report was sent (or failed).
   */
  async function sendReadiness() {
    try {
      const storedUrls = storage ? await storage.listVideos() : [];
      const body = buildReadinessReport(currentList, storedUrls, downloading);
      await fetch('/overlay/shared/' + login + '/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (_) {
      // Best effort.
    }
  }

  /**
   * Reacts to a syncer event: reports when a video is stored or removed or the queue drains, and
   * at most every few seconds while a download progresses.
   * @param {{type: string, url?: string, percent?: number}} event - The syncer event.
   * @returns {void}
   */
  function handleSyncEvent(event) {
    if (event.type === 'progress') {
      downloading = { url: event.url, percent: event.percent };
      if (Date.now() - lastProgressReportAt < PROGRESS_REPORT_MS) return;
      lastProgressReportAt = Date.now();
    } else {
      downloading = null;
    }
    void sendReadiness();
  }

  /**
   * Sets up the background syncer, or leaves it off (videos then stream at trigger time) when the
   * page can't store files — Cache Storage needs an HTTPS or localhost overlay URL.
   * @returns {void}
   */
  function setUpSync() {
    if (!sharedStorageAvailable()) {
      console.warn('Shared overlay: Cache Storage is unavailable (use an https:// browser source URL); videos will stream when triggered.');
      return;
    }
    storage = createSharedStorage();
    syncer = createSharedSyncer({
      storage: storage,
      fetchRange: fetchRange,
      isPaused: function () { return playing; },
      sleep: function (ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); },
      log: function (message, err) { console.warn(message, err); },
      onEvent: handleSyncEvent,
    });
  }

  /**
   * Hands a video list to the syncer: the first one after a random delay, later ones at once.
   * @param {Array<{url: string}>} videos - The enabled video list from the server.
   * @returns {void}
   */
  function syncList(videos) {
    if (!Array.isArray(videos)) return;
    currentList = videos;
    void sendReadiness(); // on connect and on every list change
    if (!syncer) return;
    const run = function () { syncer.sync(videos).catch(function (err) { console.warn('Shared video sync failed', err); }); };
    if (firstSyncDone) { run(); return; }
    firstSyncDone = true;
    setTimeout(run, FIRST_SYNC_MIN_MS + Math.random() * FIRST_SYNC_SPREAD_MS);
  }

  /**
   * Picks what to play from: the stored copy as an object URL when there is one, else the route.
   * @param {string} url - The video's URL path.
   * @returns {Promise<{src: string, release: function(): void}>} The source and a function freeing it.
   */
  async function resolveSource(url) {
    const blob = storage ? await storage.getVideoBlob(url).catch(function () { return null; }) : null;
    if (!blob) return { src: url, release: function () {} };
    const objectUrl = URL.createObjectURL(blob);
    return { src: objectUrl, release: function () { URL.revokeObjectURL(objectUrl); } };
  }

  /**
   * Removes a video and allows the next one to play. Only the video currently active may release
   * the gate, so a late cleanup for an earlier video can't free it while a newer one is playing.
   * @param {{v: HTMLVideoElement, source: {release: function(): void}, startTimer: number|null, deadline: number|null}} handle - The video's handle.
   * @returns {void}
   */
  function finish(handle) {
    clearTimeout(handle.startTimer);
    clearTimeout(handle.deadline);
    handle.v.remove();
    handle.source.release();
    if (current !== handle) return;
    current = null;
    playing = false;
  }

  /**
   * Starts a loaded video at its planned moment, or drops it if it is too late.
   * @param {{v: HTMLVideoElement, source: {release: function(): void}, startTimer: number|null, deadline: number|null}} handle - The video's handle.
   * @param {number} playAt - Server time the video should have started at.
   * @returns {void}
   */
  function start(handle, playAt) {
    const plan = planSharedPlayback(serverNow(), playAt, maxLateMs);
    if (plan.action === 'skip') { finish(handle); return; }
    handle.startTimer = setTimeout(function () {
      const late = planSharedPlayback(serverNow(), playAt, maxLateMs);
      if (late.action === 'skip') { finish(handle); return; }
      if (late.seekSeconds > 0) handle.v.currentTime = late.seekSeconds;
      handle.v.style.visibility = 'visible';
      handle.v.play().catch(function () { finish(handle); });
    }, plan.delayMs);
  }

  /**
   * Loads a video hidden (from storage when stored), then starts it at `playAt`. Ignored while
   * another is playing; background downloads pause for as long as `playing` is set. A video that
   * has not become ready by `playAt` plus the late limit (a stalled load fires no event) is
   * dropped, so it can't hold the gate for ever.
   * @param {string} url - URL path of the video.
   * @param {number} playAt - Server time to start at.
   * @returns {Promise<void>} Resolves once the video element is set up.
   */
  async function play(url, playAt) {
    if (playing) return;
    playing = true;
    const source = await resolveSource(url);
    const v = document.createElement('video');
    const handle = { v: v, source: source, startTimer: null, deadline: null };
    current = handle;
    v.src = source.src;
    v.preload = 'auto';
    v.playsInline = true;
    v.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;visibility:hidden;';
    v.addEventListener('ended', function () { finish(handle); });
    v.addEventListener('error', function () { finish(handle); });
    v.addEventListener('canplay', function () { start(handle, playAt); }, { once: true });
    // Only once it is really playing does the late limit stop applying: a stalled seek or a pending
    // play() must not hold the gate, or start the video after its window.
    v.addEventListener('playing', function () { clearTimeout(handle.deadline); }, { once: true });
    handle.deadline = setTimeout(function () { finish(handle); }, Math.max(0, playAt + maxLateMs - serverNow()));
    document.body.appendChild(v);
  }

  setUpSync();

  connectSse('/overlay/shared/' + login + '/events', function (data) {
    if (!data) return;
    if (data.type === 'init') {
      clockOffsetMs = data.serverTime - Date.now();
      if (typeof data.maxLateMs === 'number') maxLateMs = data.maxLateMs;
      syncList(data.videos);
    } else if (data.type === 'videos') {
      syncList(data.videos);
    } else if (data.type === 'fetchNow' && data.url) {
      // Manager push: store it now, never play it. Without storage there is nothing to do.
      if (syncer) syncer.fetchNow({ url: data.url }).catch(function (err) { console.warn('Shared video push failed', err); });
    } else if (data.type === 'play' && data.video) {
      void play(data.video, data.playAt);
    }
  });
})();
