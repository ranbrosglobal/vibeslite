import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, assetUrl, analysisStore, findAsset, useAnalysisState, useApi } from '../api'
import { Badge, Empty, KeyValue, Loading, Notice, Panel, StatCard } from '../components/Panel'
import { SOIL_FACTS, FactDeck, FieldArt, GradeStamp, Reveal, SavingsMeter, ScoreRing, WalkList } from '../components/Delight'
import MapView from '../components/MapView'

const TILLAGE = [
  ['no_till', 'No-till or direct drill'],
  ['reduced', 'Reduced or strip tillage'],
  ['conventional', 'Plough or full cultivation'],
  ['unknown', 'Not sure'],
]

const TRAJECTORY = {
  gaining: { label: 'Building soil carbon', tone: 'green', glyph: '↑' },
  'roughly stable': { label: 'Holding steady', tone: '', glyph: '→' },
  losing: { label: 'Losing soil carbon', tone: 'warn', glyph: '↓' },
}

export default function SoilHealth() {
  const { ndvi: result } = useAnalysisState()

  // Same fallback as crop health: a bookmarked page should still show the most
  // recent analysis rather than an empty screen.
  const latest = useApi(
    useCallback(() => api.results({ kind: 'crop_health', limit: 1 }), []),
    { skip: Boolean(result) },
  )
  const storedId = latest.data?.results?.[0]?.id || null
  const stored = useApi(useCallback(() => api.result(storedId), [storedId]), {
    skip: Boolean(result) || !storedId,
  })
  useEffect(() => {
    if (!result && stored.data?.payload) analysisStore.set({ ndvi: stored.data.payload })
  }, [result, stored.data])

  const payload = result
  const health = payload?.health

  const cover = useMemo(() => {
    if (!health) return null
    const covered = (health.moderate_pct || 0) + (health.healthy_pct || 0) + (health.very_healthy_pct || 0)
    const exposed = (health.very_low_pct || 0) + (health.low_pct || 0)
    return { covered, exposed }
  }, [health])

  const weak = payload?.weak_vegetation
  const overlay = payload ? findAsset(payload, 'weak_vegetation_overlay') || findAsset(payload, 'health_overlay') : null
  const verdict = coverVerdict(cover?.covered ?? 0)
  const soilWalk = useMemo(() => buildSoilWalk(cover, weak), [cover, weak])

  // practice screen
  const [tillage, setTillage] = useState('unknown')
  const [coverCrop, setCoverCrop] = useState(false)
  const [residue, setResidue] = useState(true)
  const [years, setYears] = useState(3)
  const [trend, setTrend] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const runTrend = async () => {
    if (!health) return
    setBusy(true)
    setError(null)
    try {
      const mean = payload.statistics?.mean ?? payload.field?.mean_index ?? 0.5
      setTrend(
        await api.carbon({
          index_values: [Number(mean)],
          tillage,
          cover_crop: coverCrop,
          residue_retained: residue,
          years_in_practice: Number(years) || 0,
        }),
      )
    } catch (caught) {
      setError(caught.message)
    } finally {
      setBusy(false)
    }
  }

  if (!payload) {
    return (
      <>
        <div className="hero-card">
          <div>
            <h2>Good soil shows at the surface first</h2>
            <p>
              Soil that stays covered holds water, resists erosion and keeps its organic matter. We read ground cover
              from your latest crop image, then show how your farming practices are likely to move soil carbon up or
              down over time.
            </p>
            <div className="hero-meta">
              <Badge tone="green">Ground cover</Badge>
              <Badge>Practice check</Badge>
              <Badge>What to test</Badge>
            </div>
          </div>
          <div className="hero-score-wrap">
            <FieldArt />
            <span className="caption">No field checked yet</span>
          </div>
        </div>

        <Panel title="One field check is all it takes" hint="Soil health builds on the crop image you already have">
          <Empty
            title="Check your crop first"
            action={
              <Link className="btn primary" to="/crop-health">
                Go to crop health
              </Link>
            }
          >
            Run one crop-health check on a field photo or satellite image. We then use the same map to estimate how much
            of the soil is protected by living cover, and where it is exposed.
          </Empty>
        </Panel>

        <SoilTestGuide />
      </>
    )
  }

  const trajectory = trend?.trajectory ? TRAJECTORY[trend.trajectory] || TRAJECTORY['roughly stable'] : null
  const estimate = trend?.estimate_t_c_per_ha_per_year

  return (
    <>
      <div className="hero-card">
        <div>
          <span className="hero-kicker">Soil health · ground cover</span>
          <h2>{verdict.title}</h2>
          <p>{verdict.body}</p>
          <div className="hero-meta">
            <Badge>{payload.dataset}</Badge>
            {payload.observation_date ? <Badge>{prettyDate(payload.observation_date)}</Badge> : null}
            <Badge tone="teal">estimated from ground cover</Badge>
          </div>
        </div>
        <div className="hero-ring">
          <ScoreRing value={cover?.covered ?? 0} tone={verdict.tone} suffix="%" caption="moderate to strong canopy" />
          <GradeStamp value={cover?.covered ?? 0} />
          <dl className="hero-readouts">
            <div>
              <dt>Soil exposed</dt>
              <dd>{(cover?.exposed ?? 0).toFixed(1)}%</dd>
            </div>
            <div>
              <dt>Weak patches</dt>
              <dd>{weak?.patch_count ?? 0}</dd>
            </div>
            <div>
              <dt>Area assessed</dt>
              <dd>{health?.analysed_area_ha ? `${Number(health.analysed_area_ha).toFixed(1)} ha` : '—'}</dd>
            </div>
          </dl>
        </div>
      </div>

      <div className="grid cols-4">
        <StatCard
          label="Ground covered"
          value={(cover?.covered ?? 0).toFixed(1)}
          unit="%"
          tone="green"
          foot="canopy shading the soil"
          meter={cover?.covered ?? 0}
        />
        <StatCard
          label="Soil exposed"
          value={(cover?.exposed ?? 0).toFixed(1)}
          unit="%"
          tone={(cover?.exposed ?? 0) > 25 ? 'danger' : ''}
          foot="thin canopy or bare ground"
          meter={cover?.exposed ?? 0}
        />
        <StatCard
          label="Weak patches"
          value={weak?.patch_count ?? 0}
          foot={weak?.largest_patch_ha ? `largest ${Number(weak.largest_patch_ha).toFixed(1)} ha` : 'places to inspect'}
        />
        <StatCard
          label="Area assessed"
          value={health?.analysed_area_ha ? Number(health.analysed_area_ha).toFixed(1) : '—'}
          unit={health?.analysed_area_ha ? 'ha' : ''}
          foot="same field as the crop check"
        />
      </div>

      <div className="grid sidebar-right">
        <Panel
          title="Where your soil is exposed"
          hint="Weak canopy is the first sign of soil at risk — wind, rain and heat reach it directly."
          actions={
            <a className="btn small" href={assetUrl(findAsset(payload, 'health_map'))} target="_blank" rel="noreferrer" download>
              Save map
            </a>
          }
        >
          <div className="field-strip">
            <div className="strip-bar" role="img" aria-label="Covered and exposed share of the field">
              <span style={{ width: `${cover?.covered || 0}%`, background: '#2f7a46' }} title={`Covered ${Number(cover?.covered || 0).toFixed(1)}%`} />
              <span style={{ width: `${cover?.exposed || 0}%`, background: '#b0492c' }} title={`Exposed ${Number(cover?.exposed || 0).toFixed(1)}%`} />
            </div>
            <div className="strip-legend">
              <span className="strip-key"><i style={{ background: '#2f7a46' }} /> Covered by crop <b>{Number(cover?.covered || 0).toFixed(1)}%</b></span>
              <span className="strip-key"><i style={{ background: '#b0492c' }} /> Exposed or very thin <b>{Number(cover?.exposed || 0).toFixed(1)}%</b></span>
            </div>
            <div className="strip-scale">Ground cover is estimated from the crop-health map, so it changes as the crop grows.</div>
          </div>

          <MapView
            bounds={payload.clip?.bounds_lonlat}
            overlays={[{ key: 'cover', url: assetUrl(overlay), bounds: overlay?.bounds_lonlat, opacity: 0.82 }]}
            geojson={payload.aoi_geojson ? [{ data: payload.aoi_geojson }] : []}
            note={`${weak?.patch_count ?? 0} exposed spot(s) · ${Number(health?.analysed_area_ha || 0).toFixed(1)} ha`}
          />
        </Panel>

        <div className="stack">
          <Panel title="Protect what you have" hint="Most useful when soil is exposed">
            <ul className="tip-list">
              {coverTips(cover).map((tip, index) => (
                <li key={index}>
                  <span className="tick" aria-hidden="true">{index + 1}</span>
                  <span className="text">{tip}</span>
                </li>
              ))}
            </ul>
          </Panel>

          <Panel title="Why cover matters" hint="Three things bare soil loses fastest">
            <div className="help-grid">
              <div className="help-card">
                <span className="glyph" aria-hidden="true">💧</span>
                <b>Water</b>
                <p>Bare ground sheds rain instead of soaking it in, so less reaches the roots.</p>
              </div>
              <div className="help-card">
                <span className="glyph" aria-hidden="true">🌬️</span>
                <b>Topsoil</b>
                <p>Wind and rain carry away the layer that holds most of the organic matter.</p>
              </div>
              <div className="help-card">
                <span className="glyph" aria-hidden="true">🪱</span>
                <b>Life</b>
                <p>Soil biology slows down when the surface gets hot and dry.</p>
              </div>
            </div>
          </Panel>
        </div>
      </div>

      <div className="grid sidebar-left">
        <Panel title="Your soil practices" hint="Tell us how this field is managed">
          <label className="field">
            Tillage
            <select value={tillage} onChange={(event) => setTillage(event.target.value)}>
              {TILLAGE.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="toggle">
            <input type="checkbox" checked={coverCrop} onChange={(event) => setCoverCrop(event.target.checked)} />
            I grow a cover crop between cash crops
          </label>
          <label className="toggle">
            <input type="checkbox" checked={residue} onChange={(event) => setResidue(event.target.checked)} />
            Crop residue stays on the field
          </label>
          <label className="field">
            Years in these practices
            <input type="number" min="0" max="50" step="1" value={years} onChange={(event) => setYears(event.target.value)} />
          </label>
          <button className="primary" onClick={runTrend} disabled={busy}>
            {busy ? 'Checking…' : 'See my soil trend'}
          </button>
          {error ? <Notice tone="danger">{error}</Notice> : null}
        </Panel>

        <div className="stack">
          {trend?.verdict === 'screening_estimate' ? (
            <>
              <Panel
                title="Likely direction of soil carbon"
                hint="A screening estimate from your practices and canopy — not a soil measurement"
                actions={trajectory ? <Badge tone={trajectory.tone}>{trajectory.glyph} {trajectory.label}</Badge> : null}
              >
                <div className="row" style={{ alignItems: 'baseline', gap: 8 }}>
                  <span style={{ font: '600 34px/1 var(--display)' }}>
                    {estimate ? signed(estimate.central) : '—'}
                  </span>
                  <span className="dim">t C per hectare per year</span>
                </div>
                <div className="hint">
                  Likely range {estimate ? `${signed(estimate.low)} to ${signed(estimate.high)}` : '—'} t C/ha/yr over{' '}
                  {Number(trend.years_in_practice || years).toFixed(0)} year(s) of these practices.
                </div>
                {estimate ? (
                  <>
                    <SavingsMeter low={Number(estimate.low)} high={Number(estimate.high)} central={Number(estimate.central)} />
                    <div className="hint">
                      Think of it as a savings account: cover crops and residue make deposits, tillage makes withdrawals.
                    </div>
                  </>
                ) : null}

                <div className="section-label">What is helping or holding you back</div>
                <ul className="bullet">
                  {(trend.contributions || []).map((entry, index) => (
                    <li key={index}>
                      {prettyPractice(entry.practice)}{' '}
                      <span className={entry.weight >= 0 ? 'mono' : 'mono warn-text'}>
                        {entry.weight >= 0 ? '+' : ''}
                        {Number(entry.weight).toFixed(2)}
                      </span>
                    </li>
                  ))}
                </ul>
                {trend.saturation_factor < 0.6 ? (
                  <div className="hint">
                    Gains slow down over time: after {Number(trend.years_in_practice || 0).toFixed(0)} years these practices are
                    about {Math.round(trend.saturation_factor * 100)}% of the way to their full effect.
                  </div>
                ) : null}
              </Panel>

              <Panel title="What this number is not" hint="Read before making a decision">
                <p style={{ margin: 0 }}>
                  This is a practice screen, not a soil test and not a carbon credit calculation. It cannot see your
                  actual organic matter.
                </p>
                <div className="section-label">A real figure needs</div>
                <ul className="bullet">
                  {(trend.verification?.missing_for_verification || []).slice(0, 4).map((item, index) => (
                    <li key={index}>{item}</li>
                  ))}
                </ul>
              </Panel>
            </>
          ) : (
            <Panel title="Likely direction of soil carbon" hint="A quick screening of your practices">
              {busy ? (
                <Loading label="Checking your practices…" />
              ) : (
                <Empty title="No trend yet">
                  Choose your tillage, cover crop and residue practice, then press “See my soil trend”. You will get a
                  direction and a cautious range — plus what to measure to confirm it.
                </Empty>
              )}
            </Panel>
          )}
        </div>
      </div>

      <Reveal>
        <div className="grid cols-2">
          <Panel title="Protect the soil, step by step" hint="Small jobs that pay back for years">
            <WalkList
              items={soilWalk}
              storageKey={`soil-walk:${payload.dataset}:${payload.observation_date || 'latest'}`}
            />
          </Panel>
          <FactDeck facts={SOIL_FACTS} title="Soil wisdom" />
        </div>
      </Reveal>

      <SoilTestGuide />
    </>
  )
}

/* ── static, genuinely useful guidance ───────────────────────────────────── */

function SoilTestGuide() {
  return (
    <Panel
      title="What a soil test tells you that an image cannot"
      hint="Ask your lab for these five numbers — they are the foundation of any soil plan"
    >
      <div className="help-grid">
        <div className="help-card">
          <b>pH</b>
          <p>Most crops do best between 6.0 and 7.5. Outside that, nutrients are present but locked up.</p>
        </div>
        <div className="help-card">
          <b>Organic matter</b>
          <p>The best single indicator of soil health. Watch the trend across years rather than one number.</p>
        </div>
        <div className="help-card">
          <b>EC (salts)</b>
          <p>High salts pull water away from roots. Common in coastal fields and under heavy fertiliser use.</p>
        </div>
        <div className="help-card">
          <b>Texture</b>
          <p>Sand, loam or clay decides how much water your soil can hold between rains.</p>
        </div>
        <div className="help-card">
          <b>Moisture</b>
          <p>A probe reading at root depth tells you when to irrigate far better than a surface photo.</p>
        </div>
      </div>
      <Notice tone="muted">
        Sample the same spots each time — a fence line, a mid-field point and a known weak area — so year-to-year
        changes are real rather than sampling noise.
      </Notice>
    </Panel>
  )
}

/* ── copy ────────────────────────────────────────────────────────────────── */

function buildSoilWalk(cover, weak) {
  const exposed = cover?.exposed ?? 0
  const items = []
  if (exposed >= 10) {
    items.push({
      id: 'residue',
      title: 'Leave residue on the exposed patches',
      detail: `About ${exposed.toFixed(0)}% of the field is thin or bare — its blanket matters most there`,
    })
  } else {
    items.push({
      id: 'residue',
      title: 'Keep residue spread evenly',
      detail: 'Avoid baling it all off the weaker areas',
    })
  }
  items.push(
    { id: 'soak', title: 'Do the rain test', detail: 'After the next rain, compare how fast an exposed and a covered spot soak water in' },
    { id: 'cover-window', title: 'Pick your cover-crop window', detail: 'A living root between seasons feeds soil life for free' },
    { id: 'sample', title: 'Mark the weakest spot for your next soil sample', detail: 'Same spots every year shows the real trend' },
  )
  return items
}

function coverVerdict(covered) {
  if (covered >= 70) {
    return {
      title: 'Your soil is mostly protected',
      body: 'Living cover shades most of this field, which keeps the surface cooler, slows erosion and helps rain soak in. Keep the crop and residue cover going through the season.',
      tone: 'good',
    }
  }
  if (covered >= 40) {
    return {
      title: 'About half your soil is protected',
      body: 'Cover is patchy. The exposed areas are where water, wind and heat do the most damage — they are also the cheapest places to improve first.',
      tone: 'mixed',
    }
  }
  return {
    title: 'Much of your soil is exposed',
    body: 'Bare ground is losing water and topsoil. Residue, a cover crop or a tighter row spacing will do more for this field than extra fertiliser.',
    tone: 'poor',
  }
}

function coverTips(cover) {
  const exposed = cover?.exposed ?? 0
  const tips = []
  if (exposed > 25) {
    tips.push('Prioritise the exposed patches: keep residue on them and avoid working them bare.')
  } else if (exposed > 10) {
    tips.push('Keep residue spread evenly rather than baling it all off the weaker areas.')
  } else {
    tips.push('Cover is good. Avoid overgrazing or burning residue, which removes it quickly.')
  }
  tips.push('Reduce the number of tillage passes — each one breaks up the structure that holds your soil together.')
  tips.push('A cover crop between seasons adds roots and organic matter, and protects the surface when the main crop is off.')
  tips.push('Compare an exposed and a covered spot after the next rain: how fast water soaks in tells you a lot.')
  return tips.slice(0, 4)
}

function prettyPractice(value) {
  const text = String(value || '').replace(/_/g, ' ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

function signed(value) {
  if (value === null || value === undefined) return '—'
  const number = Number(value)
  return `${number > 0 ? '+' : ''}${number.toFixed(2)}`
}

function prettyDate(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}
