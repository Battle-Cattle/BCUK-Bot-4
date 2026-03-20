const CACHE_VERSION = 'bcuk-panel-v3';
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;
const RUNTIME_CACHE_MAX_ENTRIES = 50;

const STATIC_ASSETS = [
  '/offline.html',
  '/style.css',
  '/app.js',
  '/navbar.js',
  '/admin.js',
  '/streams.js',
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
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((cacheNames) =>
        Promise.all(
          cacheNames
            .filter((cacheName) => cacheName !== STATIC_CACHE && cacheName !== RUNTIME_CACHE)
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

  if (
    request.mode !== 'navigate' &&
    isBypassPath(url.pathname)
  ) {
    event.respondWith(fetch(request));
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigationRequest(request));
    return;
  }

  if (isStaticAsset(url.pathname)) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }

  event.respondWith(networkFirst(request));
});

async function handleNavigationRequest(request) {
  try {
    return await fetch(request);
  } catch (_error) {
    const cachedOffline = await caches.match('/offline.html');
    return cachedOffline || Response.error();
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(request);

  const networkPromise = fetch(request)
    .then((response) => {
      if (response && response.ok) {
        cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => null);

  if (cached) {
    return cached;
  }

  const networkResponse = await networkPromise;
  return networkResponse || Response.error();
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      const cache = await caches.open(RUNTIME_CACHE);
      await cache.put(request, response.clone());
      let keys = await cache.keys();
      while (keys.length > RUNTIME_CACHE_MAX_ENTRIES) {
        await cache.delete(keys[0]);
        keys = await cache.keys();
      }
    }
    return response;
  } catch (_error) {
    const cached = await caches.match(request);
    return cached || Response.error();
  }
}

function isStaticAsset(pathname) {
  return (
    pathname.startsWith('/icons/') ||
    pathname.endsWith('.css') ||
    pathname.endsWith('.js') ||
    pathname.endsWith('.json') ||
    pathname.endsWith('.png') ||
    pathname.endsWith('.svg') ||
    pathname.endsWith('.woff2')
  );
}

function isBypassPath(pathname) {
  return (
    pathname.startsWith('/api/') ||
    pathname === '/auth' ||
    pathname.startsWith('/auth/') ||
    pathname === '/admin' ||
    pathname.startsWith('/admin/')
  );
}
