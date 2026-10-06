import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { describe, expect, test, tier } from 'claude-code/testing'

import { type World, type WorldOptions, world } from './fixtures/world'

tier('user')

const STARTED = { cwd: '/work', surface: 'terminal', isInteractive: true } as const
const BACKGROUND = '<task-notification><task-id>b1</task-id><status>completed</status><summary>Build finished</summary></task-notification>'
const SECOND = '<task-notification><task-id>b2</task-id><status>completed</status><summary>Tests finished</summary></task-notification>'
const ESSAY = 'Write the essay on congestion control.'
const SIMPLE = 'Reply with exactly OK.'
// A 4.8 s real wait leaves little of the kit's default 5 s test deadline on a loaded host.
const WALL = { timeoutMs: 15_000 }

async function step($: Engine, turnId: string, index: number, effort = 'xhigh'): Promise<void> {
  const stream = $.turn.step({ turnId, index, model: 'claude-opus-5-5', effort: effort as 'xhigh', messageCount: 1 + index })
  for await (const chunk of stream) void chunk
  await stream.result
}

async function complete($: Engine, turnId: string): Promise<void> {
  await $.turn.complete({ turnId, answer: 'done', durationMs: 10, isAborted: false, reason: 'answer' })
}

async function command($: Engine, args: string): Promise<void> {
  await $.command.run({ command: 'effort-router', args, origin: { kind: 'composer' } } as never)
}

function readable(on: On): void {
  on('tool.call', (_$, e) => ({ result: {}, text: `source ${'file_path' in e ? e.file_path : ''}`, isReadOnly: true }))
}

/** An enforce-mode session whose first turn is a background completion: submitted with `origin`, unless null. */
async function notified($: Engine, on: On, options: WorldOptions, origin: string | null = 'task-notification',
  text = BACKGROUND, effort = 'xhigh'): Promise<World> {
  const w = world(on, options)
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  readable(on)
  await $.session.start(STARTED)
  await command($, 'enforce')
  if (origin) await $.prompt.submit({ text, wait: false, origin: { kind: origin } as never })
  await $.turn.start({ text, turnId: 'n' })
  await step($, 'n', 0, effort)
  await w.clock.settle()
  return w
}

/** Further requests of the turn `n`, each after a Read that the router may discover on. */
async function reads($: Engine, w: World, count: number): Promise<void> {
  for (let i = 1; i <= count; i++) {
    await $.tool.call({ tool: 'Read', file_path: `/work/f${i}.ts` })
    await step($, 'n', i)
    await w.clock.settle()
  }
}

describe('a background completion the host reported holds at high', () => {
  test('N1 missing context keeps high, not the session effort, and still reports the hold', async ($, on) => {
    const w = await notified($, on, { answers: [{ low: 1 }], contexts: ['missing_scope'] })
    await complete($, 'n')
    expect(w.sent).toEqual(['high'])
    expect(w.records()[0]).toMatchObject({ task_notification: true, origin: 'task-notification', context_held: true,
      reason: 'insufficient context', decided: 'high', unheld: 'low', context_answer: { choice: 'missing_scope' } })
  })

  test('N2 with sufficient context the assessment applies as before', async ($, on) => {
    const w = await notified($, on, { answers: [{ low: 1 }], contexts: ['sufficient'] })
    await complete($, 'n')
    expect(w.sent).toEqual(['low'])
  })

  test('N3 a session below high keeps its own effort', async ($, on) => {
    const w = await notified($, on, { answers: [{ low: 1 }], contexts: ['missing_scope'], saved: { 'claude-opus-5-5': 'medium' } },
      'task-notification', BACKGROUND, 'medium')
    await complete($, 'n')
    expect(w.sent).toEqual(['medium'])
  })

  test('N4 an xhigh assessment is never capped', async ($, on) => {
    const w = await notified($, on, { answers: [{ xhigh: 1 }], contexts: ['missing_scope'] })
    await complete($, 'n')
    expect(w.sent).toEqual(['xhigh'])
  })

  test('N5 a typed lookalike keeps the session effort', async ($, on) => {
    const w = await notified($, on, { answers: [{ low: 1 }], contexts: ['missing_scope'] }, 'composer')
    await complete($, 'n')
    expect(w.sent).toEqual(['xhigh'])
    expect(w.records()[0]).toMatchObject({ task_notification: false, origin: 'composer' })
  })

  test('N6 an envelope with no submission the host stamped keeps the session effort', async ($, on) => {
    const w = await notified($, on, { answers: [{ low: 1 }], contexts: ['missing_scope'] }, null)
    await complete($, 'n')
    expect(w.sent).toEqual(['xhigh'])
    expect(w.records()[0]?.task_notification).toBe(true)
    expect(w.records()[0]?.origin).toBeUndefined()
  })

  test('N7 effort set by hand is sent unchanged', async ($, on) => {
    const w = await notified($, on, { answers: [{ low: 1 }], contexts: ['missing_scope'] }, 'task-notification', BACKGROUND, 'max')
    await complete($, 'n')
    expect(w.sent).toEqual(['max'])
  })

  test('N8 a message typed during it keeps the full hold and raises the turn', async ($, on) => {
    const w = await notified($, on, { answers: [{ low: 1 }], contexts: ['missing_scope', 'missing_scope'] })
    await $.prompt.submit({ text: 'Also check the deploy logs.', turnId: 'n', wait: false, origin: { kind: 'composer' } })
    await w.clock.settle()
    await step($, 'n', 1)
    await complete($, 'n')
    expect(w.sent).toEqual(['high', 'xhigh'])
    const record = w.records()[0]!
    expect(record.raised_to).toBe('xhigh')
    expect((record.mid_turn as { context_answer?: object }[])[0]?.context_answer).toEqual({ choice: 'missing_scope' })
  })
})

