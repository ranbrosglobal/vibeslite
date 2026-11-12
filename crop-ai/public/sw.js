/* ============================================================================
 * Vibes Lite · Crop AI — service worker
 * ----------------------------------------------------------------------------
 * Offline contract:
 *   · the application shell (HTML/CSS/JS/icons/fonts/map tiles library) is
 *     pre-cached, so the console opens instantly and works offline;
 *   · every /api request is network-only. Stale field data, sensor readings or
 *     AI verdicts are never served from a cache pretending to be live — an
 *     offline API call returns an honest 503 instead.
 *   · only same-origin GETs and the pinned CDN assets are cached at all.
 * ==========================================================================*/
'use strict';

// Bump this whenever the shell changes: the activate handler deletes every
// cache that does not carry the current version, so a shipped UI change cannot
// be masked by a service-worker copy of the old one.
const VERSION = 'v3';
const SHELL_CACHE = `vl-shell-${VERSION}`;
const ASSET_CACHE = `vl-assets-${VERSION}`;

const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './pwa.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  // Leaflet is vendored with the app (vendor/leaflet), so the map has no
  // third-party script dependency and works on a restricted network.
  './vendor/leaflet/leaflet.css',
  './vendor/leaflet/leaflet.js',
  './vendor/leaflet/images/marker-icon.png',
  './vendor/leaflet/images/marker-icon-2x.png',
  './vendor/leaflet/images/marker-shadow.png',
  './vendor/leaflet/images/layers.png',
  './vendor/leaflet/images/layers-2x.png',
];

// The only remaining third-party asset is the typeface stylesheet. Cached so the
// type survives going offline.
const VENDOR = [
  'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const shell = await caches.open(SHELL_CACHE);
      // addAll is all-or-nothing; add individually so one 404 cannot break install.
      await Promise.all(SHELL.map((url) => shell.add(url).catch(() => {})));
      const assets = await caches.open(ASSET_CACHE);
      await Promise.all(VENDOR.map((url) => assets.add(new Request(url, { mode: 'cors' })).catch(() => {})));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL_CACHE, ASSET_CACHE]);
      const names = await caches.keys();
      await Promise.all(names.filter((n) => !keep.has(n)).map((n) => caches.delete(n)));
      if (self.registration.navigationPreload) await self.registration.navigationPreload.disable();
      await self.clients.claim();
    })(),
  );
});

/**
 * Network-first with a cache fallback.
 *
 * Deliberately NOT stale-while-revalidate: this shell is redeployed, and SWR
 * would serve the previous stylesheet/script for one extra load after every
 * deploy — the exact "I shipped a fix and nothing changed" failure. Fresh wins;
 * the cache exists so the console still opens when the network is gone.
 */
async function networkFirst(cacheName, request) {
  const cache = await caches.open(cacheName);
  try {
    const fresh = await fetch(request);
    if (fresh && (fresh.ok || fresh.type === 'opaque')) cache.put(request, fresh.clone()).catch(() => {});
    return fresh;
  } catch {
    const cached = await cache.match(request);
    return cached || Response.error();
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only GETs are cacheable; mutations always go straight to the network.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Never cache the API, the SSE stream or uploads — those must be live or
  // honestly fail. Offline gets an explicit 503 so the UI can say so.
  if (url.origin === self.location.origin && (url.pathname.startsWith('/api/') || url.pathname.startsWith('/data/'))) {
    event.respondWith(
      fetch(request).catch(
        () =>
          new Response(
            JSON.stringify({
              error: 'Offline',
              detail: 'This console is offline. Live data (weather, satellite scenes, sensor readings, AI models) needs a connection.',
              offline: true,
            }),
            { status: 503, headers: { 'Content-Type': 'application/json' } },
          ),
      ),
    );
    return;
  }

  // App shell: navigations are network-first so a deploy is picked up, with the
  // cached shell as the offline fallback.
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(request);
          if (fresh && fresh.ok) {
            const cache = await caches.open(SHELL_CACHE);
            cache.put('./index.html', fresh.clone()).catch(() => {});
          }
          return fresh;
        } catch {
          const cache = await caches.open(SHELL_CACHE);
          return (await cache.match('./index.html')) || (await cache.match('./')) || Response.error();
        }
      })(),
    );
    return;
  }

  // Same-origin static assets: always take the deployed version when it is
  // reachable, fall back to the cache only when it is not.
  if (url.origin === self.location.origin) {
    event.respondWith(networkFirst(SHELL_CACHE, request));
    return;
  }

  // Pinned vendor assets are immutable (versioned URLs), so cache-first is
  // right for them — the bytes at a pinned URL never change.
  if (VENDOR.includes(request.url) || url.hostname.endsWith('gstatic.com')) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(ASSET_CACHE);
        const cached = await cache.match(request);
        return cached || networkFirst(ASSET_CACHE, request);
      })(),
    );
  }
});

// The console asks for an immediate activation after a deploy ("Update now").
self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});
