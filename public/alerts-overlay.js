(function () {
  const script = document.currentScript;
  const login = script ? script.dataset.login : '';
  if (!login) return;

  const queue = [];
  let playing = false;
  const KNOWN_ANIMATIONS = ['wave', 'pulse', 'glitch'];

  /**
   * Fills `message` with `text`, rendering it per the requested animation style. `'wave'` wraps
   * each character in its own `<span class="letter">` with a staggered `animation-delay` so the
   * CSS wave keyframes ripple across the text; `'pulse'`/`'glitch'` just add a class driving a
   * whole-element looping CSS animation, and plain text otherwise. Any value outside
   * {@link KNOWN_ANIMATIONS} is treated as no animation.
   * @param {HTMLElement} message - The `.alert-message` element to fill.
   * @param {string} text - The already-filled alert text to render.
   * @param {string} [animation] - `'wave' | 'pulse' | 'glitch'`, or anything else for none.
   * @returns {void}
   */
  function renderAlertMessage(message, text, animation) {
    if (animation !== 'wave') {
      message.textContent = text;
      if (KNOWN_ANIMATIONS.indexOf(animation) !== -1) message.classList.add('anim-' + animation);
      return;
    }
    message.classList.add('anim-wave');
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      const span = document.createElement('span');
      span.className = 'letter';
      span.style.animationDelay = (i * 0.05) + 's';
      // A plain space collapses visually once wrapped in an inline-block span — a non-breaking
      // space renders with the same width but keeps the wave's per-letter timing intact.
      span.textContent = ch === ' ' ? '\u00A0' : ch;
      message.appendChild(span);
    }
  }

  /**
   * Renders the next queued alert card (image + message, with sound if configured), animating
   * it in and out and advancing the queue once its display duration elapses. No-ops if a card
   * is already showing or the queue is empty.
   * @returns {void}
   */
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
    renderAlertMessage(message, alert.message, alert.textAnimation);
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

  connectSse('/alerts/' + login + '/events', function (data) {
    if (data && data.message) {
      queue.push(data);
      playNext();
    }
  });
})();
