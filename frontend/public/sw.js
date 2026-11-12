/* ============================================================================
 * Vibes Lite · Agriculture Intelligence — service worker
 * ----------------------------------------------------------------------------
 * The dashboard is a built SPA: Vite emits content-hashed bundles, so the
 * caching rules differ from the field console's:
 *   · hashed build assets (/assets/*) are immutable → cache-first, forever.
 *   · navigations are network-first so a new deploy is picked up immediately,
 *     falling back to the cached shell when offline.
 *   · /api and /outputs are never cached. An offline analysis request must fail
 *     loudly rather than replay a stale crop-health verdict as if it were new.
 * ==========================================================================*/
'use strict';

const VERSION = 'v1';
const SHELL_CACHE = `vl-dash-shell-${VERSION}`;
const ASSET_CACHE = `vl-dash-assets-${VERSION}`;

const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icons/icon.svg', '/icons/icon-192.png', '/icons/icon-512.png'];

// Leaflet's stylesheet is part of the bundle now, so the only pinned vendor
// asset left is the typeface stylesheet.
const VENDOR = [
  'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const shell = await caches.open(SHELL_CACHE);
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
      await self.clients.claim();
    })(),
  );
});

const offlineJson = (detail) =>
  new Response(JSON.stringify({ error: 'Offline', detail, offline: true }), {
    status: 503,
    headers: { 'Content-Type': 'application/json' },
  });

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Live data: never cached, offline is stated plainly.
  if (url.origin === self.location.origin && (url.pathname.startsWith('/api/') || url.pathname.startsWith('/outputs/'))) {
    event.respondWith(
      fetch(request).catch(() =>
        offlineJson('This dashboard is offline. Running an analysis needs the API at the configured origin.'),
      ),
    );
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(request);
          if (fresh && fresh.ok) {
            const cache = await caches.open(SHELL_CACHE);
            cache.put('/index.html', fresh.clone()).catch(() => {});
          }
          return fresh;
        } catch {
          const cache = await caches.open(SHELL_CACHE);
          return (await cache.match('/index.html')) || (await cache.match('/')) || Response.error();
        }
      })(),
    );
    return;
  }

  if (url.origin === self.location.origin) {
    const immutable = url.pathname.startsWith('/assets/') || /\.(png|svg|ico|woff2?)$/.test(url.pathname);
    event.respondWith(
      (async () => {
        const cache = await caches.open(immutable ? ASSET_CACHE : SHELL_CACHE);
        const cached = await cache.match(request);
        if (cached && immutable) return cached; // hashed filename: bytes can never change
        try {
          const fresh = await fetch(request);
          if (fresh && fresh.ok) cache.put(request, fresh.clone()).catch(() => {});
          return fresh;
        } catch {
          return cached || Response.error();
        }
      })(),
    );
    return;
  }

  if (VENDOR.includes(request.url) || url.hostname.endsWith('gstatic.com')) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(ASSET_CACHE);
        const cached = await cache.match(request);
        if (cached) return cached;
        try {
          const fresh = await fetch(request);
          if (fresh && (fresh.ok || fresh.type === 'opaque')) cache.put(request, fresh.clone()).catch(() => {});
          return fresh;
        } catch {
          return Response.error();
        }
      })(),
    );
  }
});
