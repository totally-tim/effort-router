import type { On } from 'claude-code'
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

type Answer = Record<string, number> | number
type Context = 'sufficient' | 'missing_target' | 'missing_scope' | 'missing_evidence'

/**
 * One enforce-mode turn at an xhigh session effort: the initial decision, then
 * one discovery per listed step. `between` runs before each discovery step.
 */
async function discoveryTurn($: Engine, on: On, answers: Answer[], contexts: Context[],
  options: { mode?: 'enforce' | 'shadow'; between?: (index: number) => Promise<void>; relations?: ('new' | 'continuation')[] } = {}) {
  const w = world(on, { answers: answers as never, contexts, relations: options.relations })
  on('tool.call', (_$, e) => {
    const path = 'file_path' in e ? String(e.file_path) : ''
    return path.endsWith('.missing') ? { result: {}, text: 'ENOENT', isError: true }
      : { result: {}, text: `source ${path}`, ...(e.tool === 'Read' ? { isReadOnly: true as const } : {}) }
  })
  await $.session.start(STARTED)
  if ((options.mode ?? 'enforce') === 'enforce') await command($, 'enforce')
  await $.turn.start({ text: 'Explain the application', turnId: 't1' })
  await step($, 't1', 0, 'xhigh')
  // Shadow mode does not wait for decisions; settle so each step sees the last one.
  await w.clock.settle()
  for (let i = 1; i < Math.min(answers.length, 3); i++) {
    await options.between?.(i)
    await $.tool.call({ tool: 'Read', file_path: `/work/f${i}.ts` })
    await step($, 't1', i, 'xhigh')
    await w.clock.settle()
  }
  return w
}

describe('floor: reproduction (desired behavior)', () => {
  test('F1 an applied context hold cannot lower below an earlier confident pick', async ($, on) => {
    const w = await discoveryTurn($, on, [{ high: 1 }, { low: 1 }, { low: 1 }], ['sufficient', 'missing_scope', 'sufficient'])
    await complete($, 't1')
    expect(w.posts).toHaveLength(3)
    expect(w.sent).toEqual(['high', 'xhigh', 'high'])
    const record = w.records()[0]!
    expect(record).toMatchObject({ reason: 'retained effort', context_held: false, context_sufficient: true, would_pick: 'high' })
    expect((record.discovery as { level: string; contextHeld: boolean }[]).map(d => [d.level, d.contextHeld])).toEqual([['xhigh', true], ['low', false]])
  })

  test('F2 a failed discovery cannot grant permission to lower below a confident pick', async ($, on) => {
    const w = await discoveryTurn($, on, [{ high: 1 }, 503, { low: 1 }], ['sufficient'])
    await complete($, 't1')
    expect(w.posts).toHaveLength(3)
    expect(w.sent).toEqual(['high', 'xhigh', 'high'])
  })

  test('F3 a sufficient medium after an applied hold returns to the confident high', async ($, on) => {
    const w = await discoveryTurn($, on, [{ high: 1 }, { low: 1 }, { medium: 1 }], ['sufficient', 'missing_scope', 'sufficient'])
    await complete($, 't1')
    expect(w.sent).toEqual(['high', 'xhigh', 'high'])
  })

  test('F4 tool-failure escalation applies above the retained confident pick', async ($, on) => {
    let seen = 0
    const w = await discoveryTurn($, on, [{ high: 1 }, { low: 1 }, { low: 1 }], ['sufficient', 'missing_scope', 'sufficient'], {
      between: async i => {
        if (i !== 2) return
        for (const name of ['a', 'b']) await $.tool.call({ tool: 'Read', file_path: `/work/${name}.missing` })
        seen = 2
      },
    })
    await complete($, 't1')
    expect(seen).toBe(2)
    expect(w.records()[0]?.tool_errors).toBe(2)
    expect(w.sent).toEqual(['high', 'xhigh', 'xhigh'])
  })

  test('F5 shadow mode predicts the retained confident pick', async ($, on) => {
    const w = await discoveryTurn($, on, [{ high: 1 }, { low: 1 }, { low: 1 }], ['sufficient', 'missing_scope', 'sufficient'], { mode: 'shadow' })
    await w.clock.settle()
    await complete($, 't1')
    expect(w.sent).toEqual(['xhigh', 'xhigh', 'xhigh'])
    expect((w.records()[0]?.steps as { would?: string }[]).map(s => s.would)).toEqual(['high', 'xhigh', 'high'])
  })

  test('F6 a continuation inherits the retained confident pick, not the lowered level', async ($, on) => {
    const w = await discoveryTurn($, on, [{ high: 1 }, { low: 1 }, { low: 1 }], ['sufficient', 'missing_scope', 'sufficient'],
      { relations: ['new', 'new', 'new', 'continuation'] })
    await complete($, 't1')
    await $.turn.start({ text: 'Continue with that.', turnId: 't2' })
    await step($, 't2', 0, 'xhigh')
    await complete($, 't2')
    expect(w.records()[1]?.continuation).toBe(true)
    expect(w.sent).toEqual(['high', 'xhigh', 'high', 'high'])
  })
})

