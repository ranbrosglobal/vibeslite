import { HEALTH_COLOURS, DataTable } from './Panel'

/** Stacked bar + row legend for crop-health class shares. */
export default function HealthDistribution({ health, showTable = true }) {
  if (!health?.classes?.length) {
    return <div className="empty">Run an analysis to see the health-zone distribution.</div>
  }
  const classes = health.classes
  return (
    <div className="stack">
      <div className="health-bar">
        {classes.map((entry) => (
          <span
            key={entry.key}
            style={{ width: `${entry.percentage}%`, background: HEALTH_COLOURS[entry.key] || entry.colour }}
            title={`${entry.label}: ${entry.percentage}%`}
          />
        ))}
      </div>

      <div className="health-legend">
        {classes.map((entry) => (
          <div className="health-row" key={entry.key}>
            <span className="health-swatch" style={{ background: HEALTH_COLOURS[entry.key] || entry.colour }} />
            <span>{entry.label}</span>
            <span className="range">
              {entry.range?.[0] === null ? `< ${advance(health.thresholds, entry.key, 'up')}` : null}
              {entry.range?.[1] === null ? `> ${advance(health.thresholds, entry.key, 'down')}` : null}
              {entry.range?.[0] !== null && entry.range?.[1] !== null
                ? `${fmt(entry.range[0])}–${fmt(entry.range[1])}`
                : null}
            </span>
            <span className="pct">{entry.percentage?.toFixed?.(1) ?? '—'}%</span>
          </div>
        ))}
      </div>

      <div className="row between" style={{ fontSize: 12.5 }}>
        <div>
          Healthy area: <strong>{health.healthy_pct?.toFixed?.(1)}%</strong>
          {health.healthy_area_ha ? ` (${health.healthy_area_ha.toFixed(1)} ha)` : ''}
        </div>
        <div>
          Weak area: <strong>{health.weak_pct?.toFixed?.(1)}%</strong>
          {health.weak_area_ha ? ` (${health.weak_area_ha.toFixed(1)} ha)` : ''}
        </div>
      </div>

      {showTable ? (
        <DataTable
          columns={[
            { key: 'label', label: 'Class' },
            { key: 'percentage', label: 'Share', render: (value) => `${value?.toFixed?.(2) ?? '—'}%` },
            { key: 'area_ha', label: 'Area ha', render: (value) => (value === null || value === undefined ? '—' : value.toFixed(2)) },
            { key: 'pixels', label: 'Pixels' },
          ]}
          rows={classes}
          numericFrom={2}
        />
      ) : null}
    </div>
  )
}

function fmt(value) {
  return Number(value).toFixed(2)
}

function advance(thresholds, key, direction) {
  if (!thresholds) return direction === 'up' ? '0.20' : '0.80'
  const ordered = ['very_low', 'low', 'moderate', 'healthy']
  if (direction === 'up') return Number(thresholds[key] ?? thresholds[ordered[0]]).toFixed(2)
  return Number(thresholds.high ?? thresholds.healthy).toFixed(2)
}
