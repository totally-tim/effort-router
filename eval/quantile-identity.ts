import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { mappedLevel } from './quantile-map'

const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
const [manifestPath, outputPath] = process.argv.slice(2)
if (!manifestPath || !outputPath) throw new Error('Usage: quantile-identity.ts MANIFEST OUT')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const results = []
for (const input of manifest.inputs) {
  const content = readFileSync(input.path, 'utf8')
  if (sha(content) !== input.sha256) throw new Error('Input pin mismatch')
  const rows = content.trim().split('\n').map(line => JSON.parse(line))
  const ids = new Set()
  const original = [], mapped = []
  for (const row of rows) {
    if (ids.has(row.id) || row.failed || typeof row.id !== 'string') throw new Error('Invalid or duplicate turn')
    ids.add(row.id)
    original.push([row.id, row.route.level])
    mapped.push([row.id, mappedLevel(row.route.level, row.probabilities, row.workProbabilities, .95)])
  }
  const same = JSON.stringify(original) === JSON.stringify(mapped)
  if (sha(readFileSync(input.path)) !== input.sha256) throw new Error('Source changed')
  results.push({ name: input.name, turns: rows.length, input_sha256: input.sha256,
    original_route_sha256: sha(JSON.stringify(original)), mapped_route_sha256: sha(JSON.stringify(mapped)),
    identity: same })
}
const result = { complete: results.every(r => r.identity), identityQuantile: .95,
  manifest_sha256: sha(readFileSync(manifestPath)), results }
writeFileSync(outputPath, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' })
if (!result.complete) throw new Error('Identity failed; do not fit or score')
console.log(JSON.stringify({ complete: result.complete, passes: results.length,
  turns: results.reduce((n, r) => n + r.turns, 0) }))
