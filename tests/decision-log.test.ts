import { describe, expect, test, tier } from 'claude-code/testing'

import { DecisionLog } from '../hooks/decision-log'

tier('user')

describe('decision-log', () => {
  test('a full file stays as it is and the log goes on in the next part', async () => {
    const files = new Map<string, string>()
    const log = new DecisionLog('/logs/s.jsonl', async (path, text) => void files.set(path, text), '', 40)

    await log.append({ type: 'turn', turnId: 't1', baseline: 'xhigh' })
    await log.append({ type: 'turn', turnId: 't2' })
    await log.append({ type: 'turn', turnId: 't3' })

    expect([...files.keys()]).toEqual(['/logs/s.jsonl', '/logs/s.1.jsonl', '/logs/s.2.jsonl'])
    expect(files.get('/logs/s.jsonl')).toContain('"t1"')
    expect(files.get('/logs/s.1.jsonl')).not.toContain('"t1"')
    expect(log.firstOf('baseline'), 'the first turn outlives the move').toBe('xhigh')
  })

  test('rotation counts UTF-8 bytes, including non-ASCII prompts', async () => {
    const files = new Map<string, string>()
    const log = new DecisionLog('/logs/s.writer.jsonl', async (path, text) => void files.set(path, text), '', 42)
    await log.append({ text: '漢字漢字' })
    await log.append({ text: '漢字漢字' })
    expect([...files.keys()]).toEqual(['/logs/s.writer.jsonl', '/logs/s.writer.1.jsonl'])
    expect([...files.values()].every(text => new TextEncoder().encode(text).byteLength <= 42)).toBe(true)
  })

  test('a reopened log keeps its lines and knows its first turn', async () => {
    const files = new Map<string, string>()
    const earlier = `${JSON.stringify({ type: 'label', turnId: 't0' })}\n${JSON.stringify({ type: 'turn', turnId: 't1', baseline: 'high' })}\n`
    const log = new DecisionLog('/logs/s.jsonl', async (path, text) => void files.set(path, text), earlier)

    await log.append({ type: 'turn', turnId: 't2' })

    expect(files.get('/logs/s.jsonl')?.trim().split('\n')).toHaveLength(3)
    expect(log.firstOf('baseline')).toBe('high')
  })
})
