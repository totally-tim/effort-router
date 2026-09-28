// Task effort and command identity survive delayed or repeated memory transfers.
import type { Engine } from 'claude-code/testing'
import { describe, expect, test, tier } from 'claude-code/testing'

import { type World, world } from './fixtures/world'

tier('user')

const STARTED = { cwd: '/work', surface: 'terminal', isInteractive: true } as const
const LOW = { low: 0.98, medium: 0.02, high: 0, xhigh: 0 }
const XHIGH = { low: 0, medium: 0, high: 0.02, xhigh: 0.98 }
const ID = 'the-session'
const XTASK = 'Migrate the scheduler to the lock-free queue.'

async function step($: Engine, turnId: string, index: number, effort = 'medium'): Promise<void> {
  const stream = $.turn.step({ turnId, index, model: 'claude-opus-5-5', effort: effort as 'medium', messageCount: 1 + index })
  for await (const chunk of stream) void chunk
  await stream.result
}
async function complete($: Engine, turnId: string, answer = 'done'): Promise<void> {
  await $.turn.complete({ turnId, answer, durationMs: 10, isAborted: false, reason: 'answer' })
}
async function turn($: Engine, turnId: string, text: string, effort = 'medium'): Promise<void> {
  await $.turn.start({ text, turnId })
  await step($, turnId, 0, effort)
  await complete($, turnId)
}
async function command($: Engine, args: string): Promise<string | undefined> {
  return (await $.command.run({ command: 'effort-router', args, origin: { kind: 'composer' } } as never)).text
}
const heldValue = (w: World) => w.state.read('memory', ID).value as { memory: { history: { request: string; answer?: string }[] } }
function earlierWrites(w: World, request: string): void {
  const value = heldValue(w)
  w.state.write('memory', ID, { ...value, memory: { ...value.memory, history: [...value.memory.history, { request, answer: 'done' }] } })
}
/** Reload whose takeover write misses once: the earlier instance writes right after the first read. */
async function reloadMissedOnce($: Engine, w: World): Promise<void> {
  let wrote = false
  w.state.freeze()
  w.state.afterRead = () => {
    if (wrote) return
    wrote = true
    earlierWrites(w, 'A tail write')
  }
  await $.session.start(STARTED)
  w.state.thaw()
}

describe('command identity across repeated merges', () => {
  test('a local lastRecord and currentTurnId survive a second and third merge', async ($, on) => {
    const w = world(on, { answers: [LOW] })
    await $.session.start(STARTED)
    await turn($, 't1', 'Explain in one sentence what a mutex is.', 'low')
    let reads = 0
    w.state.freeze()
    w.state.afterRead = () => {
      reads += 1
      earlierWrites(w, `A exchange ${reads}`)
    }
    await $.session.start(STARTED)
    // Frozen: t2 completes here with no merge.
    await turn($, 't2', 'Now explain what a semaphore is.', 'low')
    w.state.thaw()
    const before = w.state.memorySets.length
    await $.turn.start({ text: 'Continue.', turnId: 't3' })
    for (let i = 0; i < 3; i++) {
      await step($, 't3', i, 'low')
      await w.clock.settle()
    }
    const merges = w.state.memorySets.slice(before)
    expect(merges.length, 'at least two merges after the local completion').toBeGreaterThanOrEqual(2)
    expect(JSON.parse((await command($, 'why'))!).turnId, 'lastRecord stays the local t2').toBe('t2')
    expect(await command($, 'wrong high'), 'currentTurnId stays the local t3').toContain('t3')
  })
})

describe('completion after a refused takeover', () => {
  test('a new task and its continuation do not inherit the earlier task\'s xhigh effort', async ($, on) => {
    const w = world(on, { saved: { 'claude-opus-5-5': 'medium' }, answerOf: r => (r.includes(XTASK) ? XHIGH : LOW) })
    await $.session.start(STARTED)
    await command($, 'enforce')
    await turn($, 't1', 'Rename the helper in utils.')
    await reloadMissedOnce($, w)
    w.state.refuse = true
    await turn($, 't2', XTASK)
    await turn($, 't3', 'Rename the constant in utils.')
    await turn($, 't4', 'Continue.')
    await turn($, 't5', '')
    // t1 low; t2 xhigh; t3 held at medium; t4 continues t3; t5 inherits t4.
    expect(w.sent, 'both the continuation and empty turn inherit the new task').toEqual(['low', 'xhigh', 'medium', 'medium', 'medium'])
  })

  test('control without a reload: same turns', async ($, on) => {
    const w = world(on, { saved: { 'claude-opus-5-5': 'medium' }, answerOf: r => (r.includes(XTASK) ? XHIGH : LOW) })
    await $.session.start(STARTED)
    await command($, 'enforce')
    await turn($, 't1', 'Rename the helper in utils.')
    await turn($, 't2', XTASK)
    await turn($, 't3', 'Rename the constant in utils.')
    await turn($, 't4', 'Continue.')
    await turn($, 't5', '')
    expect(w.sent).toEqual(['low', 'xhigh', 'low', 'low', 'low'])
  })
})

describe('manual turn decided on stale memory', () => {
  test('an empty turn after a manual turn without a classifier answer keeps the session effort', async ($, on) => {
    const w = world(on, { saved: { 'claude-opus-5-5': 'medium' }, answerOf: r => (r.includes('Explain') ? undefined : LOW), answers: [500] })
    await $.session.start(STARTED)
    await command($, 'enforce')
    await turn($, 't1', 'Rename the helper in utils.')
    await reloadMissedOnce($, w)
    await $.turn.start({ text: 'Explain the design of the scheduler.', turnId: 't2' })
    let release = () => undefined as void
    w.state.gate = new Promise<void>(resolve => { release = resolve })
    const running = step($, 't2', 0, 'high')
    await w.clock.settle()
    await w.clock.advance(1000)
    await running
    release()
    w.state.gate = undefined
    await complete($, 't2')
    await $.turn.start({ text: '', turnId: 't3' })
    await step($, 't3', 0, 'medium')
    expect(w.sent.slice(0, 2)).toEqual(['low', 'high'])
    expect(w.sent[2], 'no pick below the usual level after a turn set by hand').toBe('medium')
  })
})
