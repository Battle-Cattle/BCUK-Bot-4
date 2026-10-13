registerToggleEditHandler('btn-toggle-command-edit', 'data-command-id', 'command-edit-');
registerUserHueBadges();

document.addEventListener('submit', function (event) {
  confirmSubmit(event, 'js-confirm-remove-command', function (t) {
    return 'Remove command ' + (t.dataset.commandTrigger || 'this command') + '?';
  });
});
