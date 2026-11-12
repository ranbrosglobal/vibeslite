import { useEffect, useMemo, useState } from 'react'
import { api, assetUrl, useApi } from '../api'
import { Badge, DataTable, Empty, Loading, Notice, Panel, StatCard } from '../components/Panel'
import Uploader from '../components/Uploader'

const OPERATION_HINTS = {
  grayscale: 'Colour → single channel',
  resize: 'Resample (needs a scale)',
  denoise: 'Non-local means denoising',
  blur: 'Gaussian smoothing',
  median_blur: 'Median smoothing',
  enhance: 'CLAHE / gamma / sharpening',
  threshold: 'Fixed binary threshold',
  otsu: 'Automatic histogram threshold',
  adaptive_threshold: 'Local mean threshold',
  invert: 'Invert a binary mask',
  erode: 'Shrink bright regions',
  dilate: 'Grow bright regions',
  morph_open: 'Remove small specks',
  morph_close: 'Fill holes and gaps',
  morph_gradient: 'Region edges',
  clean_mask: 'Open + close + fill + despeckle',
  remove_small_objects: 'Drop small blobs',
  edges: 'Canny / Sobel / Laplacian',
}

export default function ImageProcessing() {
  const config = useApi(api.config)
  const datasets = useApi(api.datasets)
  const [source, setSource] = useState({ kind: 'raster', dataset: '', band: 4 })
  const [file, setFile] = useState(null)
  const [filePreview, setFilePreview] = useState(null)
  const [preset, setPreset] = useState('clean_binary')
  const [operations, setOperations] = useState(['grayscale', 'denoise', 'blur', 'otsu', 'morph_open', 'morph_close'])
  const [result, setResult] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const rasters = useMemo(() => (datasets.data?.datasets || []).filter((entry) => entry.type === 'raster'), [datasets.data])
  const selected = rasters.find((entry) => entry.name === source.dataset)
  const presets = config.data?.opencv?.presets || []
  const allOperations = config.data?.opencv?.operations || []

  useEffect(() => {
    if (!source.dataset && rasters.length) setSource((current) => ({ ...current, dataset: rasters[0].name }))
  }, [rasters, source.dataset])

  useEffect(() => {
    const match = presets.find((entry) => entry.key === preset)
    if (match) setOperations(match.operations)
  }, [preset, presets])

  useEffect(() => {
    if (!file) {
      setFilePreview(null)
      return undefined
    }
    const url = URL.createObjectURL(file)
    setFilePreview(url)
    return () => URL.revokeObjectURL(url)
  }, [file])

  const run = async () => {
    setBusy(true)
    setError(null)
    try {
      const form = new FormData()
      if (file) {
        form.append('file', file)
      } else {
        form.append('dataset', source.dataset)
        if (source.band) form.append('band', String(source.band))
      }
      form.append('operations', JSON.stringify(operations))
      form.append('detect_contours_flag', 'true')
      form.append('max_size', '900')
      const payload = await api.processImage(form)
      setResult(payload)
    } catch (caught) {
      setError(caught.message)
    } finally {
      setBusy(false)
    }
  }

  const toggleOperation = (operation) => {
    setOperations((current) => (current.includes(operation) ? current.filter((item) => item !== operation) : [...current, operation]))
  }

  const before = result?.assets?.find((asset) => asset.name === 'before')
  const after = result?.assets?.find((asset) => asset.name === 'after')
  const annotated = result?.assets?.find((asset) => asset.name === 'contours_annotated')

  return (
    <>
      {error ? <Notice tone="danger" title="Processing failed">{error}</Notice> : null}

      <div className="grid sidebar-left">
        <Panel title="Source image" hint="A raster band from data/raw, or an uploaded image">
          <div className="row">
            <button className={file ? '' : 'primary'} onClick={() => setFile(null)}>
              Raster band
            </button>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>or upload below</span>
          </div>

          {!file ? (
            <>
              <label className="field">
                Dataset
                <select value={source.dataset} onChange={(event) => setSource((current) => ({ ...current, dataset: event.target.value }))}>
                  <option value="">— select —</option>
                  {rasters.map((entry) => (
                    <option key={entry.name} value={entry.name}>
                      {entry.name} · {entry.band_count} bands
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                Band (1-based)
                <input
                  type="number"
                  min="1"
                  max={selected?.band_count || 12}
                  value={source.band}
                  onChange={(event) => setSource((current) => ({ ...current, band: Number(event.target.value) }))}
                />
              </label>
              {selected ? (
                <KeyValueMini
                  rows={[
                    ['Bands', (selected.band_descriptions || []).join(', ') || 'unnamed'],
                    ['CRS', selected.crs || 'none'],
                  ]}
                />
              ) : null}
              {source.dataset ? (
                <img
                  src={api.datasetPreviewUrl(source.dataset, 520)}
                  alt="Band preview"
                  className="image-frame"
                  style={{ width: '100%' }}
                />
              ) : null}
            </>
          ) : (
            <>
              <div className="row between">
                <Badge tone="teal">{file.name}</Badge>
                <button className="ghost small" onClick={() => setFile(null)}>
                  clear
                </button>
              </div>
              {filePreview ? <img src={filePreview} alt="Upload preview" className="image-frame" style={{ width: '100%' }} /> : null}
            </>
          )}

          <Uploader
            onFiles={(files) => setFile(files[0])}
            accept=".png,.jpg,.jpeg,.tif,.tiff"
            label="Upload an image"
            hint="PNG / JPEG process in memory; GeoTIFF is stored in data/raw"
          />
        </Panel>

        <div className="stack">
          <Panel title="Processing preset" hint="Presets mirror the backend presets">
            <div className="chips">
              {presets.map((entry) => (
                <span key={entry.key} className={`chip ${preset === entry.key ? 'active' : ''}`} onClick={() => setPreset(entry.key)}>
                  {entry.label}
                </span>
              ))}
              <span className={`chip ${preset === 'custom' ? 'active' : ''}`} onClick={() => setPreset('custom')}>
                Custom
              </span>
            </div>
          </Panel>

          <Panel title="Operations" hint="Applied in order; must be a valid pipeline">
            <div className="chips">
              {allOperations.map((operation) => (
                <span
                  key={operation}
                  className={`chip ${operations.includes(operation) ? 'active' : ''}`}
                  title={OPERATION_HINTS[operation] || operation}
                  onClick={() => {
                    setPreset('custom')
                    toggleOperation(operation)
                  }}
                >
                  {operation}
                </span>
              ))}
            </div>
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>
              Pipeline: <span className="mono">{operations.join(' → ') || 'none'}</span>
            </div>
            <div className="row">
              <button className="primary" onClick={run} disabled={busy || operations.length === 0 || (!file && !source.dataset)}>
                {busy ? 'Processing…' : 'Process image'}
              </button>
              <button className="small" onClick={() => setOperations([])} disabled={busy}>
                Clear
              </button>
            </div>
          </Panel>
        </div>
      </div>

      {busy ? <Loading label="Running the OpenCV pipeline…" /> : null}

      {!result && !busy ? (
        <Panel title="Before / after">
          <Empty title="No processing run yet">
            Pick a raster band or upload an image, choose a preset or build your own operation pipeline, then process.
            Everything runs through the OpenCV engine (masking, morphology, contours, edges, enhancement).
          </Empty>
        </Panel>
      ) : null}

      {result ? (
        <>
          <div className="grid cols-4">
            <StatCard label="Operations" value={result.operation_count} foot={`${result.duration_ms} ms`} tone="accent" />
            <StatCard
              label="Output"
              value={result.binary_output ? 'binary mask' : 'image'}
              foot={(result.output_shape || []).join(' × ')}
            />
            <StatCard label="Contours" value={result.contour_count} foot={`${Number(result.contour_total_area_pixels || 0).toLocaleString()} px total`} tone="green" />
            <StatCard
              label="Mask coverage"
              value={result.mask_coverage === null || result.mask_coverage === undefined ? '—' : (result.mask_coverage * 100).toFixed(1)}
              unit="%"
              foot="share of pixels selected"
            />
          </div>

          <Panel title="Before / after" hint={`Source: ${result.source.name}${result.source.band ? ` · band ${result.source.band}` : ''}`}>
            <div className="grid cols-2">
              <figure className="image-frame" style={{ margin: 0 }}>
                <img src={assetUrl(before)} alt="Before" />
                <figcaption className="image-caption">
                  <span>Before</span>
                  <span className="mono">
                    mean {result.statistics.before.mean_brightness} · σ {result.statistics.before.std_contrast} · edges{' '}
                    {(result.statistics.before.edge_density * 100).toFixed(1)}%
                  </span>
                </figcaption>
              </figure>
              <figure className="image-frame" style={{ margin: 0 }}>
                <img src={assetUrl(after)} alt="After" />
                <figcaption className="image-caption">
                  <span>After</span>
                  <span className="mono">
                    mean {result.statistics.after.mean_brightness} · σ {result.statistics.after.std_contrast} · edges{' '}
                    {(result.statistics.after.edge_density * 100).toFixed(1)}%
                  </span>
                </figcaption>
              </figure>
            </div>
            {annotated ? (
              <figure className="image-frame" style={{ margin: 0 }}>
                <img src={assetUrl(annotated)} alt="Annotated contours" />
                <figcaption className="image-caption">
                  <span>Detected contours with pixel areas</span>
                  <a href={assetUrl(annotated)} target="_blank" rel="noreferrer" download>
                    download
                  </a>
                </figcaption>
              </figure>
            ) : null}
          </Panel>

          <div className="grid sidebar-right">
            <Panel title="Pipeline steps" hint="Per-operation timing and output">
              <DataTable
                columns={[
                  { key: 'operation', label: 'Operation' },
                  { key: 'output_shape', label: 'Shape', render: (value) => (value || []).join(' × ') },
                  { key: 'output_dtype', label: 'dtype' },
                  { key: 'duration_ms', label: 'ms' },
                ]}
                rows={result.steps}
                numericFrom={1}
              />
            </Panel>
            <Panel title="Largest contours" hint="Pixel-space geometry">
              <DataTable
                columns={[
                  { key: 'area_pixels', label: 'Area px' },
                  { key: 'perimeter_pixels', label: 'Perimeter' },
                  { key: 'bounding_box', label: 'BBox', render: (value) => (value || []).join(', ') },
                  { key: 'centroid_pixels', label: 'Centroid', render: (value) => (value || []).join(', ') },
                ]}
                rows={(result.contours || []).slice(0, 10)}
                numericFrom={2}
              />
              {result.georeferencing?.crs ? (
                <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                  Georeferenced source ({result.georeferencing.crs}) — run segmentation on the Crop Health page for areas in
                  hectares and GeoJSON polygons.
                </div>
              ) : null}
            </Panel>
          </div>

          <Panel title="Processing outputs" hint={`outputs/${result.result_id}/`}>
            <div className="image-grid">
              {(result.assets || []).map((asset) => (
                <figure key={asset.name} className="image-frame" style={{ margin: 0 }}>
                  <img src={assetUrl(asset)} alt={asset.label} loading="lazy" />
                  <figcaption className="image-caption">
                    <span>{asset.label}</span>
                    <a href={assetUrl(asset)} target="_blank" rel="noreferrer" download>
                      download
                    </a>
                  </figcaption>
                </figure>
              ))}
            </div>
          </Panel>
        </>
      ) : null}
    </>
  )
}

function KeyValueMini({ rows }) {
  return (
    <div className="kv" style={{ fontSize: 12 }}>
      {rows.map(([label, value]) => (
        <div key={label} style={{ display: 'contents' }}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </div>
  )
}
