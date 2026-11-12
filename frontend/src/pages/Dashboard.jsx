import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api, assetUrl, analysisStore, findAsset, useApi } from '../api'
import { Badge, Empty, Loading, Notice, Panel, StatCard } from '../components/Panel'
import HealthDistribution from '../components/HealthDistribution'
import MapView from '../components/MapView'
import { NdviLegend } from '../components/InterpretationPanel'
import { HistogramChart } from '../components/Charts'

export default function Dashboard() {
  const navigate = useNavigate()
  const dashboard = useApi(api.dashboard)
  const [demoBusy, setDemoBusy] = useState(false)
  const [error, setError] = useState(null)

  const latestNdviId = useMemo(() => {
    const series = dashboard.data?.index?.series || []
    return series.length ? series[series.length - 1].id : null
  }, [dashboard.data])

  const latest = useApi(useMemo(() => ({ signal } = {}) => api.result(latestNdviId, { signal }), [latestNdviId]), { skip: !latestNdviId })

  useEffect(() => {
    if (latest.data) analysisStore.set({ ndvi: latest.data.payload })
  }, [latest.data])

  const createDemo = async () => {
    setDemoBusy(true)
    setError(null)
    try {
      const scene = await api.syntheticSample(900)
      const ndvi = await api.ndvi({ dataset: scene.raster.name, aoi: scene.aoi.name, index: 'NDVI', weak_threshold: 0.45 })
      analysisStore.set({ ndvi, selection: { dataset: scene.raster.name, aoi: scene.aoi.name, index: 'NDVI' } })
      await dashboard.reload()
      navigate('/ndvi')
    } catch (caught) {
      setError(caught.message)
    } finally {
      setDemoBusy(false)
    }
  }

  const totals = dashboard.data?.totals || {}
  const index = dashboard.data?.index || {}
  const payload = latest.data?.payload
  const overlay = payload ? findAsset(payload, 'index_overlay') : null
  const activity = dashboard.data?.activity || []

  return (
    <>
      {dashboard.error ? <Notice tone="danger" title="Backend unreachable">{dashboard.error.message}</Notice> : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}

      <div className="grid cols-5">
        <StatCard label="Fields available" value={totals.fields_available ?? '—'} foot={`${totals.rasters_available ?? 0} raster(s) in data/raw`} />
        <StatCard label="Analysed fields" value={totals.analysed_fields ?? '—'} foot={`${totals.analyses ?? 0} analysis run(s)`} tone="accent" />
        <StatCard
          label="Average NDVI"
          value={index.mean_ndvi === null || index.mean_ndvi === undefined ? '—' : index.mean_ndvi.toFixed(3)}
          foot="across stored analyses"
          tone="green"
        />
        <StatCard
          label="Healthy area"
          value={index.mean_healthy_pct === null || index.mean_healthy_pct === undefined ? '—' : index.mean_healthy_pct.toFixed(1)}
          unit="%"
          foot="mean share of healthy classes"
          tone="green"
        />
        <StatCard
          label="Low vegetation"
          value={index.mean_weak_pct === null || index.mean_weak_pct === undefined ? '—' : index.mean_weak_pct.toFixed(1)}
          unit="%"
          foot="mean share of low classes"
          tone="warn"
        />
      </div>

      <div className="grid sidebar-right">
        <Panel
          title={payload ? `Latest analysis · ${payload.dataset}` : 'Imagery preview'}
          hint={payload ? `${payload.index} · ${payload.observation_date} · ${payload.clip?.georeferenced ? `EPSG:${payload.raster?.crs?.epsg}` : 'non-georeferenced'}` : 'Run an analysis to populate the map'}
          actions={
            <>
              {overlay ? (
                <a className="btn small" href={assetUrl(overlay)} target="_blank" rel="noreferrer" download>
                  Download overlay
                </a>
              ) : null}
              <Link className="btn small primary" to="/fields">
                Analyse a field
              </Link>
            </>
          }
        >
          {dashboard.loading ? <Loading label="Loading dashboard…" /> : null}
          {payload ? (
            <>
              <MapView
                bounds={payload.clip?.bounds_lonlat}
                search
                overlays={[
                  { key: 'index', url: assetUrl(overlay), bounds: overlay?.bounds_lonlat, opacity: 0.85 },
                  { key: 'boundary', url: null },
                ]}
                geojson={payload.aoi_geojson ? [{ data: payload.aoi_geojson }] : []}
                markers={zoneMarkers(payload)}
                note={`${payload.index} overlay · ${payload.band_resolution.bands.red ? `red=B${payload.band_resolution.bands.red}, nir=B${payload.band_resolution.bands.nir}` : ''}`}
              />
              <NdviLegend thresholds={payload.config?.thresholds} />
            </>
          ) : (
            <Empty
              title="No analyses stored yet"
              action={
                <div className="row" style={{ justifyContent: 'center' }}>
                  <Link className="btn primary" to="/satellite">
                    Fetch real satellite imagery
                  </Link>
                  <Link className="btn" to="/fields">
                    Upload your own imagery
                  </Link>
                  <button className="small" onClick={createDemo} disabled={demoBusy} title="A generated sample scene, not real imagery">
                    {demoBusy ? 'Running pipeline…' : 'Labelled synthetic sample'}
                  </button>
                </div>
              }
            >
              Vibes Lite analyses real imagery against GeoJSON field boundaries. Pull a real Copernicus Sentinel-2
              acquisition of your field on the Satellite page, or upload your own GeoTIFF. A generated sample scene is
              also available if you just want to see the pipeline (data → NDVI → health → maps) run through — it is
              labelled as synthetic everywhere it appears.
            </Empty>
          )}
        </Panel>

        <div className="stack">
          {payload ? (
            <Panel title="NDVI summary" hint="Latest analysis">
              <div className="grid cols-2" style={{ gap: 10 }}>
                <StatCard label="Mean" value={number(payload.statistics.mean, 3)} tone="green" />
                <StatCard label="Median" value={number(payload.statistics.median, 3)} />
                <StatCard label="Min" value={number(payload.statistics.min, 3)} />
                <StatCard label="Max" value={number(payload.statistics.max, 3)} />
              </div>
              <div className="row" style={{ fontSize: 12, color: 'var(--muted)' }}>
                <Badge tone="teal">{payload.statistics.valid_pixels?.toLocaleString()} valid px</Badge>
                <Badge>{payload.clip?.shape?.join(' × ')} px window</Badge>
                {payload.clip?.decimated ? <Badge tone="warn">decimated 1/{payload.clip.decimation}</Badge> : null}
              </div>
              <HistogramChart statistics={payload.statistics} thresholds={payload.config?.thresholds} />
            </Panel>
          ) : null}

          {payload ? (
            <Panel title="Health distribution" hint={`Thresholds from config.yaml`}>
              <HealthDistribution health={payload.health} showTable={false} />
            </Panel>
          ) : null}
        </div>
      </div>

      <div className="grid sidebar-right">
        <Panel title="Recent processing activity" hint="Newest first">
          {dashboard.loading ? <Loading label="Loading activity…" /> : null}
          {activity.length === 0 && !dashboard.loading ? <div className="empty">No analyses yet.</div> : null}
          {activity.length ? (
            <div className="timeline">
              {activity.map((item) => (
                <div className="timeline-item" key={item.id}>
                  <span className="when">{(item.created_at || '').slice(5, 16).replace('T', ' ')}</span>
                  <span className="what">
                    <Link to="/results">{item.title || item.kind}</Link>
                    {item.summary?.mean !== undefined && item.summary?.mean !== null ? (
                      <span className="mono" style={{ marginLeft: 8, color: 'var(--muted)' }}>
                        mean {Number(item.summary.mean).toFixed(3)}
                      </span>
                    ) : null}
                  </span>
                  <Badge tone={item.kind === 'ndvi' ? 'green' : item.kind === 'crop_health' ? 'teal' : ''}>{item.kind}</Badge>
                </div>
              ))}
            </div>
          ) : null}
        </Panel>

        <Panel title="Datasets in data/raw" hint="Uploads are validated on arrival">
          {dashboard.loading ? <Loading /> : null}
          {(dashboard.data?.datasets || []).length === 0 && !dashboard.loading ? <div className="empty">data/raw is empty.</div> : null}
          {(dashboard.data?.datasets || []).length ? (
            <table>
              <thead>
                <tr>
                  <th>File</th>
                  <th>Type</th>
                  <th className="num">Bands</th>
                  <th className="num">Size MB</th>
                </tr>
              </thead>
              <tbody>
                {(dashboard.data.datasets || []).map((entry) => (
                  <tr key={entry.name}>
                    <td>
                      {entry.name} {entry.synthetic ? <Badge tone="synthetic">synthetic</Badge> : null}
                    </td>
                    <td>{entry.type}</td>
                    <td className="num">{entry.band_count ?? '—'}</td>
                    <td className="num">{entry.size_mb}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </Panel>
      </div>
    </>
  )
}

function number(value, digits = 3) {
  return value === null || value === undefined ? '—' : Number(value).toFixed(digits)
}

function zoneMarkers(payload) {
  const patches = payload?.weak_vegetation?.patches || []
  return patches.slice(0, 12).map((patch, index) => ({
    position: [patch.centroid_lonlat[1], patch.centroid_lonlat[0]],
    label: `Weak patch ${index + 1}`,
    detail: `${patch.area_ha} ha · centroid ${patch.centroid_lonlat.map((value) => value.toFixed(4)).join(', ')}`,
  }))
}
