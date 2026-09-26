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
