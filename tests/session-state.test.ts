// Conversation lifecycle and state durability: `/clear`, `/resume`, reloads and the resume checkpoint.
import type { Engine } from 'claude-code/testing'
import { describe, expect, test, tier } from 'claude-code/testing'

import { resumedFrom } from '../hooks/session-state'
import { HOME, LOG_FILE, type World, world } from './fixtures/world'

tier('user')

const STARTED = { cwd: '/work', surface: 'terminal', isInteractive: true } as const
const HARD = { low: 0, medium: 0, high: 0.02, xhigh: 0.98 }
const LOW = { low: 0.98, medium: 0.02, high: 0, xhigh: 0 }
const DIR = `${HOME}/.local/state/effort-router`
const SAVED = `${DIR}/the-session.memory.w0.json`

async function drain(stream: ReturnType<Engine['turn']['step']>): Promise<void> {
  for await (const chunk of stream) void chunk
  await stream.result
}
function step($: Engine, turnId: string, index: number, effort: string): Promise<void> {
  return drain($.turn.step({ turnId, index, model: 'claude-opus-5-5', effort: effort as 'xhigh', messageCount: 1 + index }))
}
async function complete($: Engine, turnId: string): Promise<void> {
  await $.turn.complete({ turnId, answer: 'done', durationMs: 10, isAborted: false, reason: 'answer' })
}
async function turn($: Engine, turnId: string, text: string, effort = 'low'): Promise<void> {
  await $.turn.start({ text, turnId })
  await step($, turnId, 0, effort)
  await complete($, turnId)
}
async function command($: Engine, args: string): Promise<string | undefined> {
  return (await $.command.run({ command: 'effort-router', args, origin: { kind: 'composer' } } as never)).text
}
function end($: Engine, reason: 'clear' | 'resume' | 'prompt_input_exit', sessionId: string) {
  return $.session.end({ reason, sessionId, resume: { id: sessionId } })
}
/** What the classifier read for the latest request. */
function lastState(w: World): Record<string, unknown> {
  return JSON.parse(w.posts.at(-1)!.init!.body!).state as Record<string, unknown>
}
function checkpoint(overrides: Record<string, unknown> = {}, memory: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema: 1, sessionId: 'the-session', project: '/work', writer: 'w0', seq: 1, parents: [], savedAt: 1,
    memory: { history: [{ request: 'Migrate the services to the new cluster', answer: 'Started.' }], project: '/work', lastLevel: 'xhigh', ...memory },
    ...overrides,
  })
}
type Saved = { writer: string; seq: number; parents: string[]; memory: { history: { request: string }[]; previousTask?: { observations: unknown[] } } }
/** The conversation's checkpoint files by name, parsed. */
function saves(w: World): Record<string, Saved> {
  return Object.fromEntries([...w.files].filter(([path]) => path.startsWith(`${DIR}/the-session.memory.`))
    .map(([path, text]) => [path.slice(DIR.length + 1), JSON.parse(text) as Saved]))
}
const turnIdsOf = (text: string | undefined) => (text ?? '').split('\n').filter(Boolean).map(line => (JSON.parse(line) as { turnId: string }).turnId)

