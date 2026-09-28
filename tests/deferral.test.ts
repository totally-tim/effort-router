import type { Engine } from 'claude-code/testing'
import { describe, expect, test, tier } from 'claude-code/testing'

import { world } from './fixtures/world'

tier('user')

// Test-kit evidence, not a live Claude session: the engine's own hook budget
// runs while the fixture's classifier waits real wall-clock time on the
// mid-turn message. Without instrumentation, a deferral shows as three classifier
// posts (initial, mid-turn, one discovery) instead of four.

const STARTED = { cwd: '/work', surface: 'terminal', isInteractive: true } as const
// A 4.8 s real wait leaves little of the kit's default 5 s test deadline on a loaded host.
const WALL = { timeoutMs: 15_000 }

async function step($: Engine, turnId: string, index: number, effort: string): Promise<void> {
  const stream = $.turn.step({ turnId, index, model: 'claude-opus-5-5', effort: effort as 'xhigh', messageCount: 1 + index })
  for await (const chunk of stream) void chunk
  await stream.result
}

async function deferralTurn($: Engine, on: Parameters<typeof world>[0], answers: (Record<string, number> | number)[], wallMs: number) {
  const w = world(on, { answers: answers as never, contexts: ['sufficient'], wallDelays: { 2: wallMs } })
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('tool.call', (_$, e) => ({ result: {}, text: `source ${'file_path' in e ? e.file_path : ''}`, isReadOnly: true }))
  await $.session.start(STARTED)
  await $.command.run({ command: 'effort-router', args: 'enforce', origin: { kind: 'composer' } } as never)
  await $.turn.start({ text: 'Explain the application', turnId: 't1' })
  await step($, 't1', 0, 'xhigh')
  await $.prompt.submit({ turnId: 't1', text: 'Keep the final explanation to one sentence.', wait: false, origin: { kind: 'composer' } })
  await $.tool.call({ tool: 'Read', file_path: '/work/a.ts' })
  await step($, 't1', 1, 'xhigh')
  await $.tool.call({ tool: 'Read', file_path: '/work/b.ts' })
  await step($, 't1', 2, 'xhigh')
  await $.turn.complete({ turnId: 't1', answer: 'done', durationMs: 10, isAborted: false, reason: 'answer' })
  return { w }
}

describe('hook-budget deferral at the default 5 s timeout', () => {
  test('W1 a 4.8 s mid-turn classification defers discovery; the confident high is kept', WALL, async ($, on) => {
    const { w } = await deferralTurn($, on, [{ high: 1 }, { low: 1 }, { low: 1 }], 4800)
    expect(w.posts).toHaveLength(3)
    expect(w.sent).toEqual(['high', 'xhigh', 'high'])
  })

  test('W2 a 3.5 s mid-turn classification leaves enough budget to discover', WALL, async ($, on) => {
    const { w } = await deferralTurn($, on, [{ high: 1 }, { low: 1 }, { low: 1 }], 3500)
    expect(w.posts).toHaveLength(4)
    expect(w.sent).toEqual(['high', 'high', 'high'])
  })

  test('W3 after an initial failure, a deferral cannot authorize a later sufficient low', WALL, async ($, on) => {
    const { w } = await deferralTurn($, on, [503, { low: 1 }, { low: 1 }], 4800)
    expect(w.posts).toHaveLength(3)
    expect(w.sent).toEqual(['xhigh', 'xhigh', 'xhigh'])
  })
})
