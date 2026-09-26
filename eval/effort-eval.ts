#!/usr/bin/env bun
/**
 * Offline evaluation for effort-router, run with Bun. It imports the mod's own
 * request, answer and pick functions, so the eval asks exactly what the mod
 * asks.
 *
 *   bun eval/effort-eval.ts sample [--days 30] [--n 150]
 *   bun eval/effort-eval.ts autolabel [--models a,b,c]   # opencode labelers
 *   bun eval/effort-eval.ts label        # Enter accepts the labelers' consensus
 *   bun eval/effort-eval.ts score [--concurrency 8]
 *   bun eval/effort-eval.ts report [--days 7] [--baseline-days 14]
 *
 * Data (prompts, labels, answers) stays in ~/.local/state/effort-router/eval,
 * outside the repository. Label sets: labels.jsonl (yours, the truth when
 * present), proposals.jsonl (Claude) and oc-<model>/labels.jsonl (opencode).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'

import { createHash } from 'node:crypto'

import {
  type ClassifyInput,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  answerOf,
  requestOf,
  systemOneUrlOf,
} from '../hooks/classify'
import { CHOICES, type Choice, type Probabilities, isLevel, pickOf, rankOf } from '../hooks/policy'

const HOME = homedir()
const PROJECTS = join(HOME, '.claude', 'projects')
const STATE = join(HOME, '.local', 'state', 'effort-router')
const DATA = join(STATE, 'eval')
const THRESHOLDS = [0.6, 0.7, 0.8, 0.9, 0.95]

type TurnFacts = { toolErrors: number; requests: number; interrupted: boolean }

export type Prompt = {
  id: string
  session: string
  ts: string
  text: string
  previous?: string
  previousAnswer?: string
  earlier?: { request: string; answer?: string }[]
  previousTurn?: TurnFacts
  recordedEffort?: string
}

type Label = { id: string; level: Choice; reason?: string }

/**
 * What each context variant sends besides the prompt. `current` is what the
 * live mod sends.
 */
const VARIANTS: Readonly<Record<string, (p: Prompt) => ClassifyInput>> = {
  prompt: p => ({ request: p.text }),
  'no-answer': p => ({ request: p.text, previousRequest: p.previous }),
  current: p => ({ request: p.text, previousRequest: p.previous, previousAnswer: p.previousAnswer }),
  history3: p => ({
    request: p.text,
    previousRequest: p.previous,
    previousAnswer: p.previousAnswer,
    earlier: p.earlier,
  }),
  signals: p => ({
    request: p.text,
    previousRequest: p.previous,
    previousAnswer: p.previousAnswer,
    previousTurn: p.previousTurn,
  }),
}

/**
 * The variants the `ensemble` row averages.
 */
const ENSEMBLE = ['current', 'history3', 'signals']

const args = process.argv.slice(2)
const command = args[0]

function option(name: string, fallback: number): number {
  const at = args.indexOf(`--${name}`)
  const value = at >= 0 ? Number(args[at + 1]) : NaN

  return Number.isFinite(value) ? value : fallback
}

export function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) {
    return []
  }

  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => JSON.parse(line) as T)
}

function writeJsonl(path: string, rows: readonly object[]): void {
  mkdirSync(DATA, { recursive: true })
  writeFileSync(path, rows.map(row => JSON.stringify(row)).join('\n') + '\n')
}

/**
 * Top-level session transcripts modified within `days`.
 */
function transcripts(days: number): string[] {
  const since = Date.now() - days * 86_400_000
  const files: string[] = []

  for (const project of readdirSync(PROJECTS)) {
    const dir = join(PROJECTS, project)

    if (!statSync(dir).isDirectory()) {
      continue
    }

    for (const name of readdirSync(dir)) {
      const path = join(dir, name)

      if (name.endsWith('.jsonl') && statSync(path).mtimeMs >= since) {
        files.push(path)
      }
    }
  }

  return files
}

