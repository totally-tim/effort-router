// Taking the conversation's memory over after a reload, under the host's
// dispatch semantics: every `$.state.get` of one dispatch returns one moment,
// and a write that misses reports the version that stands.
import type { Engine } from 'claude-code/testing'
import { describe, expect, test, tier } from 'claude-code/testing'

import { HOME, type World, world } from './fixtures/world'

tier('user')

const STARTED = { cwd: '/work', surface: 'terminal', isInteractive: true } as const
const LOW = { low: 0.98, medium: 0.02, high: 0, xhigh: 0 }
const DIR = `${HOME}/.local/state/effort-router`
const ID = 'the-session'
const FIRST = 'Explain in one sentence what a mutex is.'
const LATE = 'A prompt the earlier instance received after the read'

async function drain(stream: ReturnType<Engine['turn']['step']>): Promise<void> {
  for await (const chunk of stream) void chunk
  await stream.result
}
async function turn($: Engine, turnId: string, text: string): Promise<void> {
  await $.turn.start({ text, turnId })
  await drain($.turn.step({ turnId, index: 0, model: 'claude-opus-5-5', effort: 'low', messageCount: 1 }))
  await $.turn.complete({ turnId, answer: 'done', durationMs: 10, isAborted: false, reason: 'answer' })
}
type HeldValue = {
  memory: { history: { request: string }[] }
  submissions: { text: string }[]
  checkpoint?: { writer: string }
}
function heldOf(w: World): HeldValue {
  return w.state.read('memory', ID).value as HeldValue
}
/** The instance before the reload writes once more: another exchange in its memory, and a prompt it received. */
function earlierWrites(w: World, extra = 'An exchange the earlier instance completed'): void {
  const value = heldOf(w)
  w.state.write('memory', ID, {
    ...value,
    memory: { ...value.memory, history: [...value.memory.history, { request: extra, answer: 'done' }] },
    submissions: [...value.submissions, { text: LATE, origin: 'prompt', entering: false }],
  })
}
function once(action: () => void): () => void {
  let done = false
  return () => {
    if (!done) {
      done = true
      action()
    }
  }
}
function saves(w: World): string[] {
  return [...w.files.keys()].filter(path => path.startsWith(`${DIR}/${ID}.memory.`))
}
function lastState(w: World): Record<string, unknown> {
  return JSON.parse(w.posts.at(-1)!.init!.body!).state as Record<string, unknown>
}

/**
 * A reload whose takeover write misses: its session.start is one dispatch,
 * and the earlier instance writes after the new one read.
 */
async function reloadWithMissedTakeover($: Engine, w: World, afterRead = once(() => earlierWrites(w))): Promise<{ earlier: number; before: number }> {
  const earlier = w.state.read('memory', ID).version
  const before = w.state.memorySets.length
  w.state.freeze()
  w.state.afterRead = afterRead
  await $.session.start(STARTED)
  w.state.thaw()
  return { earlier, before }
}

