import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api, assetUrl, analysisStore, findAsset, useAnalysisState, useApi } from '../api'
import { Badge, Collapsible, Empty, JsonBlock, KeyValue, Loading, Notice, Panel, StatCard, Warnings } from '../components/Panel'
import { AssetGallery } from '../components/Uploader'
import FieldPicker from '../components/FieldPicker'
import MapView from '../components/MapView'
import { NdviLegend } from '../components/InterpretationPanel'
import InterpretationPanel from '../components/InterpretationPanel'
import { HistogramChart } from '../components/Charts'

export default function Ndvi() {
  const navigate = useNavigate()
  const { ndvi, selection } = useAnalysisState()
  const [running, setRunning] = useState(false)
  const [error, setError] = useState(null)
  const [rerunOpen, setRerunOpen] = useState(false)

  // A deep link (bookmark, refresh) arrives with an empty store: fall back to
  // the most recent stored NDVI result so the page is populated on its own.
  const latest = useApi(
    useCallback(({ signal } = {}) => api.results({ kind: 'ndvi', limit: 1 }), []),
    { skip: Boolean(ndvi) },
  )
  const storedId = latest.data?.results?.[0]?.id || null
  const stored = useApi(useCallback(({ signal } = {}) => api.result(storedId), [storedId]), { skip: Boolean(ndvi) || !storedId })
  useEffect(() => {
    if (!ndvi && stored.data?.payload) analysisStore.set({ ndvi: stored.data.payload })
  }, [ndvi, stored.data])

  const payload = ndvi
  const overlay = payload ? findAsset(payload, 'index_overlay') : null
  const rgbOverlay = payload ? findAsset(payload, 'rgb_overlay') : null
  const [showRgb, setShowRgb] = useState(false)

  const markers = useMemo(() => {
    const patches = payload?.weak_vegetation?.patches || []
    return patches.slice(0, 15).map((patch, index) => ({
      position: [patch.centroid_lonlat[1], patch.centroid_lonlat[0]],
      label: `Weak patch ${index + 1}`,
      detail: `${patch.area_ha} ha`,
    }))
  }, [payload])

  const runAnalysis = async (request) => {
    setRunning(true)
    setError(null)
    try {
      const result = await api.ndvi({ ...request, weak_threshold: 0.45 })
      analysisStore.set({ ndvi: result, selection: request })
      setRerunOpen(false)
    } catch (caught) {
      setError(caught.message)
    } finally {
      setRunning(false)
    }
  }

  if (!payload) {
    return (
      <Panel title="No NDVI result loaded" hint="Run an analysis or open a stored result">
        <Empty
          title="Nothing analysed in this session"
          action={
            <div className="row" style={{ justifyContent: 'center' }}>
              <Link className="btn primary" to="/fields">
                Go to field analysis
              </Link>
              <Link className="btn" to="/results">
                Browse stored results
              </Link>
            </div>
          }
        >
          Run an NDVI analysis on the Fields page (or open a stored result from the Results page) and this view fills in
          with the index map, statistics, histogram and health classes.
        </Empty>
      </Panel>
    )
  }

  const statistics = payload.statistics

  return (
    <>
      {error ? <Notice tone="danger">{error}</Notice> : null}

      <div className="row between">
        <div className="row">
          <Badge tone="green">{payload.index}</Badge>
          <span style={{ fontSize: 13 }}>
            <strong>{payload.dataset}</strong>
            {payload.aoi ? ` · AOI ${payload.aoi}` : ' · whole raster extent'}
          </span>
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>{payload.observation_date}</span>
          {payload.cached ? <Badge>cached</Badge> : null}
          {payload.raster?.synthetic ? <Badge tone="synthetic">synthetic scene</Badge> : null}
        </div>
        <div className="row">
          <button className="small" onClick={() => setRerunOpen((value) => !value)}>
            {rerunOpen ? 'Hide re-run' : 'Re-run with options'}
          </button>
          <Link className="btn small" to="/crop-health">
            Crop health →
          </Link>
        </div>
      </div>

      {rerunOpen ? (
        <div className="grid sidebar-left">
          <FieldPicker onRun={runAnalysis} running={running} runLabel="Re-run index analysis" />
          <Panel title="Re-run tips">
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, lineHeight: 1.7 }}>
              <li>Identical requests are served from the results cache — change the threshold or AOI to force a new computation.</li>
              <li>NDRE needs a red-edge band (Sentinel-2 B05/B06/B07); EVI needs blue + red + NIR.</li>
              <li>Weak-vegetation threshold defaults to the configured <span className="mono">low</span> boundary (0.40).</li>
            </ul>
          </Panel>
        </div>
      ) : null}

      <div className="grid cols-5">
        <StatCard label="Mean" value={fmt(statistics.mean)} tone="green" foot={`median ${fmt(statistics.median)}`} />
        <StatCard label="Minimum" value={fmt(statistics.min)} foot={`p2 ${fmt(statistics.p2)}`} />
        <StatCard label="Maximum" value={fmt(statistics.max)} foot={`p98 ${fmt(statistics.p98)}`} />
        <StatCard label="Std deviation" value={fmt(statistics.std)} foot={`variance ${fmt(statistics.variance, 4)}`} />
        <StatCard
          label="Valid pixels"
          value={number(statistics.valid_pixels)}
          unit={`/ ${number(statistics.total_pixels)}`}
          foot={`${(statistics.valid_ratio * 100).toFixed(1)}% coverage`}
          tone="accent"
        />
      </div>

      <div className="grid sidebar-right">
        <Panel
          title={`${payload.index} map`}
          hint="Raster overlay reprojected to WGS84 with the field boundary"
          actions={
            <>
              {rgbOverlay ? (
                <button className="small" onClick={() => setShowRgb((value) => !value)}>
                  {showRgb ? 'Show index' : 'Show imagery'}
                </button>
              ) : null}
              <a className="btn small" href={assetUrl(findAsset(payload, 'index_map'))} target="_blank" rel="noreferrer" download>
                Download map
              </a>
            </>
          }
        >
          <MapView
            bounds={payload.clip?.bounds_lonlat}
            overlays={[
              showRgb && rgbOverlay
                ? { key: 'rgb', url: assetUrl(rgbOverlay), bounds: rgbOverlay.bounds_lonlat, opacity: 0.95 }
                : { key: 'index', url: assetUrl(overlay), bounds: overlay?.bounds_lonlat, opacity: 0.85 },
            ]}
            geojson={payload.aoi_geojson ? [{ data: payload.aoi_geojson }] : []}
            markers={markers}
            note={`${payload.index} · ${statistics.valid_pixels?.toLocaleString()} valid pixels · ${payload.clip?.georeferenced ? `EPSG:${payload.raster?.crs?.epsg}` : 'pixel coordinates'}`}
          />
          <NdviLegend thresholds={payload.config?.thresholds} label={payload.index} />
        </Panel>

        <div className="stack">
          <Panel title="Band resolution" hint="Which pixels fed this index">
            <KeyValue
              rows={[
                ['Method', payload.band_resolution.method],
                [
                  'Bands used',
                  Object.entries(payload.band_resolution.bands || {})
                    .map(([name, number]) => `${name}=B${number}`)
                    .join(', '),
                ],
                ['Descriptions', (payload.band_resolution.band_descriptions || []).join(', ') || 'none'],
                ['Reflectance scaling', payload.raster?.nodata === 0 ? 'applied (scale from the GeoTIFF)' : 'as stored'],
              ]}
            />
            {payload.band_resolution.assumption_warning ? (
              <Notice tone="warn">
                The band order was assumed from configuration. Verify it or pass explicit band numbers before trusting
                absolute values.
              </Notice>
            ) : null}
          </Panel>

          <Panel title="Clip & coverage" hint="Only the AOI window was read">
            <KeyValue
              rows={[
                ['Window (col, row, w, h)', (payload.clip?.window || []).join(', ') || 'whole raster'],
                ['Analysed shape', (payload.clip?.shape || []).join(' × ')],
                ['Source shape', (payload.clip?.source_shape || []).join(' × ')],
                ['Pixel area', payload.clip?.pixel_area_ha ? `${payload.clip.pixel_area_ha} ha` : 'unknown'],
                ['AOI coverage', payload.clip?.aoi_coverage_pct !== null ? `${payload.clip.aoi_coverage_pct}% of the window` : '—'],
                ['Overlap with raster', payload.clip?.overlap_fraction !== null ? `${(payload.clip.overlap_fraction * 100).toFixed(1)}%` : '—'],
                ['Decimation', payload.clip?.decimated ? `1/${payload.clip.decimation}` : 'none'],
              ]}
            />
          </Panel>

          <Panel title="Class share of pixels" hint="Interpretation bands">
            <table>
              <tbody>
                {Object.entries(statistics.classes || {}).map(([key, value]) => (
                  <tr key={key}>
                    <td>{key.replace(/_/g, ' ')}</td>
                    <td className="num">{Number(value).toFixed(2)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        </div>
      </div>

      <div className="grid sidebar-right">
        <Panel title="Value distribution" hint="Histogram with configured class boundaries">
          <HistogramChart statistics={statistics} thresholds={payload.config?.thresholds} />
        </Panel>
        <InterpretationPanel
          interpretation={payload.interpretation}
          field={payload.field}
          thresholds={payload.config?.thresholds}
          title="What this means"
        />
      </div>

      <Warnings items={payload.warnings} />
      <Notice tone="muted">{payload.disclaimer}</Notice>

      <Panel
        title="Generated outputs"
        hint={`${payload.assets?.length || 0} file(s) written to outputs/${payload.result_id}/`}
        actions={
          <a className="btn small" href={`/api/results/${payload.result_id}`} target="_blank" rel="noreferrer">
            Result JSON
          </a>
        }
      >
        <AssetGallery assets={payload.assets || []} />
        <Collapsible title="Processing details (JSON)">
          <JsonBlock
            value={{
              result_id: payload.result_id,
              kind: payload.kind,
              dataset: payload.dataset,
              aoi: payload.aoi,
              observation_date: payload.observation_date,
              band_resolution: payload.band_resolution,
              clip: payload.clip,
              statistics: { ...payload.statistics, histogram: '[20 bins]' },
              weak_vegetation: { ...payload.weak_vegetation, patches: `[${payload.weak_vegetation?.patches?.length} patches]` },
              anomalies: payload.anomalies,
              field: payload.field,
              zones: { zone_count: payload.zones?.zone_count, total_zones: payload.zones?.total_zones },
              processed_raster: payload.processed_raster,
            }}
          />
        </Collapsible>
      </Panel>
    </>
  )
}

function fmt(value, digits = 3) {
  return value === null || value === undefined ? '—' : Number(value).toFixed(digits)
}

function number(value) {
  return value === null || value === undefined ? '—' : Number(value).toLocaleString()
}
