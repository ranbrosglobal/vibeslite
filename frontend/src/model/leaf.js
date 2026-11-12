/**
 * Leaf disease classifier.
 *
 * Loads the Teachable Machine export in `public/ai-model/` and runs it with
 * plain `@tensorflow/tfjs`. We deliberately do not depend on
 * `@teachablemachine/image`: it pins tfjs 1.3.1 as a peer dependency and cannot
 * be installed alongside tfjs 4.x. Its prediction path is short, so we
 * reproduce it exactly (verified against the library source,
 * `src/utils/tf.ts` + `src/custom-mobilenet.ts` of @teachablemachine/image
 * 0.8.5):
 *
 *   1. centre-crop the image to a square (the shorter side),
 *   2. draw that square at `metadata.imageSize` (224) px,
 *   3. fromPixels → toFloat → div(127) → sub(1)  ⇒ range roughly [-1, 1],
 *   4. expandDims(0) and `model.predict`,
 *   5. the final dense layer already applies softmax, so the output is
 *      directly the 29 class probabilities.
 */

import * as tf from '@tensorflow/tfjs'

const MODEL_ROOT = '/ai-model'
const DEFAULT_SIZE = 224
const DIVISOR = 127
const OFFSET = 1

let loading = null
let referencePromise = null

/** Fetch metadata + weights once; concurrent callers share the same promise. */
export function loadLeafModel() {
  if (!loading) {
    loading = (async () => {
      const response = await fetch(`${MODEL_ROOT}/metadata.json`, { cache: 'force-cache' })
      if (!response.ok) throw new Error(`Could not read the model labels (HTTP ${response.status})`)
      const metadata = await response.json()
      const model = await tf.loadLayersModel(`${MODEL_ROOT}/model.json`)
      const embedder = buildEmbedder(model, tf)
      tf.tidy(() => {
        const blank = tf.zeros([1, metadata.imageSize || DEFAULT_SIZE, metadata.imageSize || DEFAULT_SIZE, 3])
        model.predict(blank)
        if (embedder) embedder.predict(blank)
      })
      return { model, metadata, embedder }
    })().catch((error) => {
      loading = null
      throw error
    })
  }
  return loading
}

/** Centre-crop to a square and draw it at the model's input size. */
export function leafCanvas(source, size = DEFAULT_SIZE) {
  const width = source.videoWidth || source.naturalWidth || source.width
  const height = source.videoHeight || source.naturalHeight || source.height
  if (!width || !height) throw new Error('That image has no pixels to read')
  const side = Math.min(width, height)
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(source, (width - side) / 2, (height - side) / 2, side, side, 0, 0, size, size)
  return canvas
}

/**
 * Classify an image, video frame or canvas.
 * Returns [{ className, probability }] in the model's label order.
 */
export async function classifyLeaf(source) {
  const { model, metadata, embedder } = await loadLeafModel()
  const size = metadata.imageSize || DEFAULT_SIZE
  const canvas = leafCanvas(source, size)

  const { probabilities, features } = tf.tidy(() => {
    const pixels = tf.browser.fromPixels(canvas)
    const normalised = pixels.toFloat().div(tf.scalar(DIVISOR)).sub(tf.scalar(OFFSET))
    const batched = normalised.expandDims(0)
    const output = model.predict(batched)
    const embedding = embedder ? embedder.predict(batched) : null
    return {
      probabilities: Array.from(output.dataSync()),
      features: embedding ? Array.from(embedding.dataSync()) : null,
    }
  })

  const predictions = probabilities.map((probability, index) => ({
    className: metadata.labels[index] || `Class ${index + 1}`,
    probability,
  }))

  return { predictions, leafLikeness: await likeness(features) }
}

/**
 * How close the picture is to the leaf photos the model was trained on, as the
 * best cosine similarity to a stored reference embedding. Softmax alone is
 * overconfident: a map or a screenshot can score 90% on a class. This number
 * is what lets the page say “that is not a leaf” instead of guessing.
 */
async function likeness(features) {
  if (!features) return null
  const reference = await loadReference()
  if (!reference?.vectors?.length) return null
  let best = 0
  for (const vector of reference.vectors) {
    let dot = 0
    let a = 0
    let b = 0
    for (let i = 0; i < vector.length; i += 1) {
      dot += features[i] * vector[i]
      a += features[i] * features[i]
      b += vector[i] * vector[i]
    }
    const score = dot / (Math.sqrt(a) * Math.sqrt(b) || 1)
    if (score > best) best = score
  }
  return best
}

export function loadReference() {
  if (!referencePromise) {
    referencePromise = fetch(`${MODEL_ROOT}/reference.json`, { cache: 'force-cache' })
      .then((response) => (response.ok ? response.json() : null))
      .catch(() => null)
  }
  return referencePromise
}

/**
 * The 100-unit ReLU layer that sits just before the softmax. Framed as a model
 * of its own it turns a photo into a feature vector, which the reference
 * comparison above uses.
 */
export function buildEmbedder(model, tfApi) {
  try {
    const submodels = model.layers.filter((layer) => Array.isArray(layer.layers) && layer.layers.length)
    const trunk = submodels.find((sub) => !sub.layers.some((layer) => layer.getClassName() === 'Dense'))
    const head = submodels.find((sub) => sub.layers.some((layer) => layer.getClassName() === 'Dense'))
    if (!trunk || !head) return null
    const dense = head.layers.filter((layer) => layer.getClassName() === 'Dense')
    const embeddingLayer = dense[dense.length - 2] || dense[0]
    if (!embeddingLayer) return null
    const input = tfApi.input({ shape: [DEFAULT_SIZE, DEFAULT_SIZE, 3] })
    const embedding = embeddingLayer.apply(trunk.apply(input))
    return tfApi.model({ inputs: input, outputs: embedding })
  } catch {
    // The leaf-likeness check is a bonus; classification still works without it.
    return null
  }
}

export function isHealthyClass(className = '') {
  return / - Healthy$/.test(className)
}

/** "Tomato - Early Blight" → { crop: 'Tomato', condition: 'Early Blight' } */
export function splitLabel(className = '') {
  const [crop, ...rest] = className.split(' - ')
  return { crop: crop || className, condition: rest.join(' - ') || className }
}
