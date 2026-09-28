import type { Engine } from 'claude-code/testing'
import { describe, expect, test, tier } from 'claude-code/testing'

import { CacheTracker, cacheOutcomeOf } from '../hooks/cache'
import { world } from './fixtures/world'

tier('user')

const STARTED = { cwd: '/work', surface: 'terminal', isInteractive: true } as const

async function step($: Engine, turnId: string, effort: string, options: { model?: string; agentId?: string } = {}): Promise<void> {
  const stream = $.turn.step({
    turnId,
    index: 0,
    model: options.model ?? 'claude-opus-5-5',
    effort: effort as 'xhigh',
    messageCount: 1,
    ...(options.agentId ? { agentId: options.agentId } : {}),
  })

  for await (const chunk of stream) {
    void chunk
  }

  await stream.result
}

async function turn($: Engine, turnId: string, effort: string, options: { model?: string } = {}): Promise<void> {
  await $.turn.start({ text: 'Acknowledge this in one sentence.', turnId })
  await step($, turnId, effort, options)
  await $.turn.complete({ turnId, answer: 'Acknowledged.', durationMs: 10, isAborted: false, reason: 'answer' })
}

async function status($: Engine): Promise<string | undefined> {
  const result = await $.command.run({ command: 'effort-router', args: 'status', origin: { kind: 'composer' } } as never)

  return result.text
}

// Usage of the September 28 default-path regression on Opus 5.5 (fresh
// session; low, low, xhigh, low): the two effort changes re-cached the prefix.
const REGRESSION = [
  { input: 2, cacheRead: 1441, cacheWrite: 6740 },
  { input: 2, cacheRead: 8181, cacheWrite: 62 },
  { input: 2, cacheRead: 3116, cacheWrite: 5187 },
  { input: 2, cacheRead: 3116, cacheWrite: 5248 },
]

