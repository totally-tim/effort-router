// Round two of the memory takeover after a reload: repeated merges against an
// earlier instance that keeps writing, and saving when the takeover fails.
import type { Engine } from 'claude-code/testing'
import { describe, expect, test, tier } from 'claude-code/testing'

import { HOME, type World, world } from './fixtures/world'

tier('user')

const STARTED = { cwd: '/work', surface: 'terminal', isInteractive: true } as const
const LOW = { low: 0.98, medium: 0.02, high: 0, xhigh: 0 }
const DIR = `${HOME}/.local/state/effort-router`
const ID = 'the-session'
const FIRST = 'Explain in one sentence what a mutex is.'
const LOCAL = 'Now explain what a semaphore is.'

async function drain(stream: ReturnType<Engine['turn']['step']>): Promise<void> {
  for await (const chunk of stream) void chunk
  await stream.result
}
async function turn($: Engine, turnId: string, text: string): Promise<void> {
  await $.turn.start({ text, turnId })
  await drain($.turn.step({ turnId, index: 0, model: 'claude-opus-5-5', effort: 'low', messageCount: 1 }))
  await $.turn.complete({ turnId, answer: 'done', durationMs: 10, isAborted: false, reason: 'answer' })
}
async function command($: Engine, args: string): Promise<string | undefined> {
  return (await $.command.run({ command: 'effort-router', args, origin: { kind: 'composer' } } as never)).text
}
type HeldValue = { memory: { history: { request: string }[] }; mode?: string; checkpoint?: { writer: string } }
function heldOf(w: World): HeldValue {
  return w.state.read('memory', ID).value as HeldValue
}
/** The instance before the reload writes once more, with another exchange in its memory. */
function earlierWrites(w: World, request: string): void {
  const value = heldOf(w)
  w.state.write('memory', ID, { ...value, memory: { ...value.memory, history: [...value.memory.history, { request, answer: 'done' }] } })
}
type Saved = { writer: string; seq: number; parents: string[]; savedAt: number; memory: { history: { request: string }[] } }
function saves(w: World): Record<string, Saved> {
  return Object.fromEntries([...w.files].filter(([path]) => path.startsWith(`${DIR}/${ID}.memory.`))
    .map(([path, text]) => [path.slice(DIR.length + 1), JSON.parse(text) as Saved]))
}
/** The earlier instance saves its checkpoint once more: a competing writer, not a stale file. */
function earlierSaves(w: World, writer: string, request: string): void {
  const path = `${DIR}/${ID}.memory.${writer}.json`
  const saved = JSON.parse(w.files.get(path)!) as Saved
  w.files.set(path, JSON.stringify({ ...saved, seq: saved.seq + 1, savedAt: saved.savedAt + 1,
    memory: { ...saved.memory, history: [...saved.memory.history, { request, answer: 'done' }] } }))
}
function lastState(w: World): Record<string, unknown> {
  return JSON.parse(w.posts.at(-1)!.init!.body!).state as Record<string, unknown>
}
/** A reload whose own dispatch reads one moment, the earlier instance writing after each of its first `writes` reads. */
async function reload($: Engine, w: World, writes: number, onWrite: (n: number) => void = n => earlierWrites(w, `A exchange ${n}`)): Promise<void> {
  let reads = 0
  w.state.freeze()
  w.state.afterRead = () => {
    reads += 1
    if (reads <= writes) onWrite(reads)
  }
  await $.session.start(STARTED)
  w.state.thaw()
}

