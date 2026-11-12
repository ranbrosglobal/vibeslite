import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  CircleMarker,
  GeoJSON,
  ImageOverlay,
  MapContainer,
  Marker,
  Popup,
  ScaleControl,
  TileLayer,
  useMap,
  useMapEvents,
} from 'react-leaflet'
import L from 'leaflet'
import markerIcon2xUrl from 'leaflet/dist/images/marker-icon-2x.png'
import markerIconUrl from 'leaflet/dist/images/marker-icon.png'
import markerShadowUrl from 'leaflet/dist/images/marker-shadow.png'
import { api } from '../api'

/**
 * OpenStreetMap attribution is a licence condition (ODbL 1.0), not a courtesy,
 * so the credit is rendered as visible text next to the map rather than only in
 * Leaflet's own (styled-down) attribution control.
 */
export const OSM_ATTRIBUTION = '© OpenStreetMap contributors'
export const OSM_COPYRIGHT_URL = 'https://www.openstreetmap.org/copyright'

/**
 * Basemap catalogue. This is the offline mirror of `backend/osm.py`; the live
 * list arrives from `/api/geo/status` and replaces the OpenStreetMap entries on
 * mount, so the API stays the single source of truth and the first paint still
 * has tiles if that request is slow or the backend is down.
 */
const FALLBACK_BASEMAPS = {
  osm: {
    key: 'osm',
    label: 'OSM Street',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: OSM_ATTRIBUTION,
    maxZoom: 19,
    provider: 'OpenStreetMap',
  },
  osm_hot: {
    key: 'osm_hot',
    label: 'OSM Humanitarian',
    url: 'https://tile.openstreetmap.fr/hot/{z}/{x}/{y}.png',
    attribution: `${OSM_ATTRIBUTION}, Tiles: Humanitarian OpenStreetMap Team`,
    maxZoom: 20,
    provider: 'Humanitarian OpenStreetMap Team',
  },
  osm_topo: {
    key: 'osm_topo',
    label: 'OSM Terrain',
    url: 'https://a.tile.opentopomap.org/{z}/{x}/{y}.png',
    attribution: `${OSM_ATTRIBUTION}, SRTM | © OpenTopoMap (CC-BY-SA)`,
    maxZoom: 17,
    provider: 'OpenTopoMap',
  },
  satellite: {
    key: 'satellite',
    label: 'Satellite',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
    maxZoom: 19,
    provider: 'Esri World Imagery',
  },
  none: { key: 'none', label: 'Blank', url: null, attribution: '', maxZoom: 19, provider: 'none' },
}

// Field boundary is drawn in the platform accent so it never competes with the
// data underneath. `#cbff3c` mirrors --acid in styles.css.
const boundaryStyle = { color: '#cbff3c', weight: 2, fill: false, dashArray: '7 4' }

