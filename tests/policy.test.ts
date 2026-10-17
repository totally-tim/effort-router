import { describe, expect, test, tier } from 'claude-code/testing'

import type { Answer } from '../hooks/classify'
import {
  clamp,
  cueFloorOf,
  escalationOf,
  pickOf,
  raisedBy,
  routeOf,
  ruledAnswerOf,
} from '../hooks/policy'

tier('user')

describe('policy', () => {
  test('a confident answer picks its own level', () => {
    expect(pickOf({ low: 0.98, medium: 0.02 }, 0.8, 'low', 'xhigh')).toBe('low')
  })

  test('an uncertain answer leans upward to the cumulative threshold', () => {
    expect(pickOf({ low: 0.66, medium: 0.33 }, 0.8, 'low', 'xhigh')).toBe('medium')

    expect(
      pickOf({ low: 0.06, medium: 0.55, high: 0.09, xhigh: 0.3 }, 0.8, 'low', 'xhigh'),
    ).toBe('xhigh')
  })

  test('a flat answer resolves to the ceiling', () => {
    const flat = { low: 0.25, medium: 0.25, high: 0.25, xhigh: 0.25 }

    expect(pickOf(flat, 0.8, 'low', 'xhigh')).toBe('xhigh')
    expect(pickOf(flat, 0.8, 'low', 'high')).toBe('high')
  })

  test('answers that never reach the threshold resolve to the ceiling', () => {
    expect(pickOf({ low: 0.5 }, 0.8, 'low', 'high')).toBe('high')
  })

  test('the pick stays inside floor and ceiling', () => {
    expect(pickOf({ low: 1 }, 0.8, 'medium', 'xhigh')).toBe('medium')
    expect(clamp('max', 'low', 'xhigh')).toBe('xhigh')
  })

  test('deep-reasoning phrases set a floor of xhigh', () => {
    expect(cueFloorOf('ultrathink about the cache layout')).toBe('xhigh')
    expect(cueFloorOf('Think hard before you change the schema')).toBe('xhigh')
    expect(cueFloorOf('take your time with this one')).toBe('xhigh')
    expect(cueFloorOf('push the PR')).toBeUndefined()
    expect(cueFloorOf('I think we should rename it')).toBeUndefined()
  })

  test('failed tools raise effort one level at two and two levels at four', () => {
    expect([0, 1, 2, 3, 4, 7].map(escalationOf)).toEqual([0, 0, 1, 1, 2, 2])
  })

  test('raising stops at the ceiling but never lowers a level above it', () => {
    expect(raisedBy('low', 1, 'xhigh')).toBe('medium')
    expect(raisedBy('high', 2, 'xhigh')).toBe('xhigh')
    expect(raisedBy('xhigh', 1, 'high')).toBe('xhigh')
  })
})

describe('the ruled answer', () => {
  const answer = (probabilities: Answer['probabilities'], context: Answer['context'] = 'sufficient', contextSufficient = true,
    workProbabilities: Answer['workProbabilities'] = { low: 1 }): Answer =>
    ({ choice: 'high', probabilities, workProbabilities, confidence: 1, context, contextSufficient, relation: 'new' })
  const levelOf = (a: Answer, { request = 'Explain the design', previousLevel, strict }: { request?: string; previousLevel?: 'xhigh'; strict?: boolean } = {}) =>
    routeOf(a, { request, ...(previousLevel ? { continuesTask: true, context: { observations: [], previousTask: { request: 'Design', level: previousLevel, observations: [] } } } : {}) },
      'xhigh', 0.95, 'low', 'xhigh', strict).level

  test('an xhigh share below 15 percent counts as high, a larger one still picks xhigh', () => {
    const tail = answer({ high: 0.88, xhigh: 0.12 })
    expect(ruledAnswerOf(tail).probabilities).toEqual({ high: 1, xhigh: 0 })
    expect(levelOf(tail)).toBe('high')
    expect(levelOf(tail, { strict: true })).toBe('xhigh')
    expect(levelOf(answer({ high: 0.8, xhigh: 0.2 }))).toBe('xhigh')
  })

  test('the work answer moves its small xhigh share too', () => {
    const work = answer({ low: 1 }, 'sufficient', true, { medium: 0.9, xhigh: 0.1 })
    expect(levelOf(work)).toBe('high')
    expect(levelOf(work, { strict: true })).toBe('xhigh')
  })

  test('the answer as received stays unchanged', () => {
    const tail = answer({ high: 0.88, xhigh: 0.12 }, 'sufficient', false)
    ruledAnswerOf(tail)
    expect(tail).toMatchObject({ probabilities: { high: 0.88, xhigh: 0.12 }, workProbabilities: { low: 1 }, contextSufficient: false })
  })

  test('a cue and a continued xhigh task keep xhigh', () => {
    const tail = answer({ high: 0.88, xhigh: 0.12 })
    expect(levelOf(tail, { request: 'Think hard about the design' })).toBe('xhigh')
    expect(levelOf(tail, { request: 'Continue', previousLevel: 'xhigh' })).toBe('xhigh')
  })

  test('a context answer of sufficient counts below the cutoff; a missing one still holds', () => {
    const uncertain = answer({ low: 1 }, 'sufficient', false)
    expect(routeOf(uncertain, { request: 'Explain the design' }, 'xhigh', 0.95, 'low', 'xhigh')).toMatchObject({ level: 'low', contextSufficient: true, contextHeld: false })
    expect(levelOf(uncertain, { strict: true })).toBe('xhigh')
    expect(levelOf(answer({ low: 1 }, 'missing_scope', false))).toBe('xhigh')
  })
})
