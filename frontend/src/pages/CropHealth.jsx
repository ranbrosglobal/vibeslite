import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, assetUrl, analysisStore, findAsset, useAnalysisState, useApi } from '../api'
import { Badge, Collapsible, Empty, Loading, Notice, Panel, StatCard, Warnings } from '../components/Panel'
import { CROP_FACTS, FactDeck, FieldArt, GradeStamp, Reveal, ScoreRing, SpotDuel, WalkList } from '../components/Delight'
import MapView from '../components/MapView'
import FieldPicker from '../components/FieldPicker'
import { PatchBars, SpectrumBar } from '../components/Viz'
import { HEALTH_COLOURS } from '../components/Panel'

/** Farmer-facing names for the four agronomic classes. */
const NAMES = {
  very_low: 'Very weak',
  low: 'Weak',
  moderate: 'Doing okay',
  healthy: 'Strong crop',
  very_healthy: 'Very strong',
}

const COLOURS = HEALTH_COLOURS

export default function CropHealth() {
  const { ndvi: result } = useAnalysisState()
  const [running, setRunning] = useState(false)
  const [error, setError] = useState(null)
  const [showPicker, setShowPicker] = useState(false)

  // A bookmarked or refreshed page arrives with an empty store: fall back to the
  // most recent stored crop-health result so the view is never blank.
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
  const weak = payload?.weak_vegetation

  const classes = useMemo(() => {
    return (health?.classes || [])
      .filter((entry) => (entry.percentage || 0) > 0)
      .map((entry) => ({ ...entry, name: NAMES[entry.key] || entry.label }))
  }, [health])

  const healthyShare = (health?.healthy_pct || 0) + (health?.very_healthy_pct || 0)
  const attentionShare = (health?.low_pct || 0) + (health?.very_low_pct || 0)
  const openShare = health?.very_low_pct || 0

  const verdict = verdictFor(healthyShare)
  const tips = useMemo(() => buildTips({ healthyShare, attentionShare, weak, health }), [healthyShare, attentionShare, weak, health])
  const walkItems = useMemo(() => buildWalkItems(weak), [weak])
  const duelSpots = useMemo(() => buildDuel({ healthyShare, health, weak }), [healthyShare, health, weak])

  const run = async (request) => {
    setRunning(true)
    setError(null)
    try {
      const analysis = await api.cropHealth({ ...request, weak_threshold: 0.45 })
      analysisStore.set({ ndvi: analysis, selection: request })
      setShowPicker(false)
    } catch (caught) {
      setError(caught.message)
    } finally {
      setRunning(false)
    }
  }

  if (!payload) {
    return (
      <>
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <div className="hero-card">
          <div>
            <h2>Start with one photo or satellite image of your field</h2>
            <p>
              We divide the field into small squares, read how much healthy green growth is in each one, and show you a
              simple map of where the crop is strong and where it is struggling. No technical setup needed.
            </p>
            <div className="hero-meta">
              <Badge tone="green">Healthy vs weak map</Badge>
              <Badge>Works with drone or phone photos</Badge>
              <Badge>Satellite images too</Badge>
            </div>
          </div>
          <div className="hero-score-wrap">
            <FieldArt />
            <span className="caption">No field checked yet</span>
          </div>
        </div>

        <div className="grid sidebar-left">
          <FieldPicker onRun={run} running={running} runLabel="Check crop health" note="Pick an image you already uploaded, or add a new one below." />
          <Panel title="What you will get">
            <div className="steps">
              <div className="step">
                <span>A map of your field, coloured from strong crop to very weak patches.</span>
              </div>
              <div className="step">
                <span>How much of the field is healthy, and how much needs attention — in plain percentages and hectares.</span>
              </div>
              <div className="step">
                <span>A short list of what to check first, in the field.</span>
              </div>
            </div>
            <Notice tone="muted">
              Crop health is read from how much living green cover is present. It cannot tell you the cause of a weak
              patch — that still needs your eyes, or a soil test.
            </Notice>
          </Panel>
        </div>
      </>
    )
  }

  const overlay = findAsset(payload, 'health_overlay') || findAsset(payload, 'index_overlay')
  const largestPatch = weak?.largest_patch_ha ?? weak?.patches?.[0]?.area_ha ?? null
  const areaHa = health?.analysed_area_ha ?? payload.field?.field_area_ha

  return (
    <>
      {error ? <Notice tone="danger">{error}</Notice> : null}

      <div className="hero-card">
        <div>
          <span className="hero-kicker">Crop health · {payload.index} image</span>
          <h2>{verdict.title}</h2>
          <p>{verdict.body}</p>
          <div className="hero-meta">
            <Badge tone="green">{payload.index} image</Badge>
            <Badge>{payload.dataset}</Badge>
            {payload.observation_date ? <Badge>{prettyDate(payload.observation_date)}</Badge> : null}
            {areaHa ? <Badge>{Number(areaHa).toFixed(1)} ha checked</Badge> : null}
          </div>
        </div>
        <div className="hero-ring">
          <ScoreRing value={healthyShare} tone={verdict.tone} suffix="%" caption={verdict.caption} />
          <GradeStamp value={healthyShare} />
          <dl className="hero-readouts">
            <div>
              <dt>Needs attention</dt>
              <dd>{attentionShare.toFixed(1)}%</dd>
            </div>
            <div>
              <dt>Open ground</dt>
              <dd>{openShare.toFixed(1)}%</dd>
            </div>
            <div>
              <dt>Largest patch</dt>
              <dd>{largestPatch === null ? '—' : `${Number(largestPatch).toFixed(2)} ha`}</dd>
            </div>
          </dl>
        </div>
      </div>

      <div className="grid cols-4">
        <StatCard
          label="Healthy crop"
          value={healthyShare.toFixed(1)}
          unit="%"
          tone="green"
          foot={health.healthy_area_ha ? `${Number(health.healthy_area_ha).toFixed(1)} ha growing well` : 'share of the field'}
          meter={healthyShare}
        />
        <StatCard
          label="Needs attention"
          value={attentionShare.toFixed(1)}
          unit="%"
          tone={attentionShare > 20 ? 'warn' : ''}
          foot={health.weak_area_ha ? `${Number(health.weak_area_ha).toFixed(1)} ha to walk` : 'weak and very weak areas'}
          meter={attentionShare}
        />
        <StatCard
          label="Open or very weak ground"
          value={openShare.toFixed(1)}
          unit="%"
          tone={openShare > 10 ? 'danger' : ''}
          foot="little or no living cover"
          meter={openShare}
        />
        <StatCard
          label="Largest weak patch"
          value={largestPatch === null ? '—' : Number(largestPatch).toFixed(2)}
          unit={largestPatch === null ? '' : 'ha'}
          foot={`${weak?.patch_count ?? 0} separate patch(es) found`}
        />
      </div>

      <div className="grid sidebar-right">
        <Panel
          title="Your field at a glance"
          hint="Each colour is a health zone. Tap the map to read the weather there."
          actions={
            <>
              <a className="btn small" href={assetUrl(findAsset(payload, 'health_map'))} target="_blank" rel="noreferrer" download>
                Save map
              </a>
              <button className="small" onClick={() => setShowPicker((value) => !value)}>
                {showPicker ? 'Close options' : 'Check another field'}
              </button>
            </>
          }
        >
          <SpectrumBar
            items={classes.map((entry) => ({
              key: entry.key,
              label: entry.name,
              pct: entry.percentage,
              color: COLOURS[entry.key] || '#c2ac2c',
            }))}
          />

          <MapView
            bounds={payload.clip?.bounds_lonlat}
            search
            overlays={[
              { key: 'health', url: assetUrl(overlay), bounds: overlay?.bounds_lonlat, opacity: 0.82 },
            ]}
            geojson={payload.aoi_geojson ? [{ data: payload.aoi_geojson }] : []}
            markers={(weak?.patches || []).slice(0, 12).map((patch, index) => ({
              position: [patch.centroid_lonlat[1], patch.centroid_lonlat[0]],
              label: `Weak spot ${index + 1}`,
              detail: `${patch.area_ha} ha`,
            }))}
            note={`${weak?.patch_count ?? 0} weak spot(s) marked · ${Number(health.analysed_area_ha || 0).toFixed(1)} ha`}
          />

          <div className="help-grid">
            <div className="help-card">
              <span className="glyph" aria-hidden="true">🌿</span>
              <b>Strong crop</b>
              <p>Dense, actively growing canopy. Keep doing what you are doing here.</p>
            </div>
            <div className="help-card">
              <span className="glyph" aria-hidden="true">🌤️</span>
              <b>Doing okay</b>
              <p>Growing, but not at full strength. Worth watching over the next week or two.</p>
            </div>
            <div className="help-card">
              <span className="glyph" aria-hidden="true">🔎</span>
              <b>Weak or very weak</b>
              <p>Thin canopy or bare ground. Walk these areas first — water, pests and nutrition are the usual causes.</p>
            </div>
          </div>
        </Panel>

        <div className="stack">
          <Panel title="What to do next" hint="Short, practical steps based on this image">
            <ul className="tip-list">
              {tips.map((tip, index) => (
                <li key={index}>
                  <span className="tick" aria-hidden="true">{index + 1}</span>
                  <span className="text">{tip}</span>
                </li>
              ))}
            </ul>
          </Panel>

          <Panel title="In plain words" hint="What this image can and cannot tell you">
            <ul className="bullet">
              <li>
                Roughly <strong>{Math.round(healthyShare / 10)} in 10</strong> parts of this field are growing strongly.
              </li>
              <li>
                {attentionShare >= 1
                  ? `About ${attentionShare.toFixed(0)}% is thin or weak${areaHa ? `, roughly ${((areaHa * attentionShare) / 100).toFixed(1)} ha` : ''} — worth walking.`
                  : 'No meaningful weak area was found in this image.'}
              </li>
              <li>
                {openShare >= 5
                  ? 'Bare or nearly bare ground is visible. Check for wash-outs, pests or germination gaps.'
                  : 'Very little bare ground is visible, which is good for soil and water.'}
              </li>
            </ul>
            <div className="disclaimer">A single image shows vigour, not the cause. Confirm anything important in the field.</div>
          </Panel>
        </div>
      </div>

      <Reveal>
        <div className="grid cols-2">
          <Panel title="Your walk, checked off" hint="Generated from this image — tick tasks off in the field">
            <WalkList items={walkItems} storageKey={`walk:${payload.dataset}:${payload.observation_date || 'latest'}`} />
          </Panel>
          <div className="stack">
            <Panel title="Strongest vs weakest" hint="The two spots that teach you the most">
              <SpotDuel strong={duelSpots.strong} weak={duelSpots.weak} />
            </Panel>
            <FactDeck facts={CROP_FACTS} title="Field wisdom" />
          </div>
        </div>
      </Reveal>

      {showPicker ? (
        <div className="grid sidebar-left">
          <FieldPicker onRun={run} running={running} runLabel="Check crop health" note="Choose a different image or field boundary, then run the check again." />
          <Panel title="Good images give good answers">
            <ul className="bullet">
              <li>Shoot straight down, with the sun behind you and no strong shadows.</li>
              <li>Cover the whole field — one photo of a corner only describes that corner.</li>
              <li>If you add GPS coordinates, the map and local weather will line up with your field.</li>
            </ul>
          </Panel>
        </div>
      ) : null}

      <OpenCvSpotCheck payload={payload} />

      <Panel title="Where to look first" hint="Weak areas ranked by size">
        {weak?.patches?.length ? (
          <PatchBars patches={weak.patches} />
        ) : (
          <div className="empty">
            <strong>No weak patches found</strong>
            Your crop looks even across this field.
          </div>
        )}
      </Panel>

      <Warnings items={payload.warnings} title="Worth knowing" />
      <Notice tone="muted">{payload.disclaimer}</Notice>
      <div className="hint">
        Want to understand what is happening below the surface?{' '}
        <Link to="/soil-health">Look at soil health →</Link>
      </div>
    </>
  )
}