describe('conversation switches', () => {
  test('/clear ends the conversation: the next one keeps none of its memory and logs apart', async ($, on) => {
    const w = world(on)
    await $.session.start(STARTED)
    await turn($, 't1', 'Explain in one sentence what a mutex is.')
    // The host raises session.end and goes on under a new id, without session.start.
    await end($, 'clear', 'the-session')
    w.session.id = 'after-clear'
    await turn($, 't2', 'Continue.')

    expect(lastState(w).request).toBe('Continue.')
    expect(lastState(w).previous_request, 'nothing of the cleared conversation').toBeUndefined()
    expect(w.records().map(r => r.turnId)).toEqual(['t1'])
    expect(w.records('after-clear').map(r => r.turnId)).toEqual(['t2'])
  })

  test('an in-process /resume returns to that conversation\'s own memory, not the one it leaves', async ($, on) => {
    const w = world(on)
    await $.session.start(STARTED)
    await turn($, 'a1', 'Migrate the services to the new cluster')
    await end($, 'clear', 'the-session')
    w.session.id = 'other'
    await turn($, 'b1', 'Explain in one sentence what a semaphore is.')
    await end($, 'resume', 'other')
    w.session.id = 'the-session'
    await turn($, 'a2', 'Continue.')

    expect(lastState(w).previous_request).toBe('Migrate the services to the new cluster')
    expect(w.records().map(r => r.turnId)).toEqual(['a1', 'a2'])
    expect(w.records('other').map(r => r.turnId)).toEqual(['b1'])
  })

  test('a new process resuming a conversation starts with its saved task memory', async ($, on) => {
    const w = world(on)
    await $.session.start(STARTED)
    await turn($, 'a1', 'Migrate the services to the new cluster')
    await end($, 'prompt_input_exit', 'the-session')
    w.state.clear()
    // `claude --resume`: a new process starts with the same session id.
    await $.session.start(STARTED)
    await turn($, 'a2', 'Continue.')

    expect(lastState(w).previous_request).toBe('Migrate the services to the new cluster')
    expect(w.records().map(r => r.turnId)).toEqual(['a1', 'a2'])
  })

  test('a message typed while a resumed conversation restores cannot erase the restore', async ($, on) => {
    const w = world(on)
    on('prompt.submit', ($, e) => ({ text: e.text }))
    await $.session.start(STARTED)
    await turn($, 'a1', 'Migrate the services to the new cluster')
    await end($, 'clear', 'the-session')
    w.session.id = 'other'
    await turn($, 'b1', 'Explain in one sentence what a semaphore is.')
    await end($, 'resume', 'other')
    w.session.id = 'the-session'
    await $.turn.start({ text: 'Continue.', turnId: 'a2' })
    let restore = () => undefined as void
    w.state.gate = new Promise<void>(resolve => { restore = resolve })
    const stepping = step($, 'a2', 0, 'low')
    await w.clock.settle()
    // The restore is reading what the conversation held when this message arrives.
    await $.prompt.submit({ text: 'and keep the old config', turnId: 'a2', wait: false, origin: { kind: 'composer' } })
    restore()
    w.state.gate = undefined
    await stepping
    await complete($, 'a2')

    const asked = w.posts.map(p => JSON.parse(p.init!.body!).state as Record<string, unknown>).filter(state => state.request === 'Continue.')
    expect(asked.at(-1)?.previous_request).toBe('Migrate the services to the new cluster')
  })

  test('a conversation that changes without session.end starts over at its first request', async ($, on) => {
    const w = world(on)
    await $.session.start(STARTED)
    await turn($, 't1', 'Explain in one sentence what a mutex is.')
    w.session.id = 'switched'
    await turn($, 't2', 'Continue.')

    expect(lastState(w).previous_request).toBeUndefined()
    expect(w.records().map(r => r.turnId)).toEqual(['t1'])
    expect(w.records('switched').map(r => r.turnId)).toEqual(['t2'])
  })

  test('a retry still in flight at /clear touches neither conversation', async ($, on) => {
    const w = world(on, { answers: [503, 'hang', LOW] })
    on('tool.call', () => ({ result: {}, text: 'ok' }))
    await $.session.start(STARTED)
    await command($, 'enforce')
    await $.turn.start({ text: 'Migrate the services to the new cluster', turnId: 'old' })
    await step($, 'old', 0, 'xhigh')
    await $.tool.call({ tool: 'Bash', command: 'kubectl apply' })
    await w.clock.advance(61_000)
    const inFlight = step($, 'old', 1, 'xhigh')
    await w.clock.settle()
    expect(w.posts, 'the retry is in flight').toHaveLength(2)
    await end($, 'clear', 'the-session')
    w.session.id = 'after-clear'
    await w.clock.advance(5_000)
    await inFlight
    await complete($, 'old')
    await turn($, 'fresh', '', 'xhigh')

    expect(w.records().map(r => r.turnId), 'the cleared turn is logged nowhere').toEqual([])
    expect(w.records('after-clear')).toMatchObject([{ turnId: 'fresh', reason: 'fallback: no previous pick' }])
    expect(w.sent.at(-1)).toBe('xhigh')
  })
})

