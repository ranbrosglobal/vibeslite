import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
// Leaflet's stylesheet is bundled (not fetched from a CDN), so the map renders
// the same on a restricted network as it does on a developer machine.
import 'leaflet/dist/leaflet.css'
import './styles.css'
// The console layer sits on top of the base sheet: telemetry rail, dark
// readout surfaces, dials and the calibrated chart primitives.
import './precision.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
)

/* ── service worker ─────────────────────────────────────────────────────────
 * Registered only for production builds: a worker in front of Vite's dev
 * module graph would cache transformed modules and mask every edit.
 * -------------------------------------------------------------------------*/
const isLoopback = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)
const secure = location.protocol === 'https:' || isLoopback

if (import.meta.env.PROD && 'serviceWorker' in navigator && secure) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js')
      .then((reg) => {
        reg.addEventListener('updatefound', () => {
          const sw = reg.installing
          if (!sw) return
          sw.addEventListener('statechange', () => {
            if (sw.state === 'installed' && navigator.serviceWorker.controller) {
              showUpdateBanner(reg.waiting || sw)
            }
          })
        })
      })
      .catch((err) => console.warn('[pwa] service worker registration failed', err))
  })
}

function showUpdateBanner(worker) {
  const bar = document.createElement('button')
  bar.type = 'button'
  bar.className = 'btn primary small'
  bar.textContent = 'New version ready — reload'
  bar.style.cssText =
    'position:fixed;bottom:88px;right:16px;z-index:4000'
  bar.addEventListener('click', () => {
    worker?.postMessage('skip-waiting')
    location.reload()
  })
  document.body.appendChild(bar)
  setTimeout(() => bar.remove(), 30000)
}

/* ── connectivity surfacing ─────────────────────────────────────────────────
 * Analyses need the API, so going offline is worth saying out loud.
 * -------------------------------------------------------------------------*/
function banner(message, err = false) {
  const el = document.createElement('div')
  el.className = 'btn small'
  el.textContent = message
  el.setAttribute('role', 'status')
  el.style.cssText = `position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:4000;padding:10px 16px;${
    err ? 'background:var(--flare);border-color:var(--bone);color:#140603' : 'background:var(--acid);border-color:var(--bone);color:var(--acid-ink)'
  }`
  document.body.appendChild(el)
  setTimeout(() => el.remove(), 4200)
}

window.addEventListener('offline', () =>
  banner('Offline — cached pages only. Running an analysis needs the API.', true),
)
window.addEventListener('online', () => banner('Back online — live API reconnected'))
