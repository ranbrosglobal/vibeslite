import { useEffect, useMemo, useState } from 'react'
import { Badge, Panel } from '../components/Panel'
import DroneScene, { PIP } from '../components/DroneScene'

const DRONES = [
  { id: 'D-01', role: 'Survey · spray' },
  { id: 'D-02', role: 'Survey · spray' },
  { id: 'D-03', role: 'Canopy relief' },
]

const ROBOTS = [
  { id: 'R-01', task: 'Irrigating zone 4', state: 'treating' },
  { id: 'R-02', task: 'En route · 240 m', state: 'moving' },
  { id: 'R-03', task: 'Foliar feed · zone 7', state: 'moving' },
]

const CAMERAS = [
  { id: 'C-01', at: 'North-west', value: '0.58' },
  { id: 'C-02', at: 'North-east', value: '0.63' },
  { id: 'C-03', at: 'South-east', value: '0.61' },
  { id: 'C-04', at: 'South-west', value: '0.52' },
]

const STAGES = [
  { name: 'Sense', detail: '7 cameras · 12 Hz', ms: '5 s' },
  { name: 'Ingest', detail: 'AWS IoT core', ms: '12 ms' },
  { name: 'Compare', detail: 'against baseline', ms: '38 ms' },
  { name: 'Dispatch', detail: '2 commands out', ms: '9 ms' },
]

const BASELINE = [
  ['Surveyed', '13 Oct 2026 · 06:41'],
  ['Points', '412,880'],
  ['Area', '208.8 ha'],
  ['Drift zones', '3 of 11'],
]

const READOUTS = [
  { label: 'Soil moisture', value: '−30', unit: '%', tone: 'down' },
  { label: 'Canopy NDVI', value: '0.61', unit: '', tone: '' },
  { label: 'Canopy temp', value: '+1.2', unit: '°C', tone: 'down' },
  { label: 'Link', value: '12', unit: 'ms', tone: '' },
]

function useTick() {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), 1400)
    return () => clearInterval(timer)
  }, [])
  return tick
}