describe('reloads', () => {
  test('a reload between the requests of a turn keeps its decision and effort', async ($, on) => {
    const w = world(on, { answers: [HARD] })
    await $.session.start(STARTED)
    await command($, 'enforce')
    await $.turn.start({ text: 'Design the migration plan', turnId: 't1' })
    await step($, 't1', 0, 'low')
    // The new instance starts empty: the host raises session.start for it alone.
    await $.session.start(STARTED)
    await step($, 't1', 1, 'low')
    await complete($, 't1')

    expect(w.sent).toEqual(['xhigh', 'xhigh'])
    expect(w.posts, 'the decision is not asked again').toHaveLength(1)
    expect(w.records()).toMatchObject([{ turnId: 't1', prompt_head: 'Design the migration plan', would_pick: 'xhigh', sent: 'xhigh' }])
    expect(w.records()[0]!.steps).toHaveLength(2)
  })

  test('a reload before a turn completes still logs it and remembers the task', async ($, on) => {
    const w = world(on, { answers: [HARD] })
    await $.session.start(STARTED)
    await $.turn.start({ text: 'Design the migration plan', turnId: 't1' })
    await step($, 't1', 0, 'xhigh')
    await w.clock.settle()
    await $.session.start(STARTED)
    await complete($, 't1')
    await turn($, 't2', 'Continue.')

    expect(w.records().map(r => r.turnId)).toEqual(['t1', 't2'])
    expect(w.records()[0]).toMatchObject({ would_pick: 'xhigh', task_notification: false })
    expect(lastState(w).previous_request).toBe('Design the migration plan')
  })

  test('shadow: a decision still in flight at a reload is made again by the instance that completes the turn', async ($, on) => {
    const w = world(on, { answers: [{ after: 3000, answer: LOW }, HARD] })
    await $.session.start(STARTED)
    await $.turn.start({ text: 'Design the migration plan', turnId: 't1' })
    await step($, 't1', 0, 'xhigh')
    await w.clock.settle()
    expect(w.sent, 'shadow does not wait').toEqual(['xhigh'])
    expect(w.posts, 'the decision is in flight').toHaveLength(1)
    await $.session.start(STARTED)
    await complete($, 't1')
    // The earlier instance's answer lands late and changes nothing.
    await w.clock.advance(3000)
    await w.clock.settle()

    expect(w.posts).toHaveLength(2)
    expect(w.records()).toMatchObject([{ turnId: 't1', would_pick: 'xhigh' }])
    expect(w.state.read('turn', 't1').value, 'a completed turn leaves only a mark').toEqual({ schema: 1, sessionId: 'the-session', done: true })
    expect(await command($, 'status'), 'a stale answer reports nothing about the classifier').toContain('ok (')
  })

  test('a tool call the reloaded instance receives counts toward the turn it takes over', async ($, on) => {
    const w = world(on, { answers: [LOW] })
    on('tool.call', () => ({ isError: true, result: 'Exit code 1' }))
    await $.session.start(STARTED)
    await command($, 'enforce')
    await $.turn.start({ text: 'Run the database migration', turnId: 't1' })
    await step($, 't1', 0, 'high')
    await $.session.start(STARTED)
    await $.tool.call({ tool: 'Bash', command: 'make migrate' })
    await step($, 't1', 1, 'high')
    await complete($, 't1')

    expect(w.records()).toMatchObject([{ turnId: 't1', tool_errors: 1 }])
    expect(w.records()[0]!.steps).toHaveLength(2)
  })

  test('a reload keeps the conversation\'s memory and mode', async ($, on) => {
    const w = world(on, { answers: [LOW] })
    await $.session.start(STARTED)
    await command($, 'enforce')
    await turn($, 't1', 'Explain in one sentence what a mutex is.', 'xhigh')
    await $.session.start(STARTED)
    await turn($, 't2', 'Continue.', 'xhigh')

    expect(lastState(w).previous_request).toBe('Explain in one sentence what a mutex is.')
    expect(w.sent).toEqual(['low', 'low'])
  })

  test('an instance whose turn a newer instance took over writes nothing more of it', async ($, on) => {
    const w = world(on, { answers: [HARD] })
    on('tool.call', () => ({ result: {}, text: 'ok' }))
    await $.session.start(STARTED)
    await command($, 'enforce')
    await $.turn.start({ text: 'Design the migration plan', turnId: 't1' })
    await step($, 't1', 0, 'low')
    const held = w.state.read('turn', 't1').value as { turn: { text: string } }
    expect(held.turn.text, 'the turn is held for a later instance').toBe('Design the migration plan')
    // A newer instance takes the turn over.
    w.state.write('turn', 't1', { ...held, turn: { ...held.turn, text: 'taken over' } })
    await $.tool.call({ tool: 'Bash', command: 'make' })
    await step($, 't1', 1, 'low')

    expect((w.state.read('turn', 't1').value as { turn: { text: string } }).turn.text).toBe('taken over')
  })

  test('an instance that lost the conversation to a newer one saves no checkpoint', async ($, on) => {
    const w = world(on)
    await $.session.start(STARTED)
    await $.turn.start({ text: 'Explain in one sentence what a mutex is.', turnId: 't1' })
    await step($, 't1', 0, 'low')
    const held = w.state.read('memory', 'the-session').value as Record<string, unknown>
    expect(held, 'the memory is held for a later instance').toMatchObject({ schema: 1, sessionId: 'the-session' })
    w.state.write('memory', 'the-session', held)
    await complete($, 't1')

    expect(saves(w)).toEqual({})
    expect(w.records().map(r => r.turnId), 'the turn is still logged').toEqual(['t1'])
  })
})

