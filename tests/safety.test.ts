// Effort inheritance, unanswered-decision status, telemetry and health order.
// Each test fails on the 2026-09-28 combined prototype and passes with its fix.
import type { Engine } from 'claude-code/testing'
import { describe, expect, test, tier } from 'claude-code/testing'

import { world } from './fixtures/world'

tier('user')

const STARTED = { cwd: '/work', surface: 'terminal', isInteractive: true } as const
const COOLDOWN = 300_001

async function drain(stream: ReturnType<Engine['turn']['step']>): Promise<void> {
  for await (const chunk of stream) void chunk
  await stream.result
}
function startStep($: Engine, turnId: string, index: number, effort: string): Promise<void> {
  return drain($.turn.step({ turnId, index, model: 'claude-opus-5-5', effort: effort as 'xhigh', messageCount: 1 + index }))
}
async function step($: Engine, turnId: string, index: number, effort: string): Promise<void> {
  await startStep($, turnId, index, effort)
}
async function complete($: Engine, turnId: string): Promise<void> {
  await $.turn.complete({ turnId, answer: 'done', durationMs: 10, isAborted: false, reason: 'answer' })
}
async function turn($: Engine, turnId: string, text: string, efforts: string[]): Promise<void> {
  await $.turn.start({ text, turnId })
  for (const [index, effort] of efforts.entries()) await step($, turnId, index, effort)
  await complete($, turnId)
}
async function spinner($: Engine, drawn: string[]): Promise<string | undefined> {
  await $.ui.render({ surface: 'terminal', component: 'Spinner', requestId: 'the-session',
    props: { word: 'Baking', message: null, suffix: '…', mode: 'thinking' } } as never)
  return drawn.at(-1)
}
async function command($: Engine, args: string): Promise<string | undefined> {
  return (await $.command.run({ command: 'effort-router', args, origin: { kind: 'composer' } } as never)).text
}
function previousTaskOf(w: ReturnType<typeof world>): { request: string; level?: string; observations: unknown[] } {
  return JSON.parse(w.posts.at(-1)!.init!.body!).state.task_context.previousTask
}

describe('only a level the router chose is inherited', () => {
  test('I1 a manual low turn without an answer leaves an empty turn to its fallback', async ($, on) => {
    const w = world(on, { answers: [503], saved: { 'claude-opus-5-5': 'xhigh' } })
    await $.session.start(STARTED)
    await command($, 'enforce')
    await turn($, 'manual', 'Design the queue.', ['low'])
    expect(w.records()[0]?.manual).toBe(true)
    await turn($, 'automatic', '', ['xhigh'])
    expect(w.sent).toEqual(['low', 'xhigh'])
    expect(w.records()[1]).toMatchObject({ reason: 'fallback: no previous pick' })
  })

  test('I2 a yielded last request does not become the pick of a failed turn', async ($, on) => {
    const w = world(on, { answers: [503], saved: { 'claude-opus-5-5': 'xhigh' } })
    await $.session.start(STARTED)
    await command($, 'enforce')
    await turn($, 'yielded', 'Design the queue.', ['xhigh', 'low'])
    expect((w.records()[0]?.steps as { yielded?: boolean }[])[1]?.yielded).toBe(true)
    await turn($, 'automatic', '', ['xhigh'])
    expect(w.sent).toEqual(['xhigh', 'low', 'xhigh'])
    expect(w.records()[1]).toMatchObject({ reason: 'inherit', would_pick: 'xhigh' })
  })

  test('I3 a manual turn without an answer drops an older pick below the usual level', async ($, on) => {
    const w = world(on, { answers: [{ low: 1 }, 503], saved: { 'claude-opus-5-5': 'xhigh' } })
    await $.session.start(STARTED)
    await command($, 'enforce')
    await turn($, 'a', 'Reply with exactly OK.', ['xhigh'])
    await turn($, 'b', 'Design a lock-free scheduler for the runtime', ['medium'])
    await turn($, 'c', '', ['xhigh'])
    expect(w.sent).toEqual(['low', 'medium', 'xhigh'])
    expect(w.records()[2]).toMatchObject({ reason: 'fallback: no previous pick' })
  })

  test('I4 a manual turn held by missing context holds at the usual level, not its own', async ($, on) => {
    const w = world(on, { contexts: ['missing_scope'], saved: { 'claude-opus-5-5': 'xhigh' } })
    await $.session.start(STARTED)
    await command($, 'enforce')
    await turn($, 'manual', 'Design the queue.', ['medium'])
    expect(w.records()[0]).toMatchObject({ manual: true, would_pick: 'xhigh', reason: 'insufficient context' })
    await turn($, 'automatic', '', ['xhigh'])
    expect(w.sent).toEqual(['medium', 'xhigh'])
  })

  test('I5 a manual continuation without an answer keeps the task and its higher level', async ($, on) => {
    const w = world(on, { answers: [{ xhigh: 1 }, 503, { low: 1 }], saved: { 'claude-opus-5-5': 'medium' } })
    await $.session.start(STARTED)
    await command($, 'enforce')
    await turn($, 'a', 'Design a lock-free scheduler for the runtime', ['medium'])
    await turn($, 'b', 'Continue', ['high'])
    expect(w.records()[1]).toMatchObject({ manual: true })
    await $.turn.start({ text: 'Continue', turnId: 'c' })
    await step($, 'c', 0, 'medium')
    expect(previousTaskOf(w)).toMatchObject({ request: 'Design a lock-free scheduler for the runtime\nFollow-up: Continue', level: 'xhigh' })
    await complete($, 'c')
    expect(w.sent).toEqual(['xhigh', 'high', 'xhigh'])
    expect(w.records()[2]).toMatchObject({ reason: 'continue task' })
  })
})