describe('floor: counterexamples that must keep their behavior', () => {
  test('K1 a pure temporary context hold still lowers', async ($, on) => {
    const w = await discoveryTurn($, on, [{ low: 1 }, { low: 1 }], ['missing_target', 'sufficient'])
    await complete($, 't1')
    expect(w.sent).toEqual(['xhigh', 'low'])
    expect(w.records()[0]).toMatchObject({ context_sufficient: true })
  })

  test('K2 a hold over a confident low lowers back to that low', async ($, on) => {
    const w = await discoveryTurn($, on, [{ low: 1 }, { low: 1 }, { low: 1 }], ['sufficient', 'missing_scope', 'sufficient'])
    await complete($, 't1')
    expect(w.sent).toEqual(['low', 'xhigh', 'low'])
  })

  test('K3 no lowering once work has begun', async ($, on) => {
    const w = await discoveryTurn($, on, [{ high: 1 }, { low: 1 }, { low: 1 }], ['sufficient', 'missing_scope', 'sufficient'], {
      between: async i => { if (i === 2) await $.tool.call({ tool: 'Bash', command: 'make change' }) },
    })
    expect(await spinner($, w.drawn)).toBe('Baking… at xhigh effort (kept for active work)')
    await complete($, 't1')
    expect(w.sent).toEqual(['high', 'xhigh', 'xhigh'])
  })

  test('K4 an unapplied abstention cannot reopen lowering of a confident xhigh', async ($, on) => {
    const w = await discoveryTurn($, on, [{ xhigh: 1 }, { low: 1 }, { low: 1 }], ['sufficient', 'missing_scope', 'sufficient'])
    await complete($, 't1')
    expect(w.sent).toEqual(['xhigh', 'xhigh', 'xhigh'])
  })

  test('K5 a sufficient discovery never lowers a confident pick without a hold', async ($, on) => {
    const w = await discoveryTurn($, on, [{ high: 1 }, { low: 1 }], ['sufficient', 'sufficient'])
    await complete($, 't1')
    expect(w.sent).toEqual(['high', 'high'])
  })

  test('K6 successful discovery after an initial failure keeps the session effort', async ($, on) => {
    const w = await discoveryTurn($, on, [503, { low: 1 }], ['sufficient'])
    await complete($, 't1')
    expect(w.sent).toEqual(['xhigh', 'xhigh'])
  })

  test('K7 an independent next task gets a fresh decision', async ($, on) => {
    const w = await discoveryTurn($, on, [{ high: 1 }, { low: 1 }, { low: 1 }], ['sufficient', 'missing_scope', 'sufficient'])
    await complete($, 't1')
    await $.turn.start({ text: 'Reply OK', turnId: 't2' })
    await step($, 't2', 0, 'xhigh')
    await complete($, 't2')
    expect(w.records()[1]?.continuation).toBe(false)
    expect(w.sent.at(-1)).toBe('low')
  })

  test('K8 a held initial pick lowers to a sufficient raise', async ($, on) => {
    const w = await discoveryTurn($, on, [{ low: 1 }, { medium: 1 }, { low: 1 }], ['missing_target', 'sufficient', 'sufficient'])
    await complete($, 't1')
    expect(w.sent).toEqual(['xhigh', 'medium', 'medium'])
  })

  test('K10 the floor does not block a real raise after a hold', async ($, on) => {
    const w = await discoveryTurn($, on, [{ low: 1 }, { low: 1 }, { medium: 1 }], ['sufficient', 'missing_scope', 'sufficient'])
    await complete($, 't1')
    expect(w.sent).toEqual(['low', 'xhigh', 'medium'])
    expect(w.records()[0]?.reason).toBe('classifier')
  })

  test('K11 a sufficient xhigh after a hold keeps the classifier reason', async ($, on) => {
    const w = await discoveryTurn($, on, [{ high: 1 }, { low: 1 }, { xhigh: 1 }], ['sufficient', 'missing_scope', 'sufficient'])
    await complete($, 't1')
    expect(w.sent).toEqual(['high', 'xhigh', 'xhigh'])
    expect(w.records()[0]).toMatchObject({ reason: 'classifier', context_held: false, context_sufficient: true })
  })

  test('K12 a mid-turn raise still holds after a hold is released', async ($, on) => {
    const w = world(on, { answers: [{ low: 1 }, { high: 1 }, { low: 1 }, { low: 1 }], contexts: ['sufficient', 'sufficient', 'missing_scope', 'sufficient'] })
    on('prompt.submit', (_$, e) => ({ text: e.text }))
    on('tool.call', (_$, e) => ({ result: {}, text: `source ${'file_path' in e ? e.file_path : ''}`, isReadOnly: true }))
    await $.session.start(STARTED)
    await command($, 'enforce')
    await $.turn.start({ text: 'Explain the application', turnId: 't1' })
    await step($, 't1', 0, 'xhigh')
    await $.prompt.submit({ turnId: 't1', text: 'Also redesign the release process.', wait: false, origin: { kind: 'composer' } })
    await $.tool.call({ tool: 'Read', file_path: '/work/a.ts' })
    await step($, 't1', 1, 'xhigh')
    await $.tool.call({ tool: 'Read', file_path: '/work/b.ts' })
    await step($, 't1', 2, 'xhigh')
    await complete($, 't1')
    expect(w.posts).toHaveLength(4)
    expect(w.sent).toEqual(['low', 'xhigh', 'high'])
    expect(w.records()[0]).toMatchObject({ raised_to: 'high', would_pick: 'low' })
  })

  test('K9 manual max is never routed', async ($, on) => {
    const w = world(on, { contexts: ['sufficient'] })
    on('tool.call', () => ({ result: {}, text: 'source', isReadOnly: true }))
    await $.session.start(STARTED)
    await command($, 'enforce')
    await $.turn.start({ text: 'Explain the application', turnId: 't1' })
    await step($, 't1', 0, 'max')
    await $.tool.call({ tool: 'Read', file_path: '/work/a.ts' })
    await step($, 't1', 1, 'max')
    await complete($, 't1')
    expect(w.sent).toEqual(['max', 'max'])
  })
})
