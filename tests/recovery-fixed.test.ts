// Expected behavior of the experimental recovery fix.
import type { Engine } from 'claude-code/testing'
import { describe, expect, test, tier } from 'claude-code/testing'

import { world } from './fixtures/world'

tier('user')

const STARTED = { cwd: '/work', surface: 'terminal', isInteractive: true } as const
const COOLDOWN = 300_001

async function step($: Engine, turnId: string, index: number, effort: string): Promise<void> {
  const stream = $.turn.step({ turnId, index, model: 'claude-opus-5-5', effort: effort as 'xhigh', messageCount: 1 + index })
  for await (const chunk of stream) void chunk
  await stream.result
}

async function complete($: Engine, turnId: string): Promise<void> {
  await $.turn.complete({ turnId, answer: 'done', durationMs: 10, isAborted: false, reason: 'answer' })
}

async function spinner($: Engine, drawn: string[]): Promise<string | undefined> {
  await $.ui.render({ surface: 'terminal', component: 'Spinner', requestId: 'the-session',
    props: { word: 'Baking', message: null, suffix: '…', mode: 'thinking' } } as never)
  return drawn.at(-1)
}

async function command($: Engine, args: string): Promise<string | undefined> {
  return (await $.command.run({ command: 'effort-router', args, origin: { kind: 'composer' } } as never)).text
}

async function openBreaker($: Engine, effort = 'xhigh'): Promise<void> {
  for (const turnId of ['f1', 'f2', 'f3']) {
    await $.turn.start({ text: 'Reply with exactly OK.', turnId })
    await step($, turnId, 0, effort)
    await complete($, turnId)
  }
}