describe('later checks of a held background completion', () => {
  test('D1 discovery with sufficient context still releases the hold', async ($, on) => {
    const w = await notified($, on, { answers: [{ high: 1 }, { low: 1 }], contexts: ['missing_scope', 'sufficient'] })
    await reads($, w, 1)
    await complete($, 'n')
    expect(w.sent).toEqual(['high', 'low'])
  })

  test('D2 discovery that still lacks context keeps high', async ($, on) => {
    const w = await notified($, on, { answers: [{ low: 1 }], contexts: ['missing_scope', 'missing_scope'] })
    await reads($, w, 1)
    await complete($, 'n')
    expect(w.sent).toEqual(['high', 'high'])
  })

  test('D3 a spent discovery budget retains high', async ($, on) => {
    const w = await notified($, on, { answers: [{ low: 1 }], contexts: ['missing_target'] })
    await reads($, w, 3)
    await complete($, 'n')
    expect(w.sent).toEqual(['high', 'high', 'high', 'high'])
    expect(w.records()[0]).toMatchObject({ reason: 'discovery budget exhausted' })
  })

  test('D4 a failed discovery keeps the session effort', async ($, on) => {
    const w = await notified($, on, { answers: [{ low: 1 }, 503], contexts: ['missing_scope'] })
    await reads($, w, 1)
    await complete($, 'n')
    expect(w.sent).toEqual(['high', 'xhigh'])
  })

  test('D5 after a failed first decision a held recovery keeps the session effort', async ($, on) => {
    const w = await notified($, on, { answers: [503, { low: 1 }], contexts: ['missing_scope'] })
    await reads($, w, 1)
    await complete($, 'n')
    expect(w.sent).toEqual(['xhigh', 'xhigh'])
  })

  // Test-kit evidence: the engine's hook budget runs while the fixture waits real time on the typed message.
  test('D6 a discovery deferred for the hook budget retains high', WALL, async ($, on) => {
    const w = await notified($, on, { answers: [{ low: 1 }], contexts: ['missing_scope', 'sufficient', 'missing_scope'], wallDelays: { 2: 4800 } })
    await $.prompt.submit({ text: 'Keep the summary to one sentence.', turnId: 'n', wait: false, origin: { kind: 'composer' } })
    await reads($, w, 1)
    await complete($, 'n')
    expect(w.posts).toHaveLength(2)
    expect(w.sent).toEqual(['high', 'high'])
    expect((w.records()[0]!.steps as { deferred?: object }[])[1]?.deferred).toBeDefined()
  })
})

// Review finding: while a missed takeover leaves task memory unresolved, the
// earlier instance may still bring typed prompts, so no decision may lower
// effort on it, a reported background completion included.
describe('a background completion on memory that can be stale', () => {
  /** A reload whose takeover write misses, after which the host refuses the memory, then a reported completion. */
  async function staleNotification($: Engine, on: On, options: WorldOptions): Promise<World> {
    const w = world(on, options)
    on('prompt.submit', (_$, e) => ({ text: e.text }))
    readable(on)
    await $.session.start(STARTED)
    await command($, 'enforce')
    await $.turn.start({ text: SIMPLE, turnId: 't1' })
    await step($, 't1', 0)
    await complete($, 't1')
    let wrote = false
    w.state.freeze()
    w.state.afterRead = () => {
      if (wrote) return
      wrote = true
      const value = w.state.read('memory', 'the-session').value as Record<string, any>
      w.state.write('memory', 'the-session', { ...value, memory: { ...value.memory, lastLevel: 'xhigh' } })
    }
    await $.session.start(STARTED)
    w.state.thaw()
    w.state.refuse = true
    await $.prompt.submit({ text: BACKGROUND, wait: false, origin: { kind: 'task-notification' } })
    await $.turn.start({ text: BACKGROUND, turnId: 'n' })
    await step($, 'n', 0)
    await w.clock.settle()
    await complete($, 'n')
    return w
  }

  test('an assessment with sufficient context keeps the session effort', async ($, on) => {
    const w = await staleNotification($, on, { answers: [{ low: 1 }], contexts: ['sufficient'] })
    expect(w.sent).toEqual(['low', 'xhigh'])
    expect(w.records().at(-1)).toMatchObject({ origin: 'task-notification', reason: 'held: memory takeover pending' })
  })

  test('missing context keeps the session effort', async ($, on) => {
    const w = await staleNotification($, on, { answers: [{ low: 1 }], contexts: ['missing_scope'] })
    expect(w.sent.at(-1)).toBe('xhigh')
    expect(w.records().at(-1)).toMatchObject({ origin: 'task-notification' })
  })
})

