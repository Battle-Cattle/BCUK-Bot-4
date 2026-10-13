registerToggleEditHandler('btn-toggle-timer-edit', 'data-timer-id', 'timer-edit-');
registerUserHueBadges();

document.addEventListener('submit', function (event) {
  confirmSubmit(event, 'js-confirm-remove-timer', function (t) {
    return 'Remove timer ' + (t.dataset.timerName || 'this timer') + '?';
  });
});
