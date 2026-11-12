/* ============================================================================
 * Vibes Lite · Crop AI — PWA runtime
 * ----------------------------------------------------------------------------
 * Registers the service worker, surfaces an install affordance where the
 * platform offers one, and keeps an honest online/offline indicator in the
 * sidebar so nobody mistakes cached data for a live feed.
 * Depends on the `toast()` helper defined in app.js, which loads first.
 * ==========================================================================*/
'use strict';

(function () {
  const isSecure = location.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  if (!('serviceWorker' in navigator) || !isSecure) return;

  /* ── registration ─────────────────────────────────────────────────────── */
  let waitingWorker = null;

  navigator.serviceWorker
    .register('sw.js', { scope: './' })
    .then((reg) => {
      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        if (!sw) return;
        sw.addEventListener('statechange', () => {
          if (sw.state === 'installed' && navigator.serviceWorker.controller) {
            waitingWorker = reg.waiting || sw;
            offerUpdate();
          }
        });
      });
    })
    .catch((err) => {
      // A failure here must never break the console.
      console.warn('[pwa] service worker registration failed', err);
    });

  /* ── "new version ready" — an explicit, one-tap update ────────────────── */
  function offerUpdate() {
    const bar = document.createElement('button');
    bar.type = 'button';
    bar.className = 'btn primary sm';
    bar.textContent = 'Update available — reload';
    bar.style.cssText = 'position:fixed;bottom:78px;right:14px;z-index:4000';
    bar.addEventListener('click', () => {
      if (waitingWorker) waitingWorker.postMessage('skip-waiting');
      location.reload();
    });
    document.body.appendChild(bar);
    setTimeout(() => bar.remove(), 30000);
  }

  /* ── install affordance ───────────────────────────────────────────────── */
  let deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    const host = document.querySelector('.side-foot');
    if (!host || document.getElementById('pwa-install')) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'pwa-install';
    btn.className = 'stat live';
    btn.style.cssText = 'cursor:pointer;width:100%;text-align:left;font:inherit';
    btn.innerHTML = '<span>＋ INSTALL APP</span>';
    btn.addEventListener('click', async () => {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      deferredPrompt = null;
      if (outcome === 'accepted' && typeof toast === 'function') toast('Installed — open it from your home screen');
      btn.remove();
    });
    host.appendChild(btn);
  });

  window.addEventListener('appinstalled', () => {
    if (typeof toast === 'function') toast('Vibes Lite installed');
  });

  /* ── connectivity, stated plainly ─────────────────────────────────────── */
  function paintConnectivity() {
    const chip = document.getElementById('st-net');
    if (!chip) return;
    const on = navigator.onLine;
    chip.className = `stat live${on ? ' on' : ' warn'}`;
    const label = chip.querySelector('span');
    if (label) label.textContent = on ? 'NET ONLINE' : 'NET OFFLINE';
  }

  function mountConnectivity() {
    const host = document.querySelector('.side-foot');
    if (!host || document.getElementById('st-net')) return;
    const chip = document.createElement('div');
    chip.id = 'st-net';
    chip.className = 'stat live';
    chip.innerHTML = '<span>NET —</span>';
    host.insertBefore(chip, host.firstChild);
    paintConnectivity();
  }

  window.addEventListener('online', () => {
    paintConnectivity();
    if (typeof toast === 'function') toast('Back online — live feeds reconnected');
  });
  window.addEventListener('offline', () => {
    paintConnectivity();
    if (typeof toast === 'function') {
      toast('Offline — cached console only. Live weather, satellites and AI models are unavailable.', true);
    }
  });

  document.addEventListener('DOMContentLoaded', () => {
    mountConnectivity();
    paintConnectivity();
  });
  if (document.readyState !== 'loading') {
    mountConnectivity();
    paintConnectivity();
  }
})();
