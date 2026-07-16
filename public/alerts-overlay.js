(function () {
  const script = document.currentScript;
  const login = script ? script.dataset.login : '';
  if (!login) return;

  const queue = [];
  let playing = false;

  // Animations whose motion ripples per-character (each gets its own <span class="letter">,
  // staggered by this many seconds per character) vs. ones that just loop/play on the whole
  // `.alert-message` element as a single unit. 'wave'/'pulse'/'glitch' shipped first; the rest
  // add more variety: 'shake'/'rainbow'/'flicker'/'tilt' are continuous whole-element loops
  // like pulse/glitch, while 'bounce-in'/'typewriter' are per-letter one-shot entrances like
  // wave's per-letter split, but play once instead of looping (see alertsOverlaySource.css).
  const PER_LETTER_ANIMATION_STEP_S = { wave: 0.05, 'bounce-in': 0.04, typewriter: 0.03 };
  const WHOLE_ELEMENT_ANIMATIONS = ['pulse', 'glitch', 'shake', 'rainbow', 'flicker', 'tilt'];

  /**
   * Fills `message` with `text`, rendering it per the requested animation style: a per-letter
   * animation (see {@link PER_LETTER_ANIMATION_STEP_S}) wraps each character in its own
   * `<span class="letter">` with a staggered `animation-delay` so the CSS keyframes ripple
   * across the text; a whole-element animation (see {@link WHOLE_ELEMENT_ANIMATIONS}) just adds
   * a class driving a single looping CSS animation on `message` itself; anything else (including
   * `'none'` or an unrecognised value) renders as plain, unanimated text.
   * @param {HTMLElement} message - The `.alert-message` element to fill.
   * @param {string} text - The already-filled alert text to render.
   * @param {string} [animation] - One of the values in {@link PER_LETTER_ANIMATION_STEP_S} or
   *   {@link WHOLE_ELEMENT_ANIMATIONS}, or anything else for no animation.
   * @returns {void}
   */
  function renderAlertMessage(message, text, animation) {
    const perLetterStep = PER_LETTER_ANIMATION_STEP_S[animation];
    if (perLetterStep === undefined) {
      message.textContent = text;
      if (WHOLE_ELEMENT_ANIMATIONS.indexOf(animation) !== -1) message.classList.add('anim-' + animation);
      return;
    }
    message.classList.add('anim-' + animation);
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      const span = document.createElement('span');
      span.className = 'letter';
      span.style.animationDelay = (i * perLetterStep) + 's';
      // A plain space collapses visually once wrapped in an inline-block span — a non-breaking
      // space renders with the same width but keeps the per-letter timing intact.
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
