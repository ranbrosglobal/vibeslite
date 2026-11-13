/**
 * Copies the committed demo analysis from demo/outputs into public/outputs so
 * the deployed site serves its maps and overlays as plain static files.
 *
 * The Python API writes to outputs/ (gitignored); demo/ is the tracked copy
 * that a fresh clone and Vercel both have.
 */
import { cp, mkdir, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const source = new URL('../../demo/outputs/', import.meta.url)
const target = new URL('../public/outputs/', import.meta.url)

await mkdir(target, { recursive: true })
const entries = await readdir(source, { withFileTypes: true })
let copied = 0
for (const entry of entries) {
  if (!entry.isDirectory()) continue
  await cp(new URL(`${entry.name}/`, source), new URL(`${entry.name}/`, target), { recursive: true })
  copied += 1
}
console.log(`[demo] copied ${copied} analysis folder(s) into ${fileURLToPath(target)}`)
