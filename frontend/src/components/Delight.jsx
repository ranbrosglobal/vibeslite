import { useEffect, useMemo, useRef, useState } from 'react'
import { Dial } from './Viz'

/* ── count-up ───────────────────────────────────────────────────────────── */

export function useCountUp(target, duration = 1100) {
  const [value, setValue] = useState(0)
  useEffect(() => {
    const to = Number(target) || 0
    // Background tabs pause requestAnimationFrame, so a plain rAF loop can
    // stall at zero forever. The timeout guarantees the final value lands.
    if (typeof requestAnimationFrame === 'undefined') {
      setValue(to)
      return undefined
    }
    let raf = 0
    let finished = false
    const start = performance.now()
    const step = (now) => {
      if (finished) return
      const progress = Math.min(1, (now - start) / duration)
      const eased = 1 - Math.pow(1 - progress, 3)
      setValue(to * eased)
      if (progress < 1) {
        raf = requestAnimationFrame(step)
      } else {
        finished = true
      }
    }
    raf = requestAnimationFrame(step)
    const fallback = setTimeout(() => {
      finished = true
      setValue(to)
    }, duration + 400)
    return () => {
      finished = true
      cancelAnimationFrame(raf)
      clearTimeout(fallback)
    }
  }, [target, duration])
  return value
}