describe('an unanswered continuation keeps its task', () => {
  test('T1 a "Continue" without an answer extends the task it continues, with its evidence', async ($, on) => {
    // The first task's decision and its discovery answer; every later request fails.
    const w = world(on, { answers: [{ xhigh: 1 }, { xhigh: 1 }, 503], saved: { 'claude-opus-5-5': 'medium' } })
    on('tool.call', () => ({ result: {}, text: 'export function schedule() { return queue.shift() }', isReadOnly: true }))
    await $.session.start(STARTED)
    await command($, 'enforce')
    await $.turn.start({ text: 'Design a lock-free scheduler for the runtime', turnId: 'a' })
    await step($, 'a', 0, 'medium')
    await $.tool.call({ tool: 'Read', file_path: '/work/scheduler.ts' })
    await step($, 'a', 1, 'medium')
    await complete($, 'a')
    await turn($, 'b', 'Continue', ['medium'])
    expect(w.records()[1]!.reason).toMatch(/^fallback/)
    await $.turn.start({ text: 'Continue', turnId: 'c' })
    await step($, 'c', 0, 'medium')
    const previous = previousTaskOf(w)
    expect(previous).toMatchObject({ request: 'Design a lock-free scheduler for the runtime\nFollow-up: Continue', level: 'xhigh' })
    expect(previous.observations).toHaveLength(1)
    await complete($, 'c')
    expect(w.sent.slice(0, 3)).toEqual(['xhigh', 'xhigh', 'medium'])
  })

  test('T2 control: a new task without an answer still replaces the remembered task', async ($, on) => {
    const w = world(on, { answers: [{ xhigh: 1 }, 503, { low: 1 }], saved: { 'claude-opus-5-5': 'medium' } })
    await $.session.start(STARTED)
    await command($, 'enforce')
    await turn($, 'a', 'Design a lock-free scheduler for the runtime', ['medium'])
    await turn($, 'b', 'Write the release notes', ['medium'])
    await $.turn.start({ text: 'Continue', turnId: 'c' })
    await step($, 'c', 0, 'medium')
    expect(previousTaskOf(w).request).toBe('Write the release notes')
    await complete($, 'c')
  })

  test('T3 a "Continue" whose decision and discovery both fail keeps the task level, not the effort it kept', async ($, on) => {
    // The first task answers xhigh; the "Continue" decision and its discovery fail; then the service answers low.
    const w = world(on, { answers: [{ xhigh: 1 }, 503, 503, 503, 503, { low: 1 }], saved: { 'claude-opus-5-5': 'medium' } })
    on('tool.call', () => ({ result: {}, text: 'export function schedule() { return queue.shift() }', isReadOnly: true }))
    await $.session.start(STARTED)
    await command($, 'enforce')
    await turn($, 'a', 'Design a lock-free scheduler for the runtime', ['medium'])
    await $.turn.start({ text: 'Continue', turnId: 'b' })
    await step($, 'b', 0, 'medium')
    await $.tool.call({ tool: 'Read', file_path: '/work/scheduler.ts' })
    await step($, 'b', 1, 'medium')
    await complete($, 'b')
    expect(w.records()[1]).toMatchObject({ reason: 'fallback: discovery http 503', would_pick: 'medium' })
    await $.turn.start({ text: 'Continue', turnId: 'c' })
    await step($, 'c', 0, 'medium')
    expect(previousTaskOf(w)).toMatchObject({ request: 'Design a lock-free scheduler for the runtime\nFollow-up: Continue', level: 'xhigh' })
    await complete($, 'c')
    await turn($, 'd', '', ['medium'])
    expect(w.sent).toEqual(['xhigh', 'medium', 'medium', 'xhigh', 'xhigh'])
    expect(w.records()[3]).toMatchObject({ reason: 'inherit', would_pick: 'xhigh' })
  })
})

