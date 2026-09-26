import { describe, expect, test, tier } from 'claude-code/testing'

import {
  clamp,
  cueFloorOf,
  escalationOf,
  pickOf,
  raisedBy,
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
