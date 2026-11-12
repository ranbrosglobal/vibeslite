import { Badge, Disclaimer, Panel } from './Panel'

/** NDVI colour ramp legend (mirrors the backend colormap). */
export function NdviLegend({ label = 'NDVI', from = -0.2, to = 1.0, thresholds }) {
  const marks = thresholds ? [thresholds.very_low, thresholds.low, thresholds.moderate, thresholds.healthy] : [0.2, 0.4, 0.6, 0.8]
  return (
    <div>
      <div className="legend-bar" />
      <div className="legend-scale">
        <span>{from.toFixed(1)}</span>
        {marks.map((value) => (
          <span key={value}>{Number(value).toFixed(2)}</span>
        ))}
        <span>{to.toFixed(1)}</span>
      </div>
      <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
        {label} · water & soil → sparse → moderate → dense canopy
      </div>
    </div>
  )
}

/** Plain-language interpretation of an analysis result. */
export default function InterpretationPanel({ interpretation, field, thresholds, title = 'Interpretation' }) {
  if (!interpretation) return null
  const tone = interpretation.confidence === 'good' ? 'green' : 'warn'
  return (
    <Panel
      title={title}
      actions={
        <div className="row">
          <Badge tone={tone}>{interpretation.confidence} confidence</Badge>
          {field?.vigour_score !== undefined && field?.vigour_score !== null ? (
            <Badge tone="teal">vigour {field.vigour_score}</Badge>
          ) : null}
        </div>
      }
    >
      <div style={{ fontSize: 14, fontWeight: 600 }}>{interpretation.verdict}</div>
      <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 12.5, color: 'var(--ink)' }}>
        {(interpretation.points || []).map((point, index) => (
          <li key={index} style={{ marginBottom: 4 }}>
            {point}
          </li>
        ))}
      </ul>
      {thresholds ? (
        <div className="row" style={{ fontSize: 11.5, color: 'var(--muted)' }}>
          Thresholds:
          <span className="mono">
            very low &lt; {thresholds.very_low} · low &lt; {thresholds.low} · moderate &lt; {thresholds.moderate} · healthy &lt; {thresholds.healthy}
          </span>
        </div>
      ) : null}
      <Disclaimer text={interpretation.disclaimer} />
    </Panel>
  )
}

/** Compact summary of weak-vegetation findings. */
export function WeakVegetationPanel({ weak, onFocusZones }) {
  if (!weak) return null
  return (
    <Panel title="Weak vegetation zones" hint={`NDVI below ${Number(weak.threshold).toFixed(2)}`}>
      <div className="row">
        <Badge tone={weak.patch_count ? 'warn' : 'green'}>{weak.patch_count} patch(es)</Badge>
        <Badge>{Number(weak.percentage).toFixed(2)}% of pixels</Badge>
        {weak.area_ha ? <Badge>{Number(weak.area_ha).toFixed(2)} ha</Badge> : null}
      </div>
      {weak.morphology ? (
        <div style={{ fontSize: 12, color: 'var(--muted)' }}>
          OpenCV mask refinement removed {weak.morphology.removed_pixels} noise pixel(s) · minimum patch {weak.morphology.min_area_ha} ha
        </div>
      ) : null}
      {weak.patches?.length ? (
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5 }}>
          {weak.patches.slice(0, 6).map((patch, index) => (
            <li key={index}>
              {patch.area_ha} ha near {patch.centroid_lonlat?.map((value) => value.toFixed(4)).join(', ')}
            </li>
          ))}
        </ul>
      ) : (
        <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>No weak-vegetation patches survived the morphology filter.</div>
      )}
      {onFocusZones && weak.patches?.length ? (
        <button className="small" onClick={() => onFocusZones(weak.patches)}>
          Show patches on map
        </button>
      ) : null}
    </Panel>
  )
}
