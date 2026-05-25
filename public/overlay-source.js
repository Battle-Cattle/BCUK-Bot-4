(function () {
  const script = document.currentScript;
  const login = script ? script.dataset.login : '';
  if (!login) return;

  const queue = [];
  let playing = false;

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

  function connect() {
    const es = new EventSource('/overlay/' + login + '/events');

    es.onmessage = function (e) {
      try {
        const data = JSON.parse(e.data);
        if (data.video) {
          queue.push(data.video);
          playNext();
        }
      } catch (_) {}
    };

    es.onerror = function () {
      es.close();
      // Reconnect with exponential backoff (2s → 4s → 8s → cap 30s)
      const delay = Math.min(30000, (connect.retryMs = (connect.retryMs || 1000) * 2));
      setTimeout(connect, delay);
    };

    es.onopen = function () {
      connect.retryMs = 1000;
    };
  }

  connect();
})();
