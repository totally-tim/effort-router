#!/usr/bin/env bun
/**
 * Paired before/after comparison of classifier inputs on the frozen labeled samples. Each arm is a whole tree:
 * its own transcript extraction, request builder and routing policy. Only samples whose request bodies differ
 * are sent, both arms interleaved in one time window, because identical bodies drift between windows.
 * Inputs, bodies and answers stay under --out (mode 600); stdout prints only counts and hashes.
 *
 *   bun eval/compare.ts prepare --before TREE [--after TREE] --out DIR [--since DIR]
 *   bun eval/compare.ts score --out DIR [--reps 3] [--concurrency 3]
 *   bun eval/compare.ts report --out DIR
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hash, post, routingVersion } from './replay'

type Row = Record<string, any>
type Arm = 'before' | 'after'
type Tree = { root: string; extract: Function; requestOf: Function; inputVariants: Function; contextVariantIndex: Function; answerOf: Function; averageAnswers: Function; routeOf: Function }

const args = process.argv.slice(2)
const option = (name: string, fallback?: string) => args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1]! : fallback
const out = resolve(option('out') ?? '')
const classifier = option('model', 'local-decide')!
const lines = (path: string): Row[] => existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
const write = (name: string, rows: unknown[]) => writeFileSync(join(out, name), rows.map(r => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 })
const DATASETS: Record<string, string> = Object.fromEntries((option('datasets') ??
  `47=${join(homedir(), '.local/state/effort-router/context-eval')},67=${join(homedir(), '.local/state/effort-router/context-regression')}`)
  .split(',').map(pair => pair.split('=') as [string, string]))

async function treeOf(root: string): Promise<Tree> {
  const [replay, classify, policy] = await Promise.all(['eval/replay.ts', 'hooks/classify.ts', 'hooks/policy.ts'].map(path => import(join(root, path))))
  return { root, extract: replay.extract, requestOf: classify.requestOf, inputVariants: classify.inputVariants, contextVariantIndex: classify.contextVariantIndex,
    answerOf: classify.answerOf, averageAnswers: classify.averageAnswers, routeOf: policy.routeOf }
}
/** Routing inputs plus the extractor, so a changed tree is never mistaken for one already scored. */
const fingerprintOf = (root: string) => ({ routing: routingVersion(root), extractor: hash(readFileSync(join(root, 'eval/replay.ts'), 'utf8')) })

function transcripts(): Map<string, string> {
  const index = new Map<string, string>()
  const walk = (dir: string, source: string): void => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) { if (entry.name !== 'subagents') walk(join(dir, entry.name), source) }
      else if (entry.name.endsWith('.jsonl')) index.set(`${source}:${entry.name.slice(0, -6)}`, join(dir, entry.name))
    }
  }
  walk(join(homedir(), '.claude/projects'), 'claude')
  walk(join(homedir(), '.codex/sessions'), 'codex')
  return index
}

/** The classifier bodies an arm sends for a sample's initial decision, and the fields that differ between arms. */
function bodiesOf(tree: Tree, input: Row): { bodies: string[]; context: number } {
  const variants = tree.inputVariants(input)
  return { bodies: variants.map((variant: Row) => JSON.stringify(tree.requestOf(variant, classifier))), context: tree.contextVariantIndex(variants) }
}
function changedFields(before: Row | undefined, after: Row | undefined): string[] {
  const flat = (state: Row | undefined) => {
    const { task_context: context, ...rest } = state ?? {}
    const { previousTask, ...contextRest } = context ?? {}
    return { ...rest, ...Object.fromEntries(Object.entries(contextRest).map(([k, v]) => [`task_context.${k}`, v])),
      ...Object.fromEntries(Object.entries(previousTask ?? {}).map(([k, v]) => [`task_context.previousTask.${k}`, v])) }
  }
  const a = flat(before), b = flat(after)
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(key => JSON.stringify(a[key]) !== JSON.stringify(b[key])).sort()
}

