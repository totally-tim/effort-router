import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { CHOICES, rankOf } from '../hooks/policy'
import { mappedLevel, QUANTILES } from './quantile-map'

const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
const [manifestPath, outputPath] = process.argv.slice(2)
if (!manifestPath || !outputPath) throw new Error('Usage: quantile-fit.ts MANIFEST OUT')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const sources: { path: string; sha256: string }[] = []
function pinned(pin: { path: string; sha256: string }): string {
  const text = readFileSync(pin.path, 'utf8')
  if (sha(text) !== pin.sha256) throw new Error('Pin mismatch')
  sources.push(pin)
  return text
}
const jsonl = (text: string) => text.trim().split('\n').map(line => JSON.parse(line))
const inventory = JSON.parse(pinned(manifest.inventory))
const validity = JSON.parse(pinned(manifest.validity))
if (!validity.complete || validity.problems.length) throw new Error('Invalid development collection')
if (manifest.labels.sha256 !== inventory.families.router.pins['router-dev-s1001.jsonl'].sha256
  || manifest.cases.sha256 !== inventory.families.router.pins['router-dev.scrubbed.jsonl'].sha256) {
  throw new Error('Development inventory mismatch')
}
const cases = jsonl(pinned(manifest.cases))
const ids = new Set(cases.map(row => row.id))
if (ids.size !== cases.length || ids.size !== 166) throw new Error('Development coverage mismatch')
const labels = new Map()
for (const row of jsonl(pinned(manifest.labels)).filter(row => row.parsed)) {
  if (!ids.has(row.id) || labels.has(row.id) || !CHOICES.includes(row.parsed.effort.answer)) {
    throw new Error('Label coverage or value invalid')
  }
  labels.set(row.id, row.parsed.effort.answer)
}
if (labels.size !== ids.size) throw new Error('Missing labels')
const identity = JSON.parse(pinned(manifest.identity))
if (!identity.complete) throw new Error('Identity not proven')
const grid = { base: [], candidate: [] }
const allPaths = new Set()
for (const arm of ['base', 'candidate'] as const) {
  const spec = manifest[arm]
  if (spec.passes.length !== 2) throw new Error('Two starts required')
  const passes = []
  for (const input of spec.passes) {
    if (allPaths.has(input.combined.path)) throw new Error('Repeated pass')
    allPaths.add(input.combined.path)
    if (!identity.results.some(r => r.identity && r.input_sha256 === input.combined.sha256)) {
      throw new Error('Pass has no identity proof')
    }
    const raw = jsonl(pinned(input.raw))
    if (raw.some(row => row.status !== 200 || row.response?.model !== spec.model)) throw new Error('Wrong model or failed call')
    const rows = jsonl(pinned(input.combined))
    if (rows.length !== labels.size || new Set(rows.map(row => row.id)).size !== labels.size
      || rows.some(row => !labels.has(row.id) || row.failed)) throw new Error('Incomplete combined pass')
    passes.push(rows)
  }
  for (const q of QUANTILES) {
    let below = 0, above = 0, exact = 0
    const missesByLevels = { 1: 0, 2: 0, 3: 0 }
    for (const row of passes.flat()) {
      const level = mappedLevel(row.route.level, row.probabilities, row.workProbabilities, q)
      const gap = rankOf(labels.get(row.id)) - rankOf(level)
      if (gap > 0) { below++; missesByLevels[gap]++ }
      else if (gap < 0) above++
      else exact++
    }
    const count = labels.size * passes.length
    grid[arm].push({ q, count, below, above, exact, belowRate: below / count, aboveRate: above / count, missesByLevels })
  }
}
const base = grid.base[0]!
const feasible = grid.candidate.filter(row => row.below * base.count <= base.below * row.count)
feasible.sort((a, b) => a.above * b.count - b.above * a.count || a.q - b.q)
for (const pin of sources) if (sha(readFileSync(pin.path)) !== pin.sha256) throw new Error('Input changed')
const result = { complete: true, feasible: feasible.length > 0, selected: feasible[0]?.q ?? null,
  baseTarget: base, grid, input_manifest_sha256: sha(readFileSync(manifestPath)),
  rule: 'Minimize candidate above-label rate subject to below-label rate <= unchanged incumbent at .95; ties choose smallest q.',
  scope: 'Development only, two fresh starts per arm; no held-out calculation.' }
writeFileSync(outputPath, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify(result))