describe('recovery fix', () => {
  test('F1 a transient failure retries once on a later request and never lowers after work', async ($, on) => {
    const w = world(on, { answers: [503, { low: 1 }] })
    on('tool.call', () => ({ result: {}, text: 'ok' }))
    await $.session.start(STARTED)
    await command($, 'enforce')
    await $.turn.start({ text: 'Migrate the services to the new cluster', turnId: 'long' })
    await step($, 'long', 0, 'xhigh')
    await $.tool.call({ tool: 'Bash', command: 'kubectl apply' })
    await w.clock.advance(30_000)
    await step($, 'long', 1, 'xhigh')
    expect(w.posts, 'no retry before the spacing').toHaveLength(1)
    for (let i = 2; i <= 6; i++) {
      await $.tool.call({ tool: 'Bash', command: 'kubectl apply' })
      await w.clock.advance(60_000)
      await step($, 'long', i, 'xhigh')
    }
    expect(w.posts, 'one recovery request, then none').toHaveLength(2)
    expect(w.sent.every(e => e === 'xhigh'), 'no lowering after an action').toBe(true)
    expect(await spinner($, w.drawn)).toBe('Baking… at xhigh effort (kept for active work)')
    expect(await command($, 'status')).toContain('ok (')
    await complete($, 'long')
    expect(w.records().at(-1)).toMatchObject({ reason: 'work in progress', would_pick: 'xhigh' })
    expect((w.records().at(-1)!.discovery as { recovery?: boolean }[])[0]?.recovery).toBe(true)
  })

  test('F2 a recovered classifier raises a long turn above the session effort', async ($, on) => {
    const w = world(on, { answers: [503, { xhigh: 1 }], saved: { 'claude-opus-5-5': 'medium' } })
    on('tool.call', () => ({ result: {}, text: 'ok' }))
    await $.session.start(STARTED)
    await command($, 'enforce')
    await $.turn.start({ text: 'Rotate the signing keys across services', turnId: 'long' })
    await step($, 'long', 0, 'medium')
    for (let i = 1; i <= 3; i++) {
      await $.tool.call({ tool: 'Bash', command: 'deploy' })
      await w.clock.advance(61_000)
      await step($, 'long', i, 'medium')
    }
    expect(w.sent).toEqual(['medium', 'xhigh', 'xhigh', 'xhigh'])
    expect(w.posts).toHaveLength(2)
  })

  test('F3 time alone sends nothing; the first request after the cooldown retries', async ($, on) => {
    const w = world(on, { answers: [503, 503, 503, { low: 1 }] })
    on('tool.call', () => ({ result: {}, text: 'ok' }))
    await $.session.start(STARTED)
    await command($, 'enforce')
    await openBreaker($)
    await $.turn.start({ text: 'Migrate the services to the new cluster', turnId: 'long' })
    await step($, 'long', 0, 'xhigh')
    expect(await command($, 'status')).toMatch(/failing \(http 503\); paused 300 s more/)
    await $.tool.call({ tool: 'Bash', command: 'kubectl apply' })
    await step($, 'long', 1, 'xhigh')
    await w.clock.advance(COOLDOWN)
    await w.clock.settle()
    expect(w.posts, 'elapsed time alone creates no request').toHaveLength(3)
    await step($, 'long', 2, 'xhigh')
    expect(w.posts, 'one classification: three ensemble bodies after earlier turns').toHaveLength(6)
    expect(await spinner($, w.drawn)).toBe('Baking… at xhigh effort (kept for active work)')
    await complete($, 'long')
  })

  test('F4 paused discovery keeps its budget and evidence for the retry', async ($, on) => {
    const w = world(on, { answers: [503, 503, 503, { low: 1 }] })
    on('tool.call', ($, e) => ({ result: {}, text: `source of ${'file_path' in e ? e.file_path : ''}: export const x = 1`, isReadOnly: true }))
    await $.session.start(STARTED)
    await command($, 'enforce')
    await openBreaker($)
    await $.turn.start({ text: 'Explain the application', turnId: 'long' })
    await step($, 'long', 0, 'xhigh')
    await $.tool.call({ tool: 'Read', file_path: '/work/a.ts' })
    await step($, 'long', 1, 'xhigh')
    await $.tool.call({ tool: 'Read', file_path: '/work/b.ts' })
    await step($, 'long', 2, 'xhigh')
    expect(w.posts).toHaveLength(3)
    await w.clock.advance(COOLDOWN)
    await step($, 'long', 3, 'xhigh')
    expect(w.posts, 'the unchecked evidence is assessed once the pause ends (three ensemble bodies)').toHaveLength(6)
    expect(w.sent.at(-1), 'a failure never grants permission to lower').toBe('xhigh')
    await $.tool.call({ tool: 'Read', file_path: '/work/c.ts' })
    await step($, 'long', 4, 'xhigh')
    expect(w.posts, 'regular discovery budget is still available').toHaveLength(9)
    await complete($, 'long')
    const record = w.records().at(-1)!
    expect((record.discovery as { reason: string }[]).some(d => d.reason === 'fallback: classifier paused')).toBe(false)
  })

  test('F5 a persistent outage retries at most once per five minutes after the first backoff steps', async ($, on) => {
    const w = world(on, { answers: [503] })
    on('tool.call', () => ({ result: {}, text: 'ok' }))
    await $.session.start(STARTED)
    await command($, 'enforce')
    await $.turn.start({ text: 'Migrate the services to the new cluster', turnId: 'long' })
    await step($, 'long', 0, 'xhigh')
    for (let i = 1; i <= 60; i++) {
      await $.tool.call({ tool: 'Bash', command: 'kubectl apply' })
      await w.clock.advance(30_000)
      await step($, 'long', i, 'xhigh')
    }
    // The initial decision, then retries at 60 s and 180 s; the breaker then opens at 180 s,
    // so the rest follow its cooldown: 480, 780, 1080, 1380 and 1680 s.
    expect(w.posts).toHaveLength(8)
    expect(w.sent.every(e => e === 'xhigh')).toBe(true)
    await complete($, 'long')
    expect(w.said.filter(line => line.startsWith('classifier failing'))).toHaveLength(1)
  })

  test('F6 a typed task without a decision passes on the effort it ran at, not a lower older pick', async ($, on) => {
    const w = world(on, { answers: [{ low: 1 }, 503, { xhigh: 1 }] })
    await $.session.start(STARTED)
    await command($, 'enforce')
    await $.turn.start({ text: 'Reply with exactly OK.', turnId: 'a' })
    await step($, 'a', 0, 'xhigh')
    await complete($, 'a')
    await $.turn.start({ text: 'Design a lock-free scheduler for the runtime', turnId: 'b' })
    await step($, 'b', 0, 'xhigh')
    await complete($, 'b')
    await $.turn.start({ text: '', turnId: 'c' })
    await step($, 'c', 0, 'xhigh')
    await complete($, 'c')
    expect(w.sent).toEqual(['low', 'xhigh', 'xhigh'])
    expect(w.records().at(-1)).toMatchObject({ reason: 'inherit', would_pick: 'xhigh' })
    await $.turn.start({ text: 'Continue', turnId: 'd' })
    await step($, 'd', 0, 'xhigh')
    const body = JSON.parse(w.posts.at(-1)!.init!.body!)
    expect(body.state.task_context.previousTask.level).toBe('xhigh')
  })

  test('F6b an outage turn inside a continuing task keeps the task floor', async ($, on) => {
    const w = world(on, { answers: [{ xhigh: 1 }, 503, { low: 1 }], saved: { 'claude-opus-5-5': 'medium' } })
    await $.session.start(STARTED)
    await command($, 'enforce')
    await $.turn.start({ text: 'Design a lock-free scheduler for the runtime', turnId: 'a' })
    await step($, 'a', 0, 'medium')
    await complete($, 'a')
    await $.turn.start({ text: 'Continue', turnId: 'b' })
    await step($, 'b', 0, 'medium')
    await complete($, 'b')
    await $.turn.start({ text: 'Continue', turnId: 'c' })
    await step($, 'c', 0, 'medium')
    await complete($, 'c')
    expect(w.sent).toEqual(['xhigh', 'medium', 'xhigh'])
    expect(w.records().at(-1)).toMatchObject({ reason: 'continue task' })
  })

  test('F9 [needs floor fix] a hold from a paused check is released no lower than the confident pick', async ($, on) => {
    const w = world(on, { answers: [{ high: 1 }, 503, 503, 503, { low: 1 }] })
    on('prompt.submit', ($, e) => ({ text: e.text }))
    on('tool.call', () => ({ result: {}, text: 'export function run() { return 1 }', isReadOnly: true }))
    await $.session.start(STARTED)
    await command($, 'enforce')
    await $.turn.start({ text: 'Explain the application', turnId: 't' })
    await step($, 't', 0, 'xhigh')
    for (let i = 0; i < 3; i++) await $.prompt.submit({ text: `note ${i}: keep going`, turnId: 't', wait: false, origin: { kind: 'composer' } })
    await step($, 't', 1, 'xhigh')
    await $.tool.call({ tool: 'Read', file_path: '/work/app.ts' })
    await step($, 't', 2, 'xhigh')
    await w.clock.advance(COOLDOWN)
    await step($, 't', 3, 'xhigh')
    await complete($, 't')
    // high: confident pick; xhigh: the paused check held the session effort.
    expect(w.sent.slice(0, 3)).toEqual(['high', 'high', 'xhigh'])
    // Needs the floor fix: without it the released hold drops below the confident high to low.
    expect(w.sent.at(-1)).toBe('high')
    expect(w.records().at(-1)).toMatchObject({ reason: 'retained effort' })
  })

  test('F7 a successful mid-turn message lets the next request refresh the turn', async ($, on) => {
    const w = world(on, { answers: [503, 503, 503, { xhigh: 1 }] })
    on('prompt.submit', ($, e) => ({ text: e.text }))
    await $.session.start(STARTED)
    await command($, 'enforce')
    await openBreaker($, 'high')
    await $.turn.start({ text: 'Migrate the services to the new cluster', turnId: 'long' })
    await step($, 'long', 0, 'high')
    await w.clock.advance(COOLDOWN)
    await $.prompt.submit({ text: 'careful: this touches the auth token rotation', turnId: 'long', wait: false, origin: { kind: 'composer' } })
    await step($, 'long', 1, 'high')
    expect(w.posts, 'three failures, the message, one three-body recovery').toHaveLength(7)
    expect(w.sent.slice(-2)).toEqual(['high', 'xhigh'])
    expect(await spinner($, w.drawn)).not.toContain('paused')
    await complete($, 'long')
    expect(w.records().at(-1)!.reason).not.toMatch(/^fallback/)
  })

  test('F8 a second outage in the same session is announced again', async ($, on) => {
    const w = world(on, { answers: [503, 503, 503, { low: 1 }, 503, 503, 503] })
    await $.session.start(STARTED)
    await command($, 'enforce')
    await openBreaker($)
    await w.clock.advance(COOLDOWN)
    await $.turn.start({ text: 'Reply with exactly OK.', turnId: 'ok' })
    await step($, 'ok', 0, 'xhigh')
    await complete($, 'ok')
    for (const turnId of ['g1', 'g2', 'g3']) {
      await $.turn.start({ text: 'Reply with exactly OK.', turnId })
      await step($, turnId, 0, 'xhigh')
      await complete($, turnId)
    }
    expect(w.said.filter(line => line.startsWith('classifier failing'))).toHaveLength(2)
  })
})

describe('strict failure policy', () => {
  test('F10 a failed initial decision is never lowered by a later answer, with or without a failed check between', async ($, on) => {
    const w = world(on, { answers: [503, 503, { low: 1 }] })
    on('tool.call', ($, e) => ({ result: {}, text: `source ${'file_path' in e ? e.file_path : ''}: button.onclick = () => count++`, isReadOnly: true }))
    await $.session.start(STARTED)
    await command($, 'enforce')
    await $.turn.start({ text: 'Explain the application', turnId: 't1' })
    await step($, 't1', 0, 'high')
    await $.tool.call({ tool: 'Read', file_path: '/work/a.ts' })
    await step($, 't1', 1, 'high')
    await $.tool.call({ tool: 'Read', file_path: '/work/b.ts' })
    await step($, 't1', 2, 'high')
    await complete($, 't1')
    expect(w.sent).toEqual(['high', 'high', 'high'])
    expect(w.records().at(-1)).toMatchObject({ reason: 'retained effort', context_held: false })
  })
})