/* ── OpenCV spot check ───────────────────────────────────────────────────── */

function OpenCvSpotCheck({ payload }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [scan, setScan] = useState(null)

  const runScan = async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await api.segmentation({
        dataset: payload.dataset,
        aoi: payload.aoi === 'raster_extent' ? null : payload.aoi,
        index: payload.index,
        method: 'threshold',
        params: { threshold: payload.weak_vegetation?.threshold ?? 0.4, min_area_ha: 0.2 },
        include_visuals: true,
      })
      setScan(result)
    } catch (caught) {
      setError(caught.message)
    } finally {
      setBusy(false)
    }
  }

  const overlay = scan?.assets?.find((asset) => asset.name === 'segmentation_overlay')

  return (
    <Collapsible title="Look closer with image analysis (OpenCV)">
      <div className="stack">
        <p className="hint" style={{ margin: 0 }}>
          Image analysis traces the edges of weak areas and removes tiny specks of noise, so you get a clean count of
          real patches instead of scattered pixels.
        </p>
        <div className="row">
          <button className="small primary" onClick={runScan} disabled={busy}>
            {busy ? 'Scanning the image…' : 'Find weak patches'}
          </button>
          {scan ? (
            <span className="small dim">
              {scan.component_count} area(s) · {Number(scan.mask_coverage_pct || 0).toFixed(1)}% of the field
            </span>
          ) : null}
        </div>
        {error ? <Notice tone="danger">{error}</Notice> : null}
        {busy ? <Loading label="Tracing weak areas…" /> : null}
        {scan ? (
          <>
            <div className="grid cols-3">
              <StatCard label="Weak areas found" value={scan.component_count} foot="separate patches after cleaning" />
              <StatCard label="Share of field" value={Number(scan.mask_coverage_pct || 0).toFixed(1)} unit="%" tone="warn" />
              <StatCard
                label="Total area"
                value={scan.area_ha ? Number(scan.area_ha).toFixed(2) : '—'}
                unit={scan.area_ha ? 'ha' : ''}
                foot="combined weak ground"
              />
            </div>
            {overlay || scan.segments_geojson?.features?.length ? (
              <MapView
                bounds={scan.clip?.bounds_lonlat}
                overlays={overlay ? [{ key: 'scan', url: assetUrl(overlay), bounds: overlay.bounds_lonlat, opacity: 0.8 }] : []}
                geojson={
                  scan.segments_geojson?.features?.length
                    ? [{ data: scan.segments_geojson, style: { color: '#2f7a46', weight: 1.2, fillOpacity: 0.12 } }]
                    : []
                }
                height="map-short"
                note={`${scan.contour_count || 0} outline(s) traced`}
              />
            ) : null}
          </>
        ) : null}
      </div>
    </Collapsible>
  )
}

