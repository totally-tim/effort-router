/**
 * Which cache failures of the e2e suite match a pattern observed on one host
 * version and model. A match is not a proven cause: the server's cache
 * placement is not observable. Anything outside the gate is an unexplained
 * failure. The functions are pure, so the plugin tests cover them.
 */
import { cacheOutcomeOf } from '../hooks/cache'

/** One main-conversation request as its transcript line records it. */
export type RecordedStep = {
  effort?: string
  input: number
  cacheRead: number
  cacheWrite: number
  /** Thinking tokens of the response; 0 for a text-only answer. */
  thinking: number
  /** When the response was recorded, in epoch milliseconds; 0 if unknown. */
  at: number
  /** The model that answered. */
  model?: string
  /** The Claude Code version that wrote the line. */
  version?: string
}

/**
 * The pattern of September 28 (eval/results/2026-09-28-uncertainty-verification.md):
 * in these reproducer scenarios, whose answers are text only, each effort
 * change re-cached the conversation after the system prompt. Matched
 * reasoning answers and a fixed effort kept the cache.
 */
export const OBSERVED_PATTERN = {
  scenarios: ['context-effort-transition', 'context-partial-outage'] as readonly string[],
  version: '2.1.283',
  model: 'claude-opus-5-5',
  /** A longer gap can expire the host's thread, a separate cause. */
  idleMs: 300_000,
  label: 'matches the pattern observed on Claude Code 2.1.283 with Opus 5.5 (effort change after a text-only first answer); not a proven cause',
}

/**
 * Whether request `index` of a scenario's main requests, which failed the
 * cache assertion, matches the observed pattern. Every condition must hold:
 * a reproducer scenario, the observed version and model on every request, a
 * text-only first answer, valid ordered timestamps within the idle limit, an
 * effort change, and a miss by the `/context` ledger rule.
 */
export function matchesObservedPattern(scenario: string, main: readonly RecordedStep[], index: number): boolean {
  const first = main[0]
  const before = main[index - 1]
  const step = main[index]

  if (!OBSERVED_PATTERN.scenarios.includes(scenario) || !first || !before || !step || index < 1) return false
  if (!main.every(s => s.version === OBSERVED_PATTERN.version && s.model === OBSERVED_PATTERN.model)) return false
  if (first.thinking !== 0) return false
  if (!(before.at > 0) || !(step.at >= before.at) || step.at - before.at >= OBSERVED_PATTERN.idleMs) return false
  if (step.effort === undefined || step.effort === before.effort) return false

  return cacheOutcomeOf(before, step) === 'miss'
}
