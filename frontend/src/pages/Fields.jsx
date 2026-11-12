import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, analysisStore, useApi } from '../api'
import { Badge, DataTable, Empty, KeyValue, Loading, Notice, Panel } from '../components/Panel'
import FieldPicker from '../components/FieldPicker'
import MapView from '../components/MapView'

export default function Fields() {
  const navigate = useNavigate()
  const aois = useApi(api.aois)
  const [selectedAoi, setSelectedAoi] = useState(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState(null)
  const [lastRun, setLastRun] = useState(null)
  // A location picked on the real map, and the field it is turned into.
  const [picked, setPicked] = useState(null)
  const [fieldName, setFieldName] = useState('picked_field')
  const [areaHa, setAreaHa] = useState('12')
  const [saving, setSaving] = useState(false)
  const [savedField, setSavedField] = useState(null)
  const [saveError, setSaveError] = useState(null)
  // Bumped after a boundary is stored so the analysis picker re-reads its lists.
  const [reloadToken, setReloadToken] = useState(0)

  // The loader must be memoised: useApi re-runs its effect whenever the `path`
  // function identity changes, so an inline arrow here re-fetches on every
  // render and loops through its own loading state forever.
  const aoiPath = useMemo(() => ({ signal } = {}) => api.aoi(selectedAoi, { signal }), [selectedAoi])
  const aoiDetail = useApi(aoiPath, { skip: !selectedAoi })

  /** The picked point becomes a real, validated AOI file the analysis can use. */
  const createFieldFromPoint = async () => {
    if (!picked) return
    setSaving(true)
    setSaveError(null)
    try {
      const payload = await api.aoiFromPoint({
        lat: picked.lat,
        lon: picked.lon,
        area_ha: Number(areaHa) || 10,
        name: fieldName || 'picked_field',
        label: picked.place ? picked.place.split(',')[0] : 'picked field',
        place: picked.place || '',
      })
      setSavedField(payload)
      aois.reload()
      setReloadToken((value) => value + 1)
    } catch (caught) {
      setSaveError(caught.message)
    } finally {
      setSaving(false)
    }
  }

  const runAnalysis = async (request) => {
    setRunning(true)
    setError(null)
    try {
      const payload = await api.ndvi({ ...request, weak_threshold: request.weak_threshold ?? 0.45 })
      analysisStore.set({ ndvi: payload, selection: request })
      setLastRun(payload)
      navigate('/ndvi')
    } catch (caught) {
      setError(caught.message)
    } finally {
      setRunning(false)
    }
  }

  return (
    <>
      {error ? <Notice tone="danger" title="Analysis failed">{error}</Notice> : null}

      <div className="grid sidebar-left">
        <div className="stack">
          <FieldPicker onRun={runAnalysis} running={running} runLabel="Start NDVI analysis" reloadToken={reloadToken} />
          {lastRun ? (
            <Panel title="Last run" hint={lastRun.dataset}>
              <KeyValue
                rows={[
                  ['Result id', lastRun.result_id, true],
                  ['Index', lastRun.index],
                  ['Mean', Number(lastRun.statistics.mean).toFixed(3)],
                  ['Status', lastRun.cached ? 'served from cache' : 'computed'],
                ]}
              />
            </Panel>
          ) : null}
        </div>

        <div className="stack">
          <Panel
            title="Field boundaries"
            hint="Click a boundary to inspect geometry, area and CRS"
            actions={<button className="small" onClick={aois.reload}>Refresh</button>}
          >
            {aois.loading ? <Loading label="Loading boundaries…" /> : null}
            {aois.data?.aois?.length ? (
              <DataTable
                columns={[
                  { key: 'name', label: 'File' },
                  { key: 'feature_count', label: 'Features' },
                  { key: 'area_ha', label: 'Area ha', render: (value) => (value ? Number(value).toFixed(1) : '—') },
                  {
                    key: 'select',
                    label: '',
                    render: (_, row) => (
                      <button className="ghost small" onClick={() => setSelectedAoi(row.name)}>
                        inspect
                      </button>
                    ),
                  },
                ]}
                rows={aois.data.aois}
                numericFrom={1}
              />
            ) : (
              !aois.loading && <Empty title="No field boundaries yet">Upload a GeoJSON on the left, or generate the demo scene.</Empty>
            )}
          </Panel>

          {selectedAoi ? (
            <Panel
              title={`Boundary · ${selectedAoi}`}
              hint={aoiDetail.data?.crs}
              actions={<button className="ghost small" onClick={() => setSelectedAoi(null)}>close</button>}
            >
              {aoiDetail.loading ? <Loading label="Reading geometry…" /> : null}
              {aoiDetail.error ? <Notice tone="danger">{aoiDetail.error.message}</Notice> : null}
              {aoiDetail.data ? (
                <>
                  <div className="row">
                    <Badge tone="teal">{aoiDetail.data.feature_count} feature(s)</Badge>
                    <Badge>{Number(aoiDetail.data.area_ha).toFixed(2)} ha</Badge>
                    <Badge>{aoiDetail.data.crs}</Badge>
                  </div>
                  <MapView
                    bounds={aoiDetail.data.bounds}
                    geojson={[{ data: aoiDetail.data.geojson }]}
                    height="map-short"
                    note="Analysis area (AOI)"
                  />
                  <KeyValue
                    rows={[
                      ['Total area', `${Number(aoiDetail.data.area_ha).toFixed(2)} ha`],
                      ['Bounding box', (aoiDetail.data.bounds || []).map((value) => value.toFixed(4)).join(', ')],
                      ['Warnings', aoiDetail.data.warnings?.length ? aoiDetail.data.warnings.join('; ') : 'none', true],
                    ]}
                  />
                </>
              ) : null}
            </Panel>
          ) : null}

          <Panel
            title="Find a field on the real map"
            hint="Search OpenStreetMap, or click anywhere on the map, then turn the point into a boundary"
          >
            <MapView
              height="map-short"
              search
              pickLabel="Use this point"
              onPick={setPicked}
              key="osm-picker"
              note="Basemap, place names and the feature layer all come from OpenStreetMap through this API."
            />

            {picked ? (
              <div className="stack" style={{ marginTop: 12 }}>
                <KeyValue
                  rows={[
                    ['Place', picked.place || 'unmapped in OpenStreetMap', true],
                    ['Latitude', picked.lat.toFixed(6)],
                    ['Longitude', picked.lon.toFixed(6)],
                  ]}
                />
                <div className="row">
                  <label className="field">
                    <span>Field name</span>
                    <input value={fieldName} onChange={(event) => setFieldName(event.target.value)} />
                  </label>
                  <label className="field">
                    <span>Area (ha)</span>
                    <input value={areaHa} onChange={(event) => setAreaHa(event.target.value)} inputMode="decimal" />
                  </label>
                  <button className="small primary" onClick={createFieldFromPoint} disabled={saving}>
                    {saving ? 'Creating…' : 'Create field boundary'}
                  </button>
                </div>
                <div className="hint">
                  The point becomes a square boundary laid out in the local UTM zone, so the stored area matches what you
                  ask for. It is a regular shape — not a surveyed field edge.
                </div>
              </div>
            ) : (
              <Notice tone="muted">
                No point picked yet. Search for a place above, or click the map where the field is.
              </Notice>
            )}

            {saveError ? <Notice tone="danger" title="Could not create the field">{saveError}</Notice> : null}

            {savedField ? (
              <>
                <Notice tone="info" title={`Boundary stored · ${savedField.name}`}>
                  {Number(savedField.area_ha).toFixed(2)} ha (asked for {savedField.requested_area_ha} ha) ·{' '}
                  {savedField.shape} · laid out in {savedField.utm_crs}
                  {savedField.place ? ` · near ${savedField.place}` : ''}
                </Notice>
                <MapView
                  bounds={savedField.bounds}
                  height="map-short"
                  geojson={[{ data: savedField.geojson }]}
                  osmFeatures={{ kinds: ['roads', 'waterways', 'water', 'landuse'], radiusM: 1200 }}
                  note="The new boundary over real OpenStreetMap context: roads, ditches, water and land use within 1.2 km."
                />
                <div className="row">
                  <button className="ghost small" onClick={() => setSelectedAoi(savedField.name)}>
                    Inspect geometry
                  </button>
                </div>
                <div className="hint">
                  The boundary is now selectable as the AOI in the analysis panel on the left — choose the raster it
                  should be clipped to, then run. {savedField.note}
                </div>
              </>
            ) : null}
          </Panel>

          <Panel title="How field analysis works" hint="What runs when you press Start">
            <ol style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, lineHeight: 1.7 }}>
              <li>Raster is validated (CRS, bands, nodata, size) and the band map is resolved from band descriptions.</li>
              <li>Only the AOI window is read (rasterio windows + overview decimation) — the full scene is never loaded.</li>
              <li>RED and NIR are extracted, nodata and out-of-AOI pixels are masked, reflectances are scaled.</li>
              <li>NDVI = (NIR − RED) / (NIR + RED) is computed with zero-division and NaN handling.</li>
              <li>Statistics, health classes, zones and weak-vegetation patches are derived.</li>
              <li>Maps, overlays, charts and a GeoTIFF of the index raster are written to outputs/ and data/processed/.</li>
              <li>Everything is stored as a result you can revisit on the Results page.</li>
            </ol>
            <Notice tone="muted">
              Band order is never guessed silently: the response always reports which bands were used and how they were
              determined (band descriptions, explicit request, or the configured fallback).
            </Notice>
          </Panel>
        </div>
      </div>
    </>
  )
}
