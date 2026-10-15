/* global confirmSubmit */
/** Confirms before allowing a leaderboard "Exclude bot" form to submit. */
document.addEventListener('submit', function (event) {
  confirmSubmit(event, 'js-confirm-exclude-bot', function (t) {
    return 'Exclude ' + (t.dataset.twitchUsername || 'this account') +
      ' as a bot? It will stop earning points and be hidden from the leaderboard.';
  });
});
