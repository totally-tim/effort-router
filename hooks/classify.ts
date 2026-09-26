import type { Host } from './host'
import { CHOICES, type Choice, type Probabilities } from './policy'

/**
 * What the classifier reads: the new prompt, and the previous exchange only
 * to make sense of short follow-ups such as "yes" or "do it".
 */
export type ClassifyInput = {
  request: string
  previousRequest?: string
  previousAnswer?: string
  /**
   * Exchanges before the previous one, oldest first.
   */
  earlier?: readonly { request: string; answer?: string }[]
  /**
   * How the previous turn went.
   */
  previousTurn?: { toolErrors: number; requests: number; interrupted: boolean }
}

export type Answer = {
  choice: Choice
  probabilities: Probabilities
  confidence: number
}

export type Classified = Answer & { latencyMs: number }

export type Unclassified = { failure: string; latencyMs: number }

export type ClassifyConfig = {
  /**
   * The System One endpoint: the base URL with `/v1/systemone`.
   */
  url: string
  /**
   * The `model` every request names: `jev-latest`, a pinned `jev-<version>`,
   * or whatever name a compatible service serves.
   */
  model: string
  timeoutMs: number
}

export const DEFAULT_BASE_URL = 'https://api.typesafe.ai'
export const DEFAULT_MODEL = 'jev-latest'

/**
 * The System One endpoint of a base URL, as the TypeSafe SDKs build it
 * (`https://api.typesafe.ai` gives `https://api.typesafe.ai/v1/systemone`).
 * A URL that already ends in `/v1/systemone` is kept.
 */
export function systemOneUrlOf(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '')

  return base.endsWith('/v1/systemone') ? base : `${base}/v1/systemone`
}

const REQUEST_CHARS = 4000
const PREVIOUS_CHARS = 1000

const EARLIER_CHARS = 500

const QUESTION = 'How much reasoning does this coding-agent request need?'

const INSTRUCTIONS =
  'You route requests to a coding agent. Judge only `request`. Use the ' +
  'previous_* and earlier_exchanges fields only to understand a short ' +
  'follow-up such as "yes" or "do it"; ignore how complex the earlier work was.'

const TURN_INSTRUCTIONS =
  ' `previous_turn` says how the last turn went: failed tool calls, model ' +
  'requests, and whether the person interrupted it. A struggling session may ' +
  'need more reasoning for the same request.'

const CRITERIA: Readonly<Record<Choice, string>> = {
  low:
    'Mechanical: run a known command, commit, push or merge, rename, answer ' +
    'a lookup, or apply a known pattern.',
  medium: 'A well-scoped everyday change or question.',
  high:
    'A change across several files, debugging with an unclear cause, or a ' +
    'fix that must reach every caller.',
  xhigh:
    'Hard or open-ended: architecture, novel design, creative work, or deep ' +
    'analysis.',
}

/**
 * The System One request body for one effort question. It holds only the
 * fields of hosted Jev's contract (`model`, `state`, `questions`), so any
 * compatible service accepts it. The guidance goes ahead of the question in
 * the question's instructions: of the placements the eval tried, that one
 * kept under-thinking at 8% and routed the most prompts below xhigh.
 */
export function requestOf(input: ClassifyInput, model: string): object {
  const state: Record<string, unknown> = {
    request: input.request.slice(0, REQUEST_CHARS),
  }

  if (input.previousRequest) {
    state.previous_request = input.previousRequest.slice(0, PREVIOUS_CHARS)
  }

  if (input.previousAnswer) {
    state.previous_answer_head = input.previousAnswer.slice(0, PREVIOUS_CHARS)
  }

  if (input.earlier?.length) {
    state.earlier_exchanges = input.earlier.map(exchange => ({
      request: exchange.request.slice(0, EARLIER_CHARS),
      ...(exchange.answer ? { answer_head: exchange.answer.slice(0, EARLIER_CHARS) } : {}),
    }))
  }

  if (input.previousTurn) {
    state.previous_turn = {
      failed_tool_calls: input.previousTurn.toolErrors,
      model_requests: input.previousTurn.requests,
      interrupted: input.previousTurn.interrupted,
    }
  }

  return {
    model,
    state,
    questions: {
      effort: {
        type: 'choice',
        instructions: `${INSTRUCTIONS}${input.previousTurn ? TURN_INSTRUCTIONS : ''} ${QUESTION}`,
        criteria: CRITERIA,
      },
    },
  }
}

/**
 * The effort answer from a System One response body, or undefined when the
 * body does not hold one.
 */