export default function DroneOps() {
  const [focus, setFocus] = useState({ kind: 'drone', index: 0 })
  const [spraying, setSpraying] = useState(true)
  const [mode, setMode] = useState('drone')
  const tick = useTick()

  const mission = Math.min(0.97, 0.43 + tick * 0.0011)
  const focusedId = useMemo(() => {
    if (focus.kind === 'drone') return DRONES[focus.index]?.id
    if (focus.kind === 'robot') return ROBOTS[focus.index]?.id
    return CAMERAS[focus.index]?.id
  }, [focus])

  const select = (kind, index) => setFocus({ kind, index })

  return (
    <>
      <section className="flight-stage" aria-label="Live field autonomy">
        <DroneScene focus={focus} spraying={spraying} mode={mode} speed={1} onFocus={setFocus} />

        <div className="flight-overlay">
          <div className="flight-top">
            <div className="flight-tag">
              <span className="flight-dot" aria-hidden="true" />
              Baseline locked
              <em>sim</em>
            </div>
            <dl className="flight-readouts">
              {READOUTS.map((item) => (
                <div key={item.label}>
                  <dt>{item.label}</dt>
                  <dd className={item.tone}>
                    {item.value}
                    {item.unit ? <i>{item.unit}</i> : null}
                  </dd>
                </div>
              ))}
            </dl>
          </div>

          <div className="flight-bottom">
            <div className="flight-fleet" role="tablist" aria-label="Field agents">
              {DRONES.map((unit, index) => (
                <button
                  key={unit.id}
                  type="button"
                  role="tab"
                  aria-selected={focus.kind === 'drone' && focus.index === index}
                  className={`fleet-chip${focus.kind === 'drone' && focus.index === index ? ' on' : ''}`}
                  onClick={() => select('drone', index)}
                >
                  <span className="fleet-id">{unit.id}</span>
                  <span className="fleet-role">{unit.role}</span>
                </button>
              ))}
              {ROBOTS.map((unit, index) => (
                <button
                  key={unit.id}
                  type="button"
                  role="tab"
                  aria-selected={focus.kind === 'robot' && focus.index === index}
                  className={`fleet-chip robot${focus.kind === 'robot' && focus.index === index ? ' on' : ''}`}
                  onClick={() => select('robot', index)}
                >
                  <span className="fleet-id">{unit.id}</span>
                  <span className="fleet-role">{unit.state}</span>
                </button>
              ))}
            </div>
            <div className="flight-progress">
              <span className="flight-progress-label">Pass</span>
              <span className="flight-progress-track">
                <i style={{ width: `${mission * 100}%` }} />
              </span>
              <span className="flight-progress-value">{Math.round(mission * 100)}%</span>
            </div>
          </div>

          {mode === 'drone' ? (
            <div
              className="flight-pip"
              style={{ width: PIP.w, height: PIP.h, right: PIP.m, bottom: PIP.m }}
              aria-label={`Live camera feed from ${focusedId}`}
            >
              <span className="pip-label">{focusedId} · {focus.kind} cam</span>
              <span className="pip-reticle" aria-hidden="true" />
              <span className="pip-rec" aria-hidden="true" />
            </div>
          ) : null}
        </div>
      </section>

      <div className="pipeline" aria-label="Processing pipeline">
        {STAGES.map((stage, index) => (
          <div className="pipe" key={stage.name}>
            <span className="pipe-num">{String(index + 1).padStart(2, '0')}</span>
            <b>{stage.name}</b>
            <em>{stage.detail}</em>
            <span className="pipe-ms">{stage.ms}</span>
          </div>
        ))}
      </div>

      <div className="flight-bar">
        <div className="flight-actions">
          <button
            type="button"
            className={`flight-btn${spraying ? ' on' : ''}`}
            aria-pressed={spraying}
            onClick={() => setSpraying((value) => !value)}
          >
            {spraying ? 'Treatment on' : 'Treatment paused'}
          </button>
          <button
            type="button"
            className="flight-btn"
            onClick={() => setMode((value) => (value === 'drone' ? 'field' : 'drone'))}
          >
            {mode === 'drone' ? 'Hide agent cam' : 'Show agent cam'}
          </button>
        </div>
        <p className="flight-hint">Drag to orbit · scroll to zoom · click a drone, a robot or a camera pole to open its feed.</p>
      </div>

      <div className="drone-grid">
        <div className="drone-side">
          <Panel
            title="Agents in the field"
            hint="Three survey drones above, three ground robots acting on the drift zones"
            actions={<Badge tone="green">6 online</Badge>}
          >
            <div className="fleet-list">
              {DRONES.map((unit, index) => {
                const active = focus.kind === 'drone' && focus.index === index
                const battery = Math.max(24, 92 - tick * 0.05 - index * 4)
                const tank = Math.max(16, 68 - tick * 0.11 - index * 7)
                return (
                  <button
                    key={unit.id}
                    type="button"
                    className={`fleet-row${active ? ' on' : ''}`}
                    onClick={() => select('drone', index)}
                  >
                    <span className="fleet-swatch drone" aria-hidden="true" />
                    <span className="fleet-name">
                      <b>{unit.id}</b>
                      <em>{unit.role}</em>
                    </span>
                    <span className="fleet-stat">
                      <em>Tank</em>
                      <b>{Math.round(tank)}%</b>
                    </span>
                    <span className="fleet-stat">
                      <em>Battery</em>
                      <b>{Math.round(battery)}%</b>
                    </span>
                    <span className="fleet-stat">
                      <em>Alt</em>
                      <b>{(7.2 + index * 1.15).toFixed(1)} m</b>
                    </span>
                    <span className={`fleet-state${active ? ' live' : ''}`}>{active ? 'on pass' : 'surveying'}</span>
                  </button>
                )
              })}
              {ROBOTS.map((unit, index) => {
                const active = focus.kind === 'robot' && focus.index === index
                return (
                  <button
                    key={unit.id}
                    type="button"
                    className={`fleet-row${active ? ' on' : ''}`}
                    onClick={() => select('robot', index)}
                  >
                    <span className="fleet-swatch robot" aria-hidden="true" />
                    <span className="fleet-name">
                      <b>{unit.id}</b>
                      <em>{unit.task}</em>
                    </span>
                    <span className="fleet-stat">
                      <em>Tank</em>
                      <b>{[62, 48, 74][index]}%</b>
                    </span>
                    <span className="fleet-stat">
                      <em>Battery</em>
                      <b>{[71, 58, 66][index]}%</b>
                    </span>
                    <span className="fleet-stat">
                      <em>Speed</em>
                      <b>{unit.state === 'treating' ? '0.0' : '1.4'} m/s</b>
                    </span>
                    <span className={`fleet-state${active ? ' live' : ''}`}>{unit.state}</span>
                  </button>
                )
              })}
            </div>
            <p className="fleet-note">
              Each robot receives the coordinate of a zone that drifted from the baseline, drives to it and works only that
              patch — water, foliar feed or a bio-fungicide, chosen from what the comparison says is wrong.
            </p>
          </Panel>
        </div>

        <div className="drone-side">
          <Panel title="Baseline" hint="The first survey is the permanent reference" actions={<Badge tone="teal">locked</Badge>}>
            <dl className="baseline">
              {BASELINE.map(([term, value]) => (
                <div key={term}>
                  <dt>{term}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
            <p className="cam-note">
              Every new reading is compared with this wheat survey — never with yesterday's. That is what makes a 30% moisture
              drop a measurement rather than an opinion.
            </p>
          </Panel>

          <Panel title="Depth cameras" hint="Four poles · canopy and soil, every five seconds" actions={<Badge tone="teal">12 Hz</Badge>}>
            <ul className="cam-list">
              {CAMERAS.map((unit, index) => (
                <li key={unit.id} className={focus.kind === 'camera' && focus.index === index ? 'on' : ''}>
                  <button type="button" onClick={() => select('camera', index)}>
                    <span className="cam-id">{unit.id}</span>
                    <span className="cam-at">{unit.at}</span>
                    <span className="cam-value">NDVI {unit.value}</span>
                  </button>
                </li>
              ))}
            </ul>
            <p className="cam-note">Frames arrive continuously; only the readings and the 3D reconstruction are kept, never the video.</p>
          </Panel>

          <Panel title="Dispatch queue" hint="Commands written back to the robots" flush>
            <ul className="ledger">
              <li>
                <span className="ledger-time">now</span>
                <span className="ledger-zone">R-01 · zone 4</span>
                <span className="ledger-mix">Irrigate 6.2 mm · 1.8 ha</span>
              </li>
              <li>
                <span className="ledger-time">14:22</span>
                <span className="ledger-zone">R-03 · zone 7</span>
                <span className="ledger-mix">Foliar feed 12 l/ha</span>
              </li>
              <li>
                <span className="ledger-time">14:11</span>
                <span className="ledger-zone">D-02 · zone 9</span>
                <span className="ledger-mix">Bio-fungicide 3 l/ha</span>
              </li>
            </ul>
          </Panel>
        </div>
      </div>
    </>
  )
}
