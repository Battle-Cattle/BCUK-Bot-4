/* global confirmSubmit */
/** Confirms user removal before allowing the remove-user form to submit. */
document.addEventListener('submit', function (event) {
  confirmSubmit(event, 'js-confirm-remove-user', function (t) {
    return 'Remove ' + (t.dataset.userName || 'this user') + '?';
  });
});

/**
 * Keeps an add-user form's Twitch name input and "clear Twitch name" checkbox mutually exclusive.
 * @param {HTMLFormElement} form - The add-user form.
 * @returns {void}
 */
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

/**
 * Parses a refresh-status poll response, reloading on an auth failure and showing a terminal
 * message on any other non-JSON/error response.
 * @param {Element} refreshBanner - The "refresh running" banner element.
 * @param {Response} response - The fetch response.
 * @returns {Promise<object>|null} The parsed state, or null when polling should stop.
 */
function parseRefreshStatusResponse(refreshBanner, response) {
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
}

/**
 * Keeps polling while the refresh is still running, otherwise reloads to show the outcome.
 * @param {{ outcome?: string } | null} state - Parsed refresh state, or null to stop.
 * @returns {void}
 */
function applyRefreshState(state) {
  if (state && state.outcome === 'running') {
    scheduleRefreshStatusPolling(0);
  } else if (state) {
    window.location.reload();
  }
}

/**
 * Polls the user-refresh status every 2s while the "refresh running" banner is shown, giving
 * up after 5 consecutive network failures.
 * @param {number} retryCount - Consecutive failed attempts so far.
 * @returns {void}
 */
function scheduleRefreshStatusPolling(retryCount) {
  var refreshBanner = document.querySelector('[data-refresh-running="true"]');
  if (!refreshBanner) return;
  var attempt = typeof retryCount === 'number' ? retryCount : 0;

  window.setTimeout(function () {
    window.fetch('/admin/users/refresh-status', {
      headers: { Accept: 'application/json' }
    }).then(function (response) {
      return parseRefreshStatusResponse(refreshBanner, response);
    }).then(function (state) {
      applyRefreshState(state);
    }).catch(function () {
      if (attempt >= 4) {
        refreshBanner.textContent = 'Refresh status unavailable. Reload the page to check progress.';
      } else {
        scheduleRefreshStatusPolling(attempt + 1);
      }
    });
  }, 2000);
}

scheduleRefreshStatusPolling(0);
