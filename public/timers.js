registerToggleEditHandler('btn-toggle-timer-edit', 'data-timer-id', 'timer-edit-');
registerUserHueBadges();

/** Confirms timer removal before allowing the remove-timer form to submit. */
document.addEventListener('submit', function (event) {
  confirmSubmit(event, 'js-confirm-remove-timer', function (t) {
    return 'Remove timer ' + (t.dataset.timerName || 'this timer') + '?';
  });
});
