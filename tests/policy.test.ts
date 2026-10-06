import { describe, expect, test, tier } from 'claude-code/testing'

import type { Answer } from '../hooks/classify'
import {
  candidateAnswersOf,
  clamp,
  cueFloorOf,
  escalationOf,
  pickOf,
  raisedBy,
  routeOf,
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

describe('candidate policies', () => {
  const answer = (probabilities: Answer['probabilities'], context: Answer['context'] = 'sufficient', contextSufficient = true): Answer =>
    ({ choice: 'high', probabilities, workProbabilities: { low: 1 }, confidence: 1, context, contextSufficient, relation: 'new' })
  const levelOf = (a: Answer, request = 'Explain the design', previousLevel?: 'xhigh') =>
    routeOf(a, { request, ...(previousLevel ? { continuesTask: true, context: { observations: [], previousTask: { request: 'Design', level: previousLevel, observations: [] } } } : {}) },
      'xhigh', 0.95, 'low', 'xhigh').level

  test('a small xhigh share stops deciding the level, a larger one still does', () => {
    const tail = answer({ high: 0.88, xhigh: 0.12 })
    expect(levelOf(tail)).toBe('xhigh')
    expect(candidateAnswersOf(tail).xhigh_min_mass.probabilities).toEqual({ high: 1, xhigh: 0 })
    expect(levelOf(candidateAnswersOf(tail).xhigh_min_mass)).toBe('high')
    expect(levelOf(candidateAnswersOf(answer({ high: 0.8, xhigh: 0.2 })).xhigh_min_mass)).toBe('xhigh')
  })

  test('a cue and a continued xhigh task keep xhigh in every candidate', () => {
    const tail = candidateAnswersOf(answer({ high: 0.88, xhigh: 0.12 })).xhigh_min_mass
    expect(levelOf(tail, 'Think hard about the design')).toBe('xhigh')
    expect(levelOf(tail, 'Continue', 'xhigh')).toBe('xhigh')
  })

  test('accept_uncertain releases only a context answer of sufficient', () => {
    const uncertain = answer({ low: 1 }, 'sufficient', false)
    expect(levelOf(uncertain)).toBe('xhigh')
    expect(levelOf(candidateAnswersOf(uncertain).accept_uncertain)).toBe('low')
    expect(levelOf(candidateAnswersOf(answer({ low: 1 }, 'missing_scope', false)).accept_uncertain)).toBe('xhigh')
  })
})
