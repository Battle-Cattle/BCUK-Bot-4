const APP_CACHE_PREFIX = 'bcuk-panel-';
const CACHE_VERSION = 'bcuk-panel-v5';
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;
const RUNTIME_CACHE_MAX_ENTRIES = 50;

const STATIC_ASSETS = [
  '/offline.html',
  '/style.css',
  '/app.js',
  '/navbar.js',
  '/admin.js',
  '/commands.js',
  '/counters.js',
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
                cacheName.startsWith(APP_CACHE_PREFIX) &&
                cacheName !== STATIC_CACHE &&
                cacheName !== RUNTIME_CACHE
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

  if (url.pathname === '/service-worker.js') {
    event.respondWith(fetch(request));
    return;
  }

  if (isStaticAsset(url.pathname)) {
    const swr = staleWhileRevalidate(request);
    event.respondWith(swr.responsePromise);
    event.waitUntil(swr.updatePromise);
    return;
  }

  if (shouldUseRuntimeCache(request, url)) {
    event.respondWith(networkFirst(request));
    return;
  }

  event.respondWith(fetch(request));
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

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      const cache = await caches.open(RUNTIME_CACHE);
      await cache.put(request, response.clone());
      const keys = await cache.keys();
      const entriesToDelete = Math.max(0, keys.length - RUNTIME_CACHE_MAX_ENTRIES);
      for (let i = 0; i < entriesToDelete; i++) {
        await cache.delete(keys[i]);
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
    pathname === '/api' ||
    pathname.startsWith('/api/') ||
    pathname === '/auth' ||
    pathname.startsWith('/auth/') ||
    pathname === '/admin' ||
    pathname.startsWith('/admin/') ||
    pathname === '/streams' ||
    pathname.startsWith('/streams/')
  );
}

function shouldUseRuntimeCache(request, url) {
  if (request.method !== 'GET') {
    return false;
  }

  if (url.origin !== self.location.origin) {
    return false;
  }

  return isRuntimeCachePath(url.pathname);
}

function isRuntimeCachePath(pathname) {
  return pathname === '/';
}
