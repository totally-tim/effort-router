import type { Answer, ClassifyInput } from './classify'
import { hasRoutingInstruction, hasTargetEvidence, hasUnresolvedReference, isContinuation, isSelfContainedReply, needsConcurrencyReasoning } from './context'

/**
 * The effort levels the API accepts, from least to most thinking.
 */
export const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

export type Level = (typeof LEVELS)[number]

/**
 * The levels the classifier chooses between. max stays a manual choice.
 */
export const CHOICES = ['low', 'medium', 'high', 'xhigh'] as const

export type Choice = (typeof CHOICES)[number]

export type Probabilities = Readonly<Partial<Record<Choice, number>>>

/**
 * Phrases that ask for deep reasoning. Claude Code passes all of them to the
 * model as plain text (only `ultrathink` adds an instruction), so the router
 * treats them as a floor of xhigh.
 */
const DEEP_CUES: readonly RegExp[] = [
  /\bultrathink\b/i,
  /\bthink (?:very )?(?:hard|harder|deeply|carefully)\b/i,
  /\btake your time\b/i,
]

export function isLevel(value: unknown): value is Level {
  return typeof value === 'string' && (LEVELS as readonly string[]).includes(value)
}

export function rankOf(level: Level): number {
  return LEVELS.indexOf(level)
}

export function higherOf(a: Level, b: Level): Level {
  return rankOf(a) >= rankOf(b) ? a : b
}

export function clamp(level: Level, floor: Level, ceiling: Level): Level {
  if (rankOf(level) < rankOf(floor)) {
    return floor
  }

  return rankOf(level) > rankOf(ceiling) ? ceiling : level
}

/**
 * The lowest choice whose cumulative probability reaches `threshold`, so an
 * uncertain answer resolves upward: under-thinking costs a retry, which costs
 * more than extra thinking. Answers that never reach it (rounding) resolve to
 * the ceiling.
 */
export function pickOf(
  probabilities: Probabilities,
  threshold: number,
  floor: Level,
  ceiling: Level,
): Level {
  let cumulative = 0

  for (const choice of CHOICES) {
    cumulative += probabilities[choice] ?? 0

    if (cumulative >= threshold) {
      return clamp(choice, floor, ceiling)
    }
  }

  return ceiling
}

/**
 * xhigh when the prompt asks for deep reasoning in words; otherwise nothing.
 */
export function cueFloorOf(text: string): Level | undefined {
  return DEEP_CUES.some(cue => cue.test(text)) ? 'xhigh' : undefined
}

/**
 * How many levels to raise a turn's effort after `errors` failed tool calls in
 * it: one from the second failure, two from the fourth.
 */
export function escalationOf(errors: number): number {
  if (errors >= 4) {
    return 2
  }

  return errors >= 2 ? 1 : 0
}

export function raisedBy(level: Level, steps: number, ceiling: Level): Level {
  const raised = LEVELS[Math.min(rankOf(level) + steps, LEVELS.length - 1)]

  return clamp(raised ?? level, 'low', higherOf(ceiling, level))
}

/** Shared by replay and live routing; confidence cannot replace absent evidence. */
export function routeOf(answer: Answer, input: ClassifyInput, baseline: Level, threshold: number, floor: Level, ceiling: Level): {
  level: Level; workLevel?: Level; evidenceFloor?: Level; reason: string; contextSufficient: boolean; missing: string[]; continuation: boolean
} {
  const continuation = input.continuesTask === true || isContinuation(input.request) || answer.relation === 'continuation'
  const previous = continuation ? input.context?.previousTask : undefined
  const observations = [...(input.context?.observations ?? []), ...(previous?.observations ?? [])]
  const missing: string[] = []
  if (!answer.workProbabilities) missing.push('missing_work_assessment')
  if (!answer.contextSufficient) missing.push(answer.context.startsWith('missing_') ? answer.context : 'uncertain_context')
  if (hasUnresolvedReference(input.request) && !hasTargetEvidence(observations) && !previous) missing.push('missing_target')
  if (continuation && !previous && !input.previousRequest) missing.push('missing_previous_task')
  const suppliedPrevious = input.context?.previousTask
  const untrustedText = [input.context?.repository?.summary ?? '', suppliedPrevious?.answer ?? '',
    ...(input.context?.observations ?? []).map(o => o.text), ...(suppliedPrevious?.observations ?? []).map(o => o.text)]
  if (!isSelfContainedReply(input.request) && untrustedText.some(hasRoutingInstruction)) missing.push('untrusted_routing_instruction')
  const contextSufficient = missing.length === 0
  const cue = cueFloorOf(input.request)
  const lower = cue ? higherOf(floor, cue) : floor
  let level = pickOf(answer.probabilities, threshold, lower, higherOf(ceiling, lower))
  const workLevel = answer.workProbabilities ? pickOf(answer.workProbabilities, threshold, floor, ceiling) : undefined
  const workRaised = workLevel !== undefined && rankOf(workLevel) > rankOf(level)
  if (workLevel) level = higherOf(level, workLevel)
  const evidenceFloor = needsConcurrencyReasoning(`${input.request}\n${previous?.request ?? ''}`, observations)
    ? clamp('high', floor, ceiling) : undefined
  const evidenceRaised = evidenceFloor !== undefined && rankOf(evidenceFloor) > rankOf(level)
  if (evidenceFloor) level = higherOf(level, evidenceFloor)
  // Missing context prevents a downgrade, but must not suppress a justified raise.
  if (!contextSufficient) level = higherOf(level, baseline)
  if (continuation && isLevel(previous?.level)) level = higherOf(level, clamp(previous.level, 'low', ceiling))
  return { level, workLevel, evidenceFloor, contextSufficient, missing: [...new Set(missing)], continuation,
    reason: !contextSufficient ? 'insufficient context' : continuation && isLevel(previous?.level) && level === previous.level ? 'continue task' : cue ? 'cue' : evidenceRaised ? 'concurrency evidence' : workRaised ? 'task complexity' : 'classifier' }
}
