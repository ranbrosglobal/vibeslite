import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Badge, Collapsible, Loading, Notice, Panel } from '../components/Panel'
import { FactDeck, GradeStamp, Reveal, ScoreRing } from '../components/Delight'
import { classifyLeaf, isHealthyClass, loadLeafModel, splitLabel } from '../model/leaf'

/**
 * Accuracy measured by `.dev/validate-leaf.mjs` on evenly spaced photos from
 * `image-dataset/Val` (five per class, never used for this measurement before).
 * Update both numbers if the model is retrained.
 */
const MEASURED = { correct: 142, total: 145 }

const CONFIDENT = 0.55
// Minimum similarity to the reference leaf photos. Below this the picture is
// not leaf-like enough for the softmax answer to mean anything.
const LEAF_SIMILARITY = 0.82

const SAMPLES = [
  { src: '/leaf-samples/tomato-early-blight.jpg', label: 'Tomato with brown rings' },
  { src: '/leaf-samples/corn-common-rust.jpg', label: 'Corn with rust spots' },
  { src: '/leaf-samples/grape-black-rot.jpg', label: 'Grape with black rot' },
  { src: '/leaf-samples/apple-healthy.jpg', label: 'A healthy apple leaf' },
]

const LEAF_FACTS = [
  { glyph: '🕵️', text: 'Most leaf diseases are named after what they do to the leaf: blight scorches, rust pustules, mildew powders.' },
  { glyph: '💧', text: 'Wet leaves are the single biggest invitation to fungal disease. Watering at the base beats watering from above.' },
  { glyph: '🌬️', text: 'Good airflow dries leaves faster than any spray — pruning and spacing are free disease control.' },
  { glyph: '🔁', text: 'The same disease returns to the same field. Rotating crops breaks the cycle without costing a rupee.' },
  { glyph: '🧪', text: 'A photo can name the likely disease, never the cause of a deficiency. Yellow leaves can mean water, pH or roots.' },
]

/**
 * Plain-language content for every class the model knows.
 * `what` = what the leaf shows, `steps` = three concrete actions, `urgency`
 * drives the colour and wording of the verdict.
 */
