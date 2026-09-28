import { describe, expect, test, tier } from 'claude-code/testing'
import { EMPTY_MEMORY, afterNotification, afterTask, continuationOf, inputOf, type FinishedTask, type Memory } from '../hooks/memory'

tier('user')
const turn = { toolErrors: 0, requests: 1, interrupted: false }
const task = (request: string, answer: string, extra: Partial<FinishedTask> = {}): FinishedTask =>
  ({ request, answer, continuation: false, observations: [], turn, ...extra })

describe('conversation memory shared by the router and replay', () => {
  test('a background reply is the previous answer until the next typed task, and never the task', () => {
    let memory: Memory = afterTask(EMPTY_MEMORY, task('Migrate the applications.', 'Started the moves.'))
    memory = afterNotification(memory, 'Please sign in to the DNS console.')
    const input = inputOf(memory, 'logged in')
    expect([input.previousRequest, input.previousAnswer]).toEqual(['Migrate the applications.', 'Please sign in to the DNS console.'])
    expect(memory.previousTask?.answer).toBe('Started the moves.')
    memory = afterTask(memory, task('logged in', 'Continuing.'))
    expect(inputOf(memory, 'next').previousAnswer).toBe('Continuing.')
    expect(afterNotification(memory, '  ')).toBe(memory)
  })
  test('a continuation merges into the task it continued; a new task replaces it', () => {
    const first = afterTask(EMPTY_MEMORY, task('Plan the cache.', 'Plan: three steps.', { observations: [{ tool: 'Read', target: '/a.ts', text: 'a' }] }))
    const continued = afterTask(first, task('Continue.', 'Step one done.', { continuation: true, continued: first.previousTask, observations: [{ tool: 'Read', target: '/b.ts', text: 'b' }] }))
    expect(continued.previousTask?.request).toBe('Plan the cache.\nFollow-up: Continue.')
    expect(continued.previousTask?.observations.map(o => o.target)).toEqual(['/a.ts', '/b.ts'])
    const replaced = afterTask(continued, task('Explain the build.', 'It runs tsc.', { continued: continued.previousTask }))
    expect(replaced.previousTask?.request).toBe('Explain the build.')
  })
  test('the classifier answer decides continuation; without one, the deterministic rule does', () => {
    expect([continuationOf(false, 'Continue.'), continuationOf(true, 'Explain it.'), continuationOf(undefined, 'Continue.'), continuationOf(undefined, 'Explain it.')])
      .toEqual([false, true, true, false])
  })
  test('a turn without a typed prompt changes only how the last turn went; history keeps three exchanges', () => {
    let memory: Memory = EMPTY_MEMORY
    for (const n of [1, 2, 3, 4]) memory = afterTask(memory, task(`Task ${n}.`, `Answer ${n}.`))
    expect(memory.history.map(h => h.request)).toEqual(['Task 2.', 'Task 3.', 'Task 4.'])
    const empty = afterTask(memory, task('', '', { turn: { toolErrors: 2, requests: 3, interrupted: true } }))
    expect([empty.history, empty.previousTask]).toEqual([memory.history, memory.previousTask])
    expect(inputOf(empty, 'Task 5.')).toMatchObject({ previousRequest: 'Task 4.', earlier: [{ request: 'Task 2.' }, { request: 'Task 3.' }], previousTurn: { toolErrors: 2, requests: 3, interrupted: true } })
  })
})
