// Queued prompts during a memory takeover after a reload. The instance before
// the reload can take a prompt after the new instance read the held memory, so
// the new instance's takeover write misses and the prompt reaches it only on a
// later read. A batch that turn.start begins in the new instance meanwhile must
// still include that prompt, and while the takeover is unresolved no decision
// may lower effort on memory that can be stale.
import type { Engine } from 'claude-code/testing'
import { describe, expect, test, tier } from 'claude-code/testing'

import { type World, world } from './fixtures/world'

tier('user')

const STARTED = { cwd: '/work', surface: 'terminal', isInteractive: true } as const
const LOW = { low: 0.98, medium: 0.02, high: 0, xhigh: 0 }
const XHIGH = { low: 0, medium: 0, high: 0.02, xhigh: 0.98 }
const ID = 'the-session'
const ESSAY = 'Write the essay on congestion control.'
const HARD = 'Redesign the retry protocol and prove it cannot deadlock.'
const SIMPLE = 'Reply with exactly OK.'
const hardOrLow = (request: string) => (request.includes(HARD) ? XHIGH : LOW)

async function step($: Engine, turnId: string, index: number, effort = 'xhigh'): Promise<void> {
  const stream = $.turn.step({ turnId, index, model: 'claude-opus-5-5', effort: effort as 'xhigh', messageCount: 1 + index })
  for await (const chunk of stream) void chunk
  await stream.result
}
async function complete($: Engine, turnId: string, answer = 'done'): Promise<void> {
  await $.turn.complete({ turnId, answer, durationMs: 10, isAborted: false, reason: 'answer' })
}
type Held = { submissions: { text: string }[]; memory: { history: { request: string }[] } }
const heldOf = (w: World) => w.state.read('memory', ID).value as Held
const pending = (w: World) => heldOf(w).submissions.map(s => s.text)

/**
 * The essay runs in the instance before the reload. The reload's takeover write
 * misses: after the new instance read the held memory, the earlier instance
 * took the hard prompt typed over the essay (and classified it xhigh). The
 * simple prompt is typed to the new instance, and the essay completes there
 * while its reads still return the moment the takeover missed.
 */
async function lateHardPrompt($: Engine, w: World, mode: 'enforce' | 'shadow', effort = 'xhigh'): Promise<void> {
  await $.session.start(STARTED)
  await $.command.run({ command: 'effort-router', args: mode, origin: { kind: 'composer' } } as never)
  await $.prompt.submit({ text: ESSAY, wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text: ESSAY, turnId: 'essay' })
  await step($, 'essay', 0, effort)
  let wrote = false
  w.state.freeze()
  w.state.afterRead = () => {
    if (wrote) return
    wrote = true
    const value = heldOf(w)
    w.state.write('memory', ID, {
      ...value,
      submissions: [...value.submissions, { text: HARD, origin: 'composer', entering: false, over: 'essay', level: 'xhigh' }],
    })
  }
  await $.session.start(STARTED)
  await $.prompt.submit({ text: SIMPLE, turnId: 'essay', wait: true, origin: { kind: 'composer' } })
  await w.clock.settle()
  await complete($, 'essay', 'The essay.')
  w.transcript.rows = [{ role: 'assistant', text: 'The essay.' }, { role: 'user', text: HARD }, { role: 'user', text: SIMPLE }]
}

