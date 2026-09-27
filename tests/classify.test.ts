import { describe, expect, test, tier } from 'claude-code/testing'

import { Breaker, answerOf, classify, requestOf, systemOneUrlOf } from '../hooks/classify'
import type { Host } from '../hooks/host'

tier('user')

const ANSWER = JSON.stringify({
  model: 'jev-1.13.0',
  answers: {
    effort: {
      type: 'choice',
      choice: 'low',
      probabilities: { low: 0.66, medium: 0.34, high: 0, xhigh: 0 },
      confidence: 0.54,
    },
    context: { choice: 'sufficient', probabilities: { sufficient: 1 } },
    relation: { choice: 'new', probabilities: { new: 1 } },
    work: { choice: 'mechanical', probabilities: { mechanical: 1 } },
  },
  usage: { input_tokens: 146, output_tokens: 8 },
})

function hostWith(fetch: Host['fetch']): Host {
  let now = 0

  return {
    now: async () => (now += 10),
    sleep: () => new Promise(() => undefined),
    fetch,
    readText: async () => undefined,
    writeText: async () => undefined,
    exists: async () => false,
    home: async () => '/Users/t',
    systemOneEnv: async () => ({}),
    savedEffort: async () => undefined,
    sessionId: async () => 'session',
    cwd: async () => '/work',
    registerCommand: async () => undefined,
    redraw: () => undefined,
    say: () => undefined,
  }
}

const CONFIG = { url: 'https://decide.test/v1/systemone', model: 'jev-latest', timeoutMs: 5000 }

describe('classify', () => {
  test('the base URL gets the System One path once, as the SDKs build it', () => {
    expect(systemOneUrlOf('https://api.typesafe.ai')).toBe('https://api.typesafe.ai/v1/systemone')
    expect(systemOneUrlOf('https://gateway.test/decide/')).toBe('https://gateway.test/decide/v1/systemone')
    expect(systemOneUrlOf('https://gateway.test/v1/systemone')).toBe('https://gateway.test/v1/systemone')
  })

  test("the request holds only the fields of hosted Jev's contract", () => {
    const body = requestOf({ request: 'go', previousTurn: { toolErrors: 0, requests: 1, interrupted: false } }, 'jev-1.13.0') as Record<string, unknown>

    expect(Object.keys(body).sort()).toEqual(['model', 'questions', 'state'])
    expect(body.model).toBe('jev-1.13.0')
  })

  test('the request keeps the prompt and prior exchange bounded', () => {
    const body = requestOf({
      request: 'x'.repeat(5000),
      previousRequest: 'y'.repeat(2000),
    }, 'jev-latest') as { state: Record<string, string>; questions: { effort: { criteria: object } } }

    expect(body.state.request).toHaveLength(4000)
    expect(body.state.previous_request).toHaveLength(1000)
    expect(body.state.previous_answer_head).toBeUndefined()
    expect(Object.keys(body.questions.effort.criteria)).toEqual(['low', 'medium', 'high', 'xhigh'])
  })

  test('earlier exchanges and previous-turn facts join the state only when given', () => {
    type Body = { state: Record<string, unknown>; questions: { effort: { instructions: string } } }

    const plain = requestOf({ request: 'go' }, 'jev-latest') as Body

    const rich = requestOf({
      request: 'go',
      earlier: [{ request: 'e'.repeat(900), answer: 'a' }],
      previousTurn: { toolErrors: 3, requests: 12, interrupted: true },
    }, 'jev-latest') as Body

    expect(Object.keys(plain.state)).toEqual(['request'])
    expect(plain.questions.effort.instructions).not.toContain('previous_turn')
    expect(plain.questions.effort.instructions).toMatch(/How much reasoning does this coding-agent request need\?$/)
    expect(rich.state.earlier_exchanges).toEqual([{ request: 'e'.repeat(500), answer_head: 'a' }])
    expect(rich.state.previous_turn).toEqual({ failed_tool_calls: 3, model_requests: 12, interrupted: true })
    expect(rich.questions.effort.instructions).toContain('previous_turn')
  })

  test('an answer reads choice, probabilities and confidence', () => {
    expect(answerOf(ANSWER)).toEqual({
      choice: 'low',
      probabilities: { low: 0.66, medium: 0.34, high: 0, xhigh: 0 },
      workProbabilities: { low: 1, medium: 0, high: 0, xhigh: 0 },
      confidence: 0.54,
      context: 'sufficient', contextSufficient: true, relation: 'new',
    })
  })

  test('a body without an effort answer reads as nothing', () => {
    expect(answerOf('not json')).toBeUndefined()
    expect(answerOf(JSON.stringify({ detail: { error: 'x' } }))).toBeUndefined()
    expect(answerOf(JSON.stringify({ answers: { effort: { choice: 'max' } } }))).toBeUndefined()
  })

  test('a call posts with the bearer key and returns the answer', async () => {
    const posts: { url: string; auth?: string }[] = []

    const result = await classify(
      hostWith(async (url, init) => {
        posts.push({ url, auth: init.headers?.Authorization })

        return { status: 200, ok: true, headers: {}, text: ANSWER }
      }),
      CONFIG,
      'secret',
      { request: 'push the PR' },
    )

    expect(posts).toEqual([{ url: CONFIG.url, auth: 'Bearer secret' }])
    expect(result).toMatchObject({ choice: 'low', latencyMs: 10 })
  })

  test('an HTTP error and a thrown fetch come back as failures', async () => {
    const busy = await classify(
      hostWith(async () => ({ status: 503, ok: false, headers: {}, text: '' })),
      CONFIG,
      'secret',
      { request: 'x' },
    )

    const rejected = await classify(
      hostWith(async () => ({ status: 401, ok: false, headers: {}, text: '' })),
      CONFIG,
      'secret',
      { request: 'x' },
    )

    const broken = await classify(
      hostWith(async () => {
        throw new Error('ECONNREFUSED')
      }),
      CONFIG,
      'secret',
      { request: 'x' },
    )

    expect(busy).toMatchObject({ failure: 'http 503' })
    expect(rejected).toMatchObject({ failure: 'http 401: key rejected' })
    expect(broken).toMatchObject({ failure: 'fetch failed: ECONNREFUSED' })
  })

  test('the breaker opens after three failures and retries after the pause', () => {
    const breaker = new Breaker(3, 1000)

    breaker.record(false, 0)
    breaker.record(false, 1)
    expect(breaker.isOpen(2)).toBe(false)

    breaker.record(false, 2)
    expect(breaker.isOpen(3)).toBe(true)
    expect(breaker.isOpen(1002)).toBe(false)

    breaker.record(false, 1003)
    expect(breaker.isOpen(1004), 'one more failure after the pause reopens it').toBe(true)

    breaker.record(true, 2004)
    expect(breaker.isOpen(2005)).toBe(false)
  })
})
