document.addEventListener('click', function (event) {
  var target = event.target;
  if (!(target instanceof Element)) return;

  var button = target.closest('.btn-toggle-counter-edit');
  if (!(button instanceof HTMLElement)) return;

  var counterId = button.getAttribute('data-counter-id');
  if (!counterId) return;

  var row = document.getElementById('counter-edit-' + counterId);
  if (!(row instanceof HTMLElement)) return;

  row.classList.toggle('is-hidden');

  var isOpen = !row.classList.contains('is-hidden');
  var openerButton = document.querySelector(
    '.btn-toggle-counter-edit[aria-expanded][data-counter-id="' + counterId + '"]'
  );
  if (openerButton instanceof HTMLElement) {
    openerButton.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
  }
});

document.addEventListener('submit', function (event) {
  if (confirmSubmit(event, 'js-confirm-remove-counter', function (t) {
    return 'Remove counter ' + (t.dataset.counterTrigger || 'this counter') + '?';
  })) return;
  confirmSubmit(event, 'js-confirm-reset-counter', function (t) {
    return 'Reset current value for ' + (t.dataset.counterTrigger || 'this counter') + ' to 0?';
  });
});
