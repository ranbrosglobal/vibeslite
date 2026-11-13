import { useEffect, useMemo, useState } from 'react'
import { Badge, Panel } from '../components/Panel'
import DroneScene, { PIP } from '../components/DroneScene'

const FLEET = [
  { id: 'D-01', role: 'Weak zones', tint: '#c8f24e' },
  { id: 'D-02', role: 'North strip', tint: '#7fe3b0' },
  { id: 'D-03', role: 'East block', tint: '#f2d24e' },
]

const LEDGER = [
  { at: '14:22', zone: 'Patch 04 · 2.6 ha', mix: 'Foliar feed 12 L/ha' },
  { at: '14:11', zone: 'Patch 07 · 1.9 ha', mix: 'Bio-fungicide 3 L/ha' },
  { at: '13:58', zone: 'Patch 02 · 3.4 ha', mix: 'Urea 8 % solution' },
  { at: '13:40', zone: 'Patch 09 · 1.2 ha', mix: 'Micronutrient 2 L/ha' },
]

function useMissionClock(running) {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!running) return undefined
    const timer = setInterval(() => setTick((value) => value + 1), 1400)
    return () => clearInterval(timer)
  }, [running])
  return tick
}

export default function DroneOps() {
  const [selected, setSelected] = useState(0)
  const [spraying, setSpraying] = useState(true)
  const [mode, setMode] = useState('drone')
  const tick = useMissionClock(true)

  const drone = FLEET[selected]
  const mission = Math.min(0.97, 0.43 + tick * 0.0011)

  const telemetry = useMemo(() => {
    const wave = Math.sin(tick / 3.2)
    return {
      altitude: (7.4 + selected * 0.9 + wave * 0.16).toFixed(1),
      speed: (8.4 + Math.sin(tick / 4.1) * 0.3).toFixed(1),
      flow: spraying ? (2.1 + Math.sin(tick / 2.3) * 0.07).toFixed(2) : '0.00',
      tank: spraying ? Math.max(16, 68 - tick * 0.11).toFixed(0) : '68',
      battery: Math.max(24, 92 - tick * 0.05).toFixed(0),
    }
  }, [tick, selected, spraying])

  return (
    <>
      <section className="flight-stage" aria-label="Live drone mission">
        <DroneScene selected={selected} spraying={spraying} mode={mode} speed={1} onPick={setSelected} />

        <div className="flight-overlay">
          <div className="flight-top">
            <div className="flight-tag">
              <span className="flight-dot" aria-hidden="true" />
              Mission live
              <em>sim</em>
            </div>
            <dl className="flight-readouts">
              <div>
                <dt>Altitude</dt>
                <dd>{telemetry.altitude}<i>m</i></dd>
              </div>
              <div>
                <dt>Ground speed</dt>
                <dd>{telemetry.speed}<i>m/s</i></dd>
              </div>
              <div>
                <dt>Flow</dt>
                <dd>{telemetry.flow}<i>l/min</i></dd>
              </div>
              <div>
                <dt>Tank</dt>
                <dd>{telemetry.tank}<i>%</i></dd>
              </div>
              <div>
                <dt>Battery</dt>
                <dd>{telemetry.battery}<i>%</i></dd>
              </div>
            </dl>
          </div>

          <div className="flight-bottom">
            <div className="flight-fleet" role="tablist" aria-label="Aircraft">
              {FLEET.map((unit, index) => (
                <button
                  key={unit.id}
                  type="button"
                  role="tab"
                  aria-selected={index === selected}
                  className={`fleet-chip${index === selected ? ' on' : ''}`}
                  onClick={() => setSelected(index)}
                >
                  <span className="fleet-id">{unit.id}</span>
                  <span className="fleet-role">{unit.role}</span>
                </button>
              ))}
            </div>
            <div className="flight-progress">
              <span className="flight-progress-label">Mission</span>
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
              aria-label={`Live camera feed from ${drone.id}`}
            >
              <span className="pip-label">{drone.id} · nose cam</span>
              <span className="pip-reticle" aria-hidden="true" />
              <span className="pip-rec" aria-hidden="true" />
            </div>
          ) : null}
        </div>
      </section>

      <div className="flight-bar">
        <div className="flight-actions">
          <button
            type="button"
            className={`flight-btn${spraying ? ' on' : ''}`}
            aria-pressed={spraying}
            onClick={() => setSpraying((value) => !value)}
          >
            {spraying ? 'Spray running' : 'Spray paused'}
          </button>
          <button
            type="button"
            className="flight-btn"
            onClick={() => setMode((value) => (value === 'drone' ? 'field' : 'drone'))}
          >
            {mode === 'drone' ? 'Hide nose cam' : 'Show nose cam'}
          </button>
        </div>
        <p className="flight-hint">Drag to orbit the field · scroll to zoom · click an aircraft or the field camera to read it.</p>
      </div>

      <div className="drone-grid">
        <Panel
          title="Flight plan"
          hint="Three aircraft working the eleven weak zones under manual supervision"
          actions={<Badge tone="green">in flight</Badge>}
        >
          <div className="fleet-list">
            {FLEET.map((unit, index) => {
              const active = index === selected
              const battery = Math.max(24, 92 - tick * 0.05 - index * 4)
              const tank = Math.max(16, 68 - tick * 0.11 - index * 7)
              return (
                <button
                  key={unit.id}
                  type="button"
                  className={`fleet-row${active ? ' on' : ''}`}
                  onClick={() => setSelected(index)}
                >
                  <span className="fleet-swatch" style={{ background: unit.tint }} aria-hidden="true" />
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
                    <em>Area</em>
                    <b>{[48, 39, 27][index]} ha</b>
                  </span>
                  <span className={`fleet-state${active ? ' live' : ''}`}>{active ? 'on pass' : 'in flight'}</span>
                </button>
              )
            })}
          </div>
          <p className="fleet-note">
            Spray is released only over the zones the crop scan marked as weak, so the aircraft fly narrow passes instead of
            blanketing the field. Tank mix and litres per hectare are logged against every pass.
          </p>
        </Panel>

        <div className="drone-side">
          <Panel title="Field camera" hint="East gate · 12 frames per second" actions={<Badge tone="teal">online</Badge>}>
            <dl className="cam-readings">
              <div>
                <dt>Canopy NDVI</dt>
                <dd>0.61</dd>
              </div>
              <div>
                <dt>Soil moisture</dt>
                <dd>24<i>%</i></dd>
              </div>
              <div>
                <dt>Leaf wetness</dt>
                <dd>18<i>min</i></dd>
              </div>
              <div>
                <dt>Air temp</dt>
                <dd>27.4<i>°C</i></dd>
              </div>
            </dl>
            <div className="cam-bars" aria-hidden="true">
              <span /> <span /> <span /> <span />
            </div>
            <p className="cam-note">Frames arrive continuously; the dashboard only keeps the readings, never the video.</p>
          </Panel>

          <Panel title="Spray ledger" hint="Today · logged automatically" flush>
            <ul className="ledger">
              {LEDGER.map((row) => (
                <li key={row.at}>
                  <span className="ledger-time">{row.at}</span>
                  <span className="ledger-zone">{row.zone}</span>
                  <span className="ledger-mix">{row.mix}</span>
                </li>
              ))}
            </ul>
          </Panel>
        </div>
      </div>
    </>
  )
}