describe('queued prompts during a memory takeover', () => {
  test('a batch that starts before the takeover merges the earlier instance\'s prompt still includes it', async ($, on) => {
    const w = world(on, { answerOf: hardOrLow })
    on('prompt.submit', ($, e) => ({ text: e.text }))
    await lateHardPrompt($, w, 'enforce')
    // Its turn starts before any read after the missed takeover.
    await $.turn.start({ text: SIMPLE, turnId: 'batch' })
    w.state.thaw()
    await step($, 'batch', 0)
    await complete($, 'batch')
    expect(w.sent).toEqual(['low', 'xhigh'])
    expect(w.records().at(-1)).toMatchObject({ prompt_head: `${HARD}\n\n${SIMPLE}`, batch: { count: 2, confirmed: true } })
    // Both entered the batch: neither comes back as pending.
    expect(pending(w)).toEqual([])
    await $.turn.start({ text: 'Continue.', turnId: 'next' })
    await step($, 'next', 0)
    const followups = w.posts.map(p => JSON.parse(p.init!.body!)).filter(b => b.state.request === 'Continue.')
    expect(followups.length > 0).toBe(true)
    expect(followups.every(b => b.state.task_context.previousTask.request === `${HARD}\n\n${SIMPLE}`)).toBe(true)
  })

  test('while the takeover stays unresolved the batch keeps the session effort; the late prompt joins it once merged', async ($, on) => {
    const w = world(on, { answerOf: hardOrLow })
    on('prompt.submit', ($, e) => ({ text: e.text }))
    await lateHardPrompt($, w, 'enforce')
    await $.turn.start({ text: SIMPLE, turnId: 'batch' })
    // Every read of the first request still returns the missed moment.
    await step($, 'batch', 0)
    expect(w.sent, 'no downgrade on memory that can be stale').toEqual(['low', 'xhigh'])
    w.state.thaw()
    await complete($, 'batch')
    // The first request's transcript showed the hard prompt: proof it entered.
    expect(w.records().at(-1)).toMatchObject({ reason: 'held: memory takeover pending', prompt_head: `${HARD}\n\n${SIMPLE}`, batch: { count: 2, confirmed: true } })
    expect(pending(w)).toEqual([])
    expect(heldOf(w).memory.history.at(-1)?.request).toBe(`${HARD}\n\n${SIMPLE}`)
  })

  // Counterexamples: the earlier instance held the hard prompt, but the batch the host started did not carry it
  // (canceled, pulled back or rewritten before the turn). The usual effort is high, so a wrong raise shows.
  const history = (w: World) => heldOf(w).memory.history.map(h => h.request)

  test('a late prompt the batch transcript does not show is neither remembered nor raises the turn', async ($, on) => {
    const w = world(on, { answerOf: hardOrLow })
    on('prompt.submit', ($, e) => ({ text: e.text }))
    await lateHardPrompt($, w, 'enforce', 'high')
    w.transcript.rows = [{ role: 'assistant', text: 'The essay.' }, { role: 'user', text: SIMPLE }]
    await $.turn.start({ text: SIMPLE, turnId: 'batch' })
    await step($, 'batch', 0, 'high')
    w.state.thaw()
    // The next request's read merges the hard prompt; the one after goes out once it is merged.
    await step($, 'batch', 1, 'high')
    await w.clock.settle()
    await step($, 'batch', 2, 'high')
    await complete($, 'batch')
    expect(w.sent).toEqual(['low', 'high', 'high', 'high'])
    expect(w.records().at(-1)).toMatchObject({ reason: 'held: memory takeover pending', prompt_head: SIMPLE })
    expect(w.records().at(-1)).not.toHaveProperty('batch')
    expect(history(w)).not.toContain(HARD)
    expect(history(w).at(-1)).toBe(SIMPLE)
    // Consumed: the queue it waited in has started, so no later turn gets it.
    expect(pending(w)).toEqual([])
  })

  test('without the first request\'s transcript a late prompt can only keep effort up; it is not remembered', async ($, on) => {
    const w = world(on, { answerOf: hardOrLow })
    on('prompt.submit', ($, e) => ({ text: e.text }))
    await lateHardPrompt($, w, 'enforce', 'high')
    w.transcript.rows = null
    await $.turn.start({ text: SIMPLE, turnId: 'batch' })
    await step($, 'batch', 0, 'high')
    w.state.thaw()
    await step($, 'batch', 1, 'high')
    await w.clock.settle()
    await step($, 'batch', 2, 'high')
    await complete($, 'batch')
    expect(w.sent).toEqual(['low', 'high', 'high', 'xhigh'])
    expect(w.records().at(-1)).toMatchObject({ prompt_head: SIMPLE, batch: { count: 1, confirmed: false, floor: 'xhigh' } })
    expect(history(w)).not.toContain(HARD)
    expect(pending(w)).toEqual([])
  })

  test('a late prompt canceled in a later held write, whose merge loses the takeover write again, is not invented', async ($, on) => {
    const w = world(on, { answerOf: hardOrLow })
    on('prompt.submit', ($, e) => ({ text: e.text }))
    await lateHardPrompt($, w, 'enforce', 'high')
    w.transcript.rows = [{ role: 'assistant', text: 'The essay.' }, { role: 'user', text: SIMPLE }]
    await $.turn.start({ text: SIMPLE, turnId: 'batch' })
    await step($, 'batch', 0, 'high')
    w.state.thaw()
    const tried = w.state.memorySets.length
    // Right after the read that brings the hard prompt, the earlier instance writes again without it.
    let canceled = false
    w.state.afterRead = () => {
      if (canceled) return
      canceled = true
      const value = heldOf(w)
      w.state.write('memory', ID, { ...value, submissions: value.submissions.filter(s => s.text !== HARD) })
    }
    await complete($, 'batch')
    const missedAgain = w.state.memorySets.slice(tried)
    expect(missedAgain.at(-1)?.isSet, 'the retake write missed again').toBe(false)
    expect(history(w)).not.toContain(HARD)
    expect(pending(w)).not.toContain(HARD)
    // The takeover goes on from the newer write at a later hook.
    w.transcript.rows = [{ role: 'assistant', text: 'done' }, { role: 'user', text: 'Continue.' }]
    await $.turn.start({ text: 'Continue.', turnId: 'next' })
    await step($, 'next', 0, 'high')
    await complete($, 'next')
    expect(w.state.memorySets.slice(tried).some(s => s.isSet), 'a later write lands').toBe(true)
    expect(history(w).slice(-2)).toEqual([SIMPLE, 'Continue.'])
    expect(pending(w)).not.toContain(HARD)
  })

  test('shadow: the first request of such a batch goes out at once, and the prediction includes the late prompt', async ($, on) => {
    const w = world(on, { answerOf: hardOrLow })
    on('prompt.submit', ($, e) => ({ text: e.text }))
    await lateHardPrompt($, w, 'shadow')
    await $.turn.start({ text: SIMPLE, turnId: 'batch' })
    w.state.thaw()
    // The takeover's next read does not answer while the request goes out.
    let release = () => undefined as void
    w.state.gate = new Promise<void>(resolve => { release = resolve })
    await step($, 'batch', 0)
    expect(w.sent, 'shadow sends the request without waiting for the takeover').toEqual(['xhigh', 'xhigh'])
    release()
    w.state.gate = undefined
    await w.clock.settle()
    await complete($, 'batch')
    expect(w.records().at(-1)).toMatchObject({ would_pick: 'xhigh', prompt_head: `${HARD}\n\n${SIMPLE}` })
    expect(pending(w)).toEqual([])
  })
})