export function answerOf(body: string): Answer | undefined {
  let parsed: unknown

  try {
    parsed = JSON.parse(body)
  } catch {
    return undefined
  }

  const effort = (parsed as { answers?: { effort?: Record<string, unknown> } })
    ?.answers?.effort

  const choice = effort?.choice
  const raw = effort?.probabilities

  if (!isChoice(choice) || typeof raw !== 'object' || raw === null) {
    return undefined
  }

  const probabilities: Partial<Record<Choice, number>> = {}

  for (const option of CHOICES) {
    const p = (raw as Record<string, unknown>)[option]

    if (typeof p === 'number') {
      probabilities[option] = p
    }
  }

  const confidence =
    typeof effort?.confidence === 'number' ? effort.confidence : 0

  return { choice, probabilities, confidence }
}

function isChoice(value: unknown): value is Choice {
  return typeof value === 'string' && (CHOICES as readonly string[]).includes(value)
}

const TIMED_OUT = Symbol('timed out')

/**
 * What an HTTP status says about the setup, for the failure text.
 */
function failureOf(status: number): string {
  if (status === 401 || status === 403) {
    return `http ${status}: key rejected`
  }

  if (status === 400 || status === 404 || status === 422) {
    return `http ${status}: request rejected`
  }

  return `http ${status}`
}

/**
 * Asks the classifier once, bounded by `timeoutMs`. Never rejects: a timeout,
 * an HTTP error or an unreadable body comes back as `{ failure }`.
 */
export async function classify(
  host: Host,
  config: ClassifyConfig,
  key: string,
  input: ClassifyInput,
): Promise<Classified | Unclassified> {
  const started = await host.now()

  const latency = async () => Math.round((await host.now()) - started)

  try {
    const response = await Promise.race([
      host.fetch(config.url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestOf(input, config.model)),
      }),
      host.sleep(config.timeoutMs).then((): typeof TIMED_OUT => TIMED_OUT),
    ])

    if (response === TIMED_OUT) {
      return { failure: 'timeout', latencyMs: await latency() }
    }

    if (!response.ok) {
      return { failure: failureOf(response.status), latencyMs: await latency() }
    }

    const answer = answerOf(response.text)

    return answer
      ? { ...answer, latencyMs: await latency() }
      : { failure: 'unreadable answer', latencyMs: await latency() }
  } catch (error) {
    return { failure: `fetch failed: ${messageOf(error)}`, latencyMs: await latency() }
  }
}

/**
 * Asks once per distinct request body and averages the answers over every
 * input, so inputs that come out identical count as often as they are given.
 * Fails only when no input got an answer; the latency is the slowest call's.
 */
export async function classifyAll(
  host: Host,
  config: ClassifyConfig,
  key: string,
  inputs: readonly ClassifyInput[],
): Promise<Classified | Unclassified> {
  const bodies = inputs.map(input => JSON.stringify(requestOf(input, config.model)))
  const distinct = [...new Set(bodies)]
  const answers = await Promise.all(
    distinct.map(body => classify(host, config, key, inputs[bodies.indexOf(body)] as ClassifyInput)),
  )
  const bySlot = bodies.map(body => answers[distinct.indexOf(body)] as Classified | Unclassified)
  const answered = bySlot.filter(isClassified)
  const latencyMs = Math.max(...answers.map(answer => answer.latencyMs))

  if (answered.length === 0) {
    return { failure: (bySlot[0] as Unclassified).failure, latencyMs }
  }

  const probabilities: Partial<Record<Choice, number>> = {}

  for (const choice of CHOICES) {
    probabilities[choice] = answered.reduce((sum, answer) => sum + (answer.probabilities[choice] ?? 0), 0) / answered.length
  }

  const choice = CHOICES.reduce((best, option) =>
    (probabilities[option] ?? 0) > (probabilities[best] ?? 0) ? option : best,
  )

  return {
    choice,
    probabilities,
    confidence: answered.reduce((sum, answer) => sum + answer.confidence, 0) / answered.length,
    latencyMs,
  }
}

export function isClassified(
  result: Classified | Unclassified,
): result is Classified {
  return !('failure' in result)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Stops asking a classifier that keeps failing: after `limit` failures in a
 * row it stays open for `coolMs`, then lets one request through again.
 */
export class Breaker {
  private failures = 0
  private openedAt: number | undefined

  constructor(
    private readonly limit = 3,
    private readonly coolMs = 5 * 60_000,
  ) {}

  isOpen(now: number): boolean {
    if (this.openedAt === undefined) {
      return false
    }

    if (now - this.openedAt >= this.coolMs) {
      this.openedAt = undefined
      this.failures = this.limit - 1

      return false
    }

    return true
  }

  record(isOk: boolean, now: number): void {
    if (isOk) {
      this.failures = 0
      this.openedAt = undefined

      return
    }

    this.failures += 1

    if (this.failures >= this.limit) {
      this.openedAt = now
    }
  }
}
