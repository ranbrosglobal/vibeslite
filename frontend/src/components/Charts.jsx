import { Area, AreaChart, BarChart, Bar, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis, CartesianGrid, Cell } from 'recharts'
import { HEALTH_COLOURS } from './Panel'

/* Chart palette.
 * Recharts writes these into SVG presentation attributes, which do not resolve
 * `var(--token)` consistently, so they are literals that mirror the tokens in
 * styles.css. Change them together. */
const C = {
  axis: '#98a2ad',
  grid: '#1f242c',
  rule: '#343c48',
  panel: '#0c0e11',
  ink: '#eaede6',
  acid: '#cbff3c',
  signal: '#ffb020',
  flare: '#ff5c3a',
  ice: '#4fd8e8',
}

const AXIS = { fontSize: 11, fill: C.axis, fontFamily: 'JetBrains Mono, ui-monospace, monospace' }
const TOOLTIP_STYLE = {
  contentStyle: {
    background: C.panel,
    border: `2px solid ${C.ink}`,
    borderRadius: 0,
    fontSize: 11.5,
    fontFamily: 'JetBrains Mono, ui-monospace, monospace',
    color: C.ink,
    boxShadow: '4px 4px 0 rgba(0,0,0,0.6)',
  },
  labelStyle: { color: C.acid, fontWeight: 700, fontFamily: 'JetBrains Mono, ui-monospace, monospace' },
  itemStyle: { color: C.ink },
}