const MACHINE_TEXT = /^\s*(<(command-name|command-message|local-command|task-notification|system-reminder|bash-|user-memory|pasted_content)|\[Request interrupted)/

/**
 * Interactive sessions only: headless runs (`claude -p`, the SDKs) carry
 * prompts that tools wrote, not a person.
 */
function isInteractive(line: Record<string, unknown>): boolean {
  return line.entrypoint === 'cli'
}

function contentOf(line: Record<string, unknown>): unknown {
  return (line.message as { content?: unknown } | undefined)?.content
}

/**
 * The text a person typed, or undefined for tool results, commands, meta
 * lines and harness notices.
 */
function typedTextOf(line: Record<string, unknown>): string | undefined {
  if (line.type !== 'user' || line.isMeta || line.isSidechain || line.isCompactSummary || !isInteractive(line)) {
    return undefined
  }

  const content = contentOf(line)
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content) && content.every(block => block?.type === 'text')
        ? content.map(block => block.text).join('\n')
        : undefined

  if (!text || MACHINE_TEXT.test(text)) {
    return undefined
  }

  const cleaned = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()

  return cleaned === '' ? undefined : cleaned
}

function parsedLines(path: string): Record<string, unknown>[] {
  const lines: Record<string, unknown>[] = []

  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    if (!raw) {
      continue
    }

    try {
      lines.push(JSON.parse(raw))
    } catch {
      // A torn last line of a live session.
    }
  }

  return lines
}

/**
 * Every typed prompt of one session, each with the context the variants use:
 * the previous prompt and answer, two exchanges before those, and how the
 * previous turn went.
 */
