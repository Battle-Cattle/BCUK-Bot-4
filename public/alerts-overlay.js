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
  // Own animation-duration (ms) of each one-shot per-letter entrance, matching the `animation:`
  // shorthand duration in alertsOverlaySource.css. 'wave' loops forever (no completion to reach)
  // so it's intentionally not listed here; only entrances need their per-letter delay capped
  // against the alert's durationMs -- otherwise a long message can still be mid-reveal when the
  // card is removed.
  const PER_LETTER_ENTRANCE_DURATION_MS = { 'bounce-in': 600, typewriter: 150 };

  /**
   * Fills `message` with `text`, rendering it per the requested animation style: a per-letter
   * animation (see {@link PER_LETTER_ANIMATION_STEP_S}) splits `text` into Unicode code points
   * (via `Array.from`, so a surrogate-pair character like most emoji stays intact instead of
   * being torn into two lone-surrogate spans) and wraps each in its own `<span class="letter">`
   * with a staggered `animation-delay` so the CSS keyframes ripple across the text; a
   * whole-element animation (see {@link WHOLE_ELEMENT_ANIMATIONS}) just adds a class driving a
   * single looping CSS animation on `message` itself; anything else (including `'none'` or an
   * unrecognised value) renders as plain, unanimated text.
   *
   * For a one-shot per-letter entrance (bounce-in/typewriter -- see
   * {@link PER_LETTER_ENTRANCE_DURATION_MS}), the per-letter stagger is capped so the LAST
   * letter's delay plus its own entrance duration still lands within `durationMs`, leaving room
   * to actually see the fully-revealed message before the card starts fading out; without this,
   * a long message at a short/default duration would have its tail never finish revealing.
   *
   * @param {HTMLElement} message - The `.alert-message` element to fill.
   * @param {string} text - The already-filled alert text to render.
   * @param {string} [animation] - One of the values in {@link PER_LETTER_ANIMATION_STEP_S} or
   *   {@link WHOLE_ELEMENT_ANIMATIONS}, or anything else for no animation.
   * @param {number} [durationMs] - The alert's total on-screen time, used to cap the per-letter
   *   stagger for one-shot entrance animations. Ignored for 'wave' and whole-element animations.
   * @returns {void}
   */
  function renderAlertMessage(message, text, animation, durationMs) {
    const perLetterStep = PER_LETTER_ANIMATION_STEP_S[animation];
    if (perLetterStep === undefined) {
      message.textContent = text;
      if (WHOLE_ELEMENT_ANIMATIONS.indexOf(animation) !== -1) message.classList.add('anim-' + animation);
      return;
    }
    message.classList.add('anim-' + animation);
    // Array.from splits by Unicode code point (surrogate-pair aware), unlike raw string
    // indexing/`.length`, which would tear an astral-plane character across two spans.
    const letters = Array.from(text);
    const entranceMs = PER_LETTER_ENTRANCE_DURATION_MS[animation] || 0;
    let stepS = perLetterStep;
    if (entranceMs > 0 && letters.length > 1) {
      // Reserve some of durationMs as actual display time after the reveal finishes (the 0.7
      // factor), rather than letting the last letter's entrance finish right as fade-out starts.
      const availableMs = (typeof durationMs === 'number' && durationMs > 0 ? durationMs : 6000) * 0.7;
      const maxLastDelayMs = Math.max(0, availableMs - entranceMs);
      stepS = Math.min(perLetterStep, maxLastDelayMs / (letters.length - 1) / 1000);
    }
    letters.forEach(function (ch, i) {
      const span = document.createElement('span');
      span.className = 'letter';
      span.style.animationDelay = (i * stepS) + 's';
      // A plain space collapses visually once wrapped in an inline-block span -- a non-breaking
      // space renders with the same width but keeps the per-letter timing intact.
      span.textContent = ch === ' ' ? '\u00A0' : ch;
      message.appendChild(span);
    });
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

    const durationMs = typeof alert.durationMs === 'number' && alert.durationMs > 0 ? alert.durationMs : 6000;

    const card = document.createElement('div');
    card.className = 'alert-card';

    if (alert.imageUrl) {
      const img = document.createElement('img');
      img.src = alert.imageUrl;
      card.appendChild(img);
    }

    const message = document.createElement('div');
    message.className = 'alert-message';
    renderAlertMessage(message, alert.message, alert.textAnimation, durationMs);
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
