(function () {
  const script = document.currentScript;
  const login = script ? script.dataset.login : '';
  if (!login) return;

  const queue = [];
  let playing = false;

  function playNext() {
    if (playing || queue.length === 0) return;
    const alert = queue.shift();
    playing = true;

    const card = document.createElement('div');
    card.className = 'alert-card';

    if (alert.imageUrl) {
      const img = document.createElement('img');
      img.src = alert.imageUrl;
      card.appendChild(img);
    }

    const message = document.createElement('div');
    message.className = 'alert-message';
    message.textContent = alert.message;
    card.appendChild(message);

    document.body.appendChild(card);

    let audio;
    if (alert.soundUrl) {
      audio = new Audio(alert.soundUrl);
      audio.play().catch(function () {});
    }

    // Force layout before adding the visible class so the CSS transition actually plays.
    requestAnimationFrame(function () {
      card.classList.add('is-visible');
    });

    const durationMs = typeof alert.durationMs === 'number' && alert.durationMs > 0 ? alert.durationMs : 6000;

    setTimeout(function () {
      card.classList.remove('is-visible');
      setTimeout(function () {
        card.remove();
        if (audio) audio.pause();
        playing = false;
        playNext();
      }, 300); // matches the CSS transition duration
    }, durationMs);
  }

  function connect() {
    const es = new EventSource('/alerts/' + login + '/events');

    es.onmessage = function (e) {
      try {
        const data = JSON.parse(e.data);
        if (data && data.message) {
          queue.push(data);
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
