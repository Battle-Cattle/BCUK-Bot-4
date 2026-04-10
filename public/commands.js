document.addEventListener('click', function (event) {
  var target = event.target;
  if (!(target instanceof Element)) return;

  var button = target.closest('.btn-toggle-command-edit');
  if (!(button instanceof HTMLElement)) return;

  var commandId = button.getAttribute('data-command-id');
  if (!commandId) return;

  var row = document.getElementById('command-edit-' + commandId);
  if (!(row instanceof HTMLElement)) return;

  row.style.display = row.style.display === 'none' ? '' : 'none';
});

document.addEventListener('submit', function (event) {
  var target = event.target;
  if (!(target instanceof HTMLFormElement)) return;
  if (!target.classList.contains('js-confirm-remove-command')) return;

  var triggerString = target.dataset.commandTrigger || 'this command';
  if (!window.confirm('Remove command ' + triggerString + '?')) {
    event.preventDefault();
  }
});