describe('the unanswered decision is reported from the recovery state', () => {
  test('U1 spent discovery budget keeps the note and status line; the retry cannot lower', async ($, on) => {
    const w = world(on, { answers: [503, 503, 503, { low: 1 }], saved: { 'claude-opus-5-5': 'xhigh' } })
    on('tool.call', ($, e) => ({ result: {}, text: `export const value = '${'file_path' in e ? e.file_path : 'unknown'}'`, isReadOnly: true }))
    await $.session.start(STARTED)
    await command($, 'enforce')
    await $.turn.start({ text: 'Explain how this implementation works.', turnId: 't' })
    await step($, 't', 0, 'xhigh')
    for (let i = 1; i <= 3; i++) {
      await $.tool.call({ tool: 'Read', file_path: `/work/part${i}.ts` })
      await step($, 't', i, 'xhigh')
    }
    expect(w.posts).toHaveLength(3)
    expect(await command($, 'status')).toContain('turn: no classifier answer yet (http 503); retries on a later request')
    expect(await spinner($, w.drawn)).toBe('Baking… at xhigh effort (router: http 503)')
    await w.clock.advance(COOLDOWN)
    await step($, 't', 4, 'xhigh')
    expect(w.posts, 'the unanswered decision still retries after the pause').toHaveLength(4)
    expect(w.sent.every(e => e === 'xhigh'), 'a failure never grants permission to lower').toBe(true)
    expect(await command($, 'status')).not.toContain('turn: no classifier answer')
    await complete($, 't')
    expect((w.records()[0]!.discovery as { recovery?: boolean }[]).at(-1)?.recovery).toBe(true)
  })

  // Test-kit evidence: the engine's hook budget runs while the fixture waits real time.
  test('U2 a real hook-budget deferral keeps the note and status line, and logs the deferral', { timeoutMs: 15_000 }, async ($, on) => {
    const w = world(on, { answers: [503, { low: 1 }, { low: 1 }] as never, contexts: ['sufficient'], wallDelays: { 2: 4800 } })
    on('prompt.submit', (_$, e) => ({ text: e.text }))
    on('tool.call', (_$, e) => ({ result: {}, text: `source ${'file_path' in e ? e.file_path : ''}`, isReadOnly: true }))
    await $.session.start(STARTED)
    await command($, 'enforce')
    await $.turn.start({ text: 'Explain the application', turnId: 't1' })
    await step($, 't1', 0, 'xhigh')
    await $.prompt.submit({ turnId: 't1', text: 'Keep the final explanation to one sentence.', wait: false, origin: { kind: 'composer' } })
    await $.tool.call({ tool: 'Read', file_path: '/work/a.ts' })
    await step($, 't1', 1, 'xhigh')
    expect(w.posts, 'deferred: no discovery request').toHaveLength(2)
    expect(await spinner($, w.drawn)).toBe('Baking… at xhigh effort (router: http 503, retrying)')
    expect(await command($, 'status')).toContain('turn: no classifier answer yet (http 503); retries on a later request')
    await $.tool.call({ tool: 'Read', file_path: '/work/b.ts' })
    await step($, 't1', 2, 'xhigh')
    await complete($, 't1')
    expect(w.sent).toEqual(['xhigh', 'xhigh', 'xhigh'])
    const record = w.records()[0]!
    const steps = record.steps as { deferred?: { remainingMs: number; neededMs: number; evidence?: boolean; retry?: boolean } }[]
    expect(steps[1]?.deferred).toMatchObject({ neededMs: 5500, evidence: true, retry: true })
    expect(steps[1]!.deferred!.remainingMs).toBeLessThan(5500)
    expect(steps[2]?.deferred).toBeUndefined()
    expect(typeof (record.mid_turn as { latency_ms?: number }[])[0]?.latency_ms).toBe('number')
  })
})

