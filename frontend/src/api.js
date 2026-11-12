/**
 * Vibes Lite API client.
 *
 * Every backend call lives here so pages stay declarative. Requests are
 * same-origin (`/api/...`) and proxied to FastAPI by Vite, which also means
 * generated assets under `/outputs/...` render in <img> tags without CORS.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'

const BASE = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '')

export class ApiError extends Error {
  constructor(message, status, payload) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.payload = payload
  }
}

async function request(path, { method = 'GET', body, form, signal } = {}) {
  const options = { method, signal, headers: {} }
  if (form) {
    options.body = form
  } else if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json'
    options.body = JSON.stringify(body)
  }
  let response
  try {
    response = await fetch(`${BASE}${path}`, options)
  } catch (error) {
    if (error.name === 'AbortError') throw error
    throw new ApiError('Cannot reach the Vibes Lite API. Is the backend running?', 0, null)
  }

  const contentType = response.headers.get('content-type') || ''
  const payload = contentType.includes('application/json') ? await response.json() : await response.text()
  if (!response.ok) {
    const detail = (payload && payload.detail) || (typeof payload === 'string' && payload) || response.statusText
    throw new ApiError(typeof detail === 'string' ? detail : JSON.stringify(detail), response.status, payload)
  }
  return payload
}

export const api = {
  // service
  health: () => request('/api/health'),
  project: () => request('/api/project'),
  config: () => request('/api/config'),
  dashboard: () => request('/api/dashboard'),

  // datasets
  // ``kind`` is optional and only forwarded when it is a real filter string:
  // useApi() calls endpoint helpers with a { signal } argument, which must not
  // leak into the query string (it would filter every dataset out).
  datasets: (kind) => request(`/api/datasets${typeof kind === 'string' && kind ? `?kind=${kind}` : ''}`),
  dataset: (name) => request(`/api/datasets/${encodeURIComponent(name)}`),
  datasetFootprint: (name) => request(`/api/datasets/${encodeURIComponent(name)}/footprint`),
  datasetPreviewUrl: (name, size = 900) =>
    `${BASE}/api/datasets/${encodeURIComponent(name)}/preview?max_size=${size}`,

  // AOI
  aois: () => request('/api/aoi'),
  aoi: (name) => request(`/api/aoi/${encodeURIComponent(name)}`),
  createAoi: (payload) => request('/api/aoi', { method: 'POST', body: payload }),

  // uploads
  upload: (files, kind = 'auto') => {
    const form = new FormData()
    Array.from(files).forEach((file) => form.append('files', file))
    form.append('kind', kind)
    return request('/api/upload', { method: 'POST', form })
  },

  // analysis
  ndvi: (payload) => request('/api/ndvi', { method: 'POST', body: payload }),
  cropHealth: (payload) => request('/api/crop-health', { method: 'POST', body: payload }),
  segmentation: (payload) => request('/api/segmentation', { method: 'POST', body: payload }),
  processImage: (form) => request('/api/opencv/process', { method: 'POST', form }),
  timeseries: (payload) => request('/api/timeseries', { method: 'POST', body: payload }),

  // agronomy engine
  agronomyModels: () => request('/api/agronomy/models'),
  thermalTime: (payload) => request('/api/agronomy/thermal-time', { method: 'POST', body: payload }),
  waterBalance: (payload) => request('/api/agronomy/water-balance', { method: 'POST', body: payload }),
  zones: (payload) => request('/api/agronomy/zones', { method: 'POST', body: payload }),
  prescription: (payload) => request('/api/agronomy/prescription', { method: 'POST', body: payload }),
  carbon: (payload) => request('/api/agronomy/carbon', { method: 'POST', body: payload }),
  yieldForecast: (payload) => request('/api/agronomy/yield-forecast', { method: 'POST', body: payload }),
  diseaseRisk: (payload) => request('/api/agronomy/disease-risk', { method: 'POST', body: payload }),

  // OpenStreetMap (proxied by the backend, so no third-party origin is needed)
  geoStatus: () => request('/api/geo/status'),
  geoSearch: (query, { limit, country, signal } = {}) => {
    const params = new URLSearchParams({ q: query })
    if (limit) params.set('limit', String(limit))
    if (country) params.set('country', country)
    return request(`/api/geo/search?${params.toString()}`, { signal })
  },
  geoReverse: (lat, lon, { zoom, signal } = {}) =>
    request(`/api/geo/reverse?lat=${lat}&lon=${lon}${zoom ? `&zoom=${zoom}` : ''}`, { signal }),
  geoFeatures: (lat, lon, { radiusM = 900, kinds, signal } = {}) => {
    const params = new URLSearchParams({ lat: String(lat), lon: String(lon), radius_m: String(radiusM) })
    if (kinds?.length) params.set('kinds', kinds.join(','))
    return request(`/api/geo/features?${params.toString()}`, { signal })
  },
  aoiFromPoint: (payload) => request('/api/geo/aoi-from-point', { method: 'POST', body: payload }),

  // real satellite imagery: STAC scene discovery + COG band reads on the server
  satelliteCatalogue: () => request('/api/satellite/catalogue'),
  satelliteScenes: (params = {}) => {
    const query = new URLSearchParams(
      Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== ''),
    ).toString()
    return request(`/api/satellite/scenes${query ? `?${query}` : ''}`)
  },
  satelliteFetch: (payload) => request('/api/satellite/fetch', { method: 'POST', body: payload }),

  // security posture
  security: () => request('/api/security'),

  // results
  results: (params = {}) => {
    const query = new URLSearchParams(Object.entries(params).filter(([, value]) => value)).toString()
    return request(`/api/results${query ? `?${query}` : ''}`)
  },
  result: (id) => request(`/api/results/${encodeURIComponent(id)}`),

  // explicitly labelled synthetic demo scene. Real imagery arrives through the
  // ``satellite*`` calls above or as an upload; nothing here is a real scene.
  syntheticSample: (size = 1200) => request(`/api/samples/synthetic?size=${size}`, { method: 'POST' }),
}

/* -------------------------------------------------------------------------- */
/* shared client state: the most recent analysis                              */
/* -------------------------------------------------------------------------- */
let analysisState = { ndvi: null, cropHealth: null, segmentation: null, selection: null, error: null }
const listeners = new Set()

