// Lifecycle, cancellation and concurrency around the retry logic (strict recovery + floor prototype).
import type { Engine } from 'claude-code/testing'
import { describe, expect, test, tier } from 'claude-code/testing'

import { world } from './fixtures/world'

tier('user')

const STARTED = { cwd: '/work', surface: 'terminal', isInteractive: true } as const

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
async function command($: Engine, args: string): Promise<string | undefined> {
  return (await $.command.run({ command: 'effort-router', args, origin: { kind: 'composer' } } as never)).text
}

describe('retry lifecycle', () => {
  test('L1 /clear while a retry is in flight: the late result touches nothing in the new session', async ($, on) => {
    const w = world(on, { answers: [503, 'hang', { low: 1 }] })
    on('tool.call', () => ({ result: {}, text: 'ok' }))
    await $.session.start(STARTED)
    await command($, 'enforce')
    await $.turn.start({ text: 'Migrate the services to the new cluster', turnId: 'old' })
    await step($, 'old', 0, 'xhigh')
    await $.tool.call({ tool: 'Bash', command: 'kubectl apply' })
    await w.clock.advance(61_000)
    const inFlight = startStep($, 'old', 1, 'xhigh')
    await w.clock.settle()
    expect(w.posts, 'the retry is in flight').toHaveLength(2)
    w.session.id = 'after-clear'
    await $.session.start(STARTED)
    await w.clock.advance(5_000) // the retry times out after the reset
    await inFlight
    await complete($, 'old') // the old turn's completion after the reset
    await $.turn.start({ text: '', turnId: 'fresh' })
    await step($, 'fresh', 0, 'xhigh')
    await complete($, 'fresh')
    expect(w.records('after-clear')).toMatchObject([{ turnId: 'fresh', reason: 'fallback: no previous pick' }])
    expect(w.records().map(r => r.turnId), 'the old session never logged the cleared turn').toEqual([])
    expect(w.sent.at(-1)).toBe('xhigh')
  })

  test('L2 a turn that completes with a shadow retry in flight waits for it, then the next turn is clean', async ($, on) => {
    const w = world(on, { answers: [503, 'hang', { low: 1 }] })
    on('tool.call', () => ({ result: {}, text: 'ok' }))
    await $.session.start(STARTED)
    await $.turn.start({ text: 'Migrate the services to the new cluster', turnId: 't1' })
    await step($, 't1', 0, 'high')
    await $.tool.call({ tool: 'Bash', command: 'kubectl apply' })
    await w.clock.advance(61_000)
    await step($, 't1', 1, 'high')
    expect(w.posts).toHaveLength(2)
    const completing = complete($, 't1')
    await w.clock.advance(5_000)
    await completing
    const record = w.records().at(-1)!
    expect(record.discovery).toMatchObject([{ reason: 'fallback: timeout', recovery: true }])
    await $.turn.start({ text: 'Reply with exactly OK.', turnId: 't2' })
    await step($, 't2', 0, 'high')
    await complete($, 't2')
    expect(w.records().at(-1)).toMatchObject({ turnId: 't2', would_pick: 'low', discovery: [] })
  })

  test('L3 a message and a retry in flight together: raises combine, one retry, the later result sets health', async ($, on) => {
    const w = world(on, { answers: [503, { after: 2_000, answer: { xhigh: 1 } }, { low: 1 }] })
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
    await step($, 't', 2, 'high')
    expect(w.posts, 'one retry and one message').toHaveLength(3)
    expect(w.sent).toEqual(['high', 'xhigh', 'xhigh'])
    expect(await command($, 'status')).toContain('ok (')
    await complete($, 't')
  })

  test('L3b health follows the latest request sent: a slower failed retry cannot hide a faster successful message', async ($, on) => {
    const w = world(on, { answers: [503, 'hang', { low: 1 }] })
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
    expect(await command($, 'status')).toContain('ok (')
    await w.clock.advance(5_000)
    await inFlight
    const status = await command($, 'status')
    expect(status, 'the retry timed out after the newer message succeeded').toContain('ok (')
    expect(status).toContain('turn: no classifier answer yet (timeout); retries on a later request')
    await $.ui.render({ surface: 'terminal', component: 'Spinner', requestId: 'the-session',
      props: { word: 'Baking', message: null, suffix: '…', mode: 'thinking' } } as never)
    expect(w.drawn.at(-1)).toBe('Baking… at high effort (router: timeout, retrying)')
    await complete($, 't')
  })

  test('L4 retries never overlap: a shadow retry in flight blocks another on later requests', async ($, on) => {
    const w = world(on, { answers: [503, 'hang'] })
    on('tool.call', () => ({ result: {}, text: 'ok' }))
    await $.session.start(STARTED)
    await $.turn.start({ text: 'Migrate the services to the new cluster', turnId: 't' })
    await step($, 't', 0, 'high')
    await $.tool.call({ tool: 'Bash', command: 'kubectl apply' })
    await w.clock.advance(61_000)
    for (let i = 1; i <= 4; i++) await step($, 't', i, 'high')
    expect(w.posts, 'one retry in flight, none stacked').toHaveLength(2)
    await w.clock.advance(5_000)
    await w.clock.settle()
    await step($, 't', 5, 'high')
    expect(w.posts, 'the next retry waits 60 s after the timeout').toHaveLength(2)
    const completing = complete($, 't')
    await w.clock.advance(5_500)
    await completing
  })

  test('L5 a request whose effort another source changed is retried but never rewritten', async ($, on) => {
    const w = world(on, { answers: [503, { xhigh: 1 }] })
    on('tool.call', () => ({ result: {}, text: 'ok' }))
    await $.session.start(STARTED)
    await command($, 'enforce')
    await $.turn.start({ text: 'Migrate the services to the new cluster', turnId: 't' })
    await step($, 't', 0, 'high')
    await $.tool.call({ tool: 'Bash', command: 'kubectl apply' })
    await w.clock.advance(61_000)
    await step($, 't', 1, 'medium') // a skill set another effort for this request
    expect(w.posts).toHaveLength(2)
    expect(w.sent).toEqual(['high', 'medium'])
    await step($, 't', 2, 'high')
    expect(w.sent.at(-1), 'the raise applies once the effort is back at the turn level').toBe('xhigh')
    await complete($, 't')
  })

  test('L6 a manual turn never retries', async ($, on) => {
    const w = world(on, { answers: [{ low: 1 }, 503, { xhigh: 1 }] })
    on('tool.call', () => ({ result: {}, text: 'ok' }))
    await $.session.start(STARTED)
    await command($, 'enforce')
    await $.turn.start({ text: 'Reply with exactly OK.', turnId: 'a' })
    await step($, 'a', 0, 'high')
    await complete($, 'a')
    await $.turn.start({ text: 'Migrate the services to the new cluster', turnId: 'm' })
    await step($, 'm', 0, 'xhigh')
    const initial = w.posts.length // first turn plus the manual turn's two distinct ensemble bodies
    expect(initial).toBe(3)
    for (let i = 1; i <= 4; i++) { await $.tool.call({ tool: 'Bash', command: 'kubectl apply' }); await w.clock.advance(120_000); await step($, 'm', i, 'xhigh') }
    expect(w.posts, 'no retry after the failed initial decision').toHaveLength(initial)
    expect(w.sent.slice(1).every(e => e === 'xhigh')).toBe(true)
    await complete($, 'm')
  })
})
