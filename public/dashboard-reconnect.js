/** Hides the reconnect modal on load if the user already dismissed it earlier this session. */
(function () {
  if (sessionStorage.getItem('twitch_reconnect_dismissed')) {
    var modal = document.getElementById('reconnect-modal');
    if (modal) modal.style.display = 'none';
  }
})();

var dismissReconnectBtn = document.getElementById('dismiss-reconnect-modal');
if (dismissReconnectBtn) {
  /** Persists the reconnect-modal dismissal for this session and hides the modal. */
  dismissReconnectBtn.addEventListener('click', function () {
    sessionStorage.setItem('twitch_reconnect_dismissed', '1');
    var modal = document.getElementById('reconnect-modal');
    if (modal) modal.style.display = 'none';
  });
}
