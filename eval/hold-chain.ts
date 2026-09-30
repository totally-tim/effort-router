#!/usr/bin/env bun
/**
 * Paired replay of the level a context hold passes on to the next task. `before` passes on the effort the hold
 * kept (the live router through v0.4.0); `after` passes on the classifier's assessment, `routeOf(...).unheld`.
 * Each Claude session replays in order, so one task's level reaches the next task's previous-task level and
 * continuation floor. Both arms send identical request bodies once and share the answer; bodies that differ
 * (the previous task's level is part of the request) are asked separately in the same window.
 * A held decision is assessed once more with the evidence read before the turn's first action, as live discovery
 * does. Inputs, answers and labels stay under --out (mode 600); stdout prints only counts.
 *
 *   bun eval/hold-chain.ts run [--sessions 60] [--baseline xhigh] [--out DIR]
 *   bun eval/hold-chain.ts label [--out DIR]
 *   bun eval/hold-chain.ts report [--out DIR]
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { answerOf, averageAnswers, contextVariantIndex, inputVariants, requestOf, type Answer, type ClassifyInput } from '../hooks/classify'
import { boundedContext } from '../hooks/context'
import { higherOf, isLevel, rankOf, routeOf, type Level } from '../hooks/policy'
import { extract, hash, post, routingVersion, type Sample } from './replay'

type Row = Record<string, any>
type Arm = 'before' | 'after'
const args = process.argv.slice(2)
const option = (name: string, fallback: string) => args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1]! : fallback
const out = option('out', join(homedir(), '.local/state/effort-router/hold-chain'))
const model = option('model', 'jev-latest')
const judge = option('judge', 'local-smart')
const baseline = option('baseline', 'xhigh') as Level
const load = (name: string): Row[] => existsSync(join(out, name)) ? readFileSync(join(out, name), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
const save = (name: string, rows: unknown[]) => writeFileSync(join(out, name), rows.map(row => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 })
const append = (name: string, row: unknown) => appendFileSync(join(out, name), JSON.stringify(row) + '\n', { mode: 0o600 })

function transcripts(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? transcripts(join(dir, entry.name))
    : entry.name.endsWith('.jsonl') ? [join(dir, entry.name)] : [])
}

/** One answer per distinct request body, shared by both arms. */
const answers = new Map<string, Promise<{ answer?: Answer; model?: string; ms: number; failed?: string }>>()
function ask(body: object) {
  const key = hash(body)
  if (!answers.has(key)) answers.set(key, post('/svpg/decide/v1/systemone', body, 5000)
    .then(r => ({ answer: answerOf(JSON.stringify(r.body)), model: r.body.model as string, ms: r.ms }))
    .catch(error => ({ ms: 0, failed: String(error) })))
  return answers.get(key)!
}
/** As `classifyAll`: the answered variants count, and the context variant must answer. */
async function classify(input: ClassifyInput): Promise<Answer> {
  const variants = inputVariants(input)
  const results = await Promise.all(variants.map(v => ask(requestOf(v, model))))
  const context = results[contextVariantIndex(variants)]!
  if (!context.answer) throw Error(`context assessment: ${context.failed ?? 'unreadable answer'}`)
  return averageAnswers(results.flatMap(r => r.answer ? [r.answer] : []), context.answer)
}

function withLevel(input: ClassifyInput, level: Level | undefined): ClassifyInput {
  const previous = input.context?.previousTask
  return previous ? { ...input, context: { ...input.context!, previousTask: { ...previous, level } } } : input
}