describe('telemetry for the sufficient-context floor', () => {
  test('M1 the log shows the floor and the discovery answer it replaced', async ($, on) => {
    const w = world(on, { answers: [{ high: 1 }, { low: 1 }, { low: 1 }], contexts: ['sufficient', 'missing_scope', 'sufficient'] })
    on('tool.call', (_$, e) => ({ result: {}, text: `source ${'file_path' in e ? e.file_path : ''}`, isReadOnly: true }))
    await $.session.start(STARTED)
    await command($, 'enforce')
    await $.turn.start({ text: 'Explain the application', turnId: 't1' })
    await step($, 't1', 0, 'xhigh')
    for (let i = 1; i <= 2; i++) {
      await $.tool.call({ tool: 'Read', file_path: `/work/f${i}.ts` })
      await step($, 't1', i, 'xhigh')
    }
    await complete($, 't1')
    expect(w.sent).toEqual(['high', 'xhigh', 'high'])
    const record = w.records()[0]!
    expect(record.assessed_floor).toBe('high')
    expect((record.discovery as { level: string; assessedFloor?: string }[]).map(d => [d.level, d.assessedFloor]))
      .toEqual([['xhigh', undefined], ['low', 'high']])
  })
})

// The converse of lifecycle L3b.
describe('health follows the latest request sent', () => {
  test('H2 an older request that answers late does not hide a newer failure', async ($, on) => {
    const w = world(on, { answers: [503, { after: 2_000, answer: { xhigh: 1 } }, 503] })
    on('prompt.submit', ($, e) => ({ text: e.text }))
    on('tool.call', () => ({ result: {}, text: 'ok' }))
    await $.session.start(STARTED)
    await command($, 'enforce')
    await $.turn.start({ text: 'Migrate the services to the new cluster', turnId: 't' })
    await step($, 't', 0, 'high')
    await $.tool.call({ tool: 'Bash', command: 'kubectl apply' })
    await w.clock.advance(61_000)
    const inFlight = startStep($, 't', 1, 'high')
    await w.clock.settle()
    await $.prompt.submit({ text: 'also update the docs', turnId: 't', wait: false, origin: { kind: 'composer' } })
    await w.clock.settle()
    await w.clock.advance(2_000)
    await inFlight
    expect(w.sent, 'the late retry answer still applies to the turn').toEqual(['high', 'xhigh'])
    const status = await command($, 'status')
    expect(status).toContain('failing (http 503)')
    expect(status).not.toContain('turn: no classifier answer')
    await complete($, 't')
  })

  test('H3 failures of older requests that settle after a newer answer cannot pause the classifier', async ($, on) => {
    const w = world(on, { answers: [{ low: 1 }, 'hang', 'hang', 'hang', { low: 1 }] })
    on('prompt.submit', ($, e) => ({ text: e.text }))
    await $.session.start(STARTED)
    await $.turn.start({ text: 'Migrate the services to the new cluster', turnId: 't' })
    await step($, 't', 0, 'high')
    for (let i = 1; i <= 4; i++) await $.prompt.submit({ text: `note ${i}: also check the rollback`, turnId: 't', wait: false, origin: { kind: 'composer' } })
    await w.clock.settle()
    expect(w.posts, 'three messages pending, the fourth answered').toHaveLength(5)
    await w.clock.advance(5_000)
    await w.clock.settle()
    const status = await command($, 'status')
    expect(status).toContain('ok (')
    expect(status).not.toContain('paused')
    await complete($, 't')
    await turn($, 'next', 'Reply with exactly OK.', ['high'])
    expect(w.posts.length, 'the next turn asks the classifier').toBeGreaterThan(5)
    expect(w.records().at(-1)!.reason).not.toMatch(/^fallback/)
    expect(w.said.filter(line => line.startsWith('classifier failing'))).toHaveLength(0)
  })

  test('H4 the order holds across a session reset: the new session answer wins over old late failures', async ($, on) => {
    const w = world(on, { answers: [{ low: 1 }, 'hang', 'hang', 'hang', { low: 1 }] })
    on('prompt.submit', ($, e) => ({ text: e.text }))
    await $.session.start(STARTED)
    await $.turn.start({ text: 'Migrate the services to the new cluster', turnId: 'old' })
    await step($, 'old', 0, 'high')
    for (let i = 1; i <= 3; i++) await $.prompt.submit({ text: `note ${i}: also check the rollback`, turnId: 'old', wait: false, origin: { kind: 'composer' } })
    await w.clock.settle()
    w.session.id = 'after-clear'
    await $.session.start(STARTED)
    await turn($, 'fresh', 'Reply with exactly OK.', ['high'])
    expect(w.posts).toHaveLength(5)
    await w.clock.advance(5_000)
    await w.clock.settle()
    expect(await command($, 'status')).not.toContain('paused')
    await turn($, 'next', 'Reply with exactly OK again.', ['high'])
    expect(w.posts.length).toBeGreaterThan(5)
    expect(w.records('after-clear').at(-1)!.reason).not.toMatch(/^fallback/)
  })
})