const GUIDE = {
  'Apple - Apple Scab': {
    urgency: 'watch',
    what: 'Olive-green to black velvety spots on the leaf, often with yellowing around them. Badly affected leaves drop early.',
    steps: [
      'Rake and remove fallen leaves — the fungus overwinters in them.',
      'Prune so light and air reach the middle of the tree.',
      'Water at the base and avoid wetting foliage in the evening.',
    ],
  },
  'Apple - Black Rot': {
    urgency: 'watch',
    what: 'Brown spots with soft rings that spread from the leaf edge, and dark, shrivelled fruit on the tree.',
    steps: [
      'Pick off and bin mummified fruit still hanging or on the ground.',
      'Cut out dead twigs and cankers while pruning.',
      'Keep the canopy open so leaves dry quickly after rain.',
    ],
  },
  'Apple - Cedar Apple Rust': {
    urgency: 'watch',
    what: 'Bright yellow-orange spots on the upper leaf surface, sometimes with small raised dots underneath.',
    steps: [
      'Look for cedar or juniper nearby and remove the orange galls on them.',
      'Protect new growth in spring, when infection happens.',
      'Keep the tree well fed and watered so it can outgrow mild infections.',
    ],
  },
  'Apple - Healthy': {
    urgency: 'mild',
    what: 'Even green colour, no spots, no curling. This is what a working apple leaf looks like.',
    steps: [
      'Keep scouting weekly, especially the lower and inner leaves.',
      'Keep pruning for airflow — it is the cheapest disease insurance.',
      'Check again after the next rain, when spots first appear.',
    ],
  },
  'Bell Pepper - Bacterial Spot': {
    urgency: 'act',
    what: 'Small water-soaked spots that turn brown with a yellow halo; several spots can merge into one dead patch.',
    steps: [
      'Remove and bin affected leaves — do not compost them.',
      'Stop overhead watering and stop handling plants while wet.',
      'Rotate away from peppers and tomatoes next season, and do not save seed from affected plants.',
    ],
  },
  'Bell Pepper - Healthy': {
    urgency: 'mild',
    what: 'Clean, even green leaf with no spots or yellow halos.',
    steps: [
      'Water at the base and keep the foliage dry.',
      'Scout the lower leaves weekly — that is where trouble starts.',
      'Keep weeds down around the plot so pests have fewer places to hide.',
    ],
  },
  'Cherry - Healthy': {
    urgency: 'mild',
    what: 'Smooth, evenly green leaf with clean edges.',
    steps: [
      'Check new growth weekly through the season.',
      'Prune in dry weather so cuts seal cleanly.',
      'Clear fallen leaves to deny next year’s fungi a home.',
    ],
  },
  'Cherry - Powdery Mildew': {
    urgency: 'watch',
    what: 'White, powdery patches that look like flour dusted on the leaf, often on shaded shoots.',
    steps: [
      'Remove the whitest shoots and bin them.',
      'Open up the canopy — mildew thrives in still, humid air.',
      'Ease off nitrogen, which pushes soft growth that mildew loves.',
    ],
  },
  'Corn (Maize) - Cercospora Leaf Spot': {
    urgency: 'watch',
    what: 'Long, narrow grey-tan lesions running between the veins, usually starting on lower leaves.',
    steps: [
      'Rotate the field away from corn for a season.',
      'Plough in or remove crop residue after harvest.',
      'Choose a tolerant hybrid for the next planting.',
    ],
  },
  'Corn (Maize) - Common Rust': {
    urgency: 'watch',
    what: 'Reddish-brown powdery pustules on both sides of the leaf — they rub off on your finger.',
    steps: [
      'Note how far up the plant the pustules reach; early leaves matter least.',
      'Choose a rust-tolerant hybrid next season.',
      'If pustules reach the upper leaves before tasselling, ask about a fungicide.',
    ],
  },
  'Corn (Maize) - Healthy': {
    urgency: 'mild',
    what: 'Broad, even green leaf with no lesions or pustules.',
    steps: [
      'Keep walking the field weekly — rust arrives fast in humid spells.',
      'Avoid excess nitrogen, which makes soft, disease-prone leaves.',
      'Keep the field free of volunteer corn, a bridge for disease.',
    ],
  },
  'Corn (Maize) - Northern Leaf Blight': {
    urgency: 'watch',
    what: 'Long cigar-shaped grey-green lesions that turn tan as they age, starting low and moving up.',
    steps: [
      'Plan rotation and residue burial after this harvest.',
      'Pick a blight-tolerant hybrid for the next crop.',
      'If lesions are climbing before tasselling, ask about a fungicide at tasselling.',
    ],
  },
  'Grape - Black Rot': {
    urgency: 'act',
    what: 'Small brown spots with a dark border on the leaf, and hard black shrivelled berries in the bunch.',
    steps: [
      'Remove mummified berries from the vine and the ground.',
      'Open the canopy and remove crowded shoots.',
      'Keep the vine balanced — overcropping weakens its defences.',
    ],
  },
  'Grape - Esca (Black Measles)': {
    urgency: 'watch',
    what: 'Yellow or brown “tiger stripes” between the veins, with leaves that look scorched but stay attached.',
    steps: [
      'Mark the affected vine — this spreads through pruning wounds.',
      'Prune in dry weather and seal large cuts.',
      'Remove badly affected wood rather than trying to spray it away.',
    ],
  },
  'Grape - Healthy': {
    urgency: 'mild',
    what: 'Deep green, evenly coloured leaf with clean veins and no stripes or spots.',
    steps: [
      'Keep the canopy open so leaves dry fast.',
      'Scout after rain — grape diseases start in wet spells.',
      'Prune in dry weather to protect the cuts.',
    ],
  },
  'Grape - Leaf Blight': {
    urgency: 'watch',
    what: 'Large dark-brown patches, often starting at the leaf edge, with a dry papery look.',
    steps: [
      'Clear fallen leaves from around the vines.',
      'Improve airflow by thinning crowded shoots.',
      'Water at the base only, early in the day.',
    ],
  },
  'Peach - Bacterial Spot': {
    urgency: 'watch',
    what: 'Small purple-brown spots that drop out and leave “shot holes”, plus dark spots on the fruit.',
    steps: [
      'Avoid overhead irrigation and working the tree when wet.',
      'Prune for airflow so leaves dry quickly.',
      'Remove heavily spotted shoots and clear fallen leaves.',
    ],
  },
  'Peach - Healthy': {
    urgency: 'mild',
    what: 'Clean green leaf, no shot-holes, no purple spotting.',
    steps: [
      'Scout weekly through wet weather.',
      'Keep the middle of the tree open to sun and air.',
      'Clear fallen leaves at the end of the season.',
    ],
  },
  'Potato - Early Blight': {
    urgency: 'act',
    what: 'Brown spots with faint concentric rings — like a target — on older, lower leaves, ringed with yellow.',
    steps: [
      'Remove the worst lower leaves and bin them.',
      'Earth up and mulch so soil cannot splash onto leaves.',
      'Keep plants fed and watered steadily; stressed plants lose leaves fastest.',
    ],
  },
  'Potato - Healthy': {
    urgency: 'mild',
    what: 'Even green leaf with no target-shaped spots or dark patches.',
    steps: [
      'Walk the rows weekly, starting at the lowest leaves.',
      'Water at the base, in the morning.',
      'Watch closely in cool, wet weather — late blight moves fast then.',
    ],
  },
  'Potato - Late Blight': {
    urgency: 'act',
    what: 'Dark, water-soaked grey-green patches with a pale edge, spreading fast in cool, wet weather; white mould underneath in the morning.',
    steps: [
      'Act today: cut and destroy affected plants — do not compost them.',
      'Tell neighbours growing potatoes or tomatoes; it spreads on the wind.',
      'Keep the remaining foliage dry and ask your extension officer about protection.',
    ],
  },
  'Strawberry - Healthy': {
    urgency: 'mild',
    what: 'Bright green leaf with clean edges and no purple spots.',
    steps: [
      'Remove old leaves after harvest so air reaches the crown.',
      'Keep fruit off the soil with straw mulch.',
      'Water in the morning, at the base.',
    ],
  },
  'Strawberry - Leaf Scorch': {
    urgency: 'watch',
    what: 'Many small purple spots that merge until the leaf looks scorched and brown at the edges.',
    steps: [
      'Cut off and bin the oldest, worst leaves.',
      'Thin the bed so air moves between plants.',
      'Avoid overhead watering and clear old foliage at season end.',
    ],
  },
  'Tomato - Bacterial Spot': {
    urgency: 'act',
    what: 'Small dark spots with yellow halos, mostly on older leaves; spots can join into larger dead areas.',
    steps: [
      'Remove affected leaves and bin them — never compost.',
      'Water at the base and stop handling plants while wet.',
      'Rotate away from tomatoes and peppers next season; do not save seed from this crop.',
    ],
  },
  'Tomato - Early Blight': {
    urgency: 'act',
    what: 'Brown spots with concentric rings on the lowest leaves first, each surrounded by yellowing tissue.',
    steps: [
      'Remove the affected lower leaves and bin them.',
      'Mulch the soil surface to stop spores splashing up.',
      'Stake and prune for airflow, and water only at the base.',
    ],
  },
  'Tomato - Healthy': {
    urgency: 'mild',
    what: 'Deep green, even leaf with no spots, no yellowing, no curling.',
    steps: [
      'Check the lowest leaves weekly — blight always starts there.',
      'Water at the base in the morning, never over the foliage.',
      'Keep a mulch layer so rain cannot splash soil onto leaves.',
    ],
  },
  'Tomato - Late Blight': {
    urgency: 'act',
    what: 'Greasy grey-green patches that spread quickly, with white fuzzy mould on the underside in humid weather; stems can darken too.',
    steps: [
      'Act now: remove and destroy affected plants — do not compost them.',
      'Warn nearby growers; spores travel on wind and rain.',
      'Keep foliage dry, and ask your extension officer about the next step for the remaining plants.',
    ],
  },
  'Tomato - Septoria Leaf Spot': {
    urgency: 'watch',
    what: 'Many small spots with grey centres and dark edges, starting on the lowest leaves and climbing.',
    steps: [
      'Remove spotted lower leaves and bin them.',
      'Mulch to block soil splash, and stake plants up off the ground.',
      'Water at the base and rotate the crop next season.',
    ],
  },
  'Tomato - Yellow Leaf Curl Virus': {
    urgency: 'act',
    what: 'New growth curls upward and yellows, plants look stunted, and leaves are thick and leathery. Spread by whitefly.',
    steps: [
      'Remove infected plants early — there is no cure once a plant is infected.',
      'Control whitefly and clear weeds around the plot that harbour them.',
      'Choose resistant varieties next season and use fine mesh on seedlings.',
    ],
  },
}

