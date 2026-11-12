import { useMemo, useState } from 'react'
import { api, useApi } from '../api'
import { Collapsible, DataTable, Empty, KeyValue, Notice, Panel, StatCard, Warnings } from '../components/Panel'
import { CumulativeChart, WaterBalanceChart } from '../components/Charts'

/* The engine's input validation is the authority on what is acceptable, so the
 * page sends what the operator typed and shows the API's own message rather
 * than pre-empting it with guesswork. */

const CROPS = ['generic', 'maize', 'wheat', 'rice', 'soybean', 'cotton', 'barley', 'potato', 'tomato', 'grape', 'sugarcane', 'rapeseed', 'sunflower']
const SOILS = ['generic', 'sand', 'loamy_sand', 'sandy_loam', 'loam', 'silt_loam', 'clay_loam', 'clay']
const TILLAGE = ['unknown', 'conventional', 'reduced', 'no_till']
const INDICES = ['NDVI', 'NDRE', 'EVI', 'SAVI', 'GNDVI', 'NDMI', 'NDWI', 'OSAVI', 'MSAVI', 'PSRI', 'CVI', 'RECI', 'GCI']

/** Parse a pasted list of numbers from commas, spaces or newlines. */
function parseSeries(text) {
  return text
    .split(/[\s,;]+/)
    .filter((token) => token !== '')
    .map((token) => Number(token))
    .filter((value) => Number.isFinite(value))
}

const TABS = [
  ['thermal', 'Thermal time'],
  ['water', 'Water & irrigation'],
  ['zones', 'Zones → prescription'],
  ['carbon', 'Soil carbon'],
  ['yield', 'Yield'],
  ['disease', 'Disease risk'],
]

export default function Agronomy() {
  const models = useApi(api.agronomyModels)
  const datasets = useApi(api.datasets)
  const aois = useApi(api.aois)
  const [tab, setTab] = useState('thermal')

  const catalogue = models.data?.models || []
  const coefficients = models.data?.crop_coefficients || {}

  return (
    <>
      <Panel
        title="Agronomy engine"
        hint="Independent, documented models — each one states how far its answer can be trusted"
        actions={
          <button className="small" onClick={() => models.reload()} disabled={models.loading}>
            {models.loading ? 'Loading…' : 'Reload catalogue'}
          </button>
        }
      >
        <div className="chips">
          {TABS.map(([key, label]) => (
            <span key={key} className={`chip ${tab === key ? 'active' : ''}`} onClick={() => setTab(key)} role="tab" aria-selected={tab === key}>
              {label}
            </span>
          ))}
        </div>
        <div className="hint" style={{ marginTop: 10 }}>
          Every model is a transparent calculation over the inputs you supply — no hidden model file, no black box. Where a
          number needs local calibration, the engine returns the calibration recipe instead of inventing an answer.
        </div>
      </Panel>

      {tab === 'thermal' ? <ThermalTab crops={CROPS} /> : null}
      {tab === 'water' ? <WaterTab crops={CROPS} soils={SOILS} /> : null}
      {tab === 'zones' ? (
        <ZonesTab datasets={datasets.data?.datasets || []} aois={aois.data?.aois || []} indices={INDICES} crops={CROPS} />
      ) : null}
      {tab === 'carbon' ? <CarbonTab crops={CROPS} /> : null}
      {tab === 'yield' ? <YieldTab crops={CROPS} /> : null}
      {tab === 'disease' ? <DiseaseTab crops={CROPS} /> : null}

      <Panel title="Model catalogue" hint="What each model is, and its honest confidence level">
        {catalogue.length === 0 ? (
          <Empty title="Catalogue unavailable">Start the FastAPI backend to load the model catalogue.</Empty>
        ) : (
          <DataTable
            columns={[
              { key: 'label', label: 'Model' },
              { key: 'method', label: 'Method' },
              { key: 'needs', label: 'Needs', render: (value) => (value || []).join(', ') },
              { key: 'outputs', label: 'Produces', render: (value) => (value || []).join(', ') },
              { key: 'confidence', label: 'Confidence' },
            ]}
            rows={catalogue}
            emptyLabel="No models registered."
          />
        )}
        <Collapsible title="Crop coefficients and soil water holding capacity">
          <div className="grid sidebar-right">
            <div>
              <h3 className="section-label">Crop mid-season Kc and maturity GDD</h3>
              <DataTable
                columns={[
                  { key: 'crop', label: 'Crop' },
                  { key: 'mid_kc', label: 'Mid Kc' },
                  { key: 'maturity_gdd', label: 'Maturity GDD' },
                  { key: 'stage_days', label: 'Stage days', render: (value) => (value || []).join(' / ') },
                ]}
                rows={Object.entries(coefficients).map(([crop, entry]) => ({ crop, ...entry }))}
              />
            </div>
            <div>
              <h3 className="section-label">Soil water per metre of root</h3>
              <KeyValue rows={Object.entries(models.data?.soil_water_holding_mm_per_m || {}).map(([soil, value]) => [soil, `${value} mm/m`])} />
            </div>
          </div>
        </Collapsible>
      </Panel>
    </>
  )
}

