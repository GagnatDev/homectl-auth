/*
 * Service worker for the homectl auth PWA.
 *
 * This is an authentication service, so the worker is deliberately conservative:
 * it caches only the public, non-sensitive app shell and static assets, and it
 * never touches auth/API traffic. Dynamic data always comes from the network and
 * is gated by the server's normal auth checks.
 *
 *  - install:   precache the shell (index.html) + core icons/manifest.
 *  - navigate:  network-first, falling back to the cached shell when offline so
 *               the installed app still launches. Server-side auth redirects
 *               (authorize/invite/reset-password) keep working while online.
 *  - assets:    stale-while-revalidate for hashed /assets/* and /icons/*.
 *  - auth/API:  never intercepted or cached — passed straight to the network.
 */

const CACHE = 'homectl-auth-v1';

// Public, non-sensitive resources safe to serve offline.
const PRECACHE_URLS = [
  '/',
  '/manifest.webmanifest',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/maskable-icon-192.png',
  '/icons/maskable-icon-512.png',
  '/icons/apple-touch-icon.png',
];

// Requests that must always hit the network and never be cached — anything that
// carries credentials or returns per-user/auth data. Mirrors the server's API
// path matching plus the OAuth/login endpoints.
const BYPASS = /^\/(admin\/api|api|token|refresh|logout|login|internal|health|\.well-known|admin\/github)(\/|$)/;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only ever handle same-origin GETs; everything else (POSTs, cross-origin) is
  // left to the browser so it never gets cached.
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  // Auth/API traffic: hands off to the network, no caching.
  if (BYPASS.test(url.pathname)) return;

  // Full-page navigations: network-first so redirects and fresh shells win,
  // falling back to the cached shell for offline launch.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('/', { ignoreSearch: true })),
    );
    return;
  }

  // Static assets: stale-while-revalidate.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((res) => {
          if (res.ok && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});
