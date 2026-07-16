(function () {
  const script = document.currentScript;
  const login = script ? script.dataset.login : '';
  if (!login) return;

  const queue = [];
  let playing = false;

  /**
   * Plays the next queued video full-screen, removing it and advancing the queue once it ends
   * or errors. No-ops if a video is already playing or the queue is empty.
   * @returns {void}
   */
  function playNext() {
    if (playing || queue.length === 0) return;
    const videoUrl = queue.shift();
    playing = true;

    const v = document.createElement('video');
    v.src = videoUrl;
    v.autoplay = true;
    v.playsInline = true;
    v.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;';

    v.addEventListener('ended', () => {
      v.remove();
      playing = false;
      playNext();
    });

    v.addEventListener('error', () => {
      v.remove();
      playing = false;
      playNext();
    });

    document.body.appendChild(v);
  }

  connectSse('/overlay/' + login + '/events', function (data) {
    if (data && data.video) {
      queue.push(data.video);
      playNext();
    }
  });
})();