/* -------------------------------------------------------------------------- */
/* thermal time                                                               */
/* -------------------------------------------------------------------------- */
function ThermalTab({ crops }) {
  const [tmin, setTmin] = useState('10, 11, 9, 12, 14, 15, 13, 12, 11, 13, 16, 17, 15, 14, 12')
  const [tmax, setTmax] = useState('24, 25, 23, 26, 28, 29, 27, 26, 25, 27, 30, 31, 29, 28, 26')
  const [base, setBase] = useState(10)
  const [upper, setUpper] = useState(30)
  const [method, setMethod] = useState('average')
  const [crop, setCrop] = useState('maize')
  const [stageDays, setStageDays] = useState('')
  const [result, setResult] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      setResult(
        await api.thermalTime({
          tmin: parseSeries(tmin),
          tmax: parseSeries(tmax),
          base_c: Number(base),
          upper_c: upper === '' ? null : Number(upper),
          method,
          crop,
          stage_days: stageDays.trim() ? parseSeries(stageDays) : null,
        }),
      )
    } catch (caught) {
      setError(caught.message)
    } finally {
      setBusy(false)
    }
  }

  const phenology = result?.phenology
  const cumulative = useMemo(() => {
    if (!result?.cumulative) return []
    return result.cumulative
  }, [result])

  return (
    <div className="grid sidebar-left">
      <Panel title="Daily temperatures" hint="Tmin and Tmax per day, in °C">
        <label className="field">
          Tmin series
          <textarea rows={3} value={tmin} onChange={(event) => setTmin(event.target.value)} />
        </label>
        <label className="field">
          Tmax series
          <textarea rows={3} value={tmax} onChange={(event) => setTmax(event.target.value)} />
        </label>
        <div className="grid cols-2">
          <label className="field">
            Base temperature (°C)
            <input type="number" step="0.5" value={base} onChange={(event) => setBase(event.target.value)} />
          </label>
          <label className="field">
            Cut-out ceiling (°C)
            <input type="number" step="0.5" placeholder="none" value={upper} onChange={(event) => setUpper(event.target.value)} />
          </label>
        </div>
        <div className="grid cols-2">
          <label className="field">
            Method
            <select value={method} onChange={(event) => setMethod(event.target.value)}>
              <option value="average">Average (Tmax + Tmin) / 2</option>
              <option value="modified">Modified (upper/lower cut-out)</option>
              <option value="sine">Sine (Parton & Logan)</option>
            </select>
          </label>
          <label className="field">
            Crop
            <select value={crop} onChange={(event) => setCrop(event.target.value)}>
              {crops.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="field">
          Local stage lengths (optional, days — blank uses the crop default)
          <input type="text" placeholder="30, 40, 50, 30" value={stageDays} onChange={(event) => setStageDays(event.target.value)} />
        </label>
        <button className="primary" onClick={submit} disabled={busy}>
          {busy ? 'Accumulating…' : 'Accumulate thermal time'}
        </button>
        <Warnings items={result?.warnings} />
      </Panel>

      <div className="stack">
        {result ? (
          <>
            <div className="grid cols-3">
              <StatCard label="Cumulative GDD" value={Number(result.total).toFixed(0)} foot={`${result.days} days · base ${result.base_c} °C`} tone="accent" />
              <StatCard label="Crop stage" value={phenology?.stage?.replace(/_/g, ' ') || '—'} foot={`${phenology?.season_progress_pct ?? '—'}% of the season`} />
              <StatCard label="To next stage" value={phenology?.days_to_next_stage_gdd !== null && phenology?.days_to_next_stage_gdd !== undefined ? `${Number(phenology.days_to_next_stage_gdd).toFixed(0)}` : 'mature'} unit={phenology?.days_to_next_stage_gdd === null ? '' : ' GDD'} foot={result.swapped_ranges ? `${result.swapped_ranges} day(s) had Tmax < Tmin and were swapped` : 'ranges were consistent'} />
            </div>
            <Panel title="Cumulative growing degree days" hint={result.method_note}>
              <CumulativeChart values={cumulative} label="Cumulative GDD" unit="°Cd" />
            </Panel>
            <div className="grid sidebar-right">
              <Panel title="Phenology" hint={phenology?.caveat}>
                <KeyValue
                  rows={[
                    ['Crop', phenology?.crop],
                    ['Maturity GDD used', phenology?.maturity_gdd],
                    ['Stage index', phenology?.stage_index],
                    ['Stage progress', phenology?.stage_progress_pct !== undefined ? `${phenology.stage_progress_pct}%` : null],
                    ['Stage boundaries (GDD)', (phenology?.stages_gdd || []).join(' → ')],
                  ]}
                />
              </Panel>
              <Panel title="Daily GDD" hint="One row per day">
                <DataTable
                  columns={[
                    { key: 'day', label: 'Day' },
                    { key: 'gdd', label: 'GDD' },
                    { key: 'cumulative', label: 'Cumulative' },
                  ]}
                  rows={(result.daily || []).map((value, index) => ({ day: index + 1, gdd: Number(value).toFixed(1), cumulative: Number(cumulative[index]).toFixed(1) }))}
                  numericFrom={2}
                />
              </Panel>
            </div>
          </>
        ) : (
          <Panel title="Thermal time">
            <Empty title="No accumulation yet">
              Feed a daily temperature series to get growing degree days, the current phenological stage, and how many GDD
              remain before the next stage. Swap in local stage lengths when you have them — the defaults are FAO
              indicatives, not local calibrations.
            </Empty>
          </Panel>
        )}
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* water balance                                                              */
/* -------------------------------------------------------------------------- */
function WaterTab({ crops, soils }) {
  const [et0, setEt0] = useState('6, 6.5, 7, 6, 5.5, 6, 7.5, 8, 7, 6, 5, 4.5, 5, 6, 7')
  const [rain, setRain] = useState('0, 0, 12, 0, 0, 0, 0, 0, 25, 0, 0, 0, 0, 0, 0')
  const [crop, setCrop] = useState('maize')
  const [soil, setSoil] = useState('loam')
  const [rootDepth, setRootDepth] = useState(1.0)
  const [trigger, setTrigger] = useState(55)
  const [efficiency, setEfficiency] = useState(0.75)
  const [result, setResult] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      setResult(
        await api.waterBalance({
          et0: parseSeries(et0),
          rainfall: parseSeries(rain),
          crop,
          soil,
          root_depth_m: Number(rootDepth),
          depletion_trigger_pct: Number(trigger),
          irrigation_efficiency: Number(efficiency),
        }),
      )
    } catch (caught) {
      setError(caught.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid sidebar-left">
      <Panel title="Weather and soil" hint="Daily reference ET and rainfall, in mm">
        <label className="field">
          ET₀ series
          <textarea rows={2} value={et0} onChange={(event) => setEt0(event.target.value)} />
        </label>
        <label className="field">
          Rainfall series
          <textarea rows={2} value={rain} onChange={(event) => setRain(event.target.value)} />
        </label>
        <div className="grid cols-2">
          <label className="field">
            Crop
            <select value={crop} onChange={(event) => setCrop(event.target.value)}>
              {crops.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Soil texture
            <select value={soil} onChange={(event) => setSoil(event.target.value)}>
              {soils.map((name) => (
                <option key={name} value={name}>
                  {name.replace(/_/g, ' ')}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="grid cols-3">
          <label className="field">
            Root depth (m)
            <input type="number" step="0.1" min="0.1" max="3" value={rootDepth} onChange={(event) => setRootDepth(event.target.value)} />
          </label>
          <label className="field">
            Irrigate at (% depletion)
            <input type="number" step="5" min="10" max="90" value={trigger} onChange={(event) => setTrigger(event.target.value)} />
          </label>
          <label className="field">
            Efficiency
            <input type="number" step="0.05" min="0.2" max="1" value={efficiency} onChange={(event) => setEfficiency(event.target.value)} />
          </label>
        </div>
        <button className="primary" onClick={submit} disabled={busy}>
          {busy ? 'Balancing…' : 'Run water balance'}
        </button>
      </Panel>

      <div className="stack">
        {result ? (
          <>
            <div className="grid cols-4">
              <StatCard label="Irrigation required" value={Number(result.irrigation_total_mm).toFixed(0)} unit="mm" foot={`${result.event_count} application(s)`} tone="accent" />
              <StatCard label="Crop water use" value={Number(result.etc_total_mm).toFixed(0)} unit="mm" foot={`${result.days} days of ETc`} />
              <StatCard label="Effective rain" value={Number(result.effective_rain_total_mm).toFixed(0)} unit="mm" foot={`${Number(result.rainfall_total_mm).toFixed(0)} mm fell`} />
              <StatCard label="Stress days" value={`${result.stress_days}`} foot={`${result.stress_days_pct}% of the period below the trigger`} tone={result.stress_days > 0 ? 'warn' : 'green'} />
            </div>
            <Panel title="Root-zone water balance" hint={`TAW ${result.taw_mm} mm · RAW ${result.raw_mm} mm · ${result.kc_source}`}>
              <WaterBalanceChart daily={result.daily} />
              <div className="legend-scale">
                <span>■ ETc</span>
                <span>■ Depletion</span>
                <span>■ Irrigation</span>
                <span>■ Effective rain</span>
              </div>
            </Panel>
            <div className="grid sidebar-right">
              <Panel title="Plan" hint={result.verdict}>
                <DataTable
                  columns={[
                    { key: 'day', label: 'Day' },
                    { key: 'irrigation_mm', label: 'mm' },
                    { key: 'deficit_pct', label: 'Deficit %' },
                    { key: 'ks', label: 'Ks' },
                  ]}
                  rows={(result.daily || [])
                    .map((row, index) => ({ id: index, ...row }))
                    .filter((row) => Number(row.irrigation_mm) > 0)
                    .map((row) => ({ day: row.day_index + 1, irrigation_mm: Number(row.irrigation_mm).toFixed(1), deficit_pct: Number(row.deficit_pct).toFixed(1), ks: Number(row.ks).toFixed(2) }))}
                  numericFrom={3}
                  emptyLabel="No irrigation was needed under this trigger."
                />
              </Panel>
              <Panel title="Balance details">
                <KeyValue
                  rows={[
                    ['Soil', result.soil],
                    ['Root depth', `${result.root_depth_m} m`],
                    ['TAW / RAW', `${result.taw_mm} / ${result.raw_mm} mm`],
                    ['Kc source', result.kc_source],
                    ['Depletion trigger', `${result.coefficients_used?.depletion_trigger_pct}%`],
                    ['Irrigation efficiency', result.coefficients_used?.irrigation_efficiency],
                  ]}
                />
              </Panel>
            </div>
            <Warnings items={result.caveats} title="Caveats — read before acting" />
          </>
        ) : (
          <Panel title="Water balance">
            <Empty title="No balance yet">
              This is an FAO-56 single-Kc daily balance of the root zone: it answers “would this field have run short of
              water, and when should I have irrigated?”. It describes soil water, not plant stress — confirm a decision
              with a probe before you move water.
            </Empty>
          </Panel>
        )}
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* management zones -> prescription                                           */
/* -------------------------------------------------------------------------- */
function ZonesTab({ datasets, aois, indices, crops }) {
  const rasters = datasets.filter((entry) => entry.type === 'raster')
  const [dataset, setDataset] = useState('')
  const [aoi, setAoi] = useState('')
  const [index, setIndex] = useState('NDVI')
  const [zones, setZones] = useState(3)
  const [spatialWeight, setSpatialWeight] = useState(0.35)
  const [result, setResult] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  // prescription stage
  const [product, setProduct] = useState('nitrogen')
  const [baseRate, setBaseRate] = useState(150)
  const [target, setTarget] = useState(0.6)
  const [rateUnit, setRateUnit] = useState('kg/ha')
  const [plan, setPlan] = useState(null)

  const activeDataset = dataset || rasters[0]?.name || ''

  const submit = async () => {
    setBusy(true)
    setError(null)
    setPlan(null)
    try {
      setResult(
        await api.zones({
          dataset: activeDataset,
          aoi: aoi || null,
          index,
          n_zones: Number(zones),
          spatial_weight: Number(spatialWeight),
        }),
      )
    } catch (caught) {
      setError(caught.message)
      setResult(null)
    } finally {
      setBusy(false)
    }
  }

  const buildPlan = async () => {
    setBusy(true)
    setError(null)
    try {
      setPlan(
        await api.prescription({
          zones: (result?.zones || []).map((zone) => ({ zone: zone.zone, name: zone.name, index_mean: zone.index_mean, share_pct: zone.share_pct })),
          product,
          base_rate: Number(baseRate),
          target_index: Number(target),
          rate_unit: rateUnit,
        }),
      )
    } catch (caught) {
      setError(caught.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="grid sidebar-left">
        <Panel title="Zone the field" hint="Contiguous zones from an index raster">
          <label className="field">
            Raster dataset
            <select value={activeDataset} onChange={(event) => setDataset(event.target.value)}>
              {rasters.length === 0 ? <option value="">no rasters found</option> : null}
              {rasters.map((entry) => (
                <option key={entry.name} value={entry.name}>
                  {entry.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Boundary (optional)
            <select value={aoi} onChange={(event) => setAoi(event.target.value)}>
              <option value="">whole raster</option>
              {aois.map((entry) => (
                <option key={entry.name || entry} value={entry.name || entry}>
                  {entry.name || entry}
                </option>
              ))}
            </select>
          </label>
          <div className="grid cols-2">
            <label className="field">
              Index
              <select value={index} onChange={(event) => setIndex(event.target.value)}>
                {indices.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Zones
              <input type="number" min="2" max="8" value={zones} onChange={(event) => setZones(event.target.value)} />
            </label>
          </div>
          <label className="field">
            Spatial weighting ({spatialWeight})
            <input type="range" min="0" max="2" step="0.05" value={spatialWeight} onChange={(event) => setSpatialWeight(event.target.value)} />
            <span className="hint">0 clusters on the index alone (purely agronomic), 2 forces compact, machine-friendly blocks.</span>
          </label>
          <button className="primary" onClick={submit} disabled={busy || !activeDataset}>
            {busy ? 'Zoning…' : 'Build management zones'}
          </button>
        </Panel>

        <div className="stack">
          {result?.verdict === 'ok' ? (
            <>
              <div className="grid cols-4">
                <StatCard label="Zones" value={(result.zones || []).length} foot={`k-means on ${index}`} tone="accent" />
                <StatCard label="Separation" value={result.separation || '—'} foot={`index spread ${result.index_spread !== undefined ? Number(result.index_spread).toFixed(3) : '—'}`} tone={result.separation === 'strong' ? 'green' : result.separation === 'weak' ? 'warn' : ''} />
                <StatCard label="Pixels clustered" value={result.pixels_sampled ?? '—'} foot={result.pixel_area_ha ? `${Number(result.pixel_area_ha).toFixed(4)} ha per pixel` : ''} />
                <StatCard label="Spatial weight" value={result.spatial_weight ?? spatialWeight} foot={`stride ${result.stride ?? 1}`} />
              </div>
              <Panel title="Zones" hint="Ordered weakest to strongest — this order is what the prescription consumes">
                <DataTable
                  columns={[
                    { key: 'name', label: 'Zone' },
                    { key: 'index_mean', label: `${index} mean`, render: (value) => Number(value).toFixed(4) },
                    { key: 'share_pct', label: 'Area %', render: (value) => `${Number(value).toFixed(1)}%` },
                    { key: 'pixels', label: 'Pixels' },
                    { key: 'area_ha', label: 'Area (ha)', render: (value) => (value === null || value === undefined ? '—' : Number(value).toFixed(2)) },
                  ]}
                  rows={result.zones}
                  numericFrom={3}
                />
              </Panel>
              <Warnings items={result.caveats} title="Caveats — read before acting" />
              <Warnings items={result.warnings} title="Raster warnings" />
            </>
          ) : null}
          {result && result.verdict !== 'ok' ? (
            <Panel title="Zoning">
              <Empty title={result.verdict || 'No zones'}>
                {result.message || result.reason || 'The engine did not return usable zones — check the warnings for the reason.'}
              </Empty>
              <Warnings items={result.warnings} />
            </Panel>
          ) : null}
          {!result && !busy ? (
            <Panel title="Management zones">
              <Empty title="Nothing zoned yet">
                Zone a field to turn a continuous index map into a small set of areas a machine can actually treat
                differently. Zones are ordered by index value, so zone 1 is always the weakest.
              </Empty>
            </Panel>
          ) : null}
        </div>
      </div>

      {result?.verdict === 'ok' ? (
        <div className="grid sidebar-left">
          <Panel title="Variable-rate prescription" hint="Turn those zones into a product plan">
            <div className="grid cols-2">
              <label className="field">
                Product
                <select value={product} onChange={(event) => setProduct(event.target.value)}>
                  <option value="nitrogen">Nitrogen</option>
                  <option value="phosphorus">Phosphorus</option>
                  <option value="potassium">Potassium</option>
                  <option value="seed">Seed</option>
                  <option value="lime">Lime</option>
                  <option value="fungicide">Fungicide</option>
                </select>
              </label>
              <label className="field">
                Rate unit
                <input type="text" value={rateUnit} onChange={(event) => setRateUnit(event.target.value)} />
              </label>
            </div>
            <div className="grid cols-2">
              <label className="field">
                Flat-rate baseline
                <input type="number" step="5" min="1" value={baseRate} onChange={(event) => setBaseRate(event.target.value)} />
                <span className="hint">What you apply today across the whole field. The plan is reported as a change from this.</span>
              </label>
              <label className="field">
                Target index
                <input type="number" step="0.01" min="-0.9" max="0.95" value={target} onChange={(event) => setTarget(event.target.value)} />
                <span className="hint">The index value you manage the whole field towards — usually the strong-zone average.</span>
              </label>
            </div>
            <button className="primary" onClick={buildPlan} disabled={busy}>
              {busy ? 'Building…' : 'Build prescription'}
            </button>
          </Panel>

          <div className="stack">
            {plan?.verdict === 'ok' ? (
              <>
                <div className="grid cols-4">
                  <StatCard label="Area-weighted rate" value={Number(plan.area_weighted_rate).toFixed(1)} unit={` ${plan.rate_unit}`} foot={`across ${(plan.rows || []).length} zones`} tone="accent" />
                  <StatCard
                    label="Versus flat rate"
                    value={plan.vs_flat_rate?.delta_pct !== undefined ? `${plan.vs_flat_rate.delta_pct > 0 ? '+' : ''}${Number(plan.vs_flat_rate.delta_pct).toFixed(1)}%` : '—'}
                    foot={`${Number(plan.vs_flat_rate?.prescribed_total_units ?? 0).toFixed(1)} vs ${Number(plan.vs_flat_rate?.baseline_total_units ?? 0).toFixed(1)} units`}
                    tone={plan.vs_flat_rate?.direction === 'reduce' ? 'green' : plan.vs_flat_rate?.direction === 'increase' ? 'warn' : ''}
                  />
                  <StatCard label="Clamp range" value={`${plan.clamp_range?.[0] ?? '—'}–${plan.clamp_range?.[1] ?? '—'}`} foot={`${plan.rows.filter((row) => row.clamped).length} row(s) clamped`} tone={plan.rows.some((row) => row.clamped) ? 'warn' : ''} />
                  <StatCard label="Response basis" value={plan.response_per_index ?? '—'} foot={`${plan.rate_unit} per index unit`} />
                </div>
                <Panel title="Prescription table" hint="What goes where — weakest zone gets the most product">
                  <DataTable
                    columns={[
                      { key: 'name', label: 'Zone' },
                      { key: 'index_mean', label: 'Index', render: (value) => (value === null || value === undefined ? '—' : Number(value).toFixed(3)) },
                      { key: 'deficit', label: 'Deficit', render: (value) => (value === null || value === undefined ? '—' : Number(value).toFixed(3)) },
                      { key: 'share_pct', label: 'Area %', render: (value) => `${Number(value).toFixed(1)}%` },
                      { key: 'rate', label: `Rate (${plan.rate_unit})`, render: (value) => Number(value).toFixed(1) },
                      { key: 'clamped', label: 'Clamped', render: (value) => (value ? 'yes' : 'no') },
                    ]}
                    rows={plan.rows}
                    numericFrom={3}
                  />
                </Panel>
                <Warnings items={plan.caveats} title="Caveats — read before acting" />
              </>
            ) : (
              <Panel title="Prescription">
                <Empty title="No plan yet">Set a product and a target index, then build the plan from the zones above.</Empty>
              </Panel>
            )}
          </div>
        </div>
      ) : null}
    </>
  )
}

/* -------------------------------------------------------------------------- */
/* soil carbon                                                                */
/* -------------------------------------------------------------------------- */
function CarbonTab({ crops }) {
  const [series, setSeries] = useState('0.35, 0.42, 0.51, 0.58, 0.61, 0.55, 0.48, 0.44, 0.52, 0.6, 0.66, 0.63')
  const [crop, setCrop] = useState('maize')
  const [tillage, setTillage] = useState('no_till')
  const [coverCrop, setCoverCrop] = useState(true)
  const [residue, setResidue] = useState(true)
  const [years, setYears] = useState(5)
  const [result, setResult] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      setResult(
        await api.carbon({
          index_values: parseSeries(series),
          crop,
          tillage,
          cover_crop: coverCrop,
          residue_retained: residue,
          years_in_practice: Number(years),
        }),
      )
    } catch (caught) {
      setError(caught.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid sidebar-left">
      <Panel title="Practice profile" hint="What has been done to this field">
        <label className="field">
          Seasonal index values
          <textarea rows={3} value={series} onChange={(event) => setSeries(event.target.value)} />
          <span className="hint">One value per observation; the canopy integral is what drives the estimate.</span>
        </label>
        <div className="grid cols-2">
          <label className="field">
            Crop
            <select value={crop} onChange={(event) => setCrop(event.target.value)}>
              {crops.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Tillage
            <select value={tillage} onChange={(event) => setTillage(event.target.value)}>
              {TILLAGE.map((name) => (
                <option key={name} value={name}>
                  {name.replace(/_/g, ' ')}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="toggle">
          <input type="checkbox" checked={coverCrop} onChange={(event) => setCoverCrop(event.target.checked)} /> cover crop in the rotation
        </label>
        <label className="toggle">
          <input type="checkbox" checked={residue} onChange={(event) => setResidue(event.target.checked)} /> residue retained
        </label>
        <label className="field">
          Years in practice
          <input type="number" step="1" min="0" max="50" value={years} onChange={(event) => setYears(event.target.value)} />
        </label>
        <button className="primary" onClick={submit} disabled={busy}>
          {busy ? 'Screening…' : 'Screen the practice'}
        </button>
      </Panel>

      <div className="stack">
        {result ? (
          <>
            <Notice tone="warn" title="Screening estimate — not MRV-grade">
              {result.verification?.grade}. Trajectory: <strong>{result.trajectory}</strong>.
              {result.verification?.uses_remote_observations
                ? ' Built from remote observations only — nothing here is soil-sampled.'
                : ''}
            </Notice>
            <div className="grid cols-3">
              <StatCard label="Annual rate" value={result.estimate_t_c_per_ha_per_year?.low !== undefined ? `${result.estimate_t_c_per_ha_per_year.low}–${result.estimate_t_c_per_ha_per_year.high}` : '—'} unit=" t C/ha/yr" foot={`central ${result.estimate_t_c_per_ha_per_year?.central ?? '—'} — a range, not a point value`} tone="accent" />
              <StatCard label="Cumulative" value={result.cumulative_t_c_per_ha?.central !== undefined ? Number(result.cumulative_t_c_per_ha.central).toFixed(2) : '—'} unit=" t C/ha" foot={result.cumulative_t_c_per_ha?.low !== undefined ? `${result.cumulative_t_c_per_ha.low}–${result.cumulative_t_c_per_ha.high} over ${result.years_in_practice} years` : ''} />
              <StatCard label="Practice score" value={result.practice_score} foot={`${result.trajectory} · saturation ${result.saturation_factor !== undefined ? Number(result.saturation_factor).toFixed(2) : '—'}`} tone="green" />
            </div>
            <Panel title="What the number is made of" hint="The practice weights behind the score, so you can argue with them">
              <DataTable
                columns={[
                  { key: 'practice', label: 'Practice' },
                  { key: 'weight', label: 'Weight', render: (value) => (value === null || value === undefined ? '—' : `${value > 0 ? '+' : ''}${Number(value).toFixed(2)}`) },
                ]}
                rows={result.contributions}
                numericFrom={1}
              />
            </Panel>
            <Panel title="What would make this verifiable" hint="Honest gap list">
              <ul className="bullet">
                {(result.verification?.missing_for_verification || []).map((item, position) => (
                  <li key={position}>{item}</li>
                ))}
              </ul>
            </Panel>
            <Warnings items={result.caveats} title="Caveats — read before acting" />
          </>
        ) : (
          <Panel title="Soil carbon">
            <Empty title="No screen yet">
              Describe the practice and the engine will screen the trajectory with an explicit range and a list of what is
              still missing before the number could be verified. It will not present this as a credit-ready figure.
            </Empty>
          </Panel>
        )}
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* yield                                                                      */
/* -------------------------------------------------------------------------- */
function YieldTab({ crops }) {
  const [series, setSeries] = useState('0.32, 0.48, 0.61, 0.72, 0.68, 0.55, 0.4')
  const [crop, setCrop] = useState('generic')
  const [coefficient, setCoefficient] = useState('')
  const [intercept, setIntercept] = useState(0)
  const [rmse, setRmse] = useState('')
  const [r2, setR2] = useState('')
  const [n, setN] = useState('')
  const [result, setResult] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      const calibration = rmse !== '' || r2 !== '' ? { rmse: rmse === '' ? null : Number(rmse), r_squared: r2 === '' ? null : Number(r2), n: n === '' ? null : Number(n) } : null
      setResult(
        await api.yieldForecast({
          index_series: parseSeries(series),
          crop,
          coefficient: coefficient === '' ? 0 : Number(coefficient),
          intercept: Number(intercept),
          calibration,
        }),
      )
    } catch (caught) {
      setError(caught.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid sidebar-left">
      <Panel title="Seasonal index integral" hint="One value per observation through the season">
        <label className="field">
          Index series
          <textarea rows={3} value={series} onChange={(event) => setSeries(event.target.value)} />
        </label>
        <label className="field">
          Crop
          <select value={crop} onChange={(event) => setCrop(event.target.value)}>
            <option value="generic">generic</option>
            {crops.filter((name) => name !== 'generic').map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <div className="grid cols-2">
          <label className="field">
            Fitted slope
            <input type="number" step="0.1" placeholder="leave blank if uncalibrated" value={coefficient} onChange={(event) => setCoefficient(event.target.value)} />
          </label>
          <label className="field">
            Intercept
            <input type="number" step="0.1" value={intercept} onChange={(event) => setIntercept(event.target.value)} />
          </label>
        </div>
        <div className="grid cols-3">
          <label className="field">
            RMSE
            <input type="number" step="0.1" placeholder="—" value={rmse} onChange={(event) => setRmse(event.target.value)} />
          </label>
          <label className="field">
            r²
            <input type="number" step="0.01" max="1" placeholder="—" value={r2} onChange={(event) => setR2(event.target.value)} />
          </label>
          <label className="field">
            n
            <input type="number" step="1" placeholder="—" value={n} onChange={(event) => setN(event.target.value)} />
          </label>
        </div>
        <button className="primary" onClick={submit} disabled={busy}>
          {busy ? 'Estimating…' : 'Estimate yield'}
        </button>
      </Panel>

      <div className="stack">
        {result ? (
          result.verdict === 'ok' ? (
            <>
              <div className="grid cols-3">
                <StatCard label="Estimate" value={Number(result.estimate).toFixed(2)} unit=" t/ha" foot={`range ${Number(result.uncertainty.low).toFixed(2)}–${Number(result.uncertainty.high).toFixed(2)}`} tone="accent" />
                <StatCard label="Index integral" value={Number(result.index_integral).toFixed(3)} foot={`mean ${Number(result.index_mean).toFixed(3)} · peak ${Number(result.index_peak).toFixed(3)}`} />
                <StatCard label="Uncertainty basis" value={result.uncertainty.basis} foot={result.uncertainty.r_squared !== null && result.uncertainty.r_squared !== undefined ? `r² ${result.uncertainty.r_squared} · n ${result.uncertainty.n}` : 'no calibration supplied'} />
              </div>
              <Warnings items={result.caveats} title="Caveats — read before acting" />
            </>
          ) : (
            <>
              <Notice tone="warn" title="Calibration required">
                {result.message || 'This model cannot produce a tonnage without local calibration, and it will not guess one.'}
              </Notice>
              <Panel title="How to calibrate it">
                <ul className="bullet">
                  {(result.how_to_calibrate || []).map((item, index) => (
                    <li key={index}>{item}</li>
                  ))}
                </ul>
              </Panel>
            </>
          )
        ) : (
          <Panel title="Yield">
            <Empty title="No estimate yet">
              The model is an empirical index-integral regression. Without your own fitted slope it returns the
              calibration recipe rather than a number — that refusal is the feature.
            </Empty>
          </Panel>
        )}
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* disease risk                                                               */
/* -------------------------------------------------------------------------- */
function DiseaseTab({ crops }) {
  const [tmin, setTmin] = useState('11, 12, 10, 11, 13, 12, 11')
  const [tmax, setTmax] = useState('17, 18, 16, 17, 19, 18, 17')
  const [humidity, setHumidity] = useState('95, 92, 88, 90, 96, 94, 89')
  const [rain, setRain] = useState('3, 1, 0, 2, 4, 1, 0')
  const [crop, setCrop] = useState('wheat')
  const [result, setResult] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      setResult(
        await api.diseaseRisk({
          tmin: parseSeries(tmin),
          tmax: parseSeries(tmax),
          humidity: parseSeries(humidity),
          rainfall: parseSeries(rain),
          crop,
        }),
      )
    } catch (caught) {
      setError(caught.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid sidebar-left">
      <Panel title="Weather window" hint="Per-day values for the period you are assessing">
        <label className="field">
          Tmin series
          <textarea rows={2} value={tmin} onChange={(event) => setTmin(event.target.value)} />
        </label>
        <label className="field">
          Tmax series
          <textarea rows={2} value={tmax} onChange={(event) => setTmax(event.target.value)} />
        </label>
        <label className="field">
          Relative humidity (%)
          <textarea rows={2} value={humidity} onChange={(event) => setHumidity(event.target.value)} />
        </label>
        <label className="field">
          Rainfall (mm, optional)
          <textarea rows={2} value={rain} onChange={(event) => setRain(event.target.value)} />
        </label>
        <label className="field">
          Crop
          <select value={crop} onChange={(event) => setCrop(event.target.value)}>
            {crops.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <button className="primary" onClick={submit} disabled={busy}>
          {busy ? 'Scoring…' : 'Score disease risk'}
        </button>
      </Panel>

      <div className="stack">
        {result ? (
          <>
            <Notice tone={result.highest_level === 'high' ? 'danger' : result.highest_level === 'moderate' ? 'warn' : 'info'} title={`Highest favourability: ${result.highest_level}`}>
              {result.verdict}. {result.next_action}
            </Notice>
            <Panel title="Disease favourability" hint={`${result.days} day window · ranked highest first`}>
              <DataTable
                columns={[
                  { key: 'disease', label: 'Disease' },
                  { key: 'pathogen', label: 'Pathogen' },
                  { key: 'favourability_index', label: 'Index', render: (value) => Number(value).toFixed(2) },
                  { key: 'level', label: 'Level' },
                  { key: 'favourable_days', label: 'Days' },
                  { key: 'favourable_share_pct', label: 'Share %', render: (value) => `${Number(value).toFixed(0)}%` },
                  { key: 'longest_favourable_run_days', label: 'Longest run' },
                ]}
                rows={result.diseases}
                numericFrom={4}
              />
            </Panel>
            <Panel title="Rules applied" hint="Why each disease scored what it did — no hidden weights">
              {result.diseases.map((entry) => (
                <Collapsible key={entry.disease} title={`${entry.disease} — ${entry.rule?.temp_range_c?.[0]}–${entry.rule?.temp_range_c?.[1]} °C, ${entry.rule?.wetness_basis}`}>
                  <KeyValue rows={Object.entries(entry.rule || {}).map(([key, value]) => [key.replace(/_/g, ' '), Array.isArray(value) ? value.join(' – ') : String(value)])} />
                </Collapsible>
              ))}
            </Panel>
            <Warnings items={result.caveats} title="Caveats — read before acting" />
          </>
        ) : (
          <Panel title="Disease risk">
            <Empty title="Not scored yet">
              This is a weather-driven favourability index for the main foliar diseases of the chosen crop. It is an
              early-warning signal, not a diagnosis — the engine says so on every response.
            </Empty>
          </Panel>
        )}
      </div>
    </div>
  )
}
