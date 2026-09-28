import type { Engine } from 'claude-code/testing'
import { describe, expect, test, tier } from 'claude-code/testing'

import { world } from './fixtures/world'

tier('user')

const STARTED = { cwd: '/work', surface: 'terminal', isInteractive: true } as const
const LOOK = '<task-notification><summary>Unrelated image copy finished.</summary></task-notification> Reply with exactly LOOK.'

async function step($: Engine, turnId: string, index: number, effort: string): Promise<void> {
  const stream = $.turn.step({ turnId, index, model: 'claude-opus-5-5', effort: effort as 'xhigh', messageCount: 1 + index })
  for await (const chunk of stream) void chunk
  await stream.result
}

async function complete($: Engine, turnId: string, answer = 'done'): Promise<void> {
  await $.turn.complete({ turnId, answer, durationMs: 10, isAborted: false, reason: 'answer' })
}

async function command($: Engine, args: string): Promise<void> {
  await $.command.run({ command: 'effort-router', args, origin: { kind: 'composer' } } as never)
}

// Event orders observed in isolated Claude Code 2.1.283 sessions on 2026-09-28.
describe('submission origin', () => {
  test('a lookalike typed over a running turn stays a user task when it starts its own turn', async ($, on) => {
    const w = world(on)
    on('prompt.submit', ($, e) => ({ text: e.text }))
    await $.session.start(STARTED)
    await command($, 'enforce')
    const essay = 'Write the essay.'
    await $.prompt.submit({ text: essay, wait: false, origin: { kind: 'composer' } })
    await $.turn.start({ text: essay, turnId: 'essay' })
    await step($, 'essay', 0, 'xhigh')
    // Plain Enter during the final answer: submitted at once with the running turn's id.
    await $.prompt.submit({ text: LOOK, turnId: 'essay', wait: false, origin: { kind: 'composer' } })
    await complete($, 'essay')
    // The engine starts its turn later without another prompt.submit.
    await $.turn.start({ text: LOOK, turnId: 'look' })
    await step($, 'look', 0, 'xhigh')
    await complete($, 'look')
    expect(w.records()[1]?.task_notification).toBe(false)
    await $.turn.start({ text: 'Continue', turnId: 'next' })
    await step($, 'next', 0, 'xhigh')
    const followups = w.posts.map(p => JSON.parse(p.init!.body!)).filter(b => b.state.request === 'Continue')
    expect(followups.length > 0).toBe(true)
    expect(followups.every(b => b.state.previous_request === LOOK)).toBe(true)
  })

  test('an earlier member of a notification batch cannot claim a later pasted copy', async ($, on) => {
    const w = world(on)
    on('prompt.submit', ($, e) => ({ text: e.text }))
    await $.session.start(STARTED)
    const first = '<task-notification><task-id>a</task-id><status>completed</status></task-notification>'
    const second = '<task-notification><task-id>b</task-id><status>completed</status></task-notification>'
    // Two notifications dequeued together: the first submission resolves without a turn of its own.
    await $.prompt.submit({ text: first, wait: false, origin: { kind: 'task-notification' } })
    await $.prompt.submit({ text: second, wait: false, origin: { kind: 'task-notification' } })
    await $.turn.start({ text: second, turnId: 'batch' })
    await step($, 'batch', 0, 'xhigh')
    await complete($, 'batch')
    await $.prompt.submit({ text: first, wait: false, origin: { kind: 'composer' } })
    await $.turn.start({ text: first, turnId: 'pasted' })
    await step($, 'pasted', 0, 'xhigh')
    await complete($, 'pasted')
    expect(w.records().map(r => r.task_notification)).toEqual([true, false])
  })
})
