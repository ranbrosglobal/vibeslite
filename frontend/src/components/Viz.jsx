import { useId, useMemo } from 'react'
import { useCountUp } from './Delight'

/* ── geometry helpers ───────────────────────────────────────────────────── */

function polar(cx, cy, r, deg) {
  const rad = ((deg - 90) * Math.PI) / 180
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)]
}

function arc(cx, cy, r, start, end) {
  const [x1, y1] = polar(cx, cy, r, start)
  const [x2, y2] = polar(cx, cy, r, end)
  const large = end - start > 180 ? 1 : 0
  return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`
}

/* ── spectrum bar: the field's health classes as one calibrated bar ─────── */

export function SpectrumBar({ items, ariaLabel = 'Share of the field in each health class' }) {
  const total = items.reduce((sum, item) => sum + (Number(item.pct) || 0), 0)
  const live = total > 0 ? items.filter((item) => (Number(item.pct) || 0) > 0) : []
  return (
    <div className="spectrum">
      <div className="spectrum-bar" role="img" aria-label={ariaLabel}>
        {live.map((item) => (
          <span
            key={item.key || item.label}
            className="spectrum-seg"
            style={{ flex: `${Number(item.pct)} 1 0`, background: item.color }}
            title={`${item.label}: ${Number(item.pct).toFixed(1)}%`}
          >
            <i>{Number(item.pct) >= 6 ? `${Math.round(Number(item.pct))}%` : ''}</i>
          </span>
        ))}
      </div>
      <div className="spectrum-ruler" aria-hidden="true">
        <span>0</span>
        <span>25</span>
        <span>50</span>
        <span>75</span>
        <span>100</span>
      </div>
      <div className="spectrum-legend">
        {items.map((item) => (
          <span className="spectrum-key" key={item.key || item.label}>
            <i style={{ background: item.color }} />
            <b>{item.label}</b>
            <em>{Number(item.pct || 0).toFixed(1)}%</em>
          </span>
        ))}
      </div>
    </div>
  )
}

/* ── donut: composition at a glance ─────────────────────────────────────── */

export function Donut({ items, center, centerLabel, size = 176, thickness = 13 }) {
  const total = items.reduce((sum, item) => sum + (Number(item.pct) || 0), 0) || 1
  const radius = (size - thickness) / 2
  const circumference = 2 * Math.PI * radius
  const gap = live(items) > 1 ? 2.4 : 0
  let cursor = 0
  return (
    <div className="donut" style={{ '--donut-size': `${size}px` }}>
      <svg viewBox={`0 0 ${size} ${size}`} className="donut-svg" role="img" aria-label={`${center}${centerLabel ? ` ${centerLabel}` : ''}`}>
        <circle cx={size / 2} cy={size / 2} r={radius} className="donut-track" strokeWidth={thickness} />
        <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
          {items
            .filter((item) => Number(item.pct) > 0)
            .map((item) => {
              const length = (Number(item.pct) / total) * circumference
              const dash = Math.max(0.5, length - gap)
              const offset = -cursor
              cursor += length
              return (
                <circle
                  key={item.key || item.label}
                  cx={size / 2}
                  cy={size / 2}
                  r={radius}
                  fill="none"
                  stroke={item.color}
                  strokeWidth={thickness}
                  strokeDasharray={`${dash.toFixed(2)} ${circumference.toFixed(2)}`}
                  strokeDashoffset={offset.toFixed(2)}
                  strokeLinecap="butt"
                >
                  <title>{`${item.label}: ${Number(item.pct).toFixed(1)}%`}</title>
                </circle>
              )
            })}
        </g>
      </svg>
      <div className="donut-center">
        <strong>{center}</strong>
        {centerLabel ? <span>{centerLabel}</span> : null}
      </div>
    </div>
  )
}

function live(items) {
  return items.filter((item) => Number(item.pct) > 0).length
}

export function DonutLegend({ items }) {
  return (
    <ul className="donut-legend">
      {items.map((item) => (
        <li key={item.key || item.label}>
          <i style={{ background: item.color }} aria-hidden="true" />
          <span>{item.label}</span>
          <b>{Number(item.pct || 0).toFixed(1)}%</b>
        </li>
      ))}
    </ul>
  )
}

/* ── ranked bars: where the weak ground actually is ─────────────────────── */

export function PatchBars({ patches, limit = 6 }) {
  const rows = (patches || []).slice(0, limit)
  const max = rows.reduce((peak, row) => Math.max(peak, Number(row.area_ha) || 0), 0) || 1
  return (
    <ol className="patch-bars">
      {rows.map((row, index) => {
        const area = Number(row.area_ha) || 0
        return (
          <li key={index}>
            <span className="patch-rank">{String(index + 1).padStart(2, '0')}</span>
            <span className="patch-name">
              <b>Weak spot {index + 1}</b>
              <em>
                {row.centroid_lonlat?.[0]?.toFixed(4)}, {row.centroid_lonlat?.[1]?.toFixed(4)}
              </em>
            </span>
            <span className="patch-track">
              <i style={{ width: `${Math.max(4, (area / max) * 100)}%` }} />
            </span>
            <span className="patch-area">
              {area.toFixed(area < 1 ? 2 : 1)}
              <em>ha</em>
            </span>
          </li>
        )
      })}
    </ol>
  )
}

/* ── contour field: deterministic topographic line art ──────────────────── */

function contour(cx, cy, rx, ry, wobble, phase) {
  const points = []
  for (let step = 0; step <= 84; step += 1) {
    const t = (step / 84) * Math.PI * 2
    const w = 1 + wobble * Math.sin(3 * t + phase) + wobble * 0.55 * Math.sin(5 * t - phase * 1.4)
    points.push(`${(cx + Math.cos(t) * rx * w).toFixed(1)} ${(cy + Math.sin(t) * ry * w).toFixed(1)}`)
  }
  return `M ${points.join(' L ')} Z`
}

export function TopoField({ className = '', lines = 9 }) {
  const paths = useMemo(() => {
    const list = []
    for (let i = 0; i < lines; i += 1) {
      const grow = i / lines
      list.push(
        contour(
          420,
          240,
          90 + grow * 360,
          58 + grow * 214,
          0.06 + grow * 0.05,
          i * 0.9,
        ),
      )
    }
    return list
  }, [lines])
  return (
    <svg className={`topo ${className}`} viewBox="0 0 840 480" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      {paths.map((path, index) => (
        <path key={index} d={path} />
      ))}
    </svg>
  )
}

/* ── tick gauge: the headline number on a calibrated dial ───────────────── */

const GAUGE_TONES = {
  good: { arc: '#c8f24e', needle: '#e8ffa8', label: 'rgba(232,255,168,.72)' },
  mixed: { arc: '#f5b73c', needle: '#ffd98a', label: 'rgba(255,217,138,.72)' },
  poor: { arc: '#ff6d4a', needle: '#ffb39f', label: 'rgba(255,179,159,.72)' },
}

export function Dial({ value, tone = 'good', unit = '%', caption }) {
  const id = useId().replace(/[:]/g, '')
  const shown = useCountUp(value)
  const clamped = Math.max(0, Math.min(100, Number(value) || 0))
  const START = 240
  const SWEEP = 240
  const angle = START + (clamped / 100) * SWEEP
  const colors = GAUGE_TONES[tone] || GAUGE_TONES.good
  const ticks = useMemo(() => {
    const list = []
    for (let i = 0; i <= 48; i += 1) {
      const deg = START + (i / 48) * SWEEP
      const major = i % 6 === 0
      const [x1, y1] = polar(120, 120, major ? 104 : 108, deg)
      const [x2, y2] = polar(120, 120, 113, deg)
      list.push({ x1, y1, x2, y2, major, deg })
    }
    return list
  }, [])
  const [markX1, markY1] = polar(120, 120, 84, angle)
  const [markX2, markY2] = polar(120, 120, 96, angle)

  return (
    <div className="dial">
      <svg viewBox="0 0 240 190" className="dial-svg" role="img" aria-label={`${Math.round(clamped)}${unit}${caption ? ` — ${caption}` : ''}`}>
        <defs>
          <linearGradient id={`g-${id}`} x1="0" y1="1" x2="1" y2="0">
            <stop offset="0%" stopColor={colors.arc} stopOpacity="0.45" />
            <stop offset="100%" stopColor={colors.arc} />
          </linearGradient>
        </defs>

        <path d={arc(120, 120, 96, START, START + SWEEP)} className="dial-track" />
        <path
          d={arc(120, 120, 96, START, Math.max(START + 0.6, angle))}
          className="dial-arc"
          stroke={`url(#g-${id})`}
          style={{ transition: 'd 900ms var(--ease-out)' }}
        />

        <g className="dial-ticks">
          {ticks.map((tick, index) => (
            <line
              key={index}
              x1={tick.x1}
              y1={tick.y1}
              x2={tick.x2}
              y2={tick.y2}
              className={tick.major ? 'major' : ''}
            />
          ))}
        </g>

        <line x1={markX1} y1={markY1} x2={markX2} y2={markY2} className="dial-needle" stroke={colors.needle} />
        <circle cx={markX2} cy={markY2} r="4.2" className="dial-hub" stroke={colors.needle} />

        <text x="120" y="112" textAnchor="middle" className="dial-value">
          {Math.round(shown)}
          <tspan className="dial-unit">{unit}</tspan>
        </text>
        <text x="120" y="138" textAnchor="middle" className="dial-cap" fill={colors.label}>
          {caption || 'of the field'}
        </text>
      </svg>
    </div>
  )
}