// Review finding 2: after a missed takeover, a decision must not lower effort
// on task memory the takeover has not merged. The saved effort is medium; the
// new instance's memory says the last task ran at low, while the earlier
// instance completed an xhigh task right after the new instance read.
describe('decisions while a missed takeover leaves memory unresolved', () => {
  const XTASK = 'Migrate the scheduler to the lock-free queue.'
  const heldValue = (w: World) => w.state.read('memory', ID).value as Record<string, any>

  async function staleAfterReload($: Engine, w: World): Promise<void> {
    await $.session.start(STARTED)
    await $.command.run({ command: 'effort-router', args: 'enforce', origin: { kind: 'composer' } } as never)
    await $.turn.start({ text: 'Rename the helper in utils.', turnId: 't1' })
    await step($, 't1', 0, 'medium')
    await complete($, 't1')
    let wrote = false
    w.state.freeze()
    w.state.afterRead = () => {
      if (wrote) return
      wrote = true
      const value = heldValue(w)
      w.state.write('memory', ID, { ...value, memory: { ...value.memory,
        history: [...value.memory.history, { request: XTASK, answer: 'Migrated.' }],
        previousTask: { request: XTASK, answer: 'Migrated.', level: 'xhigh', observations: [] },
        lastLevel: 'xhigh' } })
    }
    await $.session.start(STARTED)
    w.state.thaw()
  }

  /** Runs one turn's first request while the memory read does not answer, until the decision's bounded wait ends. */
  async function withDelayedRead($: Engine, w: World, run: () => Promise<void>): Promise<() => void> {
    let release = () => undefined as void
    w.state.gate = new Promise<void>(resolve => { release = resolve })
    const running = run()
    await w.clock.settle()
    await w.clock.advance(1000)
    await running
    return () => {
      release()
      w.state.gate = undefined
    }
  }

  test('control: the takeover merges before the decision, and Continue. keeps the earlier instance\'s xhigh task', async ($, on) => {
    const w = world(on, { saved: { 'claude-opus-5-5': 'medium' }, answers: [LOW] })
    await staleAfterReload($, w)
    await $.turn.start({ text: 'Continue.', turnId: 't2' })
    await step($, 't2', 0, 'medium')
    expect(w.sent).toEqual(['low', 'xhigh'])
  })

  test('the host refusing the takeover after the miss holds a typed Continue. at the session effort', async ($, on) => {
    const w = world(on, { saved: { 'claude-opus-5-5': 'medium' }, answers: [LOW] })
    await staleAfterReload($, w)
    w.state.refuse = true
    await $.turn.start({ text: 'Continue.', turnId: 't2' })
    await step($, 't2', 0, 'medium')
    await complete($, 't2')
    expect(w.sent).toEqual(['low', 'medium'])
    expect(w.records().at(-1)).toMatchObject({ reason: 'held: memory takeover pending' })
    // Refused for good: the next decision cannot lower on that memory either.
    await $.turn.start({ text: 'Rename the constant in utils.', turnId: 't3' })
    await step($, 't3', 0, 'medium')
    expect(w.sent.at(-1)).toBe('medium')
  })

  test('a takeover read slower than the decision\'s bound holds a typed Continue. at the session effort', async ($, on) => {
    const w = world(on, { saved: { 'claude-opus-5-5': 'medium' }, answers: [LOW] })
    await staleAfterReload($, w)
    await $.turn.start({ text: 'Continue.', turnId: 't2' })
    const release = await withDelayedRead($, w, () => step($, 't2', 0, 'medium'))
    expect(w.sent).toEqual(['low', 'medium'])
    release()
    await complete($, 't2')
    expect(w.records().at(-1)).toMatchObject({ reason: 'held: memory takeover pending' })
  })

  test('an empty turn inherits no lower than the session effort, and its completion keeps the merged xhigh', async ($, on) => {
    const w = world(on, { saved: { 'claude-opus-5-5': 'medium' }, answers: [LOW] })
    await staleAfterReload($, w)
    await $.turn.start({ text: '', turnId: 't2' })
    const release = await withDelayedRead($, w, () => step($, 't2', 0, 'medium'))
    expect(w.sent, 'the stale low is not inherited').toEqual(['low', 'medium'])
    release()
    // The completion's read merges the earlier instance's memory before the turn passes its level on.
    await complete($, 't2')
    await $.turn.start({ text: '', turnId: 't3' })
    await step($, 't3', 0, 'medium')
    expect(w.sent.at(-1), 'the merged level is not overwritten by the held turn').toBe('xhigh')
  })

  test('a takeover that ran out of attempts keeps later decisions at the session effort or above', async ($, on) => {
    const w = world(on, { saved: { 'claude-opus-5-5': 'medium' }, answers: [LOW] })
    await $.session.start(STARTED)
    await $.command.run({ command: 'effort-router', args: 'enforce', origin: { kind: 'composer' } } as never)
    await $.turn.start({ text: 'Rename the helper in utils.', turnId: 't1' })
    await step($, 't1', 0, 'medium')
    await complete($, 't1')
    const before = w.state.memorySets.length
    // The earlier instance writes again right after every read of the new one.
    let n = 0
    w.state.freeze()
    w.state.afterRead = () => {
      n += 1
      const value = heldValue(w)
      w.state.write('memory', ID, { ...value, memory: { ...value.memory, history: [...value.memory.history, { request: `${XTASK} ${n}`, answer: 'done' }] } })
    }
    await $.session.start(STARTED)
    w.state.thaw()
    for (let i = 0; i < 3 && w.state.memorySets.slice(before).length < 4; i++) {
      await $.turn.start({ text: 'Reply with exactly OK.', turnId: `warm${i}` })
      await step($, `warm${i}`, 0, 'medium')
      await complete($, `warm${i}`)
    }
    const tries = w.state.memorySets.slice(before)
    expect(tries.length >= 4 && tries.every(s => !s.isSet), 'every takeover write missed, up to the bound').toBe(true)
    w.state.afterRead = undefined
    await $.turn.start({ text: 'Rename the constant in utils.', turnId: 't2' })
    await step($, 't2', 0, 'medium')
    await complete($, 't2')
    expect(w.sent.at(-1)).toBe('medium')
    expect(w.records().at(-1)).toMatchObject({ reason: 'held: memory takeover pending' })
  })

  test('shadow: the bounded read runs inside the decision, never before the request', async ($, on) => {
    const w = world(on, { saved: { 'claude-opus-5-5': 'medium' }, answers: [LOW] })
    await staleAfterReload($, w)
    await $.command.run({ command: 'effort-router', args: 'shadow', origin: { kind: 'composer' } } as never)
    let release = () => undefined as void
    w.state.gate = new Promise<void>(resolve => { release = resolve })
    await $.turn.start({ text: 'Continue.', turnId: 't2' })
    await step($, 't2', 0, 'medium')
    expect(w.sent.at(-1), 'the request went out while the read waited').toBe('medium')
    release()
    w.state.gate = undefined
    await w.clock.settle()
    await complete($, 't2')
    expect(w.records().at(-1)?.would_pick).toBe('xhigh')
  })
})