export const analysisStore = {
  get: () => analysisState,
  set: (changes) => {
    analysisState = { ...analysisState, ...changes }
    listeners.forEach((listener) => listener())
  },
  subscribe: (listener) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
}

/** Subscribe a component to the shared analysis/selection state. */
export function useAnalysisState() {
  return useSyncExternalStore(analysisStore.subscribe, analysisStore.get, analysisStore.get)
}

/** Fetch-on-mount hook with loading/error state and manual refresh. */
export function useApi(path, { skip = false } = {}) {
  const [state, setState] = useState({ data: null, loading: !skip, error: null })
  const controller = useRef(null)

  const load = useCallback(async () => {
    if (skip) {
      setState({ data: null, loading: false, error: null })
      return
    }
    controller.current?.abort()
    controller.current = new AbortController()
    setState((previous) => ({ ...previous, loading: true, error: null }))
    try {
      const data = await path({ signal: controller.current.signal })
      setState({ data, loading: false, error: null })
    } catch (error) {
      if (error.name === 'AbortError') return
      setState({ data: null, loading: false, error })
    }
  }, [path, skip])

  useEffect(() => {
    load()
    return () => controller.current?.abort()
  }, [load])

  return { ...state, reload: load }
}

/** Small helper for full-URL asset downloads from the API. */
export function assetUrl(asset) {
  if (!asset) return null
  return asset.url ? `${BASE}${asset.url}` : null
}

/** Find one named asset in an analysis payload. */
export function findAsset(payload, name) {
  return (payload?.assets || []).find((asset) => asset.name === name) || null
}

/** Fetch a stored result by id (used by the Results page). */
export function useResult(id) {
  const load = useCallback(({ signal } = {}) => api.result(id), [id])
  return useApi(load, { skip: !id })
}
