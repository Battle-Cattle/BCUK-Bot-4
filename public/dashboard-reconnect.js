(function () {
  if (sessionStorage.getItem('twitch_reconnect_dismissed')) {
    var modal = document.getElementById('reconnect-modal');
    if (modal) modal.style.display = 'none';
  }
})();

var dismissReconnectBtn = document.getElementById('dismiss-reconnect-modal');
if (dismissReconnectBtn) {
  dismissReconnectBtn.addEventListener('click', function () {
    sessionStorage.setItem('twitch_reconnect_dismissed', '1');
    var modal = document.getElementById('reconnect-modal');
    if (modal) modal.style.display = 'none';
  });
}