function promptsOf(path: string): Prompt[] {
  const session = path.split('/').pop()?.replace(/\.jsonl$/, '') ?? path
  const prompts: Prompt[] = []
  const answers: (string | undefined)[] = []
  const seen = new Set<string>()
  let facts: TurnFacts = { toolErrors: 0, requests: 0, interrupted: false }
  let answer: string | undefined
  let waiting: Prompt | undefined

  for (const line of parsedLines(path)) {
    const content = contentOf(line)

    if (line.type === 'assistant' && !line.isSidechain) {
      const id = (line.message as { id?: string } | undefined)?.id

      if (id && !seen.has(id)) {
        seen.add(id)
        facts.requests += 1
      }

      if (waiting && typeof line.effort === 'string') {
        waiting.recordedEffort = line.effort
        waiting = undefined
      }

      const text = Array.isArray(content)
        ? content.filter(block => block?.type === 'text').map(block => block.text).join('\n')
        : ''

      if (text.trim() !== '') {
        answer = text
      }

      continue
    }

    if (line.type === 'user' && Array.isArray(content)) {
      facts.toolErrors += content.filter(block => block?.type === 'tool_result' && block.is_error).length

      if (content.some(block => block?.type === 'text' && /^\[Request interrupted/.test(block.text ?? ''))) {
        facts.interrupted = true
      }
    }

    const text = typedTextOf(line)

    if (!text) {
      continue
    }

    const n = prompts.length

    // The answer that closed the previous turn belongs to prompt n - 1.
    if (n > 0) {
      answers[n - 1] = answer
    }

    waiting = {
      id: `${session}:${String(line.uuid ?? n)}`,
      session,
      ts: String(line.timestamp ?? ''),
      text: text.slice(0, 4000),
      previous: prompts[n - 1]?.text.slice(0, 1000),
      previousAnswer: n > 0 ? answer?.slice(0, 1000) : undefined,
      earlier: prompts.slice(Math.max(0, n - 3), Math.max(0, n - 1)).map((p, i, list) => ({
        request: p.text.slice(0, 500),
        answer: answers[n - 1 - list.length + i]?.slice(0, 500),
      })),
      previousTurn: n > 0 ? facts : undefined,
    }

    prompts.push(waiting)
    facts = { toolErrors: 0, requests: 0, interrupted: false }
    answer = undefined
  }

  return prompts
}

/**
 * A seeded shuffle, so a sample can be drawn again.
 */
function sampleOf<T>(items: readonly T[], n: number, seed = 42): T[] {
  const copy = [...items]
  let state = seed

  for (let i = copy.length - 1; i > 0; i--) {
    state = (state * 1_103_515_245 + 12_345) % 2 ** 31
    const j = state % (i + 1)
    ;[copy[i], copy[j]] = [copy[j] as T, copy[i] as T]
  }

  return copy.slice(0, n)
}

/**
 * The sample with each prompt's context filled in from the transcripts, so a
 * sample drawn before a field existed still gets it. Rows the current rules no
 * longer count as typed prompts (a compaction summary) drop out.
 */
export function enrichedSample(): Prompt[] {
  const fresh = new Map(transcripts(60).flatMap(promptsOf).map(p => [p.id, p]))

  return readJsonl<Prompt>(join(DATA, 'sample.jsonl'))
    .filter(p => fresh.has(p.id))
    .map(p => ({ ...p, ...fresh.get(p.id), text: p.text }))
}

/**
 * Every label set on disk, by labeler name: yours as `you`, Claude's
 * proposals as `claude`, each opencode run by its model.
 */
export function labelSets(): Map<string, Map<string, Choice>> {
  const sets = new Map<string, Map<string, Choice>>()

  const add = (name: string, path: string) => {
    const rows = readJsonl<Label>(path).filter(row => isLevel(row.level) && row.level !== 'max')

    if (rows.length > 0) {
      sets.set(name, new Map(rows.map(row => [row.id, row.level])))
    }
  }

  add('you', join(DATA, 'labels.jsonl'))
  add('claude', join(DATA, 'proposals.jsonl'))

  for (const dir of existsSync(DATA) ? readdirSync(DATA) : []) {
    if (dir.startsWith('oc-')) {
      add(dir.slice(3), join(DATA, dir, 'labels.jsonl'))
    }
  }

  return sets
}

/**
 * The model labelers' median level for one prompt; an even split resolves to
 * the higher middle level.
 */
export function consensusOf(sets: Map<string, Map<string, Choice>>, id: string): Choice | undefined {
  const ranks = [...sets]
    .filter(([name]) => name !== 'you')
    .map(([, set]) => set.get(id))
    .filter((level): level is Choice => level !== undefined)
    .map(rankOf)
    .sort((a, b) => a - b)

  if (ranks.length === 0) {
    return undefined
  }

  return CHOICES[ranks[Math.floor(ranks.length / 2)] as number]
}

async function sample(): Promise<void> {
  const prompts = transcripts(option('days', 30)).flatMap(promptsOf)
  const picked = sampleOf(prompts, option('n', 150))

  writeJsonl(join(DATA, 'prompts.jsonl'), prompts)
  writeJsonl(join(DATA, 'sample.jsonl'), picked)
  console.log(`${prompts.length} typed prompts; sampled ${picked.length} into ${join(DATA, 'sample.jsonl')}`)
}

/**
 * The opencode models that label the sample by default (OpenCode Go).
 */
const LABEL_MODELS = ['deepseek-v4.1-flash', 'mimo-v2.6-pro', 'mimo-v2.6-flash']

/**
 * Labels the sample with each model through `opencode run`, in parallel. Each
 * model works in its own folder on a copy of the sample without the recorded
 * effort, so no labeler sees another's labels. The prompt is
 * eval/labeler-prompt.md.
 */
async function autolabel(): Promise<void> {
  const at = args.indexOf('--models')
  const models = at >= 0 ? String(args[at + 1]).split(',') : LABEL_MODELS
  const prompt = readFileSync(join(import.meta.dir, 'labeler-prompt.md'), 'utf8')
  const rows = readJsonl<Prompt>(join(DATA, 'sample.jsonl')).map(p => ({ id: p.id, text: p.text, previous: p.previous }))

  await Promise.all(
    models.map(async model => {
      const dir = join(DATA, `oc-${model}`)

      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'sample.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n')
      writeFileSync(join(dir, 'labels.jsonl'), '')

      const child = Bun.spawn(['opencode', 'run', '--auto', '-m', `opencode-go/${model}`, '--title', `effort-label ${model}`, prompt], {
        cwd: dir,
        stdin: 'ignore',
        stdout: Bun.file(join(dir, 'run.log')),
        stderr: 'pipe',
      })

      await child.exited

      console.log(`${model}: exit ${child.exitCode}, ${readJsonl(join(dir, 'labels.jsonl')).length} of ${rows.length} rows`)
    }),
  )
}