const URGENCY = {
  act: { badge: 'Act this week', tone: 'danger' },
  watch: { badge: 'Worth watching', tone: 'warn' },
  mild: { badge: 'No disease detected', tone: 'green' },
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.decoding = 'async'
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('That file could not be opened as an image.'))
    image.src = src
  })
}

function confidenceTone(probability) {
  if (probability >= 0.8) return 'good'
  if (probability >= CONFIDENT) return 'mixed'
  return 'poor'
}

export default function LeafCheck() {
  const [status, setStatus] = useState('idle') // idle | predicting | done
  const [modelState, setModelState] = useState('loading') // loading | ready | failed
  const [error, setError] = useState('')
  const [preview, setPreview] = useState('')
  const [results, setResults] = useState(null)
  const [likeness, setLikeness] = useState(null)
  const [dragging, setDragging] = useState(false)
  const [camOn, setCamOn] = useState(false)
  const [camError, setCamError] = useState('')
  const inputRef = useRef(null)
  const videoRef = useRef(null)
  const streamRef = useRef(null)

  useEffect(() => {
    let alive = true
    loadLeafModel()
      .then(() => alive && setModelState('ready'))
      .catch((err) => {
        if (!alive) return
        setModelState('failed')
        setError(err?.message || 'The leaf model could not be loaded.')
      })
    return () => {
      alive = false
    }
  }, [])

  // Release the camera when the tab or route is left behind.
  useEffect(() => () => {
    streamRef.current?.getTracks().forEach((track) => track.stop())
  }, [])

  async function runOn(src) {
    setStatus('predicting')
    setError('')
    try {
      const image = await loadImage(src)
      const { predictions, leafLikeness } = await classifyLeaf(image)
      predictions.sort((a, b) => b.probability - a.probability)
      setResults(predictions)
      setLikeness(leafLikeness)
      setStatus('done')
    } catch (err) {
      setError(err?.message || 'Could not read that image.')
      setStatus('idle')
    }
  }

  function onFile(file) {
    if (!file) return
    if (!file.type.startsWith('image/')) {
      setError('That is not an image file — try a JPG or PNG photo of a single leaf.')
      return
    }
    const url = URL.createObjectURL(file)
    setPreview(url)
    runOn(url)
  }

  function useSample(sample) {
    setPreview(sample.src)
    runOn(sample.src)
  }

  async function startCamera() {
    setCamError('')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 960 } },
        audio: false,
      })
      streamRef.current = stream
      setCamOn(true)
    } catch (err) {
      setCamError('The camera is not available here. Upload a photo instead — on a phone the button below opens your camera.')
    }
  }

  useEffect(() => {
    if (!camOn) return
    const video = videoRef.current
    if (video && streamRef.current) {
      video.srcObject = streamRef.current
      video.play().catch(() => {})
    }
  }, [camOn])

  function stopCamera() {
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    setCamOn(false)
  }

  async function capture() {
    const video = videoRef.current
    if (!video || !video.videoWidth) {
      setCamError('The camera is still starting — give it a second and try again.')
      return
    }
    setStatus('predicting')
    setError('')
    try {
      const { predictions, leafLikeness } = await classifyLeaf(video)
      predictions.sort((a, b) => b.probability - a.probability)
      setResults(predictions)
      setLikeness(leafLikeness)
      setStatus('done')
      stopCamera()
      setPreview('')
    } catch (err) {
      setError(err?.message || 'Could not read the camera frame.')
      setStatus('idle')
    }
  }

  const top = results?.[0]
  const leafLike = likeness === null || likeness >= LEAF_SIMILARITY
  const confident = Boolean(top) && leafLike && top.probability >= CONFIDENT
  const { crop, condition } = splitLabel(top?.className || '')
  const healthy = top ? isHealthyClass(top.className) : false
  const guide = top ? GUIDE[top.className] : null
  const urgency = guide ? URGENCY[guide.urgency] : URGENCY.watch
  const gradeValue = healthy ? 90 : guide?.urgency === 'act' ? 35 : guide?.urgency === 'watch' ? 50 : 62

  const headline = !top
    ? 'A photo can name the problem in seconds'
    : !leafLike
      ? 'That does not look like a leaf'
      : !confident
        ? 'Not sure about this leaf'
        : healthy
          ? `${crop} leaves look healthy`
          : `${crop} — ${condition}`

  const blurb = !top
    ? 'Photograph one leaf against a plain background. The model compares it with 29 crop conditions it has learned and answers in plain words.'
    : !leafLike
      ? 'This picture is nothing like the single-leaf photos the model learned from — a map, a screenshot, or a whole plant. It would only be guessing, so it is not answering. Point the camera at one leaf filling the frame and try again.'
      : !confident
      ? `The best match is ${crop} — ${condition}, but only ${Math.round(top.probability * 100)}% sure. That is not enough to act on: retake the photo flat, evenly lit, filling the frame with one leaf.`
      : guide?.what

  const accuracy = MEASURED.total ? Math.round((MEASURED.correct / MEASURED.total) * 100) : null

  return (
    <>
      <Reveal>
        <div className="hero-card leaf-hero">
          <div>
            <span className="hero-kicker">Leaf check · 29 crop conditions</span>
            <h2>{headline}</h2>
            <p>{blurb}</p>
            <div className="hero-meta">
              {top && confident ? <Badge tone={urgency.tone}>{urgency.badge}</Badge> : null}
              <Badge>9 crops</Badge>
              <Badge tone="teal">runs on this device</Badge>
            </div>
          </div>
          <div className="hero-ring">
            {top ? (
              <>
                <ScoreRing
                  value={top.probability * 100}
                  tone={confidenceTone(top.probability)}
                  inner={healthy ? 'healthy' : 'sure'}
                  caption="confidence in the top match"
                />
                <GradeStamp value={gradeValue} label="Leaf check" />
              </>
            ) : (
              <LeafArt />
            )}
          </div>
        </div>
      </Reveal>

      <div className="grid sidebar-right">
        <Panel
          title="Give it a leaf"
          hint="One leaf, filling the frame, on a plain background — that is all it needs"
          actions={
            modelState === 'loading' ? (
              <Badge>waking up…</Badge>
            ) : modelState === 'failed' ? (
              <Badge tone="danger">unavailable</Badge>
            ) : (
              <Badge tone="green">ready</Badge>
            )
          }
        >
          {camOn ? (
            <div className="leaf-cam">
              <video ref={videoRef} playsInline muted />
              <div className="row" style={{ marginTop: 10 }}>
                <button className="primary" onClick={capture} disabled={status === 'predicting'}>
                  {status === 'predicting' ? 'Reading leaf…' : 'Take the photo'}
                </button>
                <button className="ghost" onClick={stopCamera}>
                  Close camera
                </button>
              </div>
              <div className="hint">Hold the leaf flat and fill the frame. Avoid harsh glare and deep shadow.</div>
            </div>
          ) : (
            <>
              <div
                className={`leaf-drop ${dragging ? 'drag' : ''}`}
                onDragOver={(event) => {
                  event.preventDefault()
                  setDragging(true)
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(event) => {
                  event.preventDefault()
                  setDragging(false)
                  onFile(event.dataTransfer.files?.[0])
                }}
              >
                {preview ? (
                  <img className="leaf-preview" src={preview} alt="The leaf being checked" />
                ) : (
                  <>
                    <div className="leaf-drop-art" aria-hidden="true">🍃</div>
                    <strong>Drop a leaf photo here</strong>
                    <div className="hint">JPG or PNG · the photo never leaves your device</div>
                  </>
                )}
                <div className="row" style={{ marginTop: 12, justifyContent: 'center' }}>
                  <button className="primary" onClick={() => inputRef.current?.click()}>
                    Choose a photo
                  </button>
                  <button className="ghost" onClick={startCamera} type="button">
                    Use the camera
                  </button>
                </div>
                <input
                  ref={inputRef}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  hidden
                  onChange={(event) => {
                    onFile(event.target.files?.[0])
                    event.target.value = ''
                  }}
                />
              </div>

              {camError ? <Notice tone="warn">{camError}</Notice> : null}

              <div className="section-label">Or try a sample leaf</div>
              <div className="leaf-samples">
                {SAMPLES.map((sample) => (
                  <button
                    key={sample.src}
                    type="button"
                    className={`leaf-sample ${preview === sample.src ? 'on' : ''}`}
                    onClick={() => useSample(sample)}
                    disabled={status === 'predicting'}
                  >
                    <img src={sample.src} alt="" loading="lazy" />
                    <span>{sample.label}</span>
                  </button>
                ))}
              </div>

              {status === 'predicting' ? <Loading label="Reading the leaf…" /> : null}
              {error ? <Notice tone="danger">{error}</Notice> : null}
            </>
          )}
        </Panel>

        <div className="stack">
          {top && confident ? (
            <>
              <Panel
                title={healthy ? 'Keep it that way' : 'What to do this week'}
                hint={healthy ? 'This leaf shows no disease pattern' : 'Three steps, in order of impact'}
              >
                {!healthy && guide?.what ? <p className="leaf-what">{guide.what}</p> : null}
                <ol className={`leaf-actions ${guide?.urgency === 'act' ? 'danger' : ''}`}>
                  {(guide?.steps || []).map((step, index) => (
                    <li key={index}>{step}</li>
                  ))}
                </ol>
              </Panel>

              <Panel title="All 29 possibilities" hint="Every class the model was trained on">
                <ProbabilityList rows={results.slice(0, 5)} />
                <Collapsible title={`See all ${results.length}`}>
                  <ProbabilityList rows={results} />
                </Collapsible>
              </Panel>
            </>
          ) : top && !leafLike ? (
            <Panel title="Why there is no answer" hint="The model refuses rather than guesses">
              <p style={{ marginTop: 0 }}>
                Every classifier returns <em>some</em> answer, even for a picture of a map or a table. To keep that from
                becoming a confident wrong diagnosis, each photo is compared with reference leaf photos and has to reach{' '}
                <strong>{Math.round(LEAF_SIMILARITY * 100)}% similarity</strong> before the answer counts. This one reached{' '}
                <strong>{Math.round((likeness || 0) * 100)}%</strong>, so the model is staying quiet.
              </p>
              <ul className="bullet">
                <li>One leaf, filling the frame, laid flat.</li>
                <li>Plain background — paper, a table, your hand.</li>
                <li>Daylight, not flash: glare and hard shadow hide the symptom.</li>
                <li>Photograph the surface where the spots or mould are clearest.</li>
              </ul>
              <div className="hint">Want a whole field read instead? <Link to="/crop-health">Crop health</Link> works from a satellite image.</div>
            </Panel>
          ) : top ? (
            <Panel title="This one is not clear enough" hint="Low confidence is information, not a failure">
              <p style={{ marginTop: 0 }}>
                Best guess: <strong>{crop} — {condition}</strong> at {Math.round(top.probability * 100)}%.
                Rather than guess, check the photo before you act:
              </p>
              <ul className="bullet">
                <li>Fill the frame with one leaf, laid flat.</li>
                <li>Use daylight, not a flash — avoid glare and hard shadow.</li>
                <li>Plain background: white paper, a table, or your hand.</li>
                <li>Photograph the side of the leaf where the spots are clearest.</li>
              </ul>
              <ProbabilityList rows={results.slice(0, 5)} />
            </Panel>
          ) : (
            <Panel title="What it can and cannot do" hint="Read this before trusting a result">
              <ul className="bullet">
                <li>It knows 29 conditions across <strong>apple, bell pepper, cherry, corn, grape, peach, potato, strawberry and tomato</strong>.</li>
                <li>It was trained on single leaves photographed close up. A whole plant, a canopy or a satellite map will confuse it.</li>
                <li>It names the most likely condition; it cannot confirm it. Check with your local extension officer before spending on spray.</li>
                <li>Yellowing can also mean water stress, pH or poor roots — things a photo cannot see.</li>
              </ul>
              <div className="hint">
                Want the field-level picture instead? <Link to="/crop-health">Check crop health</Link> reads a whole field from one image.
              </div>
            </Panel>
          )}

          <FactDeck facts={LEAF_FACTS} title="Leaf wisdom" />
        </div>
      </div>

      <Reveal>
        <Panel title="How good is this model really?" hint="Measured, not claimed">
          <div className="grid cols-3">
            <div className="stat">
              <div className="label">Top-1 accuracy</div>
              <div className="value">{accuracy !== null ? accuracy : '—'}<span className="unit">%</span></div>
              <div className="foot">on {MEASURED.total} held-out photos</div>
            </div>
            <div className="stat">
              <div className="label">Classes</div>
              <div className="value">29</div>
              <div className="foot">9 crops, healthy and diseased</div>
            </div>
            <div className="stat">
              <div className="label">Where it runs</div>
              <div className="value small">On device</div>
              <div className="foot">your photo is never uploaded</div>
            </div>
          </div>
          <div className="hint">
            {accuracy !== null
              ? `On ${MEASURED.correct} of ${MEASURED.total} held-out photos from your own dataset the top answer was correct. Accuracy is lower on real field photos, which look nothing like the lab-style images it learned from — so treat every answer as a strong hint, not a diagnosis.`
              : 'Accuracy has not been measured yet.'}
          </div>
        </Panel>
      </Reveal>

      <Reveal delay={80}>
        <Panel title="Photographing a leaf well" hint="The single biggest factor in a good answer">
          <div className="help-grid">
            <div className="help-card">
              <span className="glyph" aria-hidden="true">☀️</span>
              <b>Even light</b>
              <p>Open shade or an overcast day. Direct sun blows out the spots you are trying to show.</p>
            </div>
            <div className="help-card">
              <span className="glyph" aria-hidden="true">🖼️</span>
              <b>Fill the frame</b>
              <p>One leaf, close up. Background clutter is the most common reason for a low-confidence answer.</p>
            </div>
            <div className="help-card">
              <span className="glyph" aria-hidden="true">🔍</span>
              <b>Show the symptom</b>
              <p>Photograph the side where spots, mould or curling is clearest — usually the upper surface.</p>
            </div>
            <div className="help-card">
              <span className="glyph" aria-hidden="true">📋</span>
              <b>Note the plant</b>
              <p>Different crops share symptoms. Knowing the crop narrows the answer instantly.</p>
            </div>
          </div>
        </Panel>
      </Reveal>
    </>
  )
}

