registerToggleEditHandler('btn-toggle-counter-edit', 'data-counter-id', 'counter-edit-');

document.addEventListener('submit', function (event) {
  if (confirmSubmit(event, 'js-confirm-remove-counter', function (t) {
    return 'Remove counter ' + (t.dataset.counterTrigger || 'this counter') + '?';
  })) return;
  confirmSubmit(event, 'js-confirm-reset-counter', function (t) {
    return 'Reset current value for ' + (t.dataset.counterTrigger || 'this counter') + ' to 0?';
  });
});
