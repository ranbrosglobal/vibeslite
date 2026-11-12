import { useEffect, useMemo, useState } from 'react'
import { api, assetUrl, useApi } from '../api'
import { Badge, DataTable, Empty, Loading, Notice, Panel, StatCard, Warnings } from '../components/Panel'
import { AssetGallery } from '../components/Uploader'
import { TimeSeriesChart } from '../components/Charts'

const emptyRow = () => ({ date: '', mean: '' })

export default function TimeSeries() {
  const datasets = useApi(api.datasets)
  const ndviResults = useApi(useMemo(() => ({ signal } = {}) => api.results({ kind: 'ndvi', limit: 40 }), []))
  const [mode, setMode] = useState('stored')
  const [rows, setRows] = useState([emptyRow(), emptyRow(), emptyRow()])
  const [csv, setCsv] = useState('')
  const [useStored, setUseStored] = useState(true)
  const [changeThreshold, setChangeThreshold] = useState(0.05)
  const [result, setResult] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const tables = (datasets.data?.datasets || []).filter((entry) => entry.type === 'table')
  const stored = ndviResults.data?.results || []

  useEffect(() => {
    if (!csv && tables.length) setCsv(tables[0].name)
  }, [tables, csv])

  const observations = useMemo(() => {
    if (mode === 'manual') {
      return rows
        .filter((row) => row.date)
        .map((row) => ({ date: row.date, mean: row.mean === '' ? null : Number(row.mean) }))
        .filter((row) => row.mean !== null)
    }
    if (mode === 'stored') {
      return stored.map((entry) => ({
        date: entry.summary?.observation_date || (entry.created_at || '').slice(0, 10),
        result_id: entry.id,
      }))
    }
    return []
  }, [mode, rows, stored])

  const useCsvFile = mode === 'csv' && Boolean(csv)

  const run = async () => {
    setBusy(true)
    setError(null)
    try {
      const payload = await api.timeseries({
        observations: useCsvFile ? [] : observations,
        csv: useCsvFile ? csv : null,
        index: 'NDVI',
        change_threshold: changeThreshold,
        include_chart: true,
      })
      setResult(payload)
    } catch (caught) {
      setError(caught.message)
    } finally {
      setBusy(false)
    }
  }

  const summary = result?.summary

  return (
    <>
      {error ? <Notice tone="danger" title="Time series failed">{error}</Notice> : null}

      <div className="grid sidebar-left">
        <Panel title="Observation source" hint="Multiple dates for the same field">
          <div className="chips">
            <span className={`chip ${mode === 'stored' ? 'active' : ''}`} onClick={() => setMode('stored')}>
              Stored NDVI results ({stored.length})
            </span>
            <span className={`chip ${mode === 'manual' ? 'active' : ''}`} onClick={() => setMode('manual')}>
              Manual rows
            </span>
            <span className={`chip ${mode === 'csv' ? 'active' : ''}`} onClick={() => setMode('csv')}>
              CSV dataset
            </span>
          </div>

          {mode === 'stored' ? (
            <div className="stack">
              <div className="hint">
                Every stored NDVI result becomes one observation. Statistics are re-used, so no raster is recomputed.
              </div>
              <DataTable
                columns={[
                  { key: 'date', label: 'Date' },
                  { key: 'mean', label: 'Mean NDVI' },
                  { key: 'dataset', label: 'Dataset' },
                ]}
                rows={stored.map((entry) => ({
                  date: entry.summary?.observation_date || (entry.created_at || '').slice(0, 10),
                  mean: entry.summary?.mean !== null && entry.summary?.mean !== undefined ? Number(entry.summary.mean).toFixed(3) : '—',
                  dataset: entry.dataset,
                }))}
                emptyLabel="No stored NDVI results yet — run an analysis first."
              />
            </div>
          ) : null}

          {mode === 'manual' ? (
            <div className="stack">
              {rows.map((row, index) => (
                <div className="row" key={index}>
                  <input
                    type="date"
                    value={row.date}
                    onChange={(event) =>
                      setRows((current) => current.map((item, itemIndex) => (itemIndex === index ? { ...item, date: event.target.value } : item)))
                    }
                  />
                  <input
                    type="number"
                    step="0.01"
                    min="-1"
                    max="1"
                    placeholder="NDVI mean"
                    value={row.mean}
                    onChange={(event) =>
                      setRows((current) => current.map((item, itemIndex) => (itemIndex === index ? { ...item, mean: event.target.value } : item)))
                    }
                  />
                  <button className="ghost small" onClick={() => setRows((current) => current.filter((_, itemIndex) => itemIndex !== index))}>
                    remove
                  </button>
                </div>
              ))}
              <div className="row">
                <button className="small" onClick={() => setRows((current) => [...current, emptyRow()])}>
                  Add observation
                </button>
                <label className="toggle">
                  <input type="checkbox" checked={useStored} onChange={(event) => setUseStored(event.target.checked)} />
                  include stored results too
                </label>
              </div>
            </div>
          ) : null}

          {mode === 'csv' ? (
            <div className="stack">
              <label className="field">
                CSV dataset (needs a date column and an NDVI column)
                <select value={csv} onChange={(event) => setCsv(event.target.value)}>
                  <option value="">— select —</option>
                  {tables.map((entry) => (
                    <option key={entry.name} value={entry.name}>
                      {entry.name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="hint">
                Rows are grouped by a <span className="mono">field</span> column when present. Weather CSVs can be joined
                later through the same table loader.
              </div>
            </div>
          ) : null}

          <label className="field">
            Change threshold (index units)
            <input type="number" step="0.01" min="0" max="1" value={changeThreshold} onChange={(event) => setChangeThreshold(Number(event.target.value))} />
          </label>

          <div className="row">
            <button
              className="primary"
              onClick={run}
              disabled={busy || (mode === 'stored' && stored.length === 0) || (mode === 'manual' && observations.length === 0) || (mode === 'csv' && !csv)}
            >
              {busy ? 'Analysing…' : 'Build time series'}
            </button>
            <button className="small" onClick={() => Promise.all([ndviResults.reload(), datasets.reload()])} disabled={busy}>
              Refresh sources
            </button>
          </div>
        </Panel>

        <div className="stack">
          {busy ? <Loading label="Analysing observations…" /> : null}
          {!result && !busy ? (
            <Panel title="Trend analysis">
              <Empty title="No series built yet">
                Feed the engine observations from stored results, manual rows, or a CSV of field statistics. You get the
                index trajectory, a least-squares trend, change between dates and the healthy-area trend.
              </Empty>
            </Panel>
          ) : null}
          {result ? (
            <>
              <div className="grid cols-3">
                <StatCard
                  label="Total change"
                  value={summary.total_change === null || summary.total_change === undefined ? '—' : `${summary.total_change > 0 ? '+' : ''}${Number(summary.total_change).toFixed(3)}`}
                  foot={summary.total_change_pct === null || summary.total_change_pct === undefined ? '' : `${summary.total_change_pct > 0 ? '+' : ''}${summary.total_change_pct}%`}
                  tone={summary.total_change > 0 ? 'green' : summary.total_change < 0 ? 'danger' : ''}
                />
                <StatCard label="Trend" value={result.trend.direction} foot={`${result.trend.slope_per_30_days ?? '—'}/30 days · r² ${result.trend.r_squared ?? '—'}`} tone="accent" />
                <StatCard label="Observations" value={summary.observation_count} foot={`${summary.span_days} day span`} />
              </div>
              <Panel title="Health trend" hint="Healthy-area share over the season">
                <div className="row">
                  <Badge tone={result.health_trend.healthy_direction === 'improving' ? 'green' : result.health_trend.healthy_direction === 'declining' ? 'danger' : ''}>
                    healthy {result.health_trend.healthy_direction}
                    {result.health_trend.healthy_change_pp !== null && result.health_trend.healthy_change_pp !== undefined
                      ? ` ${result.health_trend.healthy_change_pp > 0 ? '+' : ''}${result.health_trend.healthy_change_pp} pp`
                      : ''}
                  </Badge>
                  <Badge tone={result.health_trend.weak_direction === 'increasing' ? 'warn' : ''}>
                    weak {result.health_trend.weak_direction}
                    {result.health_trend.weak_change_pp !== null && result.health_trend.weak_change_pp !== undefined
                      ? ` ${result.health_trend.weak_change_pp > 0 ? '+' : ''}${result.health_trend.weak_change_pp} pp`
                      : ''}
                  </Badge>
                </div>
                {(result.interpretation?.points || []).length ? (
                  <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, lineHeight: 1.7 }}>
                    {result.interpretation.points.map((point, index) => (
                      <li key={index}>{point}</li>
                    ))}
                  </ul>
                ) : null}
                <div className="disclaimer">{result.interpretation?.disclaimer}</div>
              </Panel>
            </>
          ) : null}
        </div>
      </div>

      {result ? (
        <>
          <Panel title="NDVI over time" hint="Hover for exact values" actions={<a className="btn small" href={assetUrl(result.assets?.[0])} target="_blank" rel="noreferrer" download>Download chart</a>}>
            <TimeSeriesChart series={result.series} trend={result.trend} />
          </Panel>

          <div className="grid sidebar-right">
            <Panel title="Observation table" hint="One row per acquisition date">
              <DataTable
                columns={[
                  { key: 'date', label: 'Date' },
                  { key: 'mean', label: 'Mean', render: (value) => (value === null || value === undefined ? '—' : Number(value).toFixed(3)) },
                  { key: 'median', label: 'Median', render: (value) => (value === null || value === undefined ? '—' : Number(value).toFixed(3)) },
                  { key: 'healthy_pct', label: 'Healthy %', render: (value) => (value === null || value === undefined ? '—' : Number(value).toFixed(1)) },
                  { key: 'weak_pct', label: 'Weak %', render: (value) => (value === null || value === undefined ? '—' : Number(value).toFixed(1)) },
                  { key: 'source', label: 'Source' },
                ]}
                rows={result.series.observations}
                numericFrom={4}
              />
            </Panel>
            <Panel title="Change between dates" hint={`Intervals flagged when |Δ| > ${changeThreshold}`}>
              <DataTable
                columns={[
                  { key: 'to', label: 'Date' },
                  { key: 'days', label: 'Days' },
                  { key: 'delta', label: 'Δ index' },
                  { key: 'change_pct', label: '%' },
                  { key: 'direction', label: 'Direction' },
                ]}
                rows={result.change.intervals}
                numericFrom={2}
                emptyLabel="Not enough observations for interval change."
              />
            </Panel>
          </div>

          {result.assets?.length ? (
            <Panel title="Report assets" hint={`outputs/${result.result_id}/`}>
              <AssetGallery assets={result.assets} />
            </Panel>
          ) : null}
          <Warnings items={result.warnings} />
        </>
      ) : null}
    </>
  )
}
