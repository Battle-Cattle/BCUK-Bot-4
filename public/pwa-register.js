(function () {
  if (!('serviceWorker' in navigator)) {
    return;
  }

  var UPDATE_INTERVAL_MS = 30 * 60 * 1000;
  var hasRefreshingController = false;

  function forceActivateWaitingWorker(registration) {
    if (!registration || !registration.waiting) {
      return;
    }

    registration.waiting.postMessage({ type: 'SKIP_WAITING' });
  }

  function watchInstallingWorker(registration) {
    if (!registration || !registration.installing) {
      return;
    }

    registration.installing.addEventListener('statechange', function () {
      if (registration.waiting) {
        forceActivateWaitingWorker(registration);
      }
    });
  }

  function scheduleUpdateChecks(registration) {
    if (!registration) {
      return;
    }

    window.setInterval(function () {
      registration.update().catch(function (error) {
        console.warn('[PWA] Service worker update check failed:', error);
      });
    }, UPDATE_INTERVAL_MS);

    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) {
        registration.update().catch(function (error) {
          console.warn('[PWA] Service worker update check failed:', error);
        });
      }
    });
  }

  window.addEventListener('load', function () {
    navigator.serviceWorker
      .register('/service-worker.js')
      .then(function (registration) {
        navigator.serviceWorker.addEventListener('controllerchange', function () {
          if (hasRefreshingController) {
            return;
          }

          hasRefreshingController = true;
          window.location.reload();
        });

        registration.addEventListener('updatefound', function () {
          watchInstallingWorker(registration);
        });

        forceActivateWaitingWorker(registration);

        registration.update().catch(function (error) {
          console.warn('[PWA] Initial service worker update check failed:', error);
        });

        scheduleUpdateChecks(registration);
      })
      .catch(function (error) {
        console.error('[PWA] Service worker registration failed:', error);
      });
  });
})();
