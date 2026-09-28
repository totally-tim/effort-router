import { describe, expect, test, tier } from 'claude-code/testing'

import { Held, type HoldResult, type Submission, mergedSubmissionsOf } from '../hooks/session-state'

tier('user')

/** A host value with compare-and-set; `others` writes as another instance would. */
function slot(version: number) {
  const calls: number[] = []
  let current = version
  return {
    calls,
    others: () => { current += 1 },
    write: async (_value: unknown, ifVersion: number): Promise<HoldResult> => {
      calls.push(ifVersion)
      if (ifVersion !== current) return { isSet: false, version: current }
      current += 1
      return { isSet: true, version: current }
    },
  }
}

const prompt = (text: string, over?: string): Submission => ({ text, origin: 'prompt', entering: false, ...(over ? { over } : {}) })

describe('held values', () => {
  test('a takeover write that misses keeps its version, records the current one and writes nothing more', async () => {
    const host = slot(5)
    const held = new Held(() => ({ memory: 'mine' }), 5, 'wait')
    host.others()
    await held.hold(host.write)

    expect(held.missed).toBe(6)
    expect(held.version, 'no version-0 holder').toBe(5)
    expect(held.isLost).toBe(false)
    await held.hold(host.write)
    expect(host.calls, 'nothing is written at the reported version').toEqual([5])
  })

  test('a read below the missed version cannot resume; a later one resumes at its own version', async () => {
    const host = slot(5)
    const held = new Held(() => ({ memory: 'merged' }), 5, 'wait')
    host.others()
    await held.hold(host.write)

    held.resume(5)
    expect(held.missed, 'the same moment again').toBe(6)
    held.resume(6)
    await held.hold(host.write)
    expect(host.calls).toEqual([5, 6])
    expect(held.isEstablished).toBe(true)
    expect(held.version).toBe(7)
  })

  test('once a write landed, a miss loses the value for good', async () => {
    const host = slot(0)
    const held = new Held(() => ({ memory: 'mine' }), 0, 'wait')
    await held.hold(host.write)
    host.others()
    await held.hold(host.write)
    held.resume(9)
    await held.hold(host.write)

    expect(held.isLost).toBe(true)
    expect(held.missed).toBeUndefined()
    expect(host.calls, 'no reclaim').toEqual([0, 1])
  })
})

describe('held turns', () => {
  test('an adopted turn whose first write misses is lost: another instance wrote it since the read', async () => {
    const host = slot(3)
    const held = new Held(() => ({ turn: 'adopted' }), 3)
    host.others()
    await held.hold(host.write)
    held.resume(4)
    await held.hold(host.write)

    expect(held.isLost).toBe(true)
    expect(held.missed).toBeUndefined()
    expect(host.calls, 'later holds and the completion mark write nothing').toEqual([3])
  })
})

describe('pending prompts read again', () => {
  test('the first read puts the held prompts before this instance\'s own', () => {
    const own = prompt('typed here')
    const { submissions, held } = mergedSubmissionsOf([], [prompt('held a'), prompt('held b')], [own])

    expect(submissions.map(s => s.text)).toEqual(['held a', 'held b', 'typed here'])
    expect(held.map(s => s.text)).toEqual(['held a', 'held b'])
    expect(submissions[2]).toBe(own)
  })

  test('a later read adds what the earlier instance received and drops what it matched, keeping local matches and prompts', () => {
    const first = mergedSubmissionsOf([], [prompt('a'), prompt('b'), prompt('c')], [prompt('typed here')])
    const [a, b, c, own] = first.submissions as [Submission, Submission, Submission, Submission]
    // This instance matched b to a turn; the earlier instance matched c, received d, and set a's level.
    const ours = [a, c, own]
    const theirs = [{ ...prompt('a'), level: 'xhigh' as const }, prompt('b'), prompt('d')]
    const second = mergedSubmissionsOf(first.held, theirs, ours)

    expect(second.submissions.map(s => s.text)).toEqual(['a', 'd', 'typed here'])
    expect(second.submissions[0], 'the same object, updated').toBe(a)
    expect(a.level).toBe('xhigh')
    expect(second.submissions[2]).toBe(own)

    // Read again with nothing new: b stays matched, nothing is added twice.
    const third = mergedSubmissionsOf(second.held, theirs, second.submissions)
    expect(third.submissions.map(s => s.text)).toEqual(['a', 'd', 'typed here'])
  })

  test('the same text over another turn is another prompt', () => {
    const first = mergedSubmissionsOf([], [prompt('Continue.', 't1')], [])
    const second = mergedSubmissionsOf(first.held, [prompt('Continue.', 't1'), prompt('Continue.', 't2')], first.submissions)

    expect(second.submissions.map(s => s.over)).toEqual(['t1', 't2'])
  })
})