describe('resume checkpoint', () => {
  async function resumed($: Engine, on: Parameters<typeof world>[0], files: Record<string, string>, effort = 'low', text = 'Continue.'): Promise<World> {
    const w = world(on, { files, answers: [LOW] })
    await $.session.start(STARTED)
    await command($, 'enforce')
    await turn($, 't1', text, effort)
    return w
  }

  test('a checkpoint of this session and project restores its memory', async ($, on) => {
    const w = await resumed($, on, { [SAVED]: checkpoint() })
    expect(lastState(w).previous_request).toBe('Migrate the services to the new cluster')
  })

  test('a checkpoint of another schema restores nothing and holds the first turn', async ($, on) => {
    const w = await resumed($, on, { [SAVED]: checkpoint({ schema: 2 }) }, 'xhigh', 'Now update the runbook')
    expect(lastState(w).previous_request).toBeUndefined()
    expect(w.records()).toMatchObject([{ turnId: 't1', reason: 'held: resumed memory diverged', sent: 'xhigh' }])
  })

  test('a checkpoint of another session restores nothing', async ($, on) => {
    const w = await resumed($, on, { [SAVED]: checkpoint({ sessionId: 'another' }) })
    expect(lastState(w).previous_request).toBeUndefined()
  })

  test('a checkpoint of another project restores nothing', async ($, on) => {
    const w = await resumed($, on, { [SAVED]: checkpoint({ project: '/elsewhere' }, { project: '/elsewhere' }) })
    expect(lastState(w).previous_request).toBeUndefined()
  })

  test('a malformed checkpoint restores nothing', async ($, on) => {
    const w = await resumed($, on, { [SAVED]: checkpoint({}, { history: [{ request: 42 }] }) })
    expect(lastState(w).previous_request).toBeUndefined()
  })

  test('the checkpoint keeps bounded, redacted text and no tool output', async ($, on) => {
    const w = world(on)
    on('tool.call', () => ({ result: {}, text: 'export const SECRET_FILE_CONTENT = 42' }))
    await $.session.start(STARTED)
    await command($, 'enforce')
    await $.turn.start({ text: `Fix the login bug; my token is sk-abcdefghijklmnopqrstuv. ${'x'.repeat(9000)}`, turnId: 't1' })
    await step($, 't1', 0, 'low')
    await $.tool.call({ tool: 'Read', file_path: '/work/src/login.ts' } as never)
    await step($, 't1', 1, 'low')
    await complete($, 't1')

    const [name] = Object.keys(saves(w))
    const text = w.files.get(`${DIR}/${name}`)
    expect(text).toContain('[redacted]')
    expect(text).not.toContain('sk-abcdefghijklmnopqrstuv')
    expect(text).not.toContain('SECRET_FILE_CONTENT')
    const saved = saves(w)[name!]!
    expect(saved.memory.history[0]!.request.length).toBeLessThanOrEqual(4000)
    expect(saved.memory.previousTask!.observations).toEqual([])
    expect(w.records()[0]!.evidence, 'the turn itself did read the file').toHaveLength(1)
  })

  test('a resumed process saves to its own file, going on from the save it restored', async ($, on) => {
    const w = await resumed($, on, { [SAVED]: checkpoint() })
    await turn($, 't2', 'Now update the runbook')

    const files = saves(w)
    expect(w.files.get(SAVED), 'the restored save stays as it was').toBe(checkpoint())
    const [own] = Object.values(files).filter(save => save.writer !== 'w0')
    expect(own).toMatchObject({ seq: 2, parents: ['w0#1'] })
    expect(own!.memory.history.map(h => h.request)).toEqual(['Migrate the services to the new cluster', 'Continue.', 'Now update the runbook'])
    expect(await command($, 'status')).toContain('memory: saved for resume')
  })

  test('two processes that went on from one save each keep their own file', async ($, on) => {
    const w = world(on, { files: { [SAVED]: checkpoint() } })
    await $.session.start(STARTED)
    // Another process resumed the same save and saved while this one runs.
    const other = checkpoint({ writer: 'B', parents: ['w0#1'] }, { history: [{ request: 'B task' }] })
    w.files.set(`${DIR}/the-session.memory.B.json`, other)
    await turn($, 't1', 'Continue.')

    expect(w.files.get(`${DIR}/the-session.memory.B.json`)).toBe(other)
    expect(w.files.get(SAVED)).toBe(checkpoint())
    expect(Object.values(saves(w)).map(save => JSON.stringify(save.parents)).sort(), 'this process saved beside B, from the same save').toEqual(['["w0#1"]', '["w0#1"]', '[]'])
  })

  test('branched saves restore no memory; the first turn keeps the session effort and the next save joins them', async ($, on) => {
    const a = checkpoint({ writer: 'A', parents: ['w0#1'] }, { history: [{ request: 'A task' }] })
    const b = checkpoint({ writer: 'B', parents: ['w0#1'] }, { history: [{ request: 'B task' }] })
    const w = await resumed($, on, { [SAVED]: checkpoint(), [`${DIR}/the-session.memory.A.json`]: a, [`${DIR}/the-session.memory.B.json`]: b }, 'xhigh', 'Now update the runbook')

    expect(lastState(w).previous_request, 'neither branch is guessed').toBeUndefined()
    expect(w.records()).toMatchObject([{ turnId: 't1', reason: 'held: resumed memory diverged', sent: 'xhigh', would_pick: 'xhigh' }])
    const [own] = Object.values(saves(w)).filter(save => !['w0', 'A', 'B'].includes(save.writer))
    expect(own!.parents.slice().sort()).toEqual(['A#1', 'B#1'])

    // A later process finds one line again: the joined save.
    await end($, 'prompt_input_exit', 'the-session')
    w.state.clear()
    await $.session.start(STARTED)
    await turn($, 't2', 'Continue.', 'xhigh')
    expect(lastState(w).previous_request).toBe('Now update the runbook')
    expect(w.records().at(-1)!.reason, 'the hold ended with the joined save').not.toBe('held: resumed memory diverged')
    expect(await command($, 'status')).not.toContain('not restored')
  })

  test('after a reload the process goes on from the save before it', async ($, on) => {
    const w = world(on)
    await $.session.start(STARTED)
    await turn($, 't1', 'Migrate the services to the new cluster')
    const [first] = Object.values(saves(w))
    await $.session.start(STARTED)
    await turn($, 't2', 'Now update the runbook')

    const [later] = Object.values(saves(w)).filter(save => save.writer !== first!.writer)
    expect(later).toMatchObject({ seq: 1, parents: [`${first!.writer}#1`] })
    expect(later!.memory.history).toHaveLength(2)
    // A new process restores the newest save of the line.
    await end($, 'prompt_input_exit', 'the-session')
    w.state.clear()
    await $.session.start(STARTED)
    await turn($, 't3', 'Continue.')
    expect(lastState(w).previous_request).toBe('Now update the runbook')
  })
})