/* ── copy ────────────────────────────────────────────────────────────────── */

function verdictFor(healthy) {
  if (healthy >= 75) {
    return {
      title: 'Most of your crop is growing strongly',
      body: 'Canopy cover is even and vigorous across the field. Keep your current watering and feeding plan, and walk only the weak spots listed below.',
      caption: 'of the field is healthy',
      tone: 'good',
    }
  }
  if (healthy >= 45) {
    return {
      title: 'Your crop is growing, but unevenly',
      body: 'A good part of the field is strong, while other areas are lagging. Walking the weak zones and comparing them with the strong ones will show what is different.',
      caption: 'of the field is healthy',
      tone: 'mixed',
    }
  }
  return {
    title: 'A large part of this field needs attention',
    body: 'More than half of the field has thin or weak growth. Check water first, then look for pests, disease or poor establishment in the weakest areas.',
    caption: 'of the field is healthy',
    tone: 'poor',
  }
}

function buildTips({ healthyShare, attentionShare, weak, health }) {
  const tips = []
  if (attentionShare >= 1) {
    const patch = weak?.patch_count || 0
    tips.push(
      patch
        ? `Walk the ${patch} weak area${patch === 1 ? '' : 's'} marked on the map first — they are the cheapest place to find a problem early.`
        : 'Walk the weakest part of the field first, before treating the whole field.',
    )
  } else {
    tips.push('No weak areas stand out. A normal weekly walk is enough for now.')
  }

  if ((health?.very_low_pct || 0) > 8) {
    tips.push('Bare or near-bare ground is showing. Check for germination gaps, waterlogging or pest damage at the soil surface.')
  }

  if (healthyShare >= 70) {
    tips.push('Keep irrigation and nutrition as they are — this image shows the plan is working.')
  } else if (healthyShare >= 45) {
    tips.push('Compare a strong and a weak spot side by side: soil moisture, leaf colour and rooting depth usually explain the gap.')
  } else {
    tips.push('Before adding fertiliser, rule out water stress and soil compaction — more nitrogen rarely fixes either.')
  }

  if (weak?.largest_patch_ha) {
    tips.push(`Your largest weak patch is about ${Number(weak.largest_patch_ha).toFixed(1)} ha. Treat it as one zone rather than spraying the whole field.`)
  }

  tips.push('Take a photo of anything unusual so you can compare it after the next image.')
  return tips.slice(0, 5)
}