/** The turn's decision and the level its task passes on, as the live router derives them in each arm. */
async function decide(s: Sample, arm: Arm, previous: Level | undefined) {
  const input = withLevel(s.input, previous)
  const initial = routeOf(await classify(input), input, baseline, 0.95, 'low', 'xhigh')
  let { level, contextHeld: held } = initial
  let assessed = initial.unheld
  let discovered: Row | undefined
  // Live discovery may lower a held decision before the first action, where replay evidence stops.
  // Glob results reach the classifier but do not start a discovery; the continuation stays established.
  if (held && s.discovery.some(o => o.tool !== 'Glob')) {
    const later = { ...input, continuesTask: initial.continuation, context: boundedContext({ ...input.context!, observations: s.discovery }) }
    const d = routeOf(await classify(later), later, baseline, 0.95, 'low', 'xhigh')
    discovered = { level: d.level, contextSufficient: d.contextSufficient, contextHeld: d.contextHeld }
    assessed = higherOf(assessed, d.unheld)
    if (d.contextSufficient || rankOf(d.level) > rankOf(level)) { level = d.level; held = d.contextHeld }
  }
  const task = arm === 'after' && held ? assessed : level
  return { level, held, task, reason: initial.reason, continuation: initial.continuation, contextSufficient: initial.contextSufficient,
    missing: initial.missing, discovered, previous }
}

async function run() {
  mkdirSync(out, { recursive: true, mode: 0o700 })
  const wanted = Number(option('sessions', '60'))
  const paths = transcripts(join(homedir(), '.claude/projects'))
    .filter(p => !p.includes('/subagents/') && statSync(p).size < 32 * 1024 * 1024 && statSync(p).mtimeMs < Date.now() - 600_000)
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  const sessions: Sample[][] = []
  for (const path of paths) {
    if (sessions.length >= wanted) break
    const samples = await extract(path, 'claude').catch(() => [])
    if (samples.length >= 2) sessions.push(samples)
  }
  const manifest = { created: new Date().toISOString(), model, baseline, routingVersion: routingVersion(), sessions: sessions.length,
    tasks: sessions.reduce((n, s) => n + s.length, 0), fingerprint: hash(sessions.map(s => s.map(t => t.id))) }
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 })
  save('samples.jsonl', sessions.flat())
  save('rows.jsonl', [])
  let done = 0
  const queue = [...sessions]
  await Promise.all(Array.from({ length: Number(option('concurrency', '4')) }, async () => {
    for (let session = queue.shift(); session; session = queue.shift()) {
      const previous: Record<Arm, Level | undefined> = { before: undefined, after: undefined }
      for (const [index, s] of session.entries()) {
        // Memory without a previous task (the first task, `/clear`, another project) starts both arms over.
        if (!s.input.context?.previousTask) previous.before = previous.after = undefined
        try {
          const before = await decide(s, 'before', previous.before)
          const after = await decide(s, 'after', previous.after)
          previous.before = before.task
          previous.after = after.task
          append('rows.jsonl', { id: s.id, session: s.session, index, requests: s.outcome.requests, before, after, changed: before.level !== after.level })
        } catch (error) {
          // A decision without an answer keeps at least the session effort, which the task passes on.
          previous.before = previous.before ? higherOf(previous.before, baseline) : baseline
          previous.after = previous.after ? higherOf(previous.after, baseline) : baseline
          append('rows.jsonl', { id: s.id, session: s.session, index, failed: String(error) })
        }
      }
      console.log(`sessions ${++done}/${sessions.length}`)
    }
  }))
  console.log(JSON.stringify(manifest))
}