async function label(): Promise<void> {
  const labelsPath = join(DATA, 'labels.jsonl')
  const labels = readJsonl<Label>(labelsPath)
  const done = new Set(labels.map(row => row.id))
  const sets = labelSets()
  const reasons = new Map(readJsonl<Label>(join(DATA, 'proposals.jsonl')).map(row => [row.id, row.reason]))
  const todo = readJsonl<Prompt>(join(DATA, 'sample.jsonl')).filter(p => !done.has(p.id))
  const keys: Record<string, Choice> = { l: 'low', m: 'medium', h: 'high', x: 'xhigh' }
  const io = createInterface({ input: process.stdin, output: process.stdout })

  console.log(`${todo.length} to label. Enter accepts the consensus; l=low m=medium h=high x=xhigh, s=skip, q=quit\n`)

  for (const prompt of todo) {
    if (prompt.previous) {
      console.log(`previous: ${prompt.previous.slice(0, 200).replace(/\s+/g, ' ')}`)
    }

    console.log(`PROMPT:\n${prompt.text.slice(0, 800)}\n`)

    const votes = [...sets]
      .filter(([name]) => name !== 'you')
      .map(([name, set]) => `${name} ${set.get(prompt.id) ?? '-'}`)
      .join(' · ')

    const consensus = consensusOf(sets, prompt.id)

    if (consensus) {
      console.log(`labelers: ${votes}`)
      console.log(`consensus: ${consensus}${reasons.get(prompt.id) ? ` (claude: ${reasons.get(prompt.id)})` : ''}`)
    }

    const answer = (await io.question('level> ')).trim().toLowerCase()

    if (answer === 'q') {
      break
    }

    const level = answer === '' ? consensus : keys[answer]

    if (level) {
      labels.push({ id: prompt.id, level })
      writeJsonl(labelsPath, labels)
    }

    console.log('')
  }

  io.close()
  console.log(`${labels.length} labels in ${labelsPath}`)
}

function text(name: string): string | undefined {
  const at = args.indexOf(`--${name}`)

  return at >= 0 ? args[at + 1] : undefined
}

/**
 * The classifier the eval asks, set as the mod is: `--base-url`, `--model`
 * and `--key-file`/`--key-name`, else the TypeSafe SDK environment
 * (`TYPESAFE_BASE_URL`, `TYPESAFE_DEFAULT_MODEL`, `TYPESAFE_API_KEY`).
 */
export const CLASSIFIER = {
  url: systemOneUrlOf(text('base-url') ?? process.env.TYPESAFE_BASE_URL ?? DEFAULT_BASE_URL),
  model: text('model') ?? process.env.TYPESAFE_DEFAULT_MODEL ?? DEFAULT_MODEL,
}

export function keyOf(): string {
  const file = text('key-file')
  const name = text('key-name') ?? 'TYPESAFE_API_KEY'
  const key = file
    ? (JSON.parse(readFileSync(file.replace(/^~(?=\/)/, HOME), 'utf8')) as Record<string, unknown>)[name]
    : process.env.TYPESAFE_API_KEY

  if (typeof key !== 'string' || key === '') {
    throw new Error(file ? `no ${name} in ${file}` : 'set TYPESAFE_API_KEY, or pass --key-file and --key-name')
  }

  return key
}

/**
 * A short fingerprint of the classifier and the request shape, so scores
 * from another model, service or prompt wording are never mixed.
 */
export function fingerprintOf(): string {
  const shape = JSON.stringify([CLASSIFIER, requestOf({ request: '' }, CLASSIFIER.model)])

  return createHash('sha256').update(shape).digest('hex').slice(0, 10)
}

async function ask(key: string, input: ClassifyInput): Promise<Probabilities | undefined> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(CLASSIFIER.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(requestOf(input, CLASSIFIER.model)),
    })

    if (response.ok) {
      return answerOf(await response.text())?.probabilities
    }

    await Bun.sleep(1000 * (attempt + 1))
  }

  return undefined
}

export type Tally = { n: number; exact: number; under: number; over: number; cost: number; belowTop: number }

export function tallyOf(
  prompts: readonly Prompt[],
  truth: (id: string) => Choice | undefined,
  probabilitiesOf: (id: string) => Probabilities | undefined,
  threshold: number,
): Tally {
  const tally: Tally = { n: 0, exact: 0, under: 0, over: 0, cost: 0, belowTop: 0 }

  for (const p of prompts) {
    const probabilities = probabilitiesOf(p.id)
    const level = truth(p.id)

    if (!probabilities || !level) {
      continue
    }

    const pick = pickOf(probabilities, threshold, 'low', 'xhigh')
    const gap = rankOf(pick) - rankOf(level)

    tally.n += 1
    tally.exact += gap === 0 ? 1 : 0
    tally.under += gap < 0 ? 1 : 0
    tally.over += gap > 0 ? 1 : 0
    tally.cost += gap < 0 ? -3 * gap : gap
    tally.belowTop += pick === 'xhigh' ? 0 : 1
  }

  return tally
}

