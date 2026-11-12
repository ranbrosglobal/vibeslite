import { useState } from 'react'

export function Panel({ title, hint, actions, children, footer, className = '', flush = false }) {
  return (
    <section className={`panel ${className}`}>
      {(title || actions) && (
        <header className="panel-head">
          <div>
            {title && <h2>{title}</h2>}
            {hint && <div className="hint">{hint}</div>}
          </div>
          {actions && <div className="row">{actions}</div>}
        </header>
      )}
      <div className={`panel-body ${flush ? 'tight' : ''}`}>{children}</div>
      {footer && <footer className="panel-foot">{footer}</footer>}
    </section>
  )
}

export function StatCard({ label, value, unit, foot, tone = '', meter = null }) {
  const display = value === null || value === undefined || Number.isNaN(value) ? '—' : value
  const isLong = typeof display === 'string' && display.length > 9
  return (
    <div className={`stat ${tone}`}>
      <div className="label">{label}</div>
      <div className={`value ${isLong ? 'small' : ''}`}>
        {display}
        {unit ? <span className="unit">{unit}</span> : null}
      </div>
      {meter !== null && meter !== undefined ? (
        <div className="meter" role="img" aria-label={`${label}: ${display}${unit || ''}`}>
          <span
            className={`meter-fill ${tone}`}
            style={{ width: `${Math.max(0, Math.min(100, Number(meter) || 0))}%` }}
          />
        </div>
      ) : null}
      {foot ? <div className="foot">{foot}</div> : null}
    </div>
  )
}

export function Notice({ tone = 'info', title, children }) {
  return (
    <div className={`notice ${tone === 'info' ? '' : tone}`}>
      {title && <strong>{title}</strong>}
      {title ? <div>{children}</div> : children}
    </div>
  )
}

export function Warnings({ items, title = 'Warnings' }) {
  if (!items || items.length === 0) return null
  return (
    <Notice tone="warn" title={title}>
      <ul>
        {items.map((item, index) => (
          <li key={index}>{item}</li>
        ))}
      </ul>
    </Notice>
  )
}

export function Disclaimer({ text }) {
  if (!text) return null
  return <div className="disclaimer">{text}</div>
}

export function Badge({ children, tone = '' }) {
  return <span className={`badge ${tone}`}>{children}</span>
}

export function Loading({ label = 'Working…' }) {
  return (
    <div className="loading">
      <span className="spinner" />
      {label}
    </div>
  )
}

export function Empty({ title = 'Nothing here yet', children, action }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children}
      {action ? <div style={{ marginTop: 12 }}>{action}</div> : null}
    </div>
  )
}

export function KeyValue({ rows = [] }) {
  const visible = rows.filter((row) => row && row[1] !== undefined && row[1] !== null && row[1] !== '')
  if (visible.length === 0) return <div className="empty">No metadata available.</div>
  return (
    <dl className="kv">
      {visible.map(([label, value, wrap], index) => (
        <div key={`${label}-${index}`} style={{ display: 'contents' }}>
          <dt>{label}</dt>
          <dd className={wrap ? 'wrap' : ''}>{value === true ? 'yes' : value === false ? 'no' : value}</dd>
        </div>
      ))}
    </dl>
  )
}

export function DataTable({ columns, rows, emptyLabel = 'No rows', numericFrom = 0 }) {
  if (!rows || rows.length === 0) return <div className="empty">{emptyLabel}</div>
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            {/* A column may be given as a plain string key or as a definition
                object; an object with an intentionally empty label (an action
                column) must still render its key, never the object itself. */}
            {columns.map((column, index) => (
              <th
                key={`${typeof column === 'string' ? column : column.key || 'col'}-${index}`}
                className={index >= columns.length - (numericFrom || 0) ? 'num' : ''}
              >
                {typeof column === 'string' ? column : column.label ?? column.key ?? ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {columns.map((column, columnIndex) => {
                const key = typeof column === 'string' ? column : column.key
                const value = row[key]
                const isNumeric = (numericFrom || 0) > 0 && columnIndex >= columns.length - numericFrom
                return (
                  <td key={key} className={isNumeric ? 'num' : ''}>
                    {typeof column === 'object' && column.render
                      ? column.render(value, row)
                      : value === null || value === undefined
                        ? '—'
                        : String(value)}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function Collapsible({ title, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div>
      <button className="ghost small" onClick={() => setOpen((value) => !value)}>
        {open ? '▾' : '▸'} {title}
      </button>
      {open ? <div style={{ marginTop: 8 }}>{children}</div> : null}
    </div>
  )
}

export function JsonBlock({ value }) {
  return <pre className="json">{JSON.stringify(value, null, 2)}</pre>
}

/**
 * Health-class colours.
 *
 * Declared as literals rather than `var(--health-*)` on purpose: these values
 * are handed to Recharts' SVG `fill` attribute and to inline `background`
 * styles, and SVG presentation attributes do not resolve CSS custom
 * properties reliably across engines. The literals mirror the tokens in
 * styles.css one-for-one — change both together.
 */
export const HEALTH_COLOURS = {
  very_low: '#a8442b',
  low: '#c98616',
  moderate: '#c2ac2c',
  healthy: '#6fa53f',
  very_healthy: '#2f7a46',
}
