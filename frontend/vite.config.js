import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// The dashboard talks to the FastAPI backend through same-origin requests.
// In development (and in the Docker dev container) Vite proxies /api and
// /outputs to the backend, so no CORS configuration is needed in the browser.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const target = env.VITE_API_PROXY_TARGET || process.env.VITE_API_PROXY_TARGET || 'http://localhost:8000'
  const proxy = {
    '/api': { target, changeOrigin: true },
    '/outputs': { target, changeOrigin: true },
  }

  return {
    plugins: [react()],
    server: {
      host: true,
      port: 5173,
      strictPort: true,
      watch: { usePolling: true },
      proxy,
    },
    // `preview` serves the production bundle, which is the only build where the
    // service worker registers — so it needs the same proxy to be testable.
    preview: { host: true, port: 5173, proxy },
    build: { outDir: 'dist', sourcemap: false },
  }
})