describe('repeated merges keep what this instance changed', () => {
  test('a turn completed here survives every later merge of the earlier instance\'s memory', async ($, on) => {
    const w = world(on, { answers: [LOW] })
    await $.session.start(STARTED)
    await turn($, 't1', FIRST)
    const earlier = Object.keys(saves(w))
    // The earlier instance writes after the reload's read and after the first merge that keeps the local turn.
    let reads = 0
    w.state.freeze()
    w.state.afterRead = () => {
      reads += 1
      if (reads === 1 || reads === 4) earlierWrites(w, `A exchange ${reads}`)
    }
    await $.session.start(STARTED)
    // Still the missed moment: this turn completes here, and no read merges.
    await turn($, 't2', LOCAL)
    w.state.thaw()
    await turn($, 't3', 'Continue.')
    await turn($, 't4', 'Say it in one sentence.')

    expect(reads, 'reads: restore, two stale, a merge that keeps the local turn, and later merges').toBeGreaterThanOrEqual(5)
    expect(heldOf(w).memory.history.map(h => h.request), 'the local completion is still held')
      .toEqual([LOCAL, 'Continue.', 'Say it in one sentence.'])
    const own = Object.entries(saves(w)).filter(([name]) => !earlier.includes(name)).map(([, s]) => s)
    expect(own, 'this instance saves to its own file').toHaveLength(1)
    expect(own[0]!.memory.history.map(h => h.request), 'the new checkpoint keeps it too').toContain(LOCAL)
  })

  test('a mode set here survives every later merge of the earlier instance\'s mode', async ($, on) => {
    const w = world(on, { answers: [LOW] })
    await $.session.start(STARTED)
    await command($, 'enforce')
    await turn($, 't1', FIRST)
    await reload($, w, 3)
    await command($, 'shadow')
    await turn($, 't2', LOCAL)
    await turn($, 't3', 'Continue.')
    await turn($, 't4', 'Continue.')

    expect(await command($, 'status')).toContain('mode shadow')
    expect(heldOf(w).mode).toBe('shadow')
  })
})

describe('saving when the takeover fails', () => {
  test('a takeover the host stopped answering saves this instance\'s own checkpoint, and a later resume restores it', async ($, on) => {
    const w = world(on, { answers: [LOW] })
    await $.session.start(STARTED)
    await turn($, 't1', FIRST)
    const earlier = Object.keys(saves(w))
    await reload($, w, 1)

    w.state.refuse = true
    await turn($, 't2', LOCAL)
    w.state.refuse = false
    await turn($, 't3', 'Continue.')
    await turn($, 't4', 'Say it in one sentence.')

    const own = Object.entries(saves(w)).filter(([name]) => !earlier.includes(name)).map(([, s]) => s)
    expect(own, 'this instance saves to its own file').toHaveLength(1)
    expect(own[0]!.parents, 'going on from the save it merged').toEqual([`${saves(w)[earlier[0]!]!.writer}#1`])
    expect(await command($, 'status')).toContain('memory: saved for resume')

    // A new process resumes the conversation.
    w.state.clear()
    await $.session.start(STARTED)
    await turn($, 't5', 'Continue.')
    expect(lastState(w).previous_request, 'the resume restores this instance\'s latest turn, not the pre-reload one').toBe('Say it in one sentence.')
  })

  test('a takeover given up while the earlier instance keeps writing and saving leaves saves that branch; a resume restores nothing', async ($, on) => {
    const w = world(on, { answers: [LOW] })
    await $.session.start(STARTED)
    await turn($, 't1', FIRST)
    const writer = heldOf(w).checkpoint!.writer
    await reload($, w, 99, n => {
      earlierWrites(w, `A exchange ${n}`)
      earlierSaves(w, writer, `A exchange ${n}`)
    })
    for (const id of ['t2', 't3', 't4']) await turn($, id, LOCAL)
    const sets = w.state.memorySets.length
    await turn($, 't5', LOCAL)

    expect(w.state.memorySets.length, 'no write once the takeover gave up').toBe(sets)
    expect(Object.keys(saves(w)), 'each writer keeps its own file').toHaveLength(2)

    w.state.afterRead = undefined
    w.state.clear()
    await $.session.start(STARTED)
    expect(await command($, 'status')).toContain('memory: not restored')
    await turn($, 't6', 'Continue.')
    expect(lastState(w).previous_request, 'branched saves restore no task').toBeUndefined()
  })
})