function buildWalkItems(weak) {
  const patches = (weak?.patches || []).slice(0, 5)
  const items = patches.map((patch, index) => ({
    id: `spot-${index}`,
    title: `Walk weak spot ${index + 1} — ${Number(patch.area_ha).toFixed(patch.area_ha < 1 ? 2 : 1)} ha`,
    detail: `near ${patch.centroid_lonlat?.[0]?.toFixed(4)}, ${patch.centroid_lonlat?.[1]?.toFixed(4)}`,
  }))
  items.push(
    { id: 'moisture', title: 'Feel the soil in a weak and a strong spot', detail: 'Moisture and rooting depth usually explain the gap' },
    { id: 'photo', title: 'Photograph anything unusual', detail: 'Pests, colour changes, gaps — compare after the next image' },
  )
  return items
}

function buildDuel({ healthyShare, health, weak }) {
  const strong = {
    key: 'strong',
    tag: 'The good news',
    tone: 'strong',
    title: `${healthyShare.toFixed(0)}% growing strongly`,
    text: 'Dense, actively growing canopy. Whatever you are doing here — water, feed, timing — keep doing it.',
    meta: health?.healthy_area_ha ? `${Number(health.healthy_area_ha).toFixed(1)} ha` : null,
  }
  const biggest = weak?.patches?.[0]
  const weakSpot = biggest
    ? {
        key: 'weak',
        tag: 'Start here',
        tone: 'weak',
        title: `Weak spot · ${Number(biggest.area_ha).toFixed(biggest.area_ha < 1 ? 2 : 1)} ha`,
        text: 'Thin canopy or bare ground. Walk it first: water, pests and establishment are the usual suspects.',
        meta: `near ${biggest.centroid_lonlat?.[0]?.toFixed(4)}, ${biggest.centroid_lonlat?.[1]?.toFixed(4)}`,
      }
    : null
  return { strong, weak: weakSpot }
}

function prettyDate(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}
