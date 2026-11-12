/* global connectSse, planSharedPlayback */
(function () {
  const script = document.currentScript;
  const login = script ? script.dataset.login : '';
  if (!login) return;

  let clockOffsetMs = 0; // server time minus local time
  let maxLateMs = 3000;
  let playing = false;
  let current = null; // handle of the video being loaded or played

  /**
   * Current time on the server's clock.
   * @returns {number} Estimated server epoch milliseconds.
   */
  function serverNow() {
    return Date.now() + clockOffsetMs;
  }

  /**
   * Removes a video and allows the next one to play. Only the video currently active may release
   * the gate, so a late cleanup for an earlier video can't free it while a newer one is playing.
   * @param {{v: HTMLVideoElement, startTimer: number|null, deadline: number|null}} handle - The video's handle.
   * @returns {void}
   */
  function finish(handle) {
    clearTimeout(handle.startTimer);
    clearTimeout(handle.deadline);
    handle.v.remove();
    if (current !== handle) return;
    current = null;
    playing = false;
  }

  /**
   * Starts a loaded video at its planned moment, or drops it if it is too late.
   * @param {{v: HTMLVideoElement, startTimer: number|null, deadline: number|null}} handle - The video's handle.
   * @param {number} playAt - Server time the video should have started at.
   * @returns {void}
   */
  function start(handle, playAt) {
    const plan = planSharedPlayback(serverNow(), playAt, maxLateMs);
    if (plan.action === 'skip') { finish(handle); return; }
    handle.startTimer = setTimeout(function () {
      const late = planSharedPlayback(serverNow(), playAt, maxLateMs);
      if (late.action === 'skip') { finish(handle); return; }
      clearTimeout(handle.deadline); // it is starting; the late limit no longer applies
      if (late.seekSeconds > 0) handle.v.currentTime = late.seekSeconds;
      handle.v.style.visibility = 'visible';
      handle.v.play().catch(function () { finish(handle); });
    }, plan.delayMs);
  }

  /**
   * Loads a video hidden, then starts it at `playAt`. Ignored while another is playing. A video
   * that has not become ready by `playAt` plus the late limit (a stalled load fires no event) is
   * dropped, so it can't hold the gate for ever.
   * @param {string} url - URL path of the video.
   * @param {number} playAt - Server time to start at.
   * @returns {void}
   */
  function play(url, playAt) {
    if (playing) return;
    playing = true;
    const v = document.createElement('video');
    const handle = { v: v, startTimer: null, deadline: null };
    current = handle;
    v.src = url;
    v.preload = 'auto';
    v.playsInline = true;
    v.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;visibility:hidden;';
    v.addEventListener('ended', function () { finish(handle); });
    v.addEventListener('error', function () { finish(handle); });
    v.addEventListener('canplay', function () { start(handle, playAt); }, { once: true });
    handle.deadline = setTimeout(function () { finish(handle); }, Math.max(0, playAt + maxLateMs - serverNow()));
    document.body.appendChild(v);
  }

  connectSse('/overlay/shared/' + login + '/events', function (data) {
    if (!data) return;
    if (data.type === 'init') {
      clockOffsetMs = data.serverTime - Date.now();
      if (typeof data.maxLateMs === 'number') maxLateMs = data.maxLateMs;
    } else if (data.type === 'play' && data.video) {
      play(data.video, data.playAt);
    }
  });
})();
