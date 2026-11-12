import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, analysisStore, useApi } from '../api'
import { Badge, DataTable, Empty, KeyValue, Loading, Notice, Panel, Warnings } from '../components/Panel'
import MapView from '../components/MapView'

const RADII = [0.5, 0.8, 1.2, 2, 3, 5]
const CLOUD_OPTIONS = [5, 10, 20, 40, 60, 100]

/**
 * Pull a real Copernicus acquisition of an actual field.
 *
 * The backend searches the STAC catalogue and then reads only the requested
 * window of the band files over HTTPS, so this page deals in real reflectance
 * rather than a sample scene. Everything it downloads lands in `data/raw` as an
 * ordinary GeoTIFF, which is why the fetched scene can be analysed on the same
 * pages as an upload.
 */
export default function Satellite() {
  const navigate = useNavigate()
  const catalogue = useApi(api.satelliteCatalogue)

  const [centre, setCentre] = useState(null)
  const [radiusKm, setRadiusKm] = useState(1.2)
  const [days, setDays] = useState(120)
  const [maxCloud, setMaxCloud] = useState(20)
  const [maskClouds, setMaskClouds] = useState(true)

  const [searching, setSearching] = useState(false)
  const [search, setSearch] = useState(null)
  const [error, setError] = useState(null)
  const [fetching, setFetching] = useState(null)
  const [fetched, setFetched] = useState(null)
  const [running, setRunning] = useState(false)

  const collection = catalogue.data?.collections?.[0] || null
  const enabled = catalogue.data?.enabled !== false

  const runSearch = async () => {
    if (!centre) {
      setError('Pick the field on the map (or search a place) first — a scene is searched around a coordinate.')
      return
    }
    setSearching(true)
    setError(null)
    setFetched(null)
    try {
      const result = await api.satelliteScenes({
        lat: centre.lat,
        lon: centre.lon,
        radius_m: Math.round(radiusKm * 1000),
        days,
        max_cloud: maxCloud,
        limit: 10,
      })
      setSearch(result)
    } catch (caught) {
      setSearch(null)
      setError(caught.message)
    } finally {
      setSearching(false)
    }
  }

  const fetchScene = async (sceneId) => {
    setFetching(sceneId || 'best')
    setError(null)
    try {
      const result = await api.satelliteFetch({
        lat: centre.lat,
        lon: centre.lon,
        radius_m: Math.round(radiusKm * 1000),
        scene_id: sceneId || null,
        days,
        max_cloud: maxCloud,
        mask_clouds: maskClouds,
      })
      setFetched(result)
    } catch (caught) {
      setError(caught.message)
    } finally {
      setFetching(null)
    }
  }

  const runNdvi = async () => {
    if (!fetched) return
    setRunning(true)
    setError(null)
    try {
      const request = { dataset: fetched.dataset, aoi: null, index: 'NDVI' }
      const result = await api.ndvi(request)
      analysisStore.set({ ndvi: result, selection: request })
      navigate('/ndvi')
    } catch (caught) {
      setError(caught.message)
    } finally {
      setRunning(false)
    }
  }

  const sceneRows = (search?.scenes || []).map((scene) => ({
    id: scene.scene_id,
    when: (scene.datetime || '').slice(0, 10),
    platform: scene.platform || '—',
    cloud: scene.cloud_cover === null || scene.cloud_cover === undefined ? null : Number(scene.cloud_cover).toFixed(2),
    tile: scene.grid_code || '—',
    scene,
  }))

  return (
    <>
      <Panel
        title="Real Sentinel imagery"
        hint="Search the Copernicus catalogue over your field, then download only that window"
        actions={
          catalogue.data ? (
            <a className="btn small" href={catalogue.data.providers?.[0]?.url} target="_blank" rel="noreferrer">
              Catalogue
            </a>
          ) : null
        }
      >
        {catalogue.loading ? <Loading label="Reading the satellite catalogue…" /> : null}
        {catalogue.error ? <Notice tone="danger">{catalogue.error.message}</Notice> : null}
        {!enabled && catalogue.data ? (
          <Notice tone="warn" title="Disabled">
            Real satellite ingestion is switched off in configuration (<span className="mono">satellite.enabled=false</span>
            ). Set <span className="mono">VIBES_SATELLITE_ENABLED=true</span> to enable it.
          </Notice>
        ) : null}
        {collection ? (
          <>
            <div className="row">
              <Badge tone="green">{collection.label}</Badge>
              <Badge>{collection.bands.length} bands</Badge>
              {collection.supports_cloud_mask ? <Badge tone="teal">SCL cloud mask</Badge> : null}
              <Badge tone="muted">{catalogue.data.limits.max_radius_m} m radius cap</Badge>
            </div>
            <div className="hint">{collection.product}</div>
          </>
        ) : null}
      </Panel>

      <div className="grid sidebar-left">
        <Panel title="Field window" hint="Pick the field on the map, then search acquisitions over it">
          <MapView
            height="map-short"
            search
            onPick={(picked) => {
              setCentre({ lat: picked.lat, lon: picked.lon, place: picked.place })
              setSearch(null)
              setFetched(null)
            }}
            pickLabel="Use as field centre"
            markers={
              centre ? [{ position: [centre.lat, centre.lon], label: 'Field centre', detail: centre.place || '' }] : []
            }
            note={
              centre
                ? `${centre.place || 'Picked point'} · ${centre.lat.toFixed(5)}, ${centre.lon.toFixed(5)}`
                : 'No field selected yet — search a place or click the map.'
            }
          />

          <label className="field">
            Field half-width
            <select value={radiusKm} onChange={(event) => setRadiusKm(Number(event.target.value))}>
              {RADII.map((value) => (
                <option key={value} value={value}>
                  {value} km ({Math.round((value * 2000) / 10)} px at 10 m)
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Look back
            <select value={days} onChange={(event) => setDays(Number(event.target.value))}>
              {[30, 60, 120, 200, 365].map((value) => (
                <option key={value} value={value}>
                  {value} days
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Maximum scene cloud
            <select value={maxCloud} onChange={(event) => setMaxCloud(Number(event.target.value))}>
              {CLOUD_OPTIONS.map((value) => (
                <option key={value} value={value}>
                  {value}%
                </option>
              ))}
            </select>
          </label>
          <label className="row" style={{ gap: 8, alignItems: 'center', fontSize: 12.5 }}>
            <input type="checkbox" checked={maskClouds} onChange={(event) => setMaskClouds(event.target.checked)} />
            Mask cloud, shadow and snow pixels (Scene Classification Layer)
          </label>

          <div className="row">
            <button className="primary" onClick={runSearch} disabled={!centre || searching || !enabled}>
              {searching ? 'Searching…' : 'Find acquisitions'}
            </button>
            <button
              className="small"
              onClick={() => fetchScene(null)}
              disabled={!centre || !enabled || Boolean(fetching)}
              title="Download the least cloudy acquisition in the window"
            >
              {fetching === 'best' ? 'Downloading…' : 'Download least cloudy'}
            </button>
          </div>
          {error ? <Notice tone="danger">{error}</Notice> : null}
        </Panel>

        <div className="stack">
          {search ? (
            <Panel
              title={`${search.count} acquisition(s)`}
              hint={`${search.collection_label} · ${search.search.window_days} days · under ${search.search.max_cloud_cover}% cloud · least cloudy first`}
              actions={search.cached ? <Badge>cached</Badge> : null}
            >
              <Warnings items={search.warnings} title="Catalogue notes" />
              {search.count === 0 ? (
                <Empty title="No acquisition matched">
                  Nothing under {search.search.max_cloud_cover}% cloud in the last {search.search.window_days} days over
                  this field. Widen the date window, raise the cloud threshold, or try a different field.
                </Empty>
              ) : (
                <DataTable
                  columns={[
                    { key: 'when', label: 'Date' },
                    { key: 'platform', label: 'Platform' },
                    { key: 'tile', label: 'Tile' },
                    { key: 'cloud', label: 'Cloud %' },
                    {
                      key: 'id',
                      label: '',
                      render: (value, row) => (
                        <button
                          className="small primary"
                          onClick={() => fetchScene(value)}
                          disabled={Boolean(fetching)}
                        >
                          {fetching === value ? 'Downloading…' : 'Download'}
                        </button>
                      ),
                    },
                  ]}
                  rows={sceneRows}
                  emptyLabel="No acquisitions"
                />
              )}
              <div className="hint">
                Scene id, acquisition time and cloud cover come from the catalogue; the pixels are read only when you
                download. Licence: {search.licence}.
              </div>
            </Panel>
          ) : (
            <Panel title="No search yet">
              <Empty title="Pick a field and search">
                {collection
                  ? `Search returns real ${collection.label} acquisitions covering the field, least cloudy first.`
                  : 'Loading the catalogue…'}
              </Empty>
            </Panel>
          )}

          {fetched ? (
            <Panel
              title={fetched.cached ? 'Scene already stored' : 'Scene downloaded'}
              hint={fetched.dataset}
              actions={
                <button className="small primary" onClick={runNdvi} disabled={running}>
                  {running ? 'Analysing…' : 'Run NDVI on this scene'}
                </button>
              }
            >
              <div className="row">
                <Badge tone="green">{fetched.scene.scene_id}</Badge>
                <Badge>{(fetched.scene.datetime || '').slice(0, 10)}</Badge>
                {fetched.scene.cloud_cover !== null && fetched.scene.cloud_cover !== undefined ? (
                  <Badge>{Number(fetched.scene.cloud_cover).toFixed(2)}% cloud</Badge>
                ) : null}
                {fetched.cloud_masked ? <Badge tone="teal">cloud masked</Badge> : null}
                {fetched.cached ? <Badge>no re-download</Badge> : null}
              </div>

              <KeyValue
                rows={[
                  ['Bands', (fetched.bands || []).join(', ')],
                  ['Window', `${(fetched.shape || []).join(' × ')} px${fetched.decimated ? ` (from ${fetched.native_shape.join(' × ')})` : ''}`],
                  ['Ground resolution', fetched.resolution_m ? `${fetched.resolution_m} m` : '—'],
                  ['CRS', fetched.crs],
                  ['Usable pixels', fetched.usable_fraction !== undefined ? `${(fetched.usable_fraction * 100).toFixed(2)}%` : '—'],
                  ['File size', fetched.size_mb ? `${fetched.size_mb} MB` : '—'],
                  ['Stored as', fetched.dataset],
                ]}
              />

              <Warnings items={fetched.warnings} title="Notes" />

              {fetched.reflectance ? (
                <>
                  <h3 style={{ marginTop: 12, marginBottom: 4 }}>Surface reflectance read from the scene</h3>
                  <DataTable
                    columns={[
                      { key: 'band', label: 'Band' },
                      { key: 'min', label: 'Min' },
                      { key: 'mean', label: 'Mean' },
                      { key: 'max', label: 'Max' },
                    ]}
                    rows={Object.entries(fetched.reflectance).map(([band, stats]) => ({
                      band,
                      min: stats.min,
                      mean: stats.mean,
                      max: stats.max,
                    }))}
                    numericFrom={3}
                    emptyLabel="No reflectance statistics"
                  />
                </>
              ) : null}

              {fetched.provenance ? (
                <div className="hint" style={{ marginTop: 8 }}>
                  {fetched.provenance.ATTRIBUTION} · {fetched.provenance.RADIOMETRY} ·{' '}
                  {fetched.provenance.CLOUD_MASKED === 'SCL' ? 'cloud pixels are nodata' : 'no per-pixel cloud mask'}
                </div>
              ) : null}
              <div className="hint">
                This file is in <span className="mono">data/raw</span>, so Fields, NDVI, Crop Health and the agronomy
                engines all accept it by name — no upload step.
              </div>
            </Panel>
          ) : null}
        </div>
      </div>
    </>
  )
}