describe('cache diagnostics', () => {
  test('the /context ledger rule: below 95% of the smaller prompt and at least 2,000 tokens short', () => {
    expect(cacheOutcomeOf(REGRESSION[0]!, REGRESSION[1]!), 'a thread continue read the whole prefix').toBe('hit')
    expect(cacheOutcomeOf(REGRESSION[1]!, REGRESSION[2]!), 'read 3,116 of 8,245').toBe('miss')
    // The dashboard session's partial miss: 100,680 of 202,772 prior tokens.
    expect(cacheOutcomeOf({ input: 0, cacheRead: 202772, cacheWrite: 0 }, { input: 0, cacheRead: 100680, cacheWrite: 5356 })).toBe('miss')

    const before = { input: 0, cacheRead: 100000, cacheWrite: 0 }
    expect(cacheOutcomeOf(before, { input: 0, cacheRead: 95000, cacheWrite: 5000 }), 'exactly 95% hits').toBe('hit')
    expect(cacheOutcomeOf(before, { input: 0, cacheRead: 94999, cacheWrite: 5001 })).toBe('miss')

    const small = { input: 0, cacheRead: 30000, cacheWrite: 0 }
    expect(cacheOutcomeOf(small, { input: 0, cacheRead: 28001, cacheWrite: 1999 }), '1,999 short is no miss').toBe('hit')
    expect(cacheOutcomeOf(small, { input: 0, cacheRead: 28000, cacheWrite: 2000 }), '2,000 short below 95% misses').toBe('miss')
    expect(cacheOutcomeOf({ input: 0, cacheRead: 9000, cacheWrite: 0 }, { input: 0, cacheRead: 8000, cacheWrite: 1000 }),
      'a small prompt below 95% but under 2,000 short is no miss').toBe('hit')

    expect(cacheOutcomeOf({ input: 0, cacheRead: 200000, cacheWrite: 0 }, { input: 1000, cacheRead: 19000, cacheWrite: 0 }),
      'a shrunken prompt compares against its own size').toBe('hit')
    expect(cacheOutcomeOf({ input: 5000, cacheRead: 0, cacheWrite: 0 }, { input: 2, cacheRead: 0, cacheWrite: 5000 }),
      'after a request that used no cache the next is cold').toBe('cold')
  })

  test('a tracker compares within one conversation and model, and skips requests without usage', () => {
    const tracker = new CacheTracker()
    const at = Date.parse('2026-09-28T10:00:00Z')

    expect(tracker.record({ conversation: 'a', model: 'opus', effort: 'low', usage: REGRESSION[0], at }), 'the first request has nothing to compare').toEqual({})
    expect(tracker.line(), 'no line before a comparison').toBeUndefined()
    expect(tracker.record({ conversation: 'a', model: 'opus', effort: 'low', at }), 'a failed request is skipped').toEqual({})
    expect(tracker.record({ conversation: 'a', model: 'opus', effort: 'low', usage: REGRESSION[1], at })).toEqual({ cache: 'hit' })
    expect(tracker.record({ conversation: 'a', model: 'opus', effort: 'xhigh', usage: REGRESSION[2], at })).toEqual({ cache: 'miss', effortChanged: true })
    expect(tracker.line()).toBe('cache since 10:00 UTC (usage estimate): misses at 1 of 1 requests after an effort change, 0 of 1 others; 5.2k tokens re-cached')

    expect(tracker.record({ conversation: 'a', model: 'sonnet', effort: 'xhigh', usage: { input: 2, cacheRead: 0, cacheWrite: 9000 }, at }),
      'a model switch forfeits the cache by design and is no outcome').toEqual({})
    expect(tracker.record({ conversation: 'a', model: 'opus', effort: 'xhigh', usage: REGRESSION[3], at }),
      'the next request compares only with the same model').toEqual({})
    expect(tracker.tally.compared).toBe(2)

    tracker.gap()
    expect(tracker.record({ conversation: 'a', model: 'opus', effort: 'low', usage: REGRESSION[3], at }),
      'after an unseen request there is nothing to compare').toEqual({})
    expect(tracker.tally.compared, 'a gap keeps the tally').toBe(2)

    const later = Date.parse('2026-09-28T11:30:00Z')
    expect(tracker.record({ conversation: 'b', model: 'opus', effort: 'low', usage: REGRESSION[0], at: later }), 'a new conversation starts a new scope').toEqual({})
    expect(tracker.tally.compared).toBe(0)
    expect(tracker.record({ conversation: 'b', model: 'opus', effort: 'low', usage: REGRESSION[1], at: later })).toEqual({ cache: 'hit' })
    expect(tracker.line()).toBe('cache since 11:30 UTC (usage estimate): misses at 0 of 0 requests after an effort change, 0 of 1 others; 0 tokens re-cached')
  })

  test('the log and status attribute cache misses to requests that changed effort, across turns', async ($, on) => {
    const w = world(on, { usages: REGRESSION })

    await $.session.start(STARTED)
    // Shadow mode sends each request's own effort, so the efforts below are what went out.
    await turn($, 't1', 'xhigh')
    await turn($, 't2', 'xhigh')
    await turn($, 't3', 'high')
    await turn($, 't4', 'xhigh')

    expect(w.sent).toEqual(['xhigh', 'xhigh', 'high', 'xhigh'])
    const steps = w.records().map(r => (r.steps as Record<string, unknown>[])[0])
    expect(steps[0]).not.toHaveProperty('cache')
    expect(steps[1]).toMatchObject({ cache: 'hit' })
    expect(steps[1]).not.toHaveProperty('effortChanged')
    expect(steps[2]).toMatchObject({ cache: 'miss', effortChanged: true })
    expect(steps[3]).toMatchObject({ cache: 'miss', effortChanged: true })
    expect(await status($)).toContain('(usage estimate): misses at 2 of 2 requests after an effort change, 0 of 1 others; 10.4k tokens re-cached')
  })

  test('subagent requests, model switches and a conversation switch leave the comparison clean', async ($, on) => {
    const w = world(on, { usages: [REGRESSION[0]!, { input: 2, cacheRead: 0, cacheWrite: 500 }, REGRESSION[1]!, REGRESSION[2]!] })

    await $.session.start(STARTED)
    await $.turn.start({ text: 'Delegate the lookup.', turnId: 't1' })
    await step($, 't1', 'xhigh')
    await step($, 't1', 'low', { agentId: 'agent-1' })
    await step($, 't1', 'xhigh')
    await $.turn.complete({ turnId: 't1', answer: 'Done.', durationMs: 10, isAborted: false, reason: 'answer' })

    const [first] = w.records()
    expect((first?.steps as Record<string, unknown>[])[1], 'the subagent request did not break the main comparison').toMatchObject({ cache: 'hit' })

    await turn($, 't2', 'xhigh', { model: 'claude-sonnet-5' })
    expect((w.records()[1]?.steps as Record<string, unknown>[])[0], 'a model switch has no outcome').not.toHaveProperty('cache')

    // `/clear` and an in-process resume change the session id without session.start.
    w.session.id = 'another-conversation'
    await turn($, 't3', 'high')
    // Either log may hold the record, depending on how the router handles the switch.
    const switched = [...w.records(), ...w.records('another-conversation')].find(r => r.turnId === 't3')
    expect((switched?.steps as Record<string, unknown>[])[0], 'a new conversation compares nothing yet').not.toHaveProperty('cache')
    expect(await status($), 'the scope restarted with the conversation').not.toContain('cache since')
  })

  test('a request the router did not route breaks the chain instead of bridging it', async ($, on) => {
    const w = world(on, { usages: REGRESSION })

    await $.session.start(STARTED)
    await turn($, 't1', 'xhigh')
    await $.command.run({ command: 'effort-router', args: 'off', origin: { kind: 'composer' } } as never)
    await turn($, 't2', 'xhigh')
    await $.command.run({ command: 'effort-router', args: 'shadow', origin: { kind: 'composer' } } as never)
    await turn($, 't3', 'high')
    await turn($, 't4', 'xhigh')

    const steps = w.records().map(r => (r.steps as Record<string, unknown>[])[0])
    expect(w.records().map(r => r.turnId)).toEqual(['t1', 't3', 't4'])
    expect(steps[1], 'the first request after the unrouted one compares with nothing').not.toHaveProperty('cache')
    expect(steps[2]).toMatchObject({ cache: 'miss', effortChanged: true })
  })
})