/** A 25-minute turn: a Bash action and a model request every 30 s; the step indices that sent a classifier request. */
async function longTurn($: Engine, w: ReturnType<typeof world>, effort: string): Promise<number[]> {
  await $.turn.start({ text: 'Migrate the services to the new cluster', turnId: 'long' })
  await step($, 'long', 0, effort)
  await w.clock.settle()
  const asked: number[] = []
  for (let i = 1; i <= 50; i++) {
    const before = w.posts.length
    await $.tool.call({ tool: 'Bash', command: 'kubectl apply' })
    await w.clock.advance(30_000)
    await step($, 'long', i, effort)
    await w.clock.settle()
    if (w.posts.length > before) asked.push(i)
  }
  return asked
}

describe('a long outage keeps a bounded retry schedule', () => {
  // Six failures, then the service answers.
  const OUTAGE = [503, 503, 503, 503, 503, 503, { xhigh: 1 }] as const

  test('O1 the turn recovers on a request after many failed retries, never more than once a minute', async ($, on) => {
    const w = world(on, { answers: OUTAGE, saved: { 'claude-opus-5-5': 'medium' } })
    on('tool.call', () => ({ result: {}, text: 'ok' }))
    await $.session.start(STARTED)
    await command($, 'enforce')
    const asked = await longTurn($, w, 'medium')
    // 60 s and 180 s by backoff; the breaker opens at 180 s, then its cooldown and
    // the five-minute backoff agree: 480, 780, 1080 s, and the answer at 1380 s.
    expect(asked).toEqual([2, 6, 16, 26, 36, 46])
    expect(w.sent.slice(0, 46).every(e => e === 'medium'), 'no change while unanswered').toBe(true)
    expect(w.sent.slice(46).every(e => e === 'xhigh'), 'the recovered answer raises the rest of the turn').toBe(true)
    expect(await command($, 'status')).not.toContain('turn: no classifier answer')
    await complete($, 'long')
    expect(w.records().at(-1)!.reason).not.toMatch(/^fallback/)
  })

  test('O2 shadow: the same schedule predicts the recovered level and changes no request', async ($, on) => {
    const w = world(on, { answers: OUTAGE, saved: { 'claude-opus-5-5': 'medium' } })
    on('tool.call', () => ({ result: {}, text: 'ok' }))
    await $.session.start(STARTED)
    const asked = await longTurn($, w, 'medium')
    expect(asked).toEqual([2, 6, 16, 26, 36, 46])
    expect(w.sent.every(e => e === 'medium')).toBe(true)
    await complete($, 'long')
    const steps = w.records().at(-1)!.steps as { would?: string }[]
    expect(steps.slice(46).every(s => s.would === 'xhigh')).toBe(true)
  })

  test('O3 a manual turn never retries, however long the outage', async ($, on) => {
    const w = world(on, { answers: OUTAGE, saved: { 'claude-opus-5-5': 'medium' } })
    on('tool.call', () => ({ result: {}, text: 'ok' }))
    await $.session.start(STARTED)
    await command($, 'enforce')
    const asked = await longTurn($, w, 'xhigh')
    expect(asked).toEqual([])
    expect(w.posts).toHaveLength(1)
    expect(w.sent.every(e => e === 'xhigh')).toBe(true)
    expect(await command($, 'status')).not.toContain('turn: no classifier answer')
    await complete($, 'long')
  })
})
