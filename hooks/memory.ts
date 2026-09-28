import type { ClassifyInput } from './classify'
import { boundedContext, excerpt, isContinuation, type Observation, type Task, type TaskContext } from './context'
import type { Level } from './policy'

/**
 * What the router remembers of the conversation for the next typed prompt.
 * The live router and transcript replay both build and read it here, so the
 * evaluation sees what the classifier would.
 */
export type Memory = {
  /** The last typed exchanges, oldest first. */
  history: readonly { request: string; answer?: string }[]
  /** A background completion's reply that came after the last typed exchange. */
  latestAnswer?: string
  /** How the last typed turn went. */
  lastTurn?: ClassifyInput['previousTurn']
  previousTask?: Task
}

export const EMPTY_MEMORY: Memory = { history: [] }

/** A turn that reached the model and was not a background completion. */
export type FinishedTask = {
  /** The task text memory keeps; empty for a turn without a typed prompt. */
  request: string
  /** The final visible text of the turn. */
  answer: string
  /** The level the next turn inherits, derived by the caller; unknown in replay. */
  level?: Level
  /** Whether the turn continued `continued`, the previous task it started with; see `continuationOf`. */
  continuation: boolean
  continued?: Task
  observations: readonly Observation[]
  turn: NonNullable<ClassifyInput['previousTurn']>
}

/**
 * The classifier input for a typed prompt, before `inputVariants` splits it.
 * The person answers the reply they saw last, which may follow a background completion.
 */
export function inputOf(memory: Memory, request: string, context?: TaskContext, continuesTask?: boolean): ClassifyInput {
  const previous = memory.history.at(-1)
  return {
    request, previousRequest: previous?.request, previousAnswer: memory.latestAnswer ?? previous?.answer, context, continuesTask,
    earlier: memory.history.slice(0, -1).slice(-2), previousTurn: memory.lastTurn,
  }
}

/**
 * Whether a finished turn continued its previous task: the classifier's answer when it gave one, else the
 * deterministic rule on the classified request. Replay never has the answer, so it always uses the rule.
 */
export function continuationOf(answered: boolean | undefined, request: string): boolean {
  return answered ?? isContinuation(request)
}

/** A background completion's reply becomes the previous answer only; it never replaces the task. */
export function afterNotification(memory: Memory, answer: string): Memory {
  return answer.trim() === '' ? memory : { ...memory, latestAnswer: excerpt(answer, 1000) }
}

export function afterTask(memory: Memory, task: FinishedTask): Memory {
  const typed = task.request.trim() !== ''
  const continued = task.continuation ? task.continued : undefined
  return {
    history: typed ? [...memory.history, { request: excerpt(task.request, 4000), answer: excerpt(task.answer, 1000) }].slice(-3) : memory.history,
    lastTurn: task.turn,
    previousTask: typed ? boundedContext({ observations: [], previousTask: {
      request: continued ? `${continued.request}\nFollow-up: ${task.request}` : task.request,
      answer: task.answer, level: task.level,
      observations: [...(continued?.observations ?? []), ...task.observations].slice(-4),
    } }).previousTask : memory.previousTask,
  }
}
