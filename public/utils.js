function confirmSubmit(event, className, buildMessage) {
  var target = event.target;
  if (!(target instanceof HTMLFormElement)) return false;
  if (!target.classList.contains(className)) return false;
  if (!window.confirm(buildMessage(target))) event.preventDefault();
  return true;
}

/**
 * Wires a button to copy the text content of another element to the clipboard,
 * with brief "Copied!" feedback and a fallback alert when the Clipboard API is
 * unavailable or the write is rejected.
 * @param {string} buttonId - ID of the button element to attach the click handler to.
 * @param {string} sourceId - ID of the element whose textContent will be copied.
 * @param {string} idleLabel - Label to restore on the button after the "Copied!" feedback.
 * @returns {void}
 */
function registerCopyToClipboardHandler(buttonId, sourceId, idleLabel) {
  var button = document.getElementById(buttonId);
  if (!button) return;
  button.addEventListener('click', function () {
    var sourceEl = document.getElementById(sourceId);
    var text = sourceEl ? sourceEl.textContent : '';
    if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
      alert('Could not copy automatically — please copy it manually.');
      return;
    }
    navigator.clipboard.writeText(text).then(function () {
      button.textContent = 'Copied!';
      setTimeout(function () { button.textContent = idleLabel; }, 2000);
    }).catch(function () { alert('Could not copy automatically — please copy it manually.'); });
  });
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
