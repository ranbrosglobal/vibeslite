/**
 * Measures top-1 accuracy of ai-model/ on a deterministic sample of
 * image-dataset/Val. Throwaway dev tool — not shipped, not part of the app.
 *
 *   node .dev/validate-leaf.mjs [perClass]
 */
import { createRequire } from 'node:module'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const requireFrontend = createRequire(join(root, 'frontend', 'package.json'))
const requireRoot = createRequire(join(root, 'package.json'))
const tf = requireFrontend('@tensorflow/tfjs')
const jpeg = requireRoot('jpeg-js')

const PER_CLASS = Number(process.argv[2] || 5)
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
const metadata = JSON.parse(readFileSync(join(MODEL, 'metadata.json'), 'utf8'))
const labels = metadata.labels
const size = metadata.imageSize || 224

function tensorFor(file) {
  const { width, height, data } = jpeg.decode(readFileSync(file), { useTArray: true })
  const side = Math.min(width, height)
  const top = Math.floor((height - side) / 2)
  const left = Math.floor((width - side) / 2)
  const rgba = tf.tensor3d(
    new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    [height, width, 4],
    'int32',
  )
  const rgb = tf.slice(rgba, [0, 0, 0], [height, width, 3])
  const square = tf.slice(rgb, [top, left, 0], [side, side, 3])
  const resized = tf.image.resizeBilinear(square, [size, size])
  const normalised = resized.toFloat().div(tf.scalar(127)).sub(tf.scalar(1))
  tf.dispose([rgba, rgb, square, resized])
  return normalised
}

const classes = readdirSync(VAL).filter((name) => statSync(join(VAL, name)).isDirectory()).sort()
const samples = []
for (const className of classes) {
  if (!labels.includes(className)) {
    console.warn(`skip (not a model label): ${className}`)
    continue
  }
  const files = readdirSync(join(VAL, className))
    .filter((file) => /\.jpe?g$/i.test(file))
    .sort()
  const take = Math.min(PER_CLASS, files.length)
  for (let index = 0; index < take; index += 1) {
    const at = Math.floor(((index + 0.5) * files.length) / take)
    samples.push({ className, file: join(VAL, className, files[at]) })
  }
}

console.log(`model: ${labels.length} labels · sample: ${samples.length} images (${PER_CLASS}/class)`)
const perClass = new Map()
const confusions = new Map()
let correct = 0
let confidenceSum = 0

for (let start = 0; start < samples.length; start += 5) {
  const chunk = samples.slice(start, start + 5)
  const batch = tf.tidy(() => tf.stack(chunk.map((sample) => tensorFor(sample.file))))
  const output = tf.tidy(() => model.predict(batch))
  const rows = output.arraySync()
  tf.dispose([batch, output])

  rows.forEach((row, index) => {
    const best = row.indexOf(Math.max(...row))
    const predicted = labels[best]
    const truth = chunk[index].className
    const stats = perClass.get(truth) || { correct: 0, total: 0 }
    stats.total += 1
    if (predicted === truth) {
      stats.correct += 1
      correct += 1
    } else {
      const key = `${truth} → ${predicted}`
      confusions.set(key, (confusions.get(key) || 0) + 1)
    }
    perClass.set(truth, stats)
    confidenceSum += row[best]
  })
  process.stdout.write(`\r${Math.min(start + 5, samples.length)}/${samples.length}`)
}
process.stdout.write('\n')

const accuracy = (correct / samples.length) * 100
console.log(`\ntop-1 accuracy: ${accuracy.toFixed(1)}% (${correct}/${samples.length})`)
console.log(`mean confidence: ${((confidenceSum / samples.length) * 100).toFixed(1)}%`)

const ranked = [...perClass.entries()]
  .map(([className, stats]) => ({ className, pct: (stats.correct / stats.total) * 100, ...stats }))
  .sort((a, b) => a.pct - b.pct)
console.log('\nweakest classes:')
for (const row of ranked.slice(0, 8)) {
  console.log(`  ${row.pct.toFixed(0).padStart(3)}%  ${row.className} (${row.correct}/${row.total})`)
}
console.log('\nmost common confusions:')
for (const [key, count] of [...confusions.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
  console.log(`  ${count}×  ${key}`)
}
