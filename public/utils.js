function confirmSubmit(event, className, buildMessage) {
  var target = event.target;
  if (!(target instanceof HTMLFormElement)) return false;
  if (!target.classList.contains(className)) return false;
  if (!window.confirm(buildMessage(target))) event.preventDefault();
  return true;
}

function registerToggleEditHandler(buttonClass, idAttr, rowPrefix) {
  document.addEventListener('click', function (event) {
    var target = event.target;
    if (!(target instanceof Element)) return;

    var button = target.closest('.' + buttonClass);
    if (!(button instanceof HTMLElement)) return;

    var itemId = button.getAttribute(idAttr);
    if (!itemId) return;

    var row = document.getElementById(rowPrefix + itemId);
    if (!(row instanceof HTMLElement)) return;

    row.classList.toggle('is-hidden');

    var isOpen = !row.classList.contains('is-hidden');
    var openerButton = document.querySelector(
      '.' + buttonClass + '[aria-expanded][' + idAttr + '="' + itemId + '"]'
    );
    if (openerButton instanceof HTMLElement) {
      openerButton.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    }
  });
}