describe('resume checkpoint lineage', () => {
  /** One save of `writer`, going on from `parents`, as its file. */
  const file = (writer: string, parents: string[], seq = 1) => ({ name: `the-session.memory.${writer}.json`,
    text: checkpoint({ writer, seq, parents }, { history: [{ request: `task of ${writer}` }] }) })
  /** `n` saves in one line, each written by a new instance after a reload or resume. */
  const line = (n: number, from: string[] = []) => Array.from({ length: n }, (_, i) => file(`w${i}`, i === 0 ? from : [`w${i - 1}#1`]))
  const restored = (files: { name: string; text: string }[]) => resumedFrom(files, 'the-session', '/work')

  test('one line restores its newest save however many files it has', () => {
    for (const n of [1, 64, 65, 500]) {
      const result = restored(line(n))
      expect([n, result.diverged, result.memory?.history[0]?.request, result.parents]).toEqual([n, false, `task of w${n - 1}`, [`w${n - 1}#1`]])
    }
  })

  test('branches restore nothing, however long the shared line', () => {
    const files = [...line(70), file('A', ['w69#1']), file('B', ['w69#1'])]
    expect(restored(files)).toEqual({ parents: ['A#1', 'B#1'], diverged: true, reason: 'branched' })
  })

  test('an unreadable newest save restores nothing', () => {
    const malformed = { name: 'the-session.memory.X.json', text: '{"schema":1,' }
    expect(restored([...line(3), malformed])).toMatchObject({ diverged: true, reason: 'unreadable' })
    const badMemory = { name: 'the-session.memory.Y.json', text: checkpoint({ writer: 'Y', parents: ['w2#1'] }, { history: [{ request: 42 }] }) }
    expect(restored([...line(3), badMemory])).toEqual({ parents: ['Y#1'], diverged: true, reason: 'unreadable' })
  })

  test('saves outside the line restore nothing until a save names them', () => {
    // A cycle cannot come from the router; it stands for any saves that do not lead to the newest one.
    const stray = [file('X', ['Y#1']), file('Y', ['X#1'])]
    const first = restored([...line(3), ...stray])
    expect(first).toEqual({ parents: ['X#1', 'Y#1', 'w2#1'], diverged: true, reason: 'unlinked' })
    expect(restored(stray)).toMatchObject({ diverged: true, reason: 'unlinked' })
    // The save after that resume names them, so the next resume finds one line.
    const joined = restored([...line(3), ...stray, file('Z', first.parents)])
    expect([joined.diverged, joined.memory?.history[0]?.request]).toEqual([false, 'task of Z'])
  })

  test('a resume names at most 64 parents, the same ones in any file order, and later resumes join the rest', () => {
    const branches = Array.from({ length: 100 }, (_, i) => file(`b${String(i).padStart(3, '0')}`, ['w0#1']))
    const files = [...line(1), ...branches]
    const first = restored(files)
    expect([first.diverged, first.reason, first.parents.length]).toEqual([true, 'branched', 64])
    expect(restored([...files].reverse()).parents).toEqual(first.parents)
    // Each later save joins up to 64 more; restore waits until every save leads to the newest one.
    const second = restored([...files, file('m1', first.parents)])
    expect([second.diverged, second.parents.length]).toEqual([true, 37])
    const third = restored([...files, file('m1', first.parents), file('m2', second.parents)])
    expect([third.diverged, third.memory?.history[0]?.request]).toEqual([false, 'task of m2'])
  })

  test('a save that no file holds any more neither restores nor blocks', () => {
    const files = line(5).slice(2)
    expect(restored(files)).toMatchObject({ diverged: false, parents: ['w4#1'] })
  })

  test('a resumed conversation with more than 64 saves in one line restores the newest', async ($, on) => {
    const files = Object.fromEntries(line(70).map(f => [`${DIR}/${f.name}`, f.text]))
    const w = world(on, { files, answers: [LOW] })
    await $.session.start(STARTED)
    await command($, 'enforce')
    await turn($, 't1', 'Continue.')
    expect(lastState(w).previous_request).toBe('task of w69')
    expect(await command($, 'status')).not.toContain('not restored')
  })
})

