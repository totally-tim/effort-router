import { describe, expect, test, tier } from 'claude-code/testing'

import { type RecordedStep, matchesObservedPattern } from '../e2e/attribution'

tier('user')

const T0 = Date.parse('2026-09-28T10:30:46Z')

// The September 28 acknowledgment regression: low, low, xhigh, low with
// text-only answers; requests 3 and 4 read 3,116 of about 8,300 tokens.
const OBSERVED: RecordedStep[] = [
  { effort: 'low', input: 2, cacheRead: 1441, cacheWrite: 6740, thinking: 0, at: T0, model: 'claude-opus-5-5', version: '2.1.283' },
  { effort: 'low', input: 2, cacheRead: 8181, cacheWrite: 62, thinking: 0, at: T0 + 1700, model: 'claude-opus-5-5', version: '2.1.283' },
  { effort: 'xhigh', input: 2, cacheRead: 3116, cacheWrite: 5187, thinking: 0, at: T0 + 3300, model: 'claude-opus-5-5', version: '2.1.283' },
  { effort: 'low', input: 2, cacheRead: 3116, cacheWrite: 5248, thinking: 0, at: T0 + 4900, model: 'claude-opus-5-5', version: '2.1.283' },
]

function changed(index: number, fields: Partial<RecordedStep>): RecordedStep[] {
  return OBSERVED.map((step, i) => (i === index ? { ...step, ...fields } : step))
}

describe('e2e cache attribution', () => {
  test('the recorded regression matches the observed pattern at both effort changes', () => {
    expect(matchesObservedPattern('context-effort-transition', OBSERVED, 2)).toBe(true)
    expect(matchesObservedPattern('context-effort-transition', OBSERVED, 3)).toBe(true)
    expect(matchesObservedPattern('context-partial-outage', OBSERVED, 2)).toBe(true)
    expect(matchesObservedPattern('context-effort-transition', OBSERVED, 1), 'no effort change').toBe(false)
    expect(matchesObservedPattern('context-effort-transition', OBSERVED, 0), 'the first request').toBe(false)
    expect(matchesObservedPattern('context-effort-transition', OBSERVED, 4), 'no such request').toBe(false)
  })

  test('another scenario, version or model is an unexplained failure', () => {
    for (const scenario of ['context-effort-transition-reasoning', 'context-cache-control', 'real-continuation', 'real-outage-recovery']) {
      expect(matchesObservedPattern(scenario, OBSERVED, 2), scenario).toBe(false)
    }

    expect(matchesObservedPattern('context-effort-transition', changed(2, { version: '2.1.284' }), 2), 'a later Claude Code').toBe(false)
    expect(matchesObservedPattern('context-effort-transition', changed(0, { version: '2.1.282' }), 2), 'any request on another version').toBe(false)
    expect(matchesObservedPattern('context-effort-transition', changed(2, { version: undefined }), 2), 'an unknown version').toBe(false)
    expect(matchesObservedPattern('context-effort-transition', changed(2, { model: 'claude-sonnet-5' }), 2), 'another model').toBe(false)
    expect(matchesObservedPattern('context-effort-transition', changed(1, { model: 'claude-fable-5-1' }), 2), 'any request on another model').toBe(false)
  })

  test('each condition of the pattern must hold', () => {
    expect(matchesObservedPattern('context-effort-transition', changed(0, { thinking: 955 }), 2), 'a first answer with thinking').toBe(false)
    expect(matchesObservedPattern('context-effort-transition', changed(2, { effort: 'low' }), 2), 'the same effort').toBe(false)
    expect(matchesObservedPattern('context-effort-transition', changed(2, { effort: undefined }), 2), 'an unknown effort').toBe(false)
    expect(matchesObservedPattern('context-effort-transition', changed(2, { cacheRead: 8200, cacheWrite: 103 }), 2),
      'a shortfall the ledger rule does not call a miss').toBe(false)
    expect(matchesObservedPattern('context-effort-transition', changed(2, { at: T0 + 1700 + 300_000 }), 2), 'an idle gap of five minutes').toBe(false)
  })

  test('timestamps must be valid and ordered', () => {
    expect(matchesObservedPattern('context-effort-transition', changed(1, { at: 0 }), 2), 'an unknown earlier time').toBe(false)
    expect(matchesObservedPattern('context-effort-transition', changed(1, { at: Number.NaN }), 2), 'an unparsable earlier time').toBe(false)
    expect(matchesObservedPattern('context-effort-transition', changed(2, { at: Number.NaN }), 2), 'an unparsable time').toBe(false)
    expect(matchesObservedPattern('context-effort-transition', changed(2, { at: T0 }), 2), 'a time before the previous request').toBe(false)
  })
})
