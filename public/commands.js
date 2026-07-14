registerToggleEditHandler('btn-toggle-command-edit', 'data-command-id', 'command-edit-');

// Per-user badge color is a hash of the Discord ID, applied via the CSSOM (element.style)
// rather than an inline style="" attribute, so it works under CSP style-src without 'unsafe-inline'.
document.querySelectorAll('.badge-user-hue[data-user-hue]').forEach(function (el) {
  var discordId = el.dataset.userHue;
  var h = 5381;
  for (var i = 0; i < discordId.length; i++) {
    h = ((h << 5) + h) ^ discordId.charCodeAt(i);
    h >>>= 0;
  }
  el.style.setProperty('--hue', h % 360);
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