/** NDVI value distribution with the configured class boundaries marked. */
export function HistogramChart({ statistics, thresholds }) {
  const histogram = statistics?.histogram
  if (!histogram?.bins?.length || !histogram?.counts?.length) {
    return <div className="empty">No distribution available.</div>
  }
  const data = histogram.counts.map((count, index) => ({
    bin: ((histogram.bins[index] + histogram.bins[index + 1]) / 2).toFixed(2),
    value: histogram.bins[index],
    count,
  }))
  const boundaries = thresholds ? [thresholds.very_low, thresholds.low, thresholds.moderate, thresholds.healthy] : []

  return (
    <div>
      <ResponsiveContainer width="100%" height={210}>
        <BarChart data={data} margin={{ top: 6, right: 10, bottom: 4, left: -18 }}>
          <CartesianGrid stroke={C.grid} vertical={false} />
          <XAxis dataKey="bin" tick={AXIS} interval={3} tickLine={false} axisLine={{ stroke: C.rule }} />
          <YAxis tick={AXIS} tickLine={false} axisLine={false} />
          <Tooltip {...TOOLTIP_STYLE} formatter={(value) => [`${value} px`, 'Pixels']} labelFormatter={(label) => `NDVI ≈ ${label}`} />
          <Bar dataKey="count" radius={[0, 0, 0, 0]}>
            {data.map((entry, index) => (
              <Cell key={index} fill={ndviColour(entry.value)} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      <div className="legend-scale">
        <span>-1.0</span>
        {boundaries.map((value) => (
          <span key={value}>│ {Number(value).toFixed(2)}</span>
        ))}
        <span>1.0</span>
      </div>
    </div>
  )
}

/** Index over time with the healthy-area share on a secondary axis. */
export function TimeSeriesChart({ series, trend }) {
  if (!series?.dates?.length) return <div className="empty">No observations to plot.</div>
  const data = series.dates.map((date, index) => ({
    date,
    ndvi: series.means[index],
    healthy: series.healthy_pct?.[index] ?? null,
    weak: series.weak_pct?.[index] ?? null,
  }))

  return (
    <ResponsiveContainer width="100%" height={280}>
      <LineChart data={data} margin={{ top: 12, right: 14, bottom: 4, left: -18 }}>
        <CartesianGrid stroke={C.grid} vertical={false} />
        <XAxis dataKey="date" tick={AXIS} tickLine={false} axisLine={{ stroke: C.rule }} />
        <YAxis yAxisId="left" domain={[0, 1]} tick={AXIS} tickLine={false} axisLine={false} />
        <YAxis yAxisId="right" orientation="right" domain={[0, 100]} tick={AXIS} tickLine={false} axisLine={false} unit="%" />
        <Tooltip {...TOOLTIP_STYLE} />
        <Line
          yAxisId="left"
          type="monotone"
          dataKey="ndvi"
          stroke={C.acid}
          strokeWidth={2.6}
          dot={{ r: 4, fill: C.acid, stroke: C.panel, strokeWidth: 2 }}
          activeDot={{ r: 5, fill: C.acid, stroke: C.ink, strokeWidth: 2 }}
          name={series.index || 'NDVI'}
          connectNulls
        />
        <Line
          yAxisId="right"
          type="monotone"
          dataKey="healthy"
          stroke={C.signal}
          strokeWidth={1.8}
          strokeDasharray="5 3"
          dot={{ r: 3, fill: C.signal }}
          name="Healthy area %"
          connectNulls
        />
        <Line
          yAxisId="right"
          type="monotone"
          dataKey="weak"
          stroke={C.flare}
          strokeWidth={1.5}
          strokeDasharray="2 3"
          dot={false}
          name="Weak area %"
          connectNulls
        />
      </LineChart>
    </ResponsiveContainer>
  )
}

/** Horizontal class-share bars used on the crop-health page. */
export function ClassBarChart({ health }) {
  if (!health?.classes?.length) return <div className="empty">No class data.</div>
  const data = health.classes.map((entry) => ({ name: entry.short, percentage: entry.percentage, key: entry.key }))
  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 20, bottom: 0, left: 12 }}>
        <CartesianGrid stroke={C.grid} horizontal={false} />
        <XAxis type="number" unit="%" tick={AXIS} tickLine={false} axisLine={{ stroke: C.rule }} />
        <YAxis type="category" dataKey="name" tick={AXIS} width={78} tickLine={false} axisLine={false} />
        <Tooltip {...TOOLTIP_STYLE} formatter={(value) => [`${Number(value).toFixed(2)}%`, 'Share']} />
        <Bar dataKey="percentage" radius={[0, 0, 0, 0]}>
          {data.map((entry) => (
            <Cell key={entry.key} fill={HEALTH_COLOURS[entry.key] || C.acid} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

/** Cumulative curve for a single daily series (GDD, ETc, depletion, cumulative rain). */
export function CumulativeChart({ values, label = 'Cumulative', secondary, secondaryLabel, unit = '', height = 240 }) {
  if (!values?.length) return <div className="empty">No daily series to plot.</div>
  const data = values.map((value, day) => ({
    day: day + 1,
    value: Number(value),
    ...(secondary ? { secondary: secondary[day] === null || secondary[day] === undefined ? null : Number(secondary[day]) } : {}),
  }))
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 12, right: 16, bottom: 4, left: -18 }}>
        <defs>
          <linearGradient id="cumulative-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={C.acid} stopOpacity={0.42} />
            <stop offset="100%" stopColor={C.acid} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke={C.grid} vertical={false} />
        <XAxis dataKey="day" tick={AXIS} tickLine={false} axisLine={{ stroke: C.rule }} unit="d" minTickGap={26} />
        <YAxis tick={AXIS} tickLine={false} axisLine={false} unit={unit} width={52} />
        <Tooltip {...TOOLTIP_STYLE} labelFormatter={(day) => `Day ${day}`} />
        <Area
          type="monotone"
          dataKey="value"
          stroke={C.acid}
          strokeWidth={2.4}
          fill="url(#cumulative-fill)"
          name={label}
          dot={false}
        />
        {secondary ? (
          <Line type="monotone" dataKey="secondary" stroke={C.signal} strokeWidth={1.8} strokeDasharray="5 3" dot={false} name={secondaryLabel || 'Reference'} connectNulls />
        ) : null}
      </AreaChart>
    </ResponsiveContainer>
  )
}

/** Daily bars with a cumulative overlay — the water-balance view. */
export function WaterBalanceChart({ daily, unit = 'mm', height = 260 }) {
  const rows = daily || []
  if (!rows.length) return <div className="empty">No daily balance to plot.</div>
  const data = rows.map((row, index) => ({
    day: index + 1,
    etc: row.etc_mm ?? row.etc ?? null,
    rainfall: row.effective_rain_mm ?? row.rainfall_mm ?? null,
    irrigation: row.irrigation_mm ?? null,
    depletion: row.depletion_mm ?? row.depletion ?? null,
  }))
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 12, right: 16, bottom: 4, left: -18 }}>
        <CartesianGrid stroke={C.grid} vertical={false} />
        <XAxis dataKey="day" tick={AXIS} tickLine={false} axisLine={{ stroke: C.rule }} unit="d" minTickGap={26} />
        <YAxis tick={AXIS} tickLine={false} axisLine={false} unit={unit} width={52} />
        <Tooltip {...TOOLTIP_STYLE} labelFormatter={(day) => `Day ${day}`} />
        <Bar dataKey="etc" fill={C.ice} name="ETc" />
        <Bar dataKey="depletion" fill={C.flare} name="Root-zone depletion" />
        <Bar dataKey="irrigation" fill={C.acid} name="Irrigation applied" />
        <Bar dataKey="rainfall" fill={C.signal} name="Effective rain" />
      </BarChart>
    </ResponsiveContainer>
  )
}

function ndviColour(value) {
  const stops = [
    [-1.0, [47, 72, 88]],
    [-0.1, [107, 107, 86]],
    [0.0, [156, 139, 98]],
    [0.2, [205, 187, 120]],
    [0.35, [182, 201, 106]],
    [0.5, [143, 190, 95]],
    [0.65, [93, 164, 95]],
    [0.8, [46, 125, 71]],
    [1.0, [20, 86, 47]],
  ]
  const clamped = Math.max(-1, Math.min(1, Number(value)))
  for (let index = 1; index < stops.length; index += 1) {
    const [high, highColour] = stops[index]
    const [low, lowColour] = stops[index - 1]
    if (clamped <= high) {
      const ratio = (clamped - low) / (high - low || 1)
      const mix = lowColour.map((channel, channelIndex) => Math.round(channel + (highColour[channelIndex] - channel) * ratio))
      return `rgb(${mix.join(',')})`
    }
  }
  return 'rgb(20,86,47)'
}