describe('queued prompts and background completions', () => {
  test('Q1 a typed prompt queued with a completion keeps the session effort', async ($, on) => {
    const w = world(on, { answers: [{ low: 1 }], contexts: ['sufficient', 'sufficient', 'missing_target'] })
    on('prompt.submit', (_$, e) => ({ text: e.text }))
    await $.session.start(STARTED)
    await command($, 'enforce')
    await $.prompt.submit({ text: ESSAY, wait: false, origin: { kind: 'composer' } })
    await $.turn.start({ text: ESSAY, turnId: 'essay' })
    await step($, 'essay', 0)
    await $.prompt.submit({ text: SIMPLE, turnId: 'essay', wait: true, origin: { kind: 'composer' } })
    await w.clock.settle()
    await $.prompt.submit({ text: BACKGROUND, turnId: 'essay', wait: false, origin: { kind: 'task-notification' } })
    await complete($, 'essay')
    w.transcript.rows = [{ role: 'assistant', text: 'done' }, { role: 'user', text: SIMPLE }, { role: 'user', text: BACKGROUND }]
    await $.turn.start({ text: BACKGROUND, turnId: 'batch' })
    await step($, 'batch', 0)
    await complete($, 'batch')
    expect(w.sent).toEqual(['low', 'xhigh'])
    expect(w.records()[1]).toMatchObject({ task_notification: false, origin: 'task-notification', reason: 'insufficient context' })
  })

  test('Q2 completions that enter together hold at high', async ($, on) => {
    const w = world(on, { answers: [{ low: 1 }], contexts: ['missing_target'] })
    on('prompt.submit', (_$, e) => ({ text: e.text }))
    await $.session.start(STARTED)
    await command($, 'enforce')
    await $.prompt.submit({ text: BACKGROUND, wait: false, origin: { kind: 'task-notification' } })
    await $.prompt.submit({ text: SECOND, wait: false, origin: { kind: 'task-notification' } })
    await $.turn.start({ text: SECOND, turnId: 'batch' })
    await step($, 'batch', 0)
    await complete($, 'batch')
    expect(w.sent).toEqual(['high'])
    expect(w.records()[0]).toMatchObject({ task_notification: true, origin: 'task-notification' })
  })
})

describe('shadow candidates', () => {
  test('a typed turn logs what later policies would pick, and sends what this one picks', async ($, on) => {
    const w = world(on, { answers: [{ low: 1 }], contexts: ['sufficient'], contextProbabilities: [0.6] })
    await $.session.start(STARTED)
    await command($, 'enforce')
    await $.turn.start({ text: 'Explain the application', turnId: 't1' })
    await step($, 't1', 0)
    await complete($, 't1')
    expect(w.sent).toEqual(['xhigh'])
    expect(w.records()[0]).toMatchObject({ decided: 'xhigh', unheld: 'low', missing_context: ['uncertain_context'],
      context_answer: { choice: 'sufficient', sufficient: 0.6 }, relation_answer: { choice: 'new', probability: 1 },
      candidates: { accept_uncertain: 'low', xhigh_min_mass: 'low' } })
  })

  test('a small xhigh share shows as a lower candidate only', async ($, on) => {
    const w = world(on, { answers: [{ high: 0.88, xhigh: 0.12 }], contexts: ['sufficient'] })
    await $.session.start(STARTED)
    await command($, 'enforce')
    await $.turn.start({ text: 'Explain the application', turnId: 't1' })
    await step($, 't1', 0)
    await complete($, 't1')
    expect(w.sent).toEqual(['xhigh'])
    expect(w.records()[0]).toMatchObject({ candidates: { accept_uncertain: 'xhigh', xhigh_min_mass: 'high' } })
  })
})
