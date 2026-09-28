// Shadow-mode recovery: no waiting, no effort change, eventual metadata (strict recovery + floor prototype).
import type { Engine } from 'claude-code/testing'
import { describe, expect, test, tier } from 'claude-code/testing'

import { world } from './fixtures/world'

tier('user')

const STARTED = { cwd: '/work', surface: 'terminal', isInteractive: true } as const

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

describe('shadow recovery', () => {
  test('S1 a hanging retry does not hold the request, which keeps the session effort', async ($, on) => {
    const w = world(on, { answers: [503, 'hang'] })
    on('tool.call', () => ({ result: {}, text: 'ok' }))
    await $.session.start(STARTED)
    await $.turn.start({ text: 'Migrate the services to the new cluster', turnId: 't' })
    await step($, 't', 0, 'medium')
    await $.tool.call({ tool: 'Bash', command: 'kubectl apply' })
    await w.clock.advance(61_000)
    const before = w.clock.now
    await step($, 't', 1, 'medium')
    expect(w.clock.now, 'no clock time passed while the request went out').toBe(before)
    expect(w.posts).toHaveLength(2)
    expect(w.sent).toEqual(['medium', 'medium'])
    const completing = complete($, 't')
    await w.clock.advance(5_500)
    await completing
  })

  test('S2 a late successful retry fills the prediction of the request that started it, without changing it', async ($, on) => {
    const w = world(on, { answers: [503, { after: 3_000, answer: { xhigh: 1 } }] })
    on('tool.call', () => ({ result: {}, text: 'ok' }))
    await $.session.start(STARTED)
    await $.turn.start({ text: 'Migrate the services to the new cluster', turnId: 't' })
    await step($, 't', 0, 'medium')
    await $.tool.call({ tool: 'Bash', command: 'kubectl apply' })
    await w.clock.advance(61_000)
    await step($, 't', 1, 'medium')
    expect(await spinner($, w.drawn), 'before the answer lands').toBe('Baking… at medium effort (router: http 503)')
    await w.clock.advance(3_000)
    await w.clock.settle()
    expect(await spinner($, w.drawn)).toBe('Baking… at medium effort (router: xhigh)')
    await step($, 't', 2, 'medium')
    await complete($, 't')
    const record = w.records().at(-1)!
    expect(w.sent).toEqual(['medium', 'medium', 'medium'])
    expect(record).toMatchObject({ mode: 'shadow', reason: 'classifier', would_pick: 'xhigh' })
    expect((record.steps as { sent: string; would?: string }[]).map(s => [s.sent, s.would])).toEqual([['medium', undefined], ['medium', 'xhigh'], ['medium', 'xhigh']])
    expect(record.discovery).toMatchObject([{ recovery: true, level: 'xhigh' }])
  })

  test('S3 a lower retry answer after work predicts no lowering', async ($, on) => {
    const w = world(on, { answers: [503, { low: 1 }] })
    on('tool.call', () => ({ result: {}, text: 'ok' }))
    await $.session.start(STARTED)
    await $.turn.start({ text: 'Migrate the services to the new cluster', turnId: 't' })
    await step($, 't', 0, 'high')
    await $.tool.call({ tool: 'Bash', command: 'kubectl apply' })
    await w.clock.advance(61_000)
    await step($, 't', 1, 'high')
    await w.clock.settle()
    await step($, 't', 2, 'high')
    await complete($, 't')
    const record = w.records().at(-1)!
    expect(w.sent).toEqual(['high', 'high', 'high'])
    expect(record).toMatchObject({ reason: 'work in progress', would_pick: 'high' })
    expect((record.steps as { would?: string }[]).slice(1).map(s => s.would)).toEqual(['high', 'high'])
  })
})