/** Light a CSS transition shortly after mount, without relying on rAF. */
function useLit(deps) {
  const [lit, setLit] = useState(false)
  useEffect(() => {
    setLit(false)
    const timer = setTimeout(() => setLit(true), 80)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return lit
}

/* ── score ring: the headline number, alive ─────────────────────────────── */

/**
 * The headline number, read on a calibrated dial: hairline ticks, a needle,
 * and a lime arc that sweeps in. Rendered in the dark hero well, so the
 * colours are tuned for that surface.
 */
export function ScoreRing({ value, tone = 'good', suffix = '%', caption, inner }) {
  const wording = inner || caption || (tone === 'good' ? 'looking good' : tone === 'mixed' ? 'getting there' : 'needs care')
  return (
    <div className="score-ring-wrap">
      <Dial value={value} tone={tone} unit={suffix} caption={wording} />
    </div>
  )
}

/* ── field grade: a friendly report-card stamp ──────────────────────────── */

export function gradeFor(value) {
  if (value >= 85) return { mark: 'A', word: 'Thriving', tone: 'good' }
  if (value >= 70) return { mark: 'B', word: 'Healthy', tone: 'good' }
  if (value >= 55) return { mark: 'C', word: 'Uneven', tone: 'mixed' }
  if (value >= 40) return { mark: 'D', word: 'Patchy', tone: 'mixed' }
  return { mark: 'E', word: 'Struggling', tone: 'poor' }
}

export function GradeStamp({ value, label = 'Field grade' }) {
  const grade = gradeFor(value)
  return (
    <div className={`grade-stamp ${grade.tone}`} title={`${label}: ${grade.mark} — ${grade.word}`}>
      <span className="grade-mark">{grade.mark}</span>
      <span className="grade-word">{grade.word}</span>
    </div>
  )
}

/* ── fact deck: agronomy worth knowing, one card at a time ──────────────── */

export function FactDeck({ facts, title = 'Good to know', intervalMs = 9000 }) {
  const [index, setIndex] = useState(0)
  const [paused, setPaused] = useState(false)
  const count = facts.length
  useEffect(() => {
    if (paused || count <= 1) return undefined
    const timer = setInterval(() => setIndex((current) => (current + 1) % count), intervalMs)
    return () => clearInterval(timer)
  }, [paused, count, intervalMs])
  const fact = facts[index % count]
  return (
    <div
      className="fact-deck"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <div className="fact-eyebrow">{title}</div>
      <p key={index} className="fact-text route-enter">
        <span className="fact-glyph" aria-hidden="true">{fact.glyph}</span>
        {fact.text}
      </p>
      {count > 1 ? (
        <div className="fact-nav">
          <button className="small ghost" onClick={() => setIndex((index - 1 + count) % count)} aria-label="Previous fact">‹</button>
          <div className="fact-dots" role="tablist" aria-label="Facts">
            {facts.map((_, dot) => (
              <button
                key={dot}
                className={`fact-dot ${dot === index % count ? 'on' : ''}`}
                onClick={() => setIndex(dot)}
                aria-label={`Fact ${dot + 1}`}
              />
            ))}
          </div>
          <button className="small ghost" onClick={() => setIndex((index + 1) % count)} aria-label="Next fact">›</button>
        </div>
      ) : null}
    </div>
  )
}

export const CROP_FACTS = [
  { glyph: '🛰️', text: 'A healthy leaf reflects near-infrared light your eyes cannot see — that invisible glow is what the satellite reads.' },
  { glyph: '🐤', text: 'Weak patches are canaries: water stress and pests usually show at the edges days before they spread.' },
  { glyph: '🎯', text: 'Treating only the weak patch instead of the whole field can cut spray and fertiliser use sharply.' },
  { glyph: '🌂', text: 'Once canopy cover passes about 70%, the crop shades its own soil — cooler roots, slower evaporation.' },
  { glyph: '🔍', text: 'Compare a strong and a weak spot side by side: soil moisture and rooting depth usually explain the gap.' },
]

export const SOIL_FACTS = [
  { glyph: '🦠', text: 'A single handful of healthy soil holds more living organisms than there are people on Earth.' },
  { glyph: '🧥', text: 'Crop residue left on the surface is free mulch: it slows wind, traps rain and feeds soil life.' },
  { glyph: '💧', text: 'Each extra percent of organic matter can store tens of thousands more litres of water per hectare.' },
  { glyph: '⏳', text: 'Nature can take centuries to build a centimetre of topsoil — one bare, stormy season can wash it away.' },
  { glyph: '⚖️', text: 'Most crops feed best when soil pH sits between 6.0 and 7.5. Outside that, nutrients hide in plain sight.' },
]

/* ── walk list: the field visit, as a check-off ─────────────────────────── */

export function WalkList({ items, storageKey, title = 'This visit’s walk', hint = 'Tick tasks off as you walk the field' }) {
  const [done, setDone] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(storageKey) || '[]')
    } catch {
      return []
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(done))
    } catch {
      /* private mode — the list simply resets next visit */
    }
  }, [done, storageKey])
  // A new analysis replaces the list, so stale ticks never linger.
  useEffect(() => {
    setDone(() => {
      try {
        return JSON.parse(localStorage.getItem(storageKey) || '[]')
      } catch {
        return []
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey])

  const finished = items.length > 0 && done.length >= items.length
  const toggle = (id) => setDone((current) => (current.includes(id) ? current.filter((x) => x !== id) : [...current, id]))
  const pct = items.length ? Math.round((done.length / items.length) * 100) : 0

  return (
    <div className="walk">
      <div className="walk-progress">
        <div className="walk-bar" role="img" aria-label={`${pct}% of walk complete`}>
          <span style={{ width: `${pct}%` }} />
        </div>
        <span className="walk-count">{done.length}/{items.length} done</span>
      </div>
      <ul className="walk-list">
        {items.map((item) => {
          const checked = done.includes(item.id)
          return (
            <li key={item.id}>
              <button
                type="button"
                className={`walk-item ${checked ? 'done' : ''}`}
                onClick={() => toggle(item.id)}
                aria-pressed={checked}
              >
                <span className="walk-box" aria-hidden="true">{checked ? '✓' : ''}</span>
                <span className="walk-text">
                  <strong>{item.title}</strong>
                  {item.detail ? <span className="walk-detail">{item.detail}</span> : null}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
      {finished ? <div className="walk-party">Walk complete — nice work 🎉</div> : null}
      <div className="hint" style={{ marginTop: 6 }}>{hint}</div>
    </div>
  )
}

/* ── meters: animated bars for stats and savings ────────────────────────── */

export function Meter({ pct, tone = '', marker = 70, markerLabel = 'good cover' }) {
  const lit = useLit([pct])
  return (
    <div className="meter" role="img" aria-label={`${Math.round(pct)} percent`}>
      <div className={`meter-fill ${tone}`} style={{ width: lit ? `${Math.max(0, Math.min(100, pct))}%` : '0%' }} />
      <span className="meter-marker" style={{ left: `${marker}%` }} title={markerLabel} />
    </div>
  )
}

/** A savings-style meter centred on zero for the soil-carbon estimate. */
export function SavingsMeter({ low, high, central }) {
  const span = Math.max(Math.abs(low), Math.abs(high), 0.05)
  const toPct = (value) => ((value + span) / (2 * span)) * 100
  const left = Math.min(toPct(low), toPct(high))
  const width = Math.abs(toPct(high) - toPct(low))
  const lit = useLit([low, high])
  return (
    <div className="savings" role="img" aria-label={`Estimate from ${low} to ${high} tonnes of carbon per hectare per year`}>
      <div className="savings-track">
        <span className="savings-zero" />
        <span
          className={`savings-range ${central >= 0 ? 'up' : 'down'}`}
          style={{ left: lit ? `${left}%` : '50%', width: lit ? `${width}%` : '0%' }}
          title={`Likely range ${low} to ${high}`}
        />
        <span className="savings-pin" style={{ left: `${toPct(central)}%` }} title={`Central estimate ${central}`} />
      </div>
      <div className="savings-labels">
        <span>{Number(low).toFixed(2)}</span>
        <span className="savings-mid">0 = holding steady</span>
        <span>+{Number(high).toFixed(2)}</span>
      </div>
    </div>
  )
}

/* ── reveal: gentle entrance as you scroll ──────────────────────────────── */

export function Reveal({ children, delay = 0, className = '' }) {
  const ref = useRef(null)
  const [seen, setSeen] = useState(false)
  useEffect(() => {
    const node = ref.current
    if (!node) return undefined
    if (typeof IntersectionObserver === 'undefined') {
      setSeen(true)
      return undefined
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setSeen(true)
          observer.disconnect()
        }
      },
      { threshold: 0.08 },
    )
    observer.observe(node)
    // Fallback for environments where intersection never fires: reveal
    // anything already near the viewport after a short delay.
    const fallback = setTimeout(() => {
      const rect = node.getBoundingClientRect()
      if (rect.top < window.innerHeight * 0.92) setSeen(true)
    }, 2000)
    return () => {
      observer.disconnect()
      clearTimeout(fallback)
    }
  }, [])
  return (
    <div ref={ref} className={`reveal ${seen ? 'in' : ''} ${className}`} style={{ transitionDelay: `${delay}ms` }}>
      {children}
    </div>
  )
}

/* ── spot duel: the strongest vs the weakest, side by side ──────────────── */

export function SpotDuel({ strong, weak }) {
  const spots = useMemo(() => [strong, weak].filter(Boolean), [strong, weak])
  if (spots.length === 0) return null
  return (
    <div className="duel">
      {spots.map((spot, index) => (
        <div key={spot.key} className={`duel-card ${spot.tone}`}>
          <span className="duel-tag">{spot.tag}</span>
          <strong>{spot.title}</strong>
          <p>{spot.text}</p>
          {spot.meta ? <span className="duel-meta">{spot.meta}</span> : null}
          {index === 0 && spots.length > 1 ? <span className="duel-vs" aria-hidden="true">vs</span> : null}
        </div>
      ))}
    </div>
  )
}

/* ── field art: a sunny placeholder when no field is checked yet ────────── */

export function FieldArt() {
  return (
    <svg className="field-art" viewBox="0 0 220 150" role="img" aria-label="Illustration of a sunny field">
      <circle cx="172" cy="38" r="22" className="art-sun" />
      <path d="M0 96 Q55 78 110 94 T220 90 V150 H0 Z" className="art-hill far" />
      <path d="M0 112 Q70 98 130 110 T220 108 V150 H0 Z" className="art-hill near" />
      <g className="art-rows" strokeWidth="2">
        <path d="M20 150 Q60 122 96 118" />
        <path d="M70 150 Q104 126 136 122" />
        <path d="M120 150 Q148 128 176 124" />
      </g>
      <g className="art-sprout">
        <path d="M60 118 C60 106 60 98 60 92" />
        <path d="M60 102 C52 100 46 94 44 88 C52 88 58 92 60 102" />
        <path d="M60 98 C68 96 74 90 76 84 C68 84 62 88 60 98" />
      </g>
      <g className="art-sprout two">
        <path d="M150 116 C150 106 150 99 150 94" />
        <path d="M150 103 C143 101 138 96 136 91 C143 91 148 94 150 103" />
        <path d="M150 100 C157 98 162 93 164 88 C157 88 152 91 150 100" />
      </g>
    </svg>
  )
}
