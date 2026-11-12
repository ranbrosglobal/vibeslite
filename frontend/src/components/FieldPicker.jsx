import { useEffect, useMemo, useState } from 'react'
import { api, useApi, analysisStore } from '../api'
import { Badge, KeyValue, Loading, Notice, Panel } from './Panel'
import Uploader from './Uploader'
import MapView from './MapView'

const INDEXES = ['NDVI', 'NDRE', 'EVI', 'SAVI']

/**
 * Choose a raster + AOI (or upload them), inspect metadata and imagery, then
 * launch an analysis. Shared by the Fields, NDVI and Crop Health pages.
 */
export default function FieldPicker({ onRun, running = false, runLabel = 'Run analysis', extraControls, note, reloadToken = 0 })
{
  const datasets = useApi(api.datasets)
  const aois = useApi(api.aois)
  const [dataset, setDataset] = useState(null)
  const [aoi, setAoi] = useState('')
  const [index, setIndex] = useState('NDVI')
  const [uploadBusy, setUploadBusy] = useState(false)
  const [uploadError, setUploadError] = useState(null)
  const [demoBusy, setDemoBusy] = useState(false)

  const rasters = useMemo(() => (datasets.data?.datasets || []).filter((entry) => entry.type === 'raster'), [datasets.data])
  const boundaryFiles = useMemo(() => (datasets.data?.datasets || []).filter((entry) => entry.type === 'vector'), [datasets.data])
  const tables = useMemo(() => (datasets.data?.datasets || []).filter((entry) => entry.type === 'table'), [datasets.data])

  useEffect(() => {
    if (!dataset && rasters.length) setDataset(rasters[0].name)
  }, [rasters, dataset])

  // A boundary created elsewhere on the page (e.g. from a picked map location)
  // has to show up in this picker without a full page reload.
  useEffect(() => {
    if (reloadToken > 0) {
      datasets.reload()
      aois.reload()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadToken])

  // Default the AOI to a boundary file that matches the raster name when possible.
  useEffect(() => {
    if (aoi || !dataset || boundaryFiles.length === 0) return
    const stem = dataset.replace(/\.[^.]+$/, '')
    const match = boundaryFiles.find((entry) => entry.name.startsWith(stem))
    setAoi(match ? match.name : boundaryFiles[0].name)
  }, [dataset, boundaryFiles, aoi])

  const detail = useApi(useMemo(() => ({ signal }) => (dataset ? api.dataset(dataset, { signal }) : Promise.resolve(null)), [dataset]), {
    skip: !dataset,
  })

  const upload = async (files) => {
    setUploadBusy(true)
    setUploadError(null)
    try {
      const result = await api.upload(files, 'auto')
      await Promise.all([datasets.reload(), aois.reload()])
      const first = result.files?.[0]
      if (first?.type === 'raster') setDataset(first.name)
      if (first?.type === 'vector') setAoi(first.name)
    } catch (error) {
      setUploadError(error.message)
    } finally {
      setUploadBusy(false)
    }
  }

  const generateDemo = async () => {
    setDemoBusy(true)
    setUploadError(null)
    try {
      const result = await api.syntheticSample(900)
      await Promise.all([datasets.reload(), aois.reload()])
      setDataset(result.raster.name)
      setAoi(result.aoi.name)
    } catch (error) {
      setUploadError(error.message)
    } finally {
      setDemoBusy(false)
    }
  }

  const selected = rasters.find((entry) => entry.name === dataset) || null
  const metadata = detail.data?.metadata
  const footprint = detail.data?.footprint

  const run = () => {
    if (!dataset) return
    const request = { dataset, aoi: aoi || null, index }
    analysisStore.set({ selection: request })
    onRun?.(request)
  }

  return (
    <div className="stack">
      <Panel
        title="Dataset"
        hint="Rasters and field boundaries available in data/raw"
        actions={
          <button className="small" onClick={() => Promise.all([datasets.reload(), aois.reload()])} disabled={datasets.loading}>
            Refresh
          </button>
        }
      >
        {datasets.loading ? <Loading label="Loading datasets…" /> : null}
        {datasets.error ? <Notice tone="danger">{datasets.error.message}</Notice> : null}

        <label className="field">
          Raster imagery
          <select value={dataset || ''} onChange={(event) => setDataset(event.target.value)}>
            <option value="">— select a raster —</option>
            {rasters.map((entry) => (
              <option key={entry.name} value={entry.name}>
                {entry.name} · {entry.band_count} bands{entry.synthetic ? ' · synthetic' : ''}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          Field boundary (AOI)
          <select value={aoi} onChange={(event) => setAoi(event.target.value)}>
            <option value="">— whole raster extent —</option>
            {boundaryFiles.map((entry) => (
              <option key={entry.name} value={entry.name}>
                {entry.name} · {entry.feature_count} feature(s){entry.area_ha ? ` · ${Number(entry.area_ha).toFixed(1)} ha` : ''}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          Vegetation index
          <select value={index} onChange={(event) => setIndex(event.target.value)}>
            {INDEXES.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>

        {extraControls}

        <div className="row">
          <button className="primary" onClick={run} disabled={!dataset || running}>
            {running ? 'Analysing…' : runLabel}
          </button>
          <div className="spacer" />
          <button className="small" onClick={generateDemo} disabled={demoBusy}>
            {demoBusy ? 'Generating…' : 'Generate demo scene'}
          </button>
        </div>
        {note ? <div className="hint">{note}</div> : null}

        <Uploader
          onFiles={upload}
          multiple
          busy={uploadBusy}
          accept=".tif,.tiff,.geojson,.json,.csv,.png,.jpg,.jpeg"
          label="Upload imagery / boundary"
          hint="GeoTIFF, GeoJSON or CSV · stored in data/raw and validated on arrival"
        />
        {uploadError ? <Notice tone="danger">{uploadError}</Notice> : null}
        {tables.length ? (
          <div className="row" style={{ fontSize: 11.5, color: 'var(--muted)' }}>
            CSV datasets available for time series: {tables.map((entry) => entry.name).join(', ')}
          </div>
        ) : null}
      </Panel>

      {selected ? (
        <Panel title="Selected raster" hint={selected.synthetic ? 'Labelled synthetic scene (not real imagery)' : undefined}>
          {detail.loading ? <Loading label="Reading metadata…" /> : null}
          {detail.error ? <Notice tone="danger">{detail.error.message}</Notice> : null}
          {metadata ? (
            <>
              <div className="row">
                <Badge tone="teal">{metadata.band_count} bands</Badge>
                <Badge>{metadata.shape ? `${metadata.width} × ${metadata.height} px` : `${metadata.width} × ${metadata.height}`}</Badge>
                <Badge>{metadata.crs?.epsg ? `EPSG:${metadata.crs.epsg}` : 'no CRS'}</Badge>
                {selected.synthetic ? <Badge tone="synthetic">synthetic</Badge> : null}
              </div>
              <KeyValue
                rows={[
                  ['Bands', (metadata.band_descriptions || []).join(', ') || 'unnamed'],
                  ['Resolution', metadata.resolution?.x ? `${metadata.resolution.x} ${metadata.resolution.unit || 'm'}` : '—'],
                  ['Nodata', metadata.nodata ?? 'not declared'],
                  ['Dtype', (metadata.dtypes || []).join(', ')],
                  ['Size', `${metadata.file_size_mb} MB`],
                  ['Bounding box', (metadata.bounds_lonlat || []).map((value) => value.toFixed(4)).join(', ')],
                ]}
              />
              <img
                src={api.datasetPreviewUrl(selected.name, 700)}
                alt="Raster preview"
                className="image-frame"
                style={{ width: '100%' }}
              />
              {footprint ? (
                <MapView
                  bounds={footprint.properties?.bounds_lonlat}
                  height="map-short"
                  overlays={[]}
                  geojson={[{ data: { type: 'Feature', geometry: footprint.geometry, properties: {} } }]}
                  note={dataset}
                />
              ) : null}
            </>
          ) : null}
        </Panel>
      ) : null}
    </div>
  )
}
