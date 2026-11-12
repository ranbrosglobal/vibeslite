/**
 * Builds `frontend/public/ai-model/reference.json`: L2-normalised embeddings of
 * real leaf photos (the 100-dim ReLU layer before the softmax), used at runtime
 * to notice pictures that are not leaves at all. Also prints similarity stats
 * for out-of-domain images so the threshold is chosen from data, not guessed.
 *
 *   node .dev/build-reference.mjs [perClass] [fileToTest...]
 */
import { createRequire } from 'node:module'
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildEmbedder } from '../frontend/src/model/leaf.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const requireFrontend = createRequire(join(root, 'frontend', 'package.json'))
const requireRoot = createRequire(join(root, 'package.json'))
const tf = requireFrontend('@tensorflow/tfjs')
const jpeg = requireRoot('jpeg-js')

const PER_CLASS = Number(process.argv[2] || 5)
const extra = process.argv.slice(3)
const VAL = join(root, 'image-dataset', 'Val')
const MODEL = join(root, 'ai-model')

await tf.setBackend('cpu')
await tf.ready()

const modelJson = JSON.parse(readFileSync(join(MODEL, 'model.json'), 'utf8'))
const weightSpecs = modelJson.weightsManifest.flatMap((group) => group.weights)
const weights = readFileSync(join(MODEL, 'weights.bin'))
const weightData = weights.buffer.slice(weights.byteOffset, weights.byteOffset + weights.byteLength)
const model = await tf.loadLayersModel(
  tf.io.fromMemory({ modelTopology: modelJson.modelTopology, weightSpecs, weightData }),
)
const labels = JSON.parse(readFileSync(join(MODEL, 'metadata.json'), 'utf8')).labels

const embedder = buildEmbedder(model, tf)
if (!embedder) throw new Error('Could not build the embedding model')
const dim = embedder.outputs[0].shape[1]
console.log(`embedder output: ${JSON.stringify(embedder.outputs[0].shape)}`)

function tensorFor(file) {
  const { width, height, data } = jpeg.decode(readFileSync(file), { useTArray: true })
  const side = Math.min(width, height)
  const top = Math.floor((height - side) / 2)
  const left = Math.floor((width - side) / 2)
  const rgba = tf.tensor3d(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), [height, width, 4], 'int32')
  const rgb = tf.slice(rgba, [0, 0, 0], [height, width, 3])
  const square = tf.slice(rgb, [top, left, 0], [side, side, 3])
  const resized = tf.image.resizeBilinear(square, [224, 224])
  const normalised = resized.toFloat().div(tf.scalar(127)).sub(tf.scalar(1))
  tf.dispose([rgba, rgb, square, resized])
  return normalised
}

function similarity(a, b) {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1)
}

function normalise(vector) {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1
  return vector.map((value) => value / norm)
}

const classes = readdirSync(VAL).filter((name) => statSync(join(VAL, name)).isDirectory()).sort()
const samples = []
for (const className of classes) {
  if (!labels.includes(className)) continue
  const files = readdirSync(join(VAL, className)).filter((file) => /\.jpe?g$/i.test(file)).sort()
  const take = Math.min(PER_CLASS, files.length)
  for (let index = 0; index < take; index += 1) {
    const at = Math.floor(((index + 0.5) * files.length) / take)
    samples.push(join(VAL, className, files[at]))
  }
}

const vectors = []
for (let start = 0; start < samples.length; start += 5) {
  const chunk = samples.slice(start, start + 5)
  const batch = tf.tidy(() => tf.stack(chunk.map(tensorFor)))
  const out = tf.tidy(() => embedder.predict(batch))
  const rows = out.arraySync()
  tf.dispose([batch, out])
  rows.forEach((row) => vectors.push(normalise(row)))
  process.stdout.write(`\r${Math.min(start + 5, samples.length)}/${samples.length}`)
}
process.stdout.write('\n')

// How similar is each in-domain photo to its nearest *other* reference photo?
const inDomain = vectors
  .map((vector, index) => {
    let best = -1
    vectors.forEach((other, otherIndex) => {
      if (otherIndex === index) return
      best = Math.max(best, similarity(vector, other))
    })
    return best
  })
  .sort((a, b) => a - b)

function scores(file) {
  const padded = tf.tidy(() => tensorFor(resolve(root, file)).expandDims(0))
  const out = tf.tidy(() => embedder.predict(padded))
  const vector = normalise(out.arraySync()[0])
  tf.dispose([padded, out])
  let best = -1
  let total = 0
  for (const reference of vectors) {
    const score = similarity(vector, reference)
    total += score
    if (score > best) best = score
  }
  return { best, mean: total / vectors.length }
}

console.log(
  `in-domain nearest-neighbour: min ${inDomain[0].toFixed(3)} · p5 ${inDomain[Math.floor(inDomain.length * 0.05)].toFixed(3)} · median ${inDomain[Math.floor(inDomain.length / 2)].toFixed(3)}`,
)
for (const file of extra) {
  const { best, mean } = scores(file)
  console.log(`out-of-domain ${file}: max ${best.toFixed(3)} · mean ${mean.toFixed(3)}`)
}

writeFileSync(
  join(root, 'frontend', 'public', 'ai-model', 'reference.json'),
  JSON.stringify({
    dim,
    vectors: vectors.map((vector) => vector.map((value) => Number(value.toFixed(4)))),
  }),
)
console.log(`wrote reference.json (${vectors.length} × ${dim})`)
