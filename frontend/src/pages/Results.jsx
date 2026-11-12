import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api, analysisStore, useApi } from '../api'
import { Badge, Collapsible, DataTable, Empty, JsonBlock, KeyValue, Loading, Notice, Panel } from '../components/Panel'
import { AssetGallery } from '../components/Uploader'

const KINDS = [
  { key: '', label: 'All' },
  { key: 'ndvi', label: 'NDVI' },
  { key: 'crop_health', label: 'Crop health' },
  { key: 'segmentation', label: 'Segmentation' },
  { key: 'opencv', label: 'OpenCV' },
  { key: 'timeseries', label: 'Time series' },
]

export default function Results() {
  const navigate = useNavigate()
  const [kind, setKind] = useState('')
  const [selectedId, setSelectedId] = useState(null)
  const [error, setError] = useState(null)
  const listing = useApi(useMemo(() => ({ signal } = {}) => api.results({ kind, limit: 100 }), [kind]))
  const detail = useApi(useMemo(() => ({ signal } = {}) => api.result(selectedId), [selectedId]), { skip: !selectedId })

  const rows = listing.data?.results || []
  const record = detail.data

  const openInViewer = () => {
    if (!record) return
    if (record.kind === 'ndvi' || record.kind === 'crop_health') {
      analysisStore.set({
        ndvi: record.payload,
        selection: { dataset: record.dataset, aoi: record.payload?.aoi || record.aoi, index: record.payload?.index || 'NDVI' },
      })
      navigate(record.kind === 'crop_health' ? '/crop-health' : '/ndvi')
      return
    }
    setError(`Result kind '${record.kind}' has no dedicated viewer yet — open the assets below or the raw JSON.`)
  }

  return (
    <>
      {error ? <Notice tone="muted">{error}</Notice> : null}

      <Panel
        title="Stored results"
        hint="Everything the platform has produced, newest first"
        actions={
          <>
            <div className="chips">
              {KINDS.map((entry) => (
                <span key={entry.key || 'all'} className={`chip ${kind === entry.key ? 'active' : ''}`} onClick={() => setKind(entry.key)}>
                  {entry.label}
                </span>
              ))}
            </div>
            <button className="small" onClick={listing.reload}>
              Refresh
            </button>
          </>
        }
      >
        {listing.loading ? <Loading label="Loading results…" /> : null}
        {listing.error ? <Notice tone="danger">{listing.error.message}</Notice> : null}
        {rows.length === 0 && !listing.loading ? (
          <Empty
            title="No stored results"
            action={
              <Link className="btn primary" to="/fields">
                Run an analysis
              </Link>
            }
          >
            Analyses, OpenCV runs, segmentations and time series are stored on disk under outputs/ and indexed here.
          </Empty>
        ) : (
          <DataTable
            columns={[
              { key: 'created_at', label: 'Created', render: (value) => (value || '').replace('T', ' ').slice(0, 16) },
              { key: 'kind', label: 'Kind' },
              { key: 'title', label: 'Title' },
              { key: 'dataset', label: 'Dataset' },
              {
                key: 'summary',
                label: 'Key metric',
                render: (value) =>
                  value?.mean !== undefined && value?.mean !== null
                    ? `mean ${Number(value.mean).toFixed(3)}`
                    : value?.mask_coverage_pct !== undefined
                      ? `${Number(value.mask_coverage_pct).toFixed(1)}% mask`
                      : value?.contour_count !== undefined
                        ? `${value.contour_count} contours`
                        : value?.observation_count !== undefined
                          ? `${value.observation_count} obs`
                          : '—',
              },
              { key: 'asset_count', label: 'Assets' },
              {
                key: 'open',
                label: '',
                render: (_, row) => (
                  <button className="ghost small" onClick={() => setSelectedId(row.id)}>
                    inspect
                  </button>
                ),
              },
            ]}
            rows={rows}
            numericFrom={2}
          />
        )}
      </Panel>

      {selectedId ? (
        <Panel
          title={`Result ${selectedId}`}
          hint={record ? `${record.kind} · ${record.created_at}` : 'loading'}
          actions={
            <>
              <button className="small" onClick={openInViewer} disabled={!record}>
                Open in viewer
              </button>
              <a className="btn small" href={`/api/results/${selectedId}`} target="_blank" rel="noreferrer">
                Raw JSON
              </a>
              <button className="ghost small" onClick={() => setSelectedId(null)}>
                close
              </button>
            </>
          }
        >
          {detail.loading ? <Loading label="Loading result…" /> : null}
          {detail.error ? <Notice tone="danger">{detail.error.message}</Notice> : null}
          {record ? (
            <>
              <div className="row">
                <Badge tone="teal">{record.kind}</Badge>
                {record.dataset ? <Badge>{record.dataset}</Badge> : null}
                {record.aoi ? <Badge>{record.aoi}</Badge> : null}
                {record.cache_key ? <Badge title={record.cache_key}>cached key</Badge> : null}
              </div>

              {record.summary ? (
                <KeyValue
                  rows={Object.entries(record.summary).map(([key, value]) => [
                    key.replace(/_/g, ' '),
                    value === null || value === undefined
                      ? '—'
                      : typeof value === 'object'
                        ? JSON.stringify(value)
                        : typeof value === 'number'
                          ? Number(value).toLocaleString(undefined, { maximumFractionDigits: 4 })
                          : String(value),
                  ])}
                />
              ) : null}

              {record.warnings?.length ? <Notice tone="warn">{record.warnings.join(' · ')}</Notice> : null}

              {record.assets?.length ? <AssetGallery assets={record.assets} /> : <div className="empty">This result has no visual assets.</div>}

              {record.payload?.segments_geojson ? (
                <a
                  className="btn small"
                  href={`data:application/geo+json;charset=utf-8,${encodeURIComponent(JSON.stringify(record.payload.segments_geojson))}`}
                  download={`${record.id}-segments.geojson`}
                >
                  Download segments GeoJSON
                </a>
              ) : null}

              <Collapsible title="Result JSON">
                <JsonBlock value={record} />
              </Collapsible>
            </>
          ) : null}
        </Panel>
      ) : null}
    </>
  )
}
