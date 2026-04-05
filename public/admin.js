document.addEventListener('submit', function (event) {
  var target = event.target;
  if (!(target instanceof HTMLFormElement)) return;
  if (!target.classList.contains('js-confirm-remove-user')) return;

  var userName = target.dataset.userName || 'this user';
  if (!window.confirm('Remove ' + userName + '?')) {
    event.preventDefault();
  }
});

function scheduleRefreshStatusPolling() {
  var refreshBanner = document.querySelector('[data-refresh-running="true"]');
  if (!refreshBanner) return;

  window.setTimeout(function () {
    window.fetch('/admin/users/refresh-status', {
      headers: { Accept: 'application/json' }
    }).then(function (response) {
      if (!response.ok) throw new Error('Failed to read refresh status');
      return response.json();
    }).then(function (state) {
      if (state && state.outcome === 'running') {
        scheduleRefreshStatusPolling();
        return;
      }
      window.location.reload();
    }).catch(function () {
      scheduleRefreshStatusPolling();
    });
  }, 2000);
}

scheduleRefreshStatusPolling();