export function pct(x: number, n: number): string {
  return `${((100 * x) / Math.max(n, 1)).toFixed(0)}%`.padStart(5)
}

async function score(): Promise<void> {
  const prompts = enrichedSample()
  const sets = labelSets()
  const yours = sets.get('you')
  const truthName = yours ? 'your labels' : 'labeler consensus'
  const truth = (id: string) => (yours ? yours.get(id) : consensusOf(sets, id))
  const scoresPath = join(DATA, `scores-${fingerprintOf()}.jsonl`)
  const scores = new Map(
    readJsonl<{ key: string; probabilities: Probabilities }>(scoresPath).map(row => [row.key, row.probabilities]),
  )
  const key = keyOf()
  const concurrency = option('concurrency', 8)
  const jobs = Object.keys(VARIANTS).flatMap(variant =>
    prompts.filter(p => !scores.has(`${variant}:${p.id}`)).map(p => ({ variant, p })),
  )

  for (let i = 0; i < jobs.length; i += concurrency) {
    const batch = jobs.slice(i, i + concurrency)
    const answers = await Promise.all(
      batch.map(job => ask(key, (VARIANTS[job.variant] as (p: Prompt) => ClassifyInput)(job.p))),
    )

    batch.forEach((job, j) => {
      const probabilities = answers[j]

      if (probabilities) {
        scores.set(`${job.variant}:${job.p.id}`, probabilities)
      }
    })
  }

  writeJsonl(scoresPath, [...scores].map(([k, probabilities]) => ({ key: k, probabilities })))

  // The mean of three context variants' answers, which costs nothing extra
  // offline and three parallel calls live.
  for (const p of prompts) {
    const parts = ENSEMBLE.map(variant => scores.get(`${variant}:${p.id}`)).filter(Boolean) as Probabilities[]

    if (parts.length === ENSEMBLE.length) {
      scores.set(`ensemble:${p.id}`, Object.fromEntries(
        CHOICES.map(choice => [choice, parts.reduce((sum, part) => sum + (part[choice] ?? 0), 0) / parts.length]),
      ))
    }
  }

  const labelers = [...sets.keys()]

  console.log(`labelers: ${labelers.map(name => `${name} (${sets.get(name)?.size})`).join(', ')}`)
  console.log('pairwise agreement, exact / within one level:')

  for (let a = 0; a < labelers.length; a++) {
    for (let b = a + 1; b < labelers.length; b++) {
      const left = sets.get(labelers[a] as string) as Map<string, Choice>
      const right = sets.get(labelers[b] as string) as Map<string, Choice>
      const shared = [...left.keys()].filter(id => right.has(id))
      const exact = shared.filter(id => left.get(id) === right.get(id)).length
      const near = shared.filter(
        id => Math.abs(rankOf(left.get(id) as Choice) - rankOf(right.get(id) as Choice)) <= 1,
      ).length

      console.log(`  ${`${labelers[a]} vs ${labelers[b]}`.padEnd(44)} ${pct(exact, shared.length)} / ${pct(near, shared.length)}  (n=${shared.length})`)
    }
  }

  const truthCounts = CHOICES.map(level => `${level} ${prompts.filter(p => truth(p.id) === level).length}`).join(', ')

  console.log(`\ntruth = ${truthName}: ${truthCounts}`)
  console.log('\nvariant     threshold  exact  under  over   cost (under x3)  below xhigh')

  for (const variant of [...Object.keys(VARIANTS), 'ensemble']) {
    for (const threshold of THRESHOLDS) {
      const t = tallyOf(prompts, truth, id => scores.get(`${variant}:${id}`), threshold)

      console.log(`${variant.padEnd(11)} ${threshold.toFixed(2).padEnd(9)}  ${pct(t.exact, t.n)}  ${pct(t.under, t.n)}  ${pct(t.over, t.n)}  ${(t.cost / Math.max(t.n, 1)).toFixed(2).padEnd(15)}  ${pct(t.belowTop, t.n)}`)
    }
  }

  console.log('\nconfusion for `current` at 0.80 (rows = truth, columns = pick)')
  console.log(`${''.padEnd(8)}${CHOICES.map(c => c.padStart(7)).join('')}`)

  for (const level of CHOICES) {
    const row = CHOICES.map(
      pick =>
        prompts.filter(p => {
          const probabilities = scores.get(`current:${p.id}`)

          return truth(p.id) === level && probabilities && pickOf(probabilities, 0.8, 'low', 'xhigh') === pick
        }).length,
    )

    console.log(`${level.padEnd(8)}${row.map(x => String(x).padStart(7)).join('')}`)
  }
}