// The judge prompt of `replay.ts label`, checked against its source so the two cannot drift apart.
const JUDGE_PROMPT = /const JUDGE_PROMPT = `([^`]+)`/.exec(readFileSync(join(import.meta.dir, 'replay.ts'), 'utf8'))![1]!

async function label() {
  const samples = new Map(load('samples.jsonl').map(s => [s.id, s as Sample]))
  const done = new Set(load('labels.jsonl').map(r => r.id))
  const jobs = load('rows.jsonl').filter(r => r.changed && !done.has(r.id))
  for (let i = 0; i < jobs.length; i += 2) {
    await Promise.all(jobs.slice(i, i + 2).map(async row => {
      const s = samples.get(row.id)!
      try {
        const result = await post('/v1/chat/completions', { model: judge, temperature: 0, reasoning_effort: 'medium', max_tokens: 4096, messages: [
          { role: 'system', content: JUDGE_PROMPT }, { role: 'user', content: JSON.stringify({ task: s.input, observedWork: s.judgeEvidence }) }] }, 120_000)
        const raw = String(result.body.choices?.[0]?.message?.content ?? '')
        const parsed = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, '').trim())
        if (!isLevel(parsed.level) || typeof parsed.scorable !== 'boolean') throw Error('Invalid judge schema')
        append('labels.jsonl', { id: row.id, ...parsed, judge, servedModel: result.body.model })
      } catch (error) { console.log(`judge failed ${row.id}: ${String(error)}`) }
    }))
    console.log(`labeled ${Math.min(i + 2, jobs.length)}/${jobs.length}`)
  }
}

function report() {
  const rows = load('rows.jsonl'), ok = rows.filter(r => !r.failed)
  const labels = new Map(load('labels.jsonl').map(r => [r.id, r]))
  const changed = ok.filter(r => r.changed)
  const levels = (arm: Arm) => Object.fromEntries(['low', 'medium', 'high', 'xhigh'].map(l => [l, ok.filter(r => r[arm].level === l).length]))
  const vsLabel = (arm: Arm) => {
    const scored = changed.filter(r => labels.get(r.id)?.scorable)
    return { n: scored.length, below: scored.filter(r => rankOf(r[arm].level) < rankOf(labels.get(r.id)!.level)).length,
      exact: scored.filter(r => r[arm].level === labels.get(r.id)!.level).length, above: scored.filter(r => rankOf(r[arm].level) > rankOf(labels.get(r.id)!.level)).length }
  }
  const heldBefore = ok.filter(r => r.before.held)
  const summary = {
    manifest: existsSync(join(out, 'manifest.json')) ? JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')) : undefined,
    tasks: rows.length, failures: rows.length - ok.length,
    held: heldBefore.length, heldReleasedByDiscovery: ok.filter(r => r.before.discovered?.contextSufficient).length,
    heldThenContinued: ok.filter(r => r.before.continuation && r.before.previous !== undefined && heldBefore.some(h => h.session === r.session && h.index === r.index - 1)).length,
    changed: changed.length, changedLower: changed.filter(r => rankOf(r.after.level) < rankOf(r.before.level)).length,
    changedHigher: changed.filter(r => rankOf(r.after.level) > rankOf(r.before.level)).length,
    changedHistoricalRequests: changed.reduce((n, r) => n + (r.requests ?? 0), 0), historicalRequests: ok.reduce((n, r) => n + (r.requests ?? 0), 0),
    transitions: Object.fromEntries([...new Set(changed.map(r => `${r.before.level}->${r.after.level}`))].map(t => [t, changed.filter(r => `${r.before.level}->${r.after.level}` === t).length])),
    levels: { before: levels('before'), after: levels('after') },
    againstLabels: { labeled: changed.filter(r => labels.has(r.id)).length, before: vsLabel('before'), after: vsLabel('after') },
    limitations: ['Replay knows the transcript, not the live relation answers that composed task memory.',
      'Discovery is one assessment with the evidence before the first action; live discovery can check twice.',
      'Mid-turn messages, tool-failure raises and batches are not replayed.',
      'Labels are an independent model judgment, not measured task success.'],
  }
  writeFileSync(join(out, 'report.json'), JSON.stringify(summary, null, 2), { mode: 0o600 })
  console.log(JSON.stringify(summary, null, 2))
}

if (import.meta.main) {
  const commands: Record<string, () => unknown> = { run, label, report }
  const command = commands[args[0] ?? '']
  if (!command) throw Error('Usage: bun eval/hold-chain.ts run|label|report [--out DIR]')
  await command()
}
