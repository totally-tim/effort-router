// Expected behavior of the stale-label remedy. On the prior prototype these fail; with the remedy they pass.
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
async function command($: Engine, args: string): Promise<string | undefined> {
  return (await $.command.run({ command: 'effort-router', args, origin: { kind: 'composer' } } as never)).text
}
async function message($: Engine, turnId: string, text = 'careful: this touches the auth token rotation'): Promise<void> {
  await $.prompt.submit({ text, turnId, wait: false, origin: { kind: 'composer' } })
}

/** The N2 sequence: initial failure, three failed retries across one pause; ends 301 s after the last reopen. */
async function spendRetries($: Engine, w: ReturnType<typeof world>, next: (ms: number) => Promise<void>): Promise<void> {
  await next(61_000)
  await next(61_000)
  await next(61_000)
  await next(300_000)
  expect(w.posts).toHaveLength(4)
  await w.clock.advance(301_000)
}

describe('stale-label remedy', () => {
  test('R1 before the retry deadline, a successful message makes the next request retry and the note follows', async ($, on) => {
    const w = world(on, { answers: [503, { xhigh: 1 }] })
    on('prompt.submit', ($, e) => ({ text: e.text }))
    on('tool.call', () => ({ result: {}, text: 'ok' }))
    await $.session.start(STARTED)
    await command($, 'enforce')
    await $.turn.start({ text: 'Migrate the services to the new cluster', turnId: 't' })
    await step($, 't', 0, 'high')
    await $.tool.call({ tool: 'Bash', command: 'kubectl apply' })
    await w.clock.advance(20_000)
    await message($, 't')
    await w.clock.settle()
    expect(w.posts).toHaveLength(2)
    // The in-flight request went out on the failed assessment; the classifier has answered since.
    expect(await spinner($, w.drawn)).toBe('Baking… at high effort (router: http 503, retrying)')
    const status = await command($, 'status')
    expect(status).toContain('ok (')
    expect(status).toContain('turn: no classifier answer yet (http 503); retries on a later request')
    await step($, 't', 1, 'high')
    expect(w.posts, 'the next request retried the turn decision at once').toHaveLength(3)
    expect(w.sent).toEqual(['high', 'xhigh'])
    expect(await spinner($, w.drawn)).toBe('Baking… at xhigh effort (raised by your message)')
    expect(await command($, 'status')).not.toContain('turn: no classifier answer')
    await complete($, 't')
    expect(w.records().at(-1)!.reason).not.toMatch(/^fallback/)
  })

  test('R2 three failed retries do not end recovery: the next due request still retries', async ($, on) => {
    const w = world(on, { answers: [503, 503, 503, 503, { xhigh: 1 }] })
    on('prompt.submit', ($, e) => ({ text: e.text }))
    on('tool.call', () => ({ result: {}, text: 'ok' }))
    await $.session.start(STARTED)
    await command($, 'enforce')
    await $.turn.start({ text: 'Migrate the services to the new cluster', turnId: 't' })
    await step($, 't', 0, 'high')
    let index = 0
    const next = async (ms: number) => { await $.tool.call({ tool: 'Bash', command: 'kubectl apply' }); await w.clock.advance(ms); await step($, 't', ++index, 'high') }
    await spendRetries($, w, next)
    expect(await command($, 'status')).toContain('retries on a later request')
    await next(120_000)
    expect(w.posts, 'the backoff retry after the pause').toHaveLength(5)
    await next(120_000)
    await next(120_000)
    expect(w.posts, 'no further retry after an answer').toHaveLength(5)
    expect(w.sent.slice(-3)).toEqual(['xhigh', 'xhigh', 'xhigh'])
    await complete($, 't')
    expect(w.records().at(-1)!.reason).not.toMatch(/^fallback/)
  })

  test('R3 a failed retry after a message waits the full backoff; each later successful message retries at once', async ($, on) => {
    const w = world(on, { answers: [503, 503, 503, 503, { xhigh: 1 }, 503, { xhigh: 1 }] })
    on('prompt.submit', ($, e) => ({ text: e.text }))
    on('tool.call', () => ({ result: {}, text: 'ok' }))
    await $.session.start(STARTED)
    await command($, 'enforce')
    await $.turn.start({ text: 'Migrate the services to the new cluster', turnId: 't' })
    await step($, 't', 0, 'high')
    let index = 0
    const next = async (ms: number) => { await $.tool.call({ tool: 'Bash', command: 'kubectl apply' }); await w.clock.advance(ms); await step($, 't', ++index, 'high') }
    await spendRetries($, w, next)
    await message($, 't')
    await next(120_000)
    expect(w.posts, 'message succeeded; the retry it allowed failed').toHaveLength(6)
    await next(120_000)
    await next(120_000)
    expect(w.posts, 'the next retry waits the five-minute backoff').toHaveLength(6)
    expect(await spinner($, w.drawn)).toBe('Baking… at xhigh effort (raised by your message)')
    const status = await command($, 'status')
    expect(status).toContain('failing (http 503)')
    expect(status).toContain('turn: no classifier answer yet (http 503); retries on a later request')
    await message($, 't', 'also check the rollback path')
    await next(30_000)
    expect(w.posts, 'second message and its retry, before the backoff ends').toHaveLength(8)
    await next(120_000)
    expect(w.posts).toHaveLength(8)
    await complete($, 't')
    expect(w.records().at(-1)!.reason).not.toMatch(/^fallback/)
  })

  test('R4 a manual turn is never retried and keeps its note', async ($, on) => {
    const w = world(on, { answers: [{ low: 1 }, 503, { xhigh: 1 }] })
    on('prompt.submit', ($, e) => ({ text: e.text }))
    on('tool.call', () => ({ result: {}, text: 'ok' }))
    await $.session.start(STARTED)
    await command($, 'enforce')
    await $.turn.start({ text: 'Reply with exactly OK.', turnId: 'a' })
    await step($, 'a', 0, 'high')
    await complete($, 'a')
    await $.turn.start({ text: 'Migrate the services to the new cluster', turnId: 'm' })
    await step($, 'm', 0, 'xhigh') // differs from the usual high: set by hand
    expect(w.posts, 'first turn plus two distinct ensemble bodies').toHaveLength(3)
    await $.tool.call({ tool: 'Bash', command: 'kubectl apply' })
    await message($, 'm')
    for (let i = 1; i <= 3; i++) { await w.clock.advance(120_000); await step($, 'm', i, 'xhigh') }
    expect(w.posts, 'only the message was classified; no retry').toHaveLength(4)
    expect(w.sent.slice(1).every(e => e === 'xhigh')).toBe(true)
    expect(await spinner($, w.drawn)).toBe('Baking… at xhigh effort (set by hand)')
    expect(await command($, 'status')).not.toContain('turn: no classifier answer')
    await complete($, 'm')
  })

  test('R5 a retry allowed by a message cannot lower after work', async ($, on) => {
    const w = world(on, { answers: [503, { low: 1 }] })
    on('prompt.submit', ($, e) => ({ text: e.text }))
    on('tool.call', () => ({ result: {}, text: 'ok' }))
    await $.session.start(STARTED)
    await command($, 'enforce')
    await $.turn.start({ text: 'Migrate the services to the new cluster', turnId: 't' })
    await step($, 't', 0, 'xhigh')
    await $.tool.call({ tool: 'Bash', command: 'kubectl apply' })
    await message($, 't', 'thanks, looks fine so far')
    await step($, 't', 1, 'xhigh')
    await step($, 't', 2, 'xhigh')
    expect(w.posts).toHaveLength(3)
    expect(w.sent).toEqual(['xhigh', 'xhigh', 'xhigh'])
    expect(await spinner($, w.drawn)).toBe('Baking… at xhigh effort (kept for active work)')
    await complete($, 't')
    expect(w.records().at(-1)).toMatchObject({ reason: 'work in progress' })
  })

  test('R6 shadow: a successful message schedules the retry without changing any request', async ($, on) => {
    const w = world(on, { answers: [503, { xhigh: 1 }] })
    on('prompt.submit', ($, e) => ({ text: e.text }))
    on('tool.call', () => ({ result: {}, text: 'ok' }))
    await $.session.start(STARTED)
    await $.turn.start({ text: 'Migrate the services to the new cluster', turnId: 't' })
    await step($, 't', 0, 'high')
    await $.tool.call({ tool: 'Bash', command: 'kubectl apply' })
    await message($, 't')
    await w.clock.settle() // shadow requests never wait for the message's classification
    await step($, 't', 1, 'high')
    await w.clock.settle()
    expect(w.posts, 'the retry went out with the next request').toHaveLength(3)
    expect(await spinner($, w.drawn)).toBe('Baking… at high effort (router: xhigh)')
    await step($, 't', 2, 'high')
    expect(w.posts).toHaveLength(3)
    expect(w.sent).toEqual(['high', 'high', 'high'])
    await complete($, 't')
    const record = w.records().at(-1)!
    expect(record.reason).not.toMatch(/^fallback/)
    expect((record.steps as { would?: string }[]).slice(1).map(s => s.would)).toEqual(['xhigh', 'xhigh'])
  })
})
