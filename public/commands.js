registerToggleEditHandler('btn-toggle-command-edit', 'data-command-id', 'command-edit-');
registerUserHueBadges();

document.addEventListener('submit', function (event) {
  var target = event.target;
  if (!(target instanceof HTMLFormElement)) return;
  if (!target.classList.contains('js-confirm-remove-command')) return;

  var triggerString = target.dataset.commandTrigger || 'this command';
  if (!window.confirm('Remove command ' + triggerString + '?')) {
    event.preventDefault();
  }
});
