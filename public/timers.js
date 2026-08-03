registerToggleEditHandler('btn-toggle-timer-edit', 'data-timer-id', 'timer-edit-');
registerUserHueBadges();

document.addEventListener('submit', function (event) {
  var target = event.target;
  if (!(target instanceof HTMLFormElement)) return;
  if (!target.classList.contains('js-confirm-remove-timer')) return;

  var timerName = target.dataset.timerName || 'this timer';
  if (!window.confirm('Remove timer ' + timerName + '?')) {
    event.preventDefault();
  }
});