async function prepare() {
  const beforeRoot = resolve(option('before') ?? ''), afterRoot = resolve(option('after') ?? fileURLToPath(new URL('..', import.meta.url)))
  if (!option('before') || !option('out')) throw Error('Usage: prepare --before TREE [--after TREE] --out DIR')
  mkdirSync(out, { recursive: true, mode: 0o700 })
  const trees: Record<Arm, Tree> = { before: await treeOf(beforeRoot), after: await treeOf(afterRoot) }
  const index = transcripts(), cache = new Map<string, Promise<Row[]>>()
  const extracted = (arm: Arm, source: string, path: string) => {
    const key = `${arm}:${path}`
    if (!cache.has(key)) cache.set(key, Promise.resolve(trees[arm].extract(path, source)))
    return cache.get(key)!
  }
  const prior = option('since') ? new Map(lines(join(resolve(option('since')!), 'inputs.jsonl')).map(r => [`${r.dataset}:${r.id}`, r])) : undefined
  const rows: Row[] = [], datasets: Row = {}
  for (const [dataset, dir] of Object.entries(DATASETS)) {
    const samples = lines(join(dir, 'samples.jsonl')), labels = new Map(lines(join(dir, 'labels.jsonl')).map(l => [l.id, l]))
    const summary = { dir, samples: samples.length, frozenFingerprint: hash(samples), labels: labels.size, unmatched: 0, changed: 0, frozenEqualsBefore: 0, rerun: 0 }
    for (const s of samples) {
      const path = index.get(`${s.source}:${s.session}`)
      const arms: Partial<Record<Arm, Row>> = {}
      for (const arm of ['before', 'after'] as const) {
        const match = path ? (await extracted(arm, s.source, path)).find(x => x.timestamp === s.timestamp) : undefined
        if (!match) continue
        const { bodies, context } = bodiesOf(trees[arm], match.input)
        arms[arm] = { input: match.input, bodies, context, hashes: [...new Set(bodies.map(hash))].sort(), provenance: match.provenance }
      }
      if (!arms.before || !arms.after) { summary.unmatched++; rows.push({ dataset, id: s.id, unmatched: [!arms.before && 'before', !arms.after && 'after'].filter(Boolean) }); continue }
      if (JSON.stringify(bodiesOf(trees.before, s.input).bodies) === JSON.stringify(arms.before.bodies)) summary.frozenEqualsBefore++
      const changed = JSON.stringify(arms.before.hashes) !== JSON.stringify(arms.after.hashes)
      const state = (arm: Arm) => JSON.parse(arms[arm]!.bodies[arms[arm]!.context]).state
      const was = prior?.get(`${dataset}:${s.id}`)
      // After integration, rerun only what changed since the prior run's bodies.
      const rerun = changed && (!prior || JSON.stringify(was?.before?.hashes) !== JSON.stringify(arms.before.hashes) || JSON.stringify(was?.after?.hashes) !== JSON.stringify(arms.after.hashes))
      if (changed) summary.changed++
      if (rerun) summary.rerun++
      const label = labels.get(s.id)
      rows.push({ dataset, id: s.id, source: s.source, label: label?.scorable ? label.level : undefined, changed, rerun, fields: changed ? changedFields(state('before'), state('after')) : [], ...arms })
    }
    datasets[dataset] = summary
  }
  write('inputs.jsonl', rows)
  const manifest = { created: new Date().toISOString(), classifier, trees: { before: { root: beforeRoot, ...fingerprintOf(beforeRoot) }, after: { root: afterRoot, ...fingerprintOf(afterRoot) } },
    since: option('since'), datasets, fields: Object.fromEntries(Object.entries(rows.filter(r => r.changed).flatMap(r => r.fields as string[]).reduce((n: Row, f) => ({ ...n, [f]: (n[f] ?? 0) + 1 }), {})).sort()),
    provenance: provenanceCounts(rows) }
  writeFileSync(join(out, 'prepare.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 })
  console.log(JSON.stringify(manifest, null, 2))
}
function provenanceCounts(rows: Row[]): Row {
  const counts: Row = {}
  for (const r of rows) for (const [key, value] of Object.entries(r.after?.provenance ?? {})) {
    for (const item of Array.isArray(value) ? value : [value === true ? key : `${key}=${value}`]) counts[`${key}:${item}`] = (counts[`${key}:${item}`] ?? 0) + 1
  }
  return counts
}

async function score() {
  const manifest = JSON.parse(readFileSync(join(out, 'prepare.json'), 'utf8'))
  const trees: Record<Arm, Tree> = { before: await treeOf(manifest.trees.before.root), after: await treeOf(manifest.trees.after.root) }
  for (const arm of ['before', 'after'] as const) {
    if (JSON.stringify(fingerprintOf(manifest.trees[arm].root)) !== JSON.stringify({ routing: manifest.trees[arm].routing, extractor: manifest.trees[arm].extractor })) throw Error(`The ${arm} tree changed after prepare; run prepare again`)
  }
  const jobs = lines(join(out, 'inputs.jsonl')).filter(r => r.rerun)
  const reps = Number(option('reps', '3')), concurrency = Number(option('concurrency', '3')), run = new Date().toISOString()
  async function call(job: Row, arm: Arm, rep: number, order: number): Promise<Row> {
    const tree = trees[arm], { bodies, context } = job[arm], distinct = [...new Set(bodies as string[])]
    try {
      const responses = await Promise.all(distinct.map(body => post('/svpg/decide/v1/systemone', JSON.parse(body), 15000)))
      const raw = bodies.map((body: string) => responses[distinct.indexOf(body)]!.body)
      const answers = raw.map((body: Row) => tree.answerOf(JSON.stringify(body)))
      if (answers.some((a: unknown) => !a)) throw Error('Invalid classifier response')
      const answer = tree.averageAnswers(answers, answers[context])
      const routed = (baseline: string) => tree.routeOf(answer, job[arm].input, baseline, 0.95, 'low', 'xhigh')
      const atHigh = routed('high'), atXhigh = routed('xhigh')
      return { run, dataset: job.dataset, id: job.id, arm, rep, order, sufficientP: raw[context].answers?.context?.probabilities?.sufficient, context: answer.context,
        contextSufficient: answer.contextSufficient, relation: answer.relation, choice: answer.choice, levelHigh: atHigh.level, levelXhigh: atXhigh.level,
        heldXhigh: atXhigh.contextHeld, reasonXhigh: atXhigh.reason, latencyMs: Math.max(...responses.map(r => r.ms)), calls: distinct.length, servedModel: responses[0]!.body.model }
    } catch (error) { return { run, dataset: job.dataset, id: job.id, arm, rep, order, failed: String(error) } }
  }
  for (let rep = 1; rep <= reps; rep++) {
    // A seeded shuffle per repetition; the arm that goes first alternates by sample and repetition.
    const ordered = [...jobs].sort((a, b) => hash([run, rep, a.dataset, a.id]).localeCompare(hash([run, rep, b.dataset, b.id])))
    for (let i = 0; i < ordered.length; i += concurrency) {
      await Promise.all(ordered.slice(i, i + concurrency).map(async (job, k) => {
        const arms: Arm[] = (rep + i + k) % 2 === 0 ? ['before', 'after'] : ['after', 'before']
        for (const [order, arm] of arms.entries()) appendFileSync(join(out, 'answers.jsonl'), JSON.stringify(await call(job, arm, rep, order)) + '\n', { mode: 0o600 })
      }))
      console.log(`rep ${rep}: ${Math.min(i + concurrency, ordered.length)}/${ordered.length}`)
    }
  }
}

const RANK: Record<string, number> = { low: 0, medium: 1, high: 2, xhigh: 3, max: 4 }
function report() {
  const manifest = JSON.parse(readFileSync(join(out, 'prepare.json'), 'utf8'))
  const inputs = new Map(lines(join(out, 'inputs.jsonl')).map(r => [`${r.dataset}:${r.id}`, r]))
  const answers = lines(join(out, 'answers.jsonl'))
  const result: Row = { trees: manifest.trees, datasets: {}, limitations: [
    'Labels are earlier model judgments, not task success; agreement with them is not a quality improvement.',
    'Unchanged samples send identical bodies and are not called; their difference is zero by construction.',
    'Arms are interleaved in one window; absolute rates are window-specific.',
    'Replay cannot know the previous task level or the classifier relation answer of earlier turns (see provenance).'] }
  for (const dataset of Object.keys(manifest.datasets)) {
    const rows = answers.filter(a => a.dataset === dataset && !a.failed)
    const ids = [...new Set(rows.map(r => r.id))]
    const per = (arm: Arm, id: string) => rows.filter(r => r.arm === arm && r.id === id)
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1)
    const paired = ids.map(id => ({ id, label: inputs.get(`${dataset}:${id}`)?.label, before: per('before', id), after: per('after', id) })).filter(p => p.before.length && p.after.length)
    const deltas = paired.map(p => mean(p.after.map(r => r.sufficientP ?? 0)) - mean(p.before.map(r => r.sufficientP ?? 0)))
    // Bootstrap over samples, seeded for repeatability.
    let state = 1
    const random = () => (state = (state * 48271) % 2147483647) / 2147483647
    const boots = Array.from({ length: 2000 }, () => mean(deltas.map(() => deltas[Math.floor(random() * deltas.length)]!))).sort((a, b) => a - b)
    const arm = (name: Arm) => {
      const all = paired.flatMap(p => p[name].map(r => ({ ...r, label: p.label })))
      const levels = (key: string) => Object.fromEntries(['low', 'medium', 'high', 'xhigh'].map(level => [level, all.filter(r => r[key] === level).length]))
      const vsLabel = (key: string) => ({ below: all.filter(r => r.label && RANK[r[key]]! < RANK[r.label]!).length, equal: all.filter(r => r.label && r[key] === r.label).length,
        above: all.filter(r => r.label && RANK[r[key]]! > RANK[r.label]!).length })
      return { runs: all.length, sufficient: all.filter(r => r.contextSufficient).length, heldAtXhigh: all.filter(r => r.heldXhigh).length,
        continuation: all.filter(r => r.relation === 'continuation').length, levelsAtHigh: levels('levelHigh'), levelsAtXhigh: levels('levelXhigh'),
        labelAtHigh: vsLabel('levelHigh'), labelAtXhigh: vsLabel('levelXhigh'), meanSufficientP: mean(all.map(r => r.sufficientP ?? 0)) }
    }
    result.datasets[dataset] = { ...manifest.datasets[dataset], pairedSamples: paired.length, failures: answers.filter(a => a.dataset === dataset && a.failed).length,
      deltaSufficientP: { mean: mean(deltas), ci95: [boots[50], boots[1949]], up: deltas.filter(d => d > 0.02).length, down: deltas.filter(d => d < -0.02).length },
      before: arm('before'), after: arm('after'),
      perSample: paired.map(p => ({ id: p.id.slice(0, 8), label: p.label, fields: inputs.get(`${dataset}:${p.id}`)?.fields,
        before: p.before.map(r => `${r.levelXhigh}/${(r.sufficientP ?? 0).toFixed(2)}`).join(' '), after: p.after.map(r => `${r.levelXhigh}/${(r.sufficientP ?? 0).toFixed(2)}`).join(' ') })) }
  }
  writeFileSync(join(out, 'report.json'), JSON.stringify(result, null, 2), { mode: 0o600 })
  console.log(JSON.stringify(result, null, 2))
}

if (import.meta.main) {
  const commands: Record<string, () => unknown> = { prepare, score, report }
  const run = commands[args[0] ?? '']
  if (!run || !option('out')) throw Error('Usage: bun eval/compare.ts prepare|score|report --out DIR [--before TREE] [--after TREE] [--since DIR] [--reps 3]')
  await run()
}
