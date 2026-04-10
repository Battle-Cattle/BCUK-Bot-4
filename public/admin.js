document.addEventListener('submit', function (event) {
  var target = event.target;
  if (!(target instanceof HTMLFormElement)) return;
  if (!target.classList.contains('js-confirm-remove-user')) return;

  var userName = target.dataset.userName || 'this user';
  if (!window.confirm('Remove ' + userName + '?')) {
    event.preventDefault();
  }
});

function syncTwitchNameControls(form) {
  if (!(form instanceof HTMLFormElement)) return;

  var twitchNameInput = form.querySelector('[data-twitch-name-input]');
  var clearTwitchNameInput = form.querySelector('[data-clear-twitch-name-input]');
  if (!(twitchNameInput instanceof HTMLInputElement) || !(clearTwitchNameInput instanceof HTMLInputElement)) {
    return;
  }

  var hasTwitchName = twitchNameInput.value.trim().length > 0;
  if (hasTwitchName) {
    clearTwitchNameInput.checked = false;
    clearTwitchNameInput.disabled = true;
    twitchNameInput.disabled = false;
    return;
  }

  if (clearTwitchNameInput.checked) {
    twitchNameInput.value = '';
    twitchNameInput.disabled = true;
    clearTwitchNameInput.disabled = false;
    return;
  }

  twitchNameInput.disabled = false;
  clearTwitchNameInput.disabled = false;
}

document.querySelectorAll('form[action="/admin/users/add"]').forEach(function (form) {
  if (!(form instanceof HTMLFormElement)) return;

  var twitchNameInput = form.querySelector('[data-twitch-name-input]');
  var clearTwitchNameInput = form.querySelector('[data-clear-twitch-name-input]');
  if (!(twitchNameInput instanceof HTMLInputElement) || !(clearTwitchNameInput instanceof HTMLInputElement)) {
    return;
  }

  twitchNameInput.addEventListener('input', function () {
    syncTwitchNameControls(form);
  });
  clearTwitchNameInput.addEventListener('change', function () {
    syncTwitchNameControls(form);
  });
  form.addEventListener('submit', function () {
    syncTwitchNameControls(form);
  });

  syncTwitchNameControls(form);
});

function scheduleRefreshStatusPolling(retryCount) {
  var refreshBanner = document.querySelector('[data-refresh-running="true"]');
  if (!refreshBanner) return;
  var attempt = typeof retryCount === 'number' ? retryCount : 0;

  window.setTimeout(function () {
    window.fetch('/admin/users/refresh-status', {
      headers: { Accept: 'application/json' }
    }).then(function (response) {
      var contentType = response.headers.get('content-type') || '';
      if (response.status === 401 || response.status === 403) {
        window.location.reload();
        return null;
      }
      // Treat HTML/error responses as terminal so expired sessions do not loop forever.
      if (!response.ok || contentType.indexOf('application/json') === -1) {
        refreshBanner.textContent = 'Refresh status unavailable. Reload the page to check progress.';
        return null;
      }
      return response.json();
    }).then(function (state) {
      if (!state) return;
      if (state.outcome === 'running') {
        scheduleRefreshStatusPolling(0);
        return;
      }
      window.location.reload();
    }).catch(function () {
      if (attempt >= 4) {
        refreshBanner.textContent = 'Refresh status unavailable. Reload the page to check progress.';
        return;
      }
      scheduleRefreshStatusPolling(attempt + 1);
    });
  }, 2000);
}

scheduleRefreshStatusPolling(0);
