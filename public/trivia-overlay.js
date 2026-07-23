(function () {
  const script = document.currentScript;
  const login = script ? script.dataset.login : '';
  if (!login) return;

  const root = document.createElement('div');
  root.className = 'trivia-root';
  document.body.appendChild(root);

  /** Removes every child of `el`. */
  function clear(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  /** Renders the idle placeholder shown between rounds. */
  function renderIdle() {
    clear(root);
    const card = document.createElement('div');
    card.className = 'trivia-card trivia-idle';
    const message = document.createElement('div');
    message.className = 'trivia-idle-message';
    message.textContent = 'Next question coming up…';
    card.appendChild(message);
    root.appendChild(card);
  }

  /**
   * Renders an active question: category, question text, four lettered choices, and a
   * countdown bar that animates from full to empty over `questionSeconds`.
   */
  function renderQuestion(data) {
    clear(root);
    const card = document.createElement('div');
    card.className = 'trivia-card trivia-question';

    const category = document.createElement('div');
    category.className = 'trivia-category';
    category.textContent = data.category || 'Trivia';
    card.appendChild(category);

    const question = document.createElement('div');
    question.className = 'trivia-question-text';
    question.textContent = data.question;
    card.appendChild(question);

    const choices = document.createElement('div');
    choices.className = 'trivia-choices';
    (data.choices || []).forEach(function (choice) {
      const choiceEl = document.createElement('div');
      choiceEl.className = 'trivia-choice';
      const letter = document.createElement('span');
      letter.className = 'trivia-choice-letter';
      letter.textContent = choice.letter;
      const text = document.createElement('span');
      text.className = 'trivia-choice-text';
      text.textContent = choice.text;
      choiceEl.appendChild(letter);
      choiceEl.appendChild(text);
      choices.appendChild(choiceEl);
    });
    card.appendChild(choices);

    const timerTrack = document.createElement('div');
    timerTrack.className = 'trivia-timer-track';
    const timerBar = document.createElement('div');
    timerBar.className = 'trivia-timer-bar';
    timerTrack.appendChild(timerBar);
    card.appendChild(timerTrack);

    root.appendChild(card);

    const seconds = typeof data.questionSeconds === 'number' && data.questionSeconds > 0 ? data.questionSeconds : 20;
    // A single rAF isn't reliable here: the freshly-inserted bar's initial 100% width can still
    // get coalesced with this callback's own mutation into one style recalc, skipping straight to
    // the 0% end state with no visible animation. Nesting a second rAF guarantees a style/layout
    // pass in between, so the 100% width is actually committed before the transition to 0% starts.
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        timerBar.style.transitionDuration = seconds + 's';
        timerBar.style.width = '0%';
      });
    });
  }

  /**
   * Renders the reveal state: the correct answer highlighted (and every other choice marked
   * wrong), a winner banner (or a "no one answered" message), and the current session scoreboard.
   */
  function renderReveal(data) {
    clear(root);
    const card = document.createElement('div');
    card.className = 'trivia-card trivia-reveal';

    const banner = document.createElement('div');
    banner.className = 'trivia-banner';
    banner.textContent = data.winner ? ('🏆 ' + data.winner + ' got it first!') : 'No one answered in time!';
    card.appendChild(banner);

    const choices = document.createElement('div');
    choices.className = 'trivia-choices';
    (data.choices || []).forEach(function (choice) {
      const isCorrect = choice.letter === data.correctLetter;
      const choiceEl = document.createElement('div');
      choiceEl.className = 'trivia-choice ' + (isCorrect ? 'is-correct' : 'is-wrong');
      const letter = document.createElement('span');
      letter.className = 'trivia-choice-letter';
      letter.textContent = choice.letter;
      const text = document.createElement('span');
      text.className = 'trivia-choice-text';
      text.textContent = choice.text;
      choiceEl.appendChild(letter);
      choiceEl.appendChild(text);
      choices.appendChild(choiceEl);
    });
    card.appendChild(choices);

    if (Array.isArray(data.scoreboard) && data.scoreboard.length > 0) {
      const scoreboard = document.createElement('div');
      scoreboard.className = 'trivia-scoreboard';
      data.scoreboard.forEach(function (entry) {
        const row = document.createElement('div');
        row.className = 'trivia-scoreboard-row';
        const name = document.createElement('span');
        name.className = 'trivia-scoreboard-name';
        name.textContent = entry.username;
        const score = document.createElement('span');
        score.className = 'trivia-scoreboard-score';
        score.textContent = entry.score;
        row.appendChild(name);
        row.appendChild(score);
        scoreboard.appendChild(row);
      });
      card.appendChild(scoreboard);
    }

    root.appendChild(card);
  }

  renderIdle();

  // Forwards the page's own query string (e.g. `?guild=...`, pasted from the guild's dashboard
  // to play a synchronized round with other streamers) onto the SSE connection, so the server
  // sees the same opt-in without any extra markup needed on this script tag.
  connectSse('/trivia/' + login + '/events' + location.search, function (data) {
    if (!data || typeof data.type !== 'string') return;
    if (data.type === 'question') renderQuestion(data);
    else if (data.type === 'reveal') renderReveal(data);
    else if (data.type === 'idle') renderIdle();
  });
})();