function ProbabilityList({ rows }) {
  const max = rows[0]?.probability || 1
  return (
    <ul className="prob-list">
      {rows.map((row, index) => {
        const pct = row.probability * 100
        return (
          <li key={row.className} className={`prob-row ${index === 0 ? 'top' : ''}`}>
            <span className="prob-name">{row.className}</span>
            <span className="prob-pct">{pct >= 10 ? pct.toFixed(0) : pct.toFixed(1)}%</span>
            <span className="prob-track">
              <span style={{ width: `${Math.max(2, (row.probability / max) * 100)}%` }} />
            </span>
          </li>
        )
      })}
    </ul>
  )
}

function LeafArt() {
  return (
    <svg className="leaf-art" viewBox="0 0 180 180" role="img" aria-label="Illustration of a scanned leaf">
      <circle cx="90" cy="90" r="66" className="art-sun" />
      <path d="M126 52C96 52 68 72 62 106c-2 12 2 22 2 22s14-4 26-12c22-14 36-36 36-64z" className="art-hill far" />
      <path d="M60 132c14-22 30-38 52-50" className="art-rows" strokeWidth="2.5" fill="none" />
      <g className="art-sprout">
        <path d="M52 126c0-10 0-18 0-24" />
        <path d="M52 110c-8-2-14-8-16-14 8 0 14 4 16 14" />
        <path d="M52 106c8-2 14-8 16-14-8 0-14 4-16 14" />
      </g>
    </svg>
  )
}
