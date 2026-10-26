(function () {
  if (!('serviceWorker' in navigator)) {
    return;
  }

  var UPDATE_INTERVAL_MS = 30 * 60 * 1000;
  var hasRefreshingController = false;

  /**
   * Tells a waiting service worker to activate now instead of after every tab closes.
   * @param registration - The page's ServiceWorkerRegistration; ignored when it has no waiting worker.
   */
  function forceActivateWaitingWorker(registration) {
    if (!registration || !registration.waiting) {
      return;
    }

    registration.waiting.postMessage({ type: 'SKIP_WAITING' });
  }

  /**
   * Activates a service worker as soon as it finishes installing.
   * @param registration - The page's ServiceWorkerRegistration; ignored when nothing is installing.
   */
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

  /**
   * Asks the browser to re-check for a newer service worker, logging (not throwing) on failure.
   * @param registration - The page's ServiceWorkerRegistration to re-check.
   */
  function checkForUpdate(registration) {
    registration.update().catch(function (error) {
      console.warn('[PWA] Service worker update check failed:', error);
    });
  }

  /**
   * Checks for a new service worker every UPDATE_INTERVAL_MS, and whenever the page becomes visible again.
   * @param registration - The page's ServiceWorkerRegistration to re-check periodically.
   */
  function scheduleUpdateChecks(registration) {
    window.setInterval(function () {
      checkForUpdate(registration);
    }, UPDATE_INTERVAL_MS);

    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) checkForUpdate(registration);
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
        checkForUpdate(registration);
        scheduleUpdateChecks(registration);
      })
      .catch(function (error) {
        console.error('[PWA] Service worker registration failed:', error);
      });
  });
})();