describe('memory takeover across dispatches', () => {
  test('a missed takeover writes once, holds no version 0, and completes from a later read without losing the earlier write', async ($, on) => {
    const w = world(on, { answers: [LOW] })
    await $.session.start(STARTED)
    await turn($, 't1', FIRST)
    expect(saves(w), 'the earlier instance saved its checkpoint').toHaveLength(1)

    const { earlier, before } = await reloadWithMissedTakeover($, w)
    expect(w.state.memorySets.slice(before), 'one takeover write in the dispatch, at the version it read').toEqual([{ ifVersion: earlier, isSet: false }])

    await turn($, 't2', 'Continue.')

    const later = w.state.memorySets.slice(before + 1)
    expect(later.every(s => s.ifVersion !== 0), 'no write from a version-0 holder').toBe(true)
    expect(later.some(s => s.isSet), 'the takeover completed on a later hook').toBe(true)
    const held = heldOf(w)
    expect(held.submissions.map(s => s.text), 'the earlier instance\'s write was merged, not overwritten').toContain(LATE)
    expect(held.memory.history.map(h => h.request)).toEqual([FIRST, 'An exchange the earlier instance completed', 'Continue.'])
    expect(saves(w), 'the new instance saves its own checkpoint').toHaveLength(2)
  })

  test('a read of the missed moment writes nothing; a turn completed meanwhile is kept over the earlier memory', async ($, on) => {
    const w = world(on, { answers: [LOW] })
    await $.session.start(STARTED)
    await turn($, 't1', FIRST)

    const earlier = w.state.read('memory', ID).version
    w.state.freeze()
    w.state.afterRead = once(() => earlierWrites(w))
    await $.session.start(STARTED)
    const tried = w.state.memorySets.length
    // Still the missed moment: this instance completes a turn and reads it again.
    await turn($, 't2', 'Now explain what a semaphore is.')
    expect(w.state.memorySets.length, 'a read below the missed version writes nothing').toBe(tried)
    expect(saves(w), 'no checkpoint before the memory is held').toHaveLength(1)
    w.state.thaw()

    await turn($, 't3', 'Continue.')

    expect(lastState(w).previous_request, 'the local completion decides the next turn').toBe('Now explain what a semaphore is.')
    const held = heldOf(w)
    expect(held.memory.history.map(h => h.request), 'the newer local memory is not replaced by the earlier instance\'s')
      .toEqual([FIRST, 'Now explain what a semaphore is.', 'Continue.'])
    expect(held.submissions.map(s => s.text)).toContain(LATE)
    expect(w.state.memorySets.filter(s => s.isSet && (s.ifVersion ?? 0) > earlier).length).toBeGreaterThan(0)
    expect(saves(w), 'the skipped save is made once the memory is held').toHaveLength(2)
  })

  for (const intruder of ['the same millisecond', 'a clock that went back'] as const) {
    test(`another reload writing meanwhile ends the takeover, even from ${intruder}`, async ($, on) => {
      const w = world(on, { answers: [LOW] })
      await $.session.start(STARTED)
      await turn($, 't1', FIRST)
      const earlierWriter = heldOf(w).checkpoint!.writer
      // Writer names are never ordered: only the instance taken over may write meanwhile.
      const writer = intruder === 'the same millisecond' ? `${earlierWriter.split('-')[0]}-another` : '0-another'

      const { before } = await reloadWithMissedTakeover($, w, once(() => {
        w.state.write('memory', ID, { ...heldOf(w), checkpoint: { writer, seq: 0, parents: [] } })
      }))
      await turn($, 't2', 'Continue.')
      await turn($, 't3', 'Continue.')

      expect(w.state.memorySets.slice(before), 'only the missed takeover write').toHaveLength(1)
      expect(heldOf(w).checkpoint?.writer).toBe(writer)
      expect(saves(w), 'no checkpoint of the instance that yielded').toHaveLength(1)
    })
  }

  test('takeover attempts are bounded when the earlier instance keeps writing', async ($, on) => {
    const w = world(on, { answers: [LOW] })
    await $.session.start(STARTED)
    await turn($, 't1', FIRST)

    const { before } = await reloadWithMissedTakeover($, w, () => earlierWrites(w))
    for (const id of ['t2', 't3', 't4', 't5', 't6']) await turn($, id, 'Continue.')

    const attempts = w.state.memorySets.slice(before)
    expect(attempts.every(s => !s.isSet)).toBe(true)
    expect(attempts.length, 'the restore and at most three later attempts').toBeLessThanOrEqual(4)
    expect(attempts.every(s => s.ifVersion !== 0)).toBe(true)
  })

  // Contract changed by the second review: a takeover that ends without another owner keeps this instance's own saves.
  test('a takeover the host stops answering writes no memory again, and saves only to this instance\'s own file', async ($, on) => {
    const w = world(on, { answers: [LOW] })
    await $.session.start(STARTED)
    await turn($, 't1', FIRST)
    const { before } = await reloadWithMissedTakeover($, w)

    w.state.refuse = true
    await turn($, 't2', 'Continue.')
    w.state.refuse = false
    await turn($, 't3', 'Continue.')

    expect(w.state.memorySets.slice(before), 'only the missed takeover write').toHaveLength(1)
    expect(saves(w), 'the earlier instance\'s file and this instance\'s own').toHaveLength(2)
    expect(heldOf(w).submissions.map(s => s.text)).toContain(LATE)
  })

  test('an instance that lost memory it held never takes it back', async ($, on) => {
    const w = world(on, { answers: [LOW] })
    await $.session.start(STARTED)
    await turn($, 't1', FIRST)
    // A newer instance takes the memory over.
    w.state.write('memory', ID, heldOf(w))
    await turn($, 't2', 'Continue.')
    const lost = w.state.memorySets.length
    await turn($, 't3', 'Continue.')
    await turn($, 't4', 'Continue.')

    expect(w.state.memorySets.length, 'no write after the loss').toBe(lost)
    expect(saves(w)).toHaveLength(1)
  })

  test('a takeover in flight at /clear touches neither conversation', async ($, on) => {
    const w = world(on, { answers: [LOW] })
    await $.session.start(STARTED)
    await turn($, 't1', FIRST)
    await reloadWithMissedTakeover($, w)

    let release = () => {}
    w.state.gate = new Promise<void>(resolve => { release = resolve })
    await $.turn.start({ text: 'Continue.', turnId: 't2' })
    await drain($.turn.step({ turnId: 't2', index: 0, model: 'claude-opus-5-5', effort: 'low', messageCount: 1 }))
    const sets = w.state.memorySets.length
    await $.session.end({ reason: 'clear', sessionId: ID, resume: { id: ID } } as never)
    release()
    w.state.gate = undefined
    await w.clock.settle()

    expect(w.state.memorySets.length, 'the earlier conversation\'s takeover wrote nothing after /clear').toBe(sets)
    expect(w.state.read('memory', ID).value).toBeUndefined()
  })
})
