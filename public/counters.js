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
  var target = event.target;
  if (!(target instanceof HTMLFormElement)) return;

  if (target.classList.contains('js-confirm-remove-counter')) {
    var triggerString = target.dataset.counterTrigger || 'this counter';
    if (!window.confirm('Remove counter ' + triggerString + '?')) {
      event.preventDefault();
    }
    return;
  }

  if (target.classList.contains('js-confirm-reset-counter')) {
    var resetTriggerString = target.dataset.counterTrigger || 'this counter';
    if (!window.confirm('Reset current value for ' + resetTriggerString + ' to 0?')) {
      event.preventDefault();
    }
  }
});
