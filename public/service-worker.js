const APP_CACHE_PREFIX = 'bcuk-panel-';
// Substituted server-side (see src/web/routes/serviceWorker.ts) with a hash of every file
// under public/, so any static-asset change automatically busts old caches — no manual
// version bump to remember. If this file is ever served as-is (bypassing that route), the
// literal placeholder below is still a valid, if non-rotating, cache name.
const CACHE_VERSION = 'bcuk-panel-__CACHE_VERSION__';
const STATIC_CACHE = `${CACHE_VERSION}-static`;

const STATIC_EXTENSIONS = ['.css', '.js', '.json', '.png', '.svg', '.woff2'];
// Non-navigation requests under these prefixes always go straight to the network, never the
// static-asset cache: '/api', '/auth' and '/admin' are per-user/state-changing, and '/dashboard'
// and '/channel-points' carry live SSE endpoints. '/' renders the per-user dashboard (CSRF token,
// recent-activity feed), so a script fetch('/') must not be cached past logout either.
const BYPASS_PATH_PREFIXES = ['/api', '/auth', '/admin', '/dashboard', '/channel-points', '/'];

const STATIC_ASSETS = [
  '/offline.html',
  '/style.css',
  '/dashboard-utils.js',
  '/dashboard-status.js',
  '/dashboard-voice.js',
  '/dashboard-events.js',
  '/app.js',
  '/sfx.js',
  '/navbar.js',
  '/admin.js',
  '/commands.js',
  '/counters.js',
  '/streams-utils.js',
  '/streams-discord.js',
  '/streams-live-detail.js',
  '/streams-live-table.js',
  '/streams-live-poll.js',
  '/pwa-register.js',
  '/manifest.json',
  '/icons/BCUK-192.svg',
  '/icons/BCUK-512.svg',
  '/icons/BCUK-192.png',
  '/icons/BCUK-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => cache.addAll(STATIC_ASSETS))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((cacheNames) =>
        Promise.all(
          cacheNames
            .filter(
              (cacheName) =>
                cacheName.startsWith(APP_CACHE_PREFIX) && cacheName !== STATIC_CACHE
            )
            .map((cacheName) => caches.delete(cacheName))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  const request = event.request;

  if (request.method !== 'GET') {
    return;
  }

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigationRequest(request));
    return;
  }

  // Anything not served from the static cache below is left to the browser's own network fetch.
  if (isBypassPath(url.pathname) || url.pathname === '/service-worker.js') {
    return;
  }

  if (isStaticAsset(url.pathname)) {
    const swr = staleWhileRevalidate(request);
    event.respondWith(swr.responsePromise);
    event.waitUntil(swr.updatePromise);
  }
});

async function handleNavigationRequest(request) {
  try {
    return await fetch(request);
  } catch (_error) {
    const cachedOffline = await caches.match('/offline.html');
    return cachedOffline || Response.error();
  }
}

function staleWhileRevalidate(request) {
  const cachePromise = caches.open(STATIC_CACHE);
  const cachedPromise = cachePromise.then((cache) => cache.match(request));

  const networkPromise = cachePromise.then(async (cache) => {
    try {
      const response = await fetch(request);
      if (response && response.ok) {
        await cache.put(request, response.clone());
      }
      return response;
    } catch (_error) {
      return null;
    }
  });

  const responsePromise = cachedPromise.then(async (cached) => {
    if (cached) {
      return cached;
    }

    const networkResponse = await networkPromise;
    return networkResponse || Response.error();
  });

  const updatePromise = networkPromise.then(() => undefined);

  return { responsePromise, updatePromise };
}

function isStaticAsset(pathname) {
  return (
    pathname.startsWith('/icons/') ||
    STATIC_EXTENSIONS.some((ext) => pathname.endsWith(ext))
  );
}

function isBypassPath(pathname) {
  return BYPASS_PATH_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(prefix + '/')
  );
}