function FitBounds({ bounds, center, zoom, once }) {
  const map = useMap()
  const key = JSON.stringify(bounds || center || null)
  useEffect(() => {
    if (bounds && bounds.length === 4 && bounds.every((value) => Number.isFinite(value))) {
      map.fitBounds(
        [
          [bounds[1], bounds[0]],
          [bounds[3], bounds[2]],
        ],
        { padding: [18, 18] },
      )
    } else if (center && Number.isFinite(center[0]) && Number.isFinite(center[1])) {
      map.setView(center, zoom || 14)
    } else if (once) {
      map.setView([52.625, 5.655], 8)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return null
}

/** Fly to a place chosen in the search box. */
function FlyTo({ target }) {
  const map = useMap()
  useEffect(() => {
    if (!target) return
    map.flyTo([target.lat, target.lon], target.zoom || 15, { duration: 0.8 })
  }, [target, map])
  return null
}

/** Report map clicks upward; used for click-to-pick. */
function ClickReporter({ onClick }) {
  useMapEvents({
    click: (event) => onClick({ lat: event.latlng.lat, lon: event.latlng.lng }),
  })
  return null
}

function ZoneMarkers({ markers }) {
  return markers.map((marker, index) => (
    <Marker key={`${marker.position.join('-')}-${index}`} position={marker.position}>
      <Popup>
        <strong>{marker.label || 'Zone'}</strong>
        {marker.detail ? <div>{marker.detail}</div> : null}
      </Popup>
    </Marker>
  ))
}

/**
 * Lightweight geospatial view. Supports raster image overlays (already
 * reprojected to WGS84 by the backend), GeoJSON boundaries/zones and markers.
 *
 * OpenStreetMap integration (all proxied by the backend, so the browser never
 * talks to a third party and `connect-src 'self'` still holds):
 *   · basemaps from `/api/geo/status`
 *   · `search` — place/address/postcode lookup (Nominatim), plus reverse
 *     geocoding of any clicked point
 *   · `onPick` — hand the picked coordinate back to the page
 *   · `osmFeatures` — draw real OSM features (roads, waterways, land use)
 */
export default function MapView({
  bounds,
  overlays = [],
  geojson = [],
  markers = [],
  height = 'map-tall',
  note,
  defaultBasemap = 'osm',
  showSwitcher = true,
  search = false,
  osmFeatures = null,
  onPick = null,
  pickLabel = 'Use this location',
}) {
  const [basemaps, setBasemaps] = useState(FALLBACK_BASEMAPS)
  const [basemapKey, setBasemapKey] = useState(defaultBasemap)
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [results, setResults] = useState(null)
  const [searchError, setSearchError] = useState(null)
  const [picked, setPicked] = useState(null)
  const [focus, setFocus] = useState(null)
  const [featureLayer, setFeatureLayer] = useState(null)
  const [featureError, setFeatureError] = useState(null)

  const active = basemaps[basemapKey] || null
  const visibleOverlays = useMemo(
    () => overlays.filter((overlay) => overlay && overlay.url && overlay.bounds?.length === 4),
    [overlays],
  )

  const center = useMemo(() => {
    if (bounds && bounds.length === 4 && bounds.every((value) => Number.isFinite(value))) {
      return [(bounds[1] + bounds[3]) / 2, (bounds[0] + bounds[2]) / 2]
    }
    return null
  }, [bounds])

  // The provider catalogue is served by the API; the literals above are only a
  // fallback so a map still draws while that request is in flight.
  useEffect(() => {
    let cancelled = false
    api
      .geoStatus()
      .then((status) => {
        if (cancelled || !status?.basemaps?.length) return
        const provided = {}
        status.basemaps.forEach((entry) => {
          provided[entry.key] = {
            key: entry.key,
            label: entry.label,
            url: entry.url,
            attribution: entry.attribution,
            maxZoom: entry.max_zoom || 19,
            provider: entry.provider,
          }
        })
        setBasemaps((previous) => ({ ...provided, ...previous, ...provided }))
      })
      .catch(() => {
        /* the fallback catalogue is already rendering */
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Real OSM features around the field. Only fetched when a page asks for it.
  const featureKinds = osmFeatures?.kinds?.join(',') || ''
  const featureRadius = osmFeatures?.radiusM || 900
  useEffect(() => {
    if (!osmFeatures) {
      setFeatureLayer(null)
      return undefined
    }
    const target = osmFeatures.center || center
    if (!target) return undefined
    let cancelled = false
    const kinds = featureKinds ? featureKinds.split(',').filter(Boolean) : null
    setFeatureError(null)
    api
      .geoFeatures(target[0], target[1], { radiusM: featureRadius, kinds })
      .then((payload) => {
        if (!cancelled) setFeatureLayer(payload)
      })
      .catch((error) => {
        if (!cancelled) {
          setFeatureLayer(null)
          setFeatureError(error.message)
        }
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [osmFeatures, featureKinds, featureRadius, center?.[0], center?.[1]])

  /** Name the place at a coordinate. Never invents one - the error is shown. */
  const describePoint = useCallback(async (lat, lon) => {
    setPicked({ lat, lon, loading: true, place: null, error: null })
    try {
      const payload = await api.geoReverse(lat, lon)
      setPicked({ lat, lon, loading: false, place: payload.place, error: null, note: payload.note })
    } catch (error) {
      setPicked({ lat, lon, loading: false, place: null, error: error.message })
    }
  }, [])

  const runSearch = async (event) => {
    event.preventDefault()
    const text = query.trim()
    if (text.length < 3) {
      setSearchError('Enter at least 3 characters — a place, address, postcode or landmark.')
      return
    }
    setSearching(true)
    setSearchError(null)
    try {
      const payload = await api.geoSearch(text)
      setResults(payload.results || [])
      if (!payload.results?.length) setSearchError(`OpenStreetMap has no match for “${text}”.`)
    } catch (error) {
      setResults(null)
      setSearchError(error.message)
    } finally {
      setSearching(false)
    }
  }

  const choosePlace = (place) => {
    setResults(null)
    setQuery(place.display_name || place.name || query)
    setFocus({ lat: place.lat, lon: place.lon, zoom: 15 })
    describePoint(place.lat, place.lon)
  }

  const styleForKind = (feature) => {
    const match = (featureLayer?.kinds_available || []).find((entry) => entry.key === feature.properties?.kind)
    const isArea = feature.geometry?.type === 'Polygon' || feature.geometry?.type === 'MultiPolygon'
    return {
      color: match?.style?.color || '#cbff3c',
      weight: match?.style?.weight || 1,
      opacity: 0.85,
      fillOpacity: isArea ? 0.12 : 0,
    }
  }

  return (
    <div className="map-shell">
      {search ? (
        <div className="map-search">
          <form onSubmit={runSearch} className="row">
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search a place, address or postcode (OpenStreetMap)"
              aria-label="Search a place on OpenStreetMap"
            />
            <button className="small primary" type="submit" disabled={searching}>
              {searching ? 'Searching…' : 'Search'}
            </button>
          </form>
          {searchError ? <div className="hint warn-text">{searchError}</div> : null}
          {results ? (
            <ul className="map-results">
              {results.map((place) => (
                <li key={`${place.osm_type}-${place.osm_id}-${place.lat}`}>
                  <button className="ghost small" onClick={() => choosePlace(place)}>
                    {place.display_name}
                  </button>
                  <span className="dim mono">
                    {place.lat?.toFixed(5)}, {place.lon?.toFixed(5)}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <MapContainer center={[52.625, 5.655]} zoom={bounds ? 13 : 6} className={`map ${height}`} scrollWheelZoom attributionControl>
        {active?.url ? <TileLayer url={active.url} attribution={active.attribution} maxZoom={active.maxZoom || 19} /> : null}
        <ScaleControl position="bottomright" imperial={false} />
        {geojson.map((layer, index) => (
          <GeoJSON key={`geojson-${index}`} data={layer.data} style={layer.style || boundaryStyle} />
        ))}
        {visibleOverlays.map((overlay, index) => (
          <ImageOverlay
            key={`overlay-${overlay.key || index}`}
            url={overlay.url}
            bounds={[
              [overlay.bounds[1], overlay.bounds[0]],
              [overlay.bounds[3], overlay.bounds[2]],
            ]}
            opacity={overlay.opacity ?? 0.85}
          />
        ))}
        {featureLayer?.geojson?.features?.length ? (
          <GeoJSON
            key={`osm-${featureLayer.center?.lat}-${featureLayer.center?.lon}-${featureLayer.radius_m}-${featureLayer.feature_count}`}
            data={featureLayer.geojson}
            style={styleForKind}
            onEachFeature={(feature, layer) => {
              const tags = feature.properties?.tags || {}
              const rows = Object.entries(tags)
                .map(([key, value]) => `<div><b>${key}</b>: ${value}</div>`)
                .join('')
              layer.bindPopup(
                `<b>${feature.properties?.label || feature.properties?.kind_label}</b>`
                  + `<div class="dim">${feature.properties?.osm_id} · ${feature.properties?.kind_label}</div>`
                  + rows,
              )
            }}
          />
        ) : null}
        <ZoneMarkers markers={markers} />
        {picked ? (
          <CircleMarker
            center={[picked.lat, picked.lon]}
            radius={7}
            pathOptions={{ color: '#cbff3c', weight: 2, fillColor: '#07080a', fillOpacity: 1 }}
          >
            <Popup>
              <strong>Picked location</strong>
              <div>
                {picked.lat.toFixed(5)}, {picked.lon.toFixed(5)}
              </div>
              <div>
                {picked.loading
                  ? 'Resolving the place name…'
                  : picked.error
                    ? picked.error
                    : picked.place?.display_name || 'Unmapped in OpenStreetMap'}
              </div>
            </Popup>
          </CircleMarker>
        ) : null}
        <ClickReporter onClick={({ lat, lon }) => describePoint(lat, lon)} />
        {focus ? <FlyTo target={focus} /> : null}
        <FitBounds bounds={bounds} center={null} zoom={13} />
      </MapContainer>

      {showSwitcher ? (
        <div className="map-toolbar">
          {Object.values(basemaps).map((entry) => (
            <button
              key={entry.key}
              className={basemapKey === entry.key ? 'primary small' : 'small'}
              onClick={() => setBasemapKey(entry.key)}
              title={entry.url ? entry.provider : 'Blank canvas (overlays only)'}
            >
              {entry.label}
            </button>
          ))}
        </div>
      ) : null}

      {picked ? (
        <div className="map-pick">
          <div>
            <strong>{picked.loading ? 'Resolving place name…' : picked.place?.display_name || picked.error || 'Unmapped in OpenStreetMap'}</strong>
            <div className="dim mono">
              {picked.lat.toFixed(5)}, {picked.lon.toFixed(5)}
            </div>
            {picked.place?.address && Object.keys(picked.place.address).length ? (
              <div className="hint">
                {Object.entries(picked.place.address)
                  .slice(0, 4)
                  .map(([key, value]) => `${key}: ${value}`)
                  .join(' · ')}
              </div>
            ) : null}
            {!picked.loading && !picked.place && picked.note ? <div className="hint">{picked.note}</div> : null}
          </div>
          <div className="row">
            {onPick ? (
              <button
                className="small primary"
                disabled={picked.loading}
                onClick={() => onPick({ lat: picked.lat, lon: picked.lon, place: picked.place?.display_name || '' })}
              >
                {pickLabel}
              </button>
            ) : null}
            <button className="ghost small" onClick={() => setPicked(null)}>
              clear
            </button>
          </div>
        </div>
      ) : null}

      {osmFeatures ? (
        <div className="map-credit">
          {featureError ? (
            <span className="warn-text">OpenStreetMap features unavailable: {featureError}</span>
          ) : featureLayer ? (
            <>
              {featureLayer.feature_count} real OSM features within {featureLayer.radius_m} m ·{' '}
              {Object.entries(featureLayer.counts || {})
                .filter(([, count]) => count > 0)
                .map(([kind, count]) => `${kind} ${count}`)
                .join(' · ')}
              {featureLayer.cached ? ' · cached' : ''}
            </>
          ) : (
            'Loading real OpenStreetMap features…'
          )}
        </div>
      ) : null}

      {note ? <div className="map-note">{note}</div> : null}
      <div className="map-credit">
        {active?.url ? (
          <>
            Basemap {active.label} — {active.attribution} ·{' '}
            <a href={OSM_COPYRIGHT_URL} target="_blank" rel="noreferrer noopener">
              OSM copyright &amp; licence (ODbL)
            </a>{' '}
            · tile servers are donated capacity: interactive use only, no bulk download.
          </>
        ) : (
          'Blank canvas — overlays and boundaries only, no basemap tiles requested.'
        )}
      </div>
    </div>
  )
}

/** Convert a [west, south, east, north] box to Leaflet-friendly centre/zoom. */
export function boundsCenter(bounds) {
  if (!bounds || bounds.length !== 4) return null
  return [(bounds[1] + bounds[3]) / 2, (bounds[0] + bounds[2]) / 2]
}

export const markerIcon = L.icon({
  // Bundled by Vite from the leaflet package: the marker images load from this
  // origin, so a map marker never depends on a CDN being reachable.
  iconUrl: markerIconUrl,
  iconRetinaUrl: markerIcon2xUrl,
  shadowUrl: markerShadowUrl,
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
})
L.Marker.prototype.options.icon = markerIcon
