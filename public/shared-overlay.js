/* global connectSse, planSharedPlayback */
(function () {
  const script = document.currentScript;
  const login = script ? script.dataset.login : '';
  if (!login) return;

  let clockOffsetMs = 0; // server time minus local time
  let maxLateMs = 3000;
  let playing = false;

  /**
   * Current time on the server's clock.
   * @returns {number} Estimated server epoch milliseconds.
   */
  function serverNow() {
    return Date.now() + clockOffsetMs;
  }

  /**
   * Starts a loaded video at its planned moment, or drops it if it is too late.
   * @param {HTMLVideoElement} v - The loaded, hidden video element.
   * @param {number} playAt - Server time the video should have started at.
   * @returns {void}
   */
  function start(v, playAt) {
    const plan = planSharedPlayback(serverNow(), playAt, maxLateMs);
    if (plan.action === 'skip') { finish(v); return; }
    setTimeout(function () {
      const late = planSharedPlayback(serverNow(), playAt, maxLateMs);
      if (late.action === 'skip') { finish(v); return; }
      if (late.seekSeconds > 0) v.currentTime = late.seekSeconds;
      v.style.visibility = 'visible';
      v.play().catch(function () { finish(v); });
    }, plan.delayMs);
  }

  /**
   * Removes a video and allows the next one to play.
   * @param {HTMLVideoElement} v - The video element to remove.
   * @returns {void}
   */
  function finish(v) {
    v.remove();
    playing = false;
  }

  /**
   * Loads a video hidden, then starts it at `playAt`. Ignored while another is playing.
   * @param {string} url - URL path of the video.
   * @param {number} playAt - Server time to start at.
   * @returns {void}
   */
  function play(url, playAt) {
    if (playing) return;
    playing = true;
    const v = document.createElement('video');
    v.src = url;
    v.preload = 'auto';
    v.playsInline = true;
    v.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;visibility:hidden;';
    v.addEventListener('ended', function () { finish(v); });
    v.addEventListener('error', function () { finish(v); });
    v.addEventListener('canplay', function () { start(v, playAt); }, { once: true });
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