type Totals = {
  requests: number
  prompts: number
  output: number
  cacheRead: number
  input: number
  efforts: Record<string, number>
}

function totalsOf(files: readonly string[], from: number, to: number): Totals {
  const totals: Totals = { requests: 0, prompts: 0, output: 0, cacheRead: 0, input: 0, efforts: {} }

  for (const path of files) {
    const seen = new Set<string>()

    for (const line of parsedLines(path)) {
      const at = Date.parse(String(line.timestamp ?? ''))

      if (!(at >= from && at < to)) {
        continue
      }

      if (typedTextOf(line)) {
        totals.prompts += 1
      }

      const message = line.message as { id?: string; usage?: Record<string, number> } | undefined

      if (line.type !== 'assistant' || !isInteractive(line) || !message?.id || seen.has(message.id)) {
        continue
      }

      seen.add(message.id)

      const usage = message.usage ?? {}
      const effort = String(line.effort ?? 'none')

      totals.requests += 1
      totals.output += usage.output_tokens ?? 0
      totals.cacheRead += usage.cache_read_input_tokens ?? 0
      totals.input +=
        (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0)
      totals.efforts[effort] = (totals.efforts[effort] ?? 0) + 1
    }
  }

  return totals
}

function report(): void {
  const days = option('days', 7)
  const baselineDays = option('baseline-days', 14)
  const now = Date.now()
  const split = now - days * 86_400_000
  const files = transcripts(days + baselineDays)

  const rows: [string, Totals][] = [
    [`previous ${baselineDays} d`, totalsOf(files, split - baselineDays * 86_400_000, split)],
    [`last ${days} d`, totalsOf(files, split, now)],
  ]

  for (const [name, t] of rows) {
    const mix = Object.entries(t.efforts)
      .sort((a, b) => b[1] - a[1])
      .map(([effort, n]) => `${effort} ${((100 * n) / Math.max(t.requests, 1)).toFixed(0)}%`)
      .join(', ')

    console.log(`${name}: ${t.prompts} prompts, ${t.requests} requests`)
    console.log(`  requests per prompt ${(t.requests / Math.max(t.prompts, 1)).toFixed(1)}; output tokens per prompt ${Math.round(t.output / Math.max(t.prompts, 1))}; cache read share ${((100 * t.cacheRead) / Math.max(t.input, 1)).toFixed(1)}%`)
    console.log(`  effort mix: ${mix}`)
  }

  const logs = existsSync(STATE) ? readdirSync(STATE).filter(name => name.endsWith('.jsonl')) : []
  const records = logs.flatMap(name => readJsonl<Record<string, unknown>>(join(STATE, name)))
  const reasons: Record<string, number> = {}

  for (const record of records.filter(r => r.type === 'turn')) {
    const reason = String(record.reason ?? 'none').replace(/^fallback: .*/, 'fallback')

    reasons[reason] = (reasons[reason] ?? 0) + 1
  }

  console.log(`\ndecision logs: ${logs.length} sessions, ${records.filter(r => r.type === 'turn').length} turns, ${records.filter(r => r.type === 'label').length} labels`)
  console.log(`  reasons: ${Object.entries(reasons).map(([r, n]) => `${r} ${n}`).join(', ') || 'none'}`)
}

const COMMANDS: Record<string, () => unknown> = { sample, autolabel, label, score, report }

if (import.meta.main) {
  const run = command ? COMMANDS[command] : undefined

  if (!run) {
    console.error('usage: bun eval/effort-eval.ts sample|autolabel|label|score|report [options]')
    process.exit(2)
  }

  await run()
}