describe('decision log ownership', () => {
  test('a resumed process writes its own log and never rewrites the files before it', async ($, on) => {
    const earlier = `${JSON.stringify({ type: 'turn', turnId: 't0', baseline: 'xhigh' })}\n`
    const part = LOG_FILE.replace(/\.jsonl$/, '.1.jsonl')
    const partText = `${JSON.stringify({ type: 'turn', turnId: 't1' })}\n`
    const w = world(on, { files: { [LOG_FILE]: earlier, [part]: partText } })
    await $.session.start(STARTED)
    await command($, 'enforce')
    await turn($, 't2', 'push the PR', 'high')

    expect(w.files.get(LOG_FILE)).toBe(earlier)
    expect(w.files.get(part)).toBe(partText)
    expect(w.records().map(r => r.turnId)).toEqual(['t0', 't1', 't2'])
    expect(w.sent, 'high differs from the usual level the first log recorded').toEqual(['high'])
  })

  test('each instance writes its own log, never the shared name; together they hold each turn once', async ($, on) => {
    const w = world(on)
    await $.session.start(STARTED)
    await turn($, 't1', 'Migrate the services to the new cluster')
    await $.session.start(STARTED)
    await turn($, 't2', 'Now update the runbook')

    expect(w.files.has(LOG_FILE), 'no instance writes a name another could pick').toBe(false)
    const own = [...w.files.keys()].filter(path => path.startsWith(LOG_FILE.replace(/\.jsonl$/, '.')) && path.endsWith('.jsonl'))
    expect(own.map(path => turnIdsOf(w.files.get(path)))).toEqual([['t1'], ['t2']])
    expect(await command($, 'status')).toContain(`log: ${own[1]}`)
  })
})
