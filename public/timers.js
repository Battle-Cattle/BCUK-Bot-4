registerToggleEditHandler('btn-toggle-timer-edit', 'data-timer-id', 'timer-edit-');

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
  if (!target.classList.contains('js-confirm-remove-timer')) return;

  var timerName = target.dataset.timerName || 'this timer';
  if (!window.confirm('Remove timer ' + timerName + '?')) {
    event.preventDefault();
  }
});
