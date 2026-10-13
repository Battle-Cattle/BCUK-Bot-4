registerToggleEditHandler('btn-toggle-command-edit', 'data-command-id', 'command-edit-');
registerUserHueBadges();

/** Confirms command removal before allowing the remove-command form to submit. */
document.addEventListener('submit', function (event) {
  confirmSubmit(event, 'js-confirm-remove-command', function (t) {
    return 'Remove command ' + (t.dataset.commandTrigger || 'this command') + '?';
  });
});
