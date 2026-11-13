import { useEffect, useRef, useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { api, useApi } from '../api'
import { TopoField } from './Viz'

const NAV = [
  { to: '/crop-health', num: '01', label: 'Crop', full: 'Crop health' },
  { to: '/soil-health', num: '02', label: 'Soil', full: 'Soil health' },
  { to: '/leaf-check', num: '03', label: 'Leaf', full: 'Leaf check' },
  { to: '/drone-ops', num: '04', label: 'Flight', full: 'Drone operations' },
]

const SECTIONS = {
  '/crop-health': {
    index: '01',
    eyebrow: 'Canopy',
    title: 'Crop health',
    subtitle: 'How evenly the crop is growing across the field, and where it needs a closer look.',
    source: 'Sentinel-2 · L2A',
    note: 'Vegetation vigour read from a single image',
  },
  '/soil-health': {
    index: '02',
    eyebrow: 'Ground cover',
    title: 'Soil health',
    subtitle: 'How much living cover protects the soil, and which direction your practices are taking it.',
    source: 'Cover index · practice model',
    note: 'Protection estimated from canopy cover',
  },
  '/leaf-check': {
    index: '03',
    eyebrow: 'Diagnosis',
    title: 'Leaf check',
    subtitle: 'One clear photo of one leaf, named in plain words — with the steps that actually help.',
    source: 'On-device · 29 classes',
    note: 'Runs in the browser · nothing is uploaded',
  },
  '/drone-ops': {
    index: '04',
    eyebrow: 'Flight ops',
    title: 'Drone operations',
    subtitle: 'Three spray aircraft working the weak zones, with a live camera in the field and a readout of every pass.',
    source: 'Field mesh · 12 Hz',
    note: 'Simulated mission · 3 aircraft',
  },
}

function useClock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(timer)
  }, [])
  return now
}

export default function Layout() {
  const location = useLocation()
  const health = useApi(api.health)
  const section = SECTIONS[location.pathname] || {
    index: '—',
    eyebrow: 'Field',
    title: 'Field health',
    subtitle: '',
    source: '—',
    note: '',
  }
  const online = Boolean(health.data) && !health.error
  const today = new Date().toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' })
  const now = useClock()
  const clock = now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })

  const [progress, setProgress] = useState(0)
  useEffect(() => {
    let frame = 0
    const onScroll = () => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        const max = document.documentElement.scrollHeight - window.innerHeight
        setProgress(max > 0 ? Math.min(1, window.scrollY / max) : 0)
        frame = 0
      })
    }
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      window.removeEventListener('scroll', onScroll)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [location.pathname])

  useEffect(() => {
    document.title = `${section.title} · Vibes Lite`
    window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' })
  }, [location.pathname, section.title])

  const contentRef = useRef(null)
  useEffect(() => {
    const el = contentRef.current
    if (!el) return
    el.classList.remove('route-enter')
    void el.offsetWidth
    el.classList.add('route-enter')
  }, [location.pathname])

  return (
    <div className="shell">
      <aside className="rail">
        <NavLink to="/crop-health" className="rail-mark" aria-label="Vibes Lite home">
          <span>V</span>
          <i>L</i>
        </NavLink>

        <nav className="rail-nav" aria-label="Sections">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              aria-label={item.full}
              className={({ isActive }) => `rail-link${isActive ? ' on' : ''}`}
            >
              <span className="rail-num">{item.num}</span>
              <span className="rail-word">{item.label}</span>
              <span className="rail-pip" aria-hidden="true" />
            </NavLink>
          ))}
        </nav>

        <div className="rail-foot">
          <span className={`rail-led${online ? ' on' : ''}`} aria-hidden="true" />
          <span className="rail-time">{clock}</span>
          <span className="rail-vert">Field telemetry</span>
        </div>
      </aside>

      <div className="workspace">
        <div className="command">
          <div className="command-crumb">
            <b>Vibes Lite</b>
            <span className="crumb-sep">/</span>
            <span className="crumb-here">{section.eyebrow}</span>
            <span className="crumb-meta">Field intelligence unit</span>
          </div>

          <div className="command-right">
            <span className="cmd-chip">
              <em>Source</em>
              {section.source}
            </span>
            <span className="cmd-chip hide-sm">
              <em>Session</em>
              {today}
            </span>
            <span className={`cmd-live${online ? ' on' : ''}`}>
              <i aria-hidden="true" />
              {online ? 'Live' : health.loading ? 'Linking' : 'Offline'}
            </span>
          </div>

          <span className="command-progress" style={{ transform: `scaleX(${progress})` }} aria-hidden="true" />
        </div>

        <main className="main" id="main-content">
          <header className="masthead">
            <div className="masthead-art" aria-hidden="true">
              <TopoField />
            </div>
            <div className="masthead-index" aria-hidden="true">{section.index}</div>
            <div className="masthead-body">
              <span className="eyebrow">
                <i aria-hidden="true" />
                {section.eyebrow} — {section.index}
              </span>
              <h1>
                {section.title}
                <span className="h1-mark" aria-hidden="true">.</span>
              </h1>
              <p className="masthead-sub">{section.subtitle}</p>
            </div>
            <dl className="masthead-meta">
              <div>
                <dt>Reading</dt>
                <dd>{section.note}</dd>
              </div>
              <div>
                <dt>Session</dt>
                <dd>{today}</dd>
              </div>
              <div>
                <dt>Link</dt>
                <dd className={online ? 'ok' : 'down'}>{online ? 'Live · 12 ms' : 'Down'}</dd>
              </div>
            </dl>
          </header>

          <div className="content" ref={contentRef}>
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  )
}
