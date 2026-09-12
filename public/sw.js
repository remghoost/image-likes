/*
 * Image Likes — service worker
 *
 * Caching strategy:
 *   - App shell (index.html, app.js, style.css, manifest, icons): precached on
 *     install, then served stale-while-revalidate.
 *   - Navigation requests: network-first, falling back to the cached app shell
 *     so the app still opens when offline.
 *   - Uploaded images (/uploads/*): cache-first. Filenames are unique per
 *     upload, so a given URL always maps to the same image.
 *   - API requests (/api/*): never cached — always hit the network (they are
 *     auth-based and dynamic).
 */
const CACHE_VERSION = 'v1';
const CACHE_NAME = 'image-likes-' + CACHE_VERSION;
const UPLOADS_CACHE = 'image-likes-uploads-' + CACHE_VERSION;

const PRECACHE_URLS = [
  '/index.html',
  '/app.js',
  '/style.css',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-192.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS))
  );
  // Activate as soon as installed (no need to wait for open tabs to close).
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Drop caches from older versions.
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith('image-likes-') && k !== CACHE_NAME && k !== UPLOADS_CACHE)
          .map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

function isApiRequest(url) {
  return url.pathname.startsWith('/api/');
}

function isUploadRequest(url) {
  return url.pathname.startsWith('/uploads/');
}

const STATIC_EXTS = new Set([
  'js', 'css', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif',
  'json', 'svg', 'ico', 'woff', 'woff2', 'txt'
]);

function isStaticAsset(url) {
  const dot = url.pathname.lastIndexOf('.');
  if (dot === -1) return false;
  return STATIC_EXTS.has(url.pathname.slice(dot + 1).toLowerCase());
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return; // only intercept GETs

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // same-origin only

  // API: never cache — let the browser hit the network directly.
  if (isApiRequest(url)) return;

  // Navigation (page loads): network-first, fall back to the cached shell.
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(request);
          const cache = await caches.open(CACHE_NAME);
          cache.put('/index.html', fresh.clone());
          return fresh;
        } catch (err) {
          const cached = await caches.match('/index.html');
          if (cached) return cached;
          return Response.error();
        }
      })()
    );
    return;
  }

  // Uploaded images: cache-first.
  if (isUploadRequest(url)) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        const fresh = await fetch(request);
        if (fresh && fresh.ok) {
          const cache = await caches.open(UPLOADS_CACHE);
          cache.put(request, fresh.clone());
        }
        return fresh;
      })()
    );
    return;
  }

  // Static assets (app shell + icons): stale-while-revalidate.
  if (isStaticAsset(url)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE_NAME);
        const cached = await cache.match(request);
        const network = fetch(request)
          .then((fresh) => {
            if (fresh && fresh.ok) cache.put(request, fresh.clone());
            return fresh;
          })
          .catch(() => null);
        return cached || (await network) || Response.error();
      })()
    );
    return;
  }

  // Everything else: default network behavior.
});
