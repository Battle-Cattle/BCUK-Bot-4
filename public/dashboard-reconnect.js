/** Hides the Twitch reconnect modal, if it's on the page. */
function hideReconnectModal() {
  var modal = document.getElementById('reconnect-modal');
  if (modal) modal.style.display = 'none';
}

// Keep it hidden on load if the user already dismissed it earlier this session.
if (sessionStorage.getItem('twitch_reconnect_dismissed')) hideReconnectModal();

var dismissReconnectBtn = document.getElementById('dismiss-reconnect-modal');
if (dismissReconnectBtn) {
  /** Persists the reconnect-modal dismissal for this session and hides the modal. */
  dismissReconnectBtn.addEventListener('click', function () {
    sessionStorage.setItem('twitch_reconnect_dismissed', '1');
    hideReconnectModal();
  });
}
