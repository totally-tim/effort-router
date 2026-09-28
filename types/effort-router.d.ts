// The values effort-router holds in the session (`$.state`) for the instance
// that takes over after a hot reload of its code: the conversation's task
// memory by session id, and each running turn of the main loop by turn id.
// The host drops them when the conversation changes or the process ends.

/** One typed exchange, as bounded, redacted excerpts. */
export type EffortRouterExchange = {
  request: string
  answer?: string
}

/** Bounded output of an inspection tool (Read, Grep, Glob) a turn used. */
export type EffortRouterObservation = {
  tool: string
  target?: string
  text: string
}

export type EffortRouterTask = {
  request: string
  answer?: string
  level?: string
  observations: EffortRouterObservation[]
}

export type EffortRouterLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** The task memory later turns of one conversation are classified with. */
export type EffortRouterMemory = {
  history: readonly EffortRouterExchange[]
  latestAnswer?: string
  lastTurn?: { toolErrors: number; requests: number; interrupted: boolean }
  previousTask?: EffortRouterTask
  /** The level a turn without a typed prompt inherits. */
  lastLevel?: EffortRouterLevel
  /** The project identity the memory belongs to. */
  project?: string
  projectRoot?: string
  baseline?: EffortRouterLevel | number
}

/**
 * Where an instance's resume checkpoints come from. Each instance writes only
 * its own file, `<session>.memory.<writer>.json`; `seq` counts its saves, and
 * `parents` names the saves (`<writer>#<seq>`, or `file:<name>:<print>` for a
 * file that could not be read) it went on from. `diverged` marks memory that
 * was not restored because the saves branched, the newest could not be read,
 * or the saves did not form one line.
 */
export type EffortRouterLineage = {
  writer: string
  seq: number
  parents: string[]
  diverged?: true
}

/** A prompt submitted and not yet matched to the turn it started or entered. */
export type EffortRouterSubmission = {
  text: string
  origin: string
  over?: string
  level?: EffortRouterLevel
  entering: boolean
  [field: string]: unknown
}

export type EffortRouterSession = {
  schema: 1
  sessionId: string
  memory: EffortRouterMemory
  submissions: readonly EffortRouterSubmission[]
  currentTurnId?: string
  lastRecord?: Record<string, unknown>
  mode?: string
  checkpoint?: EffortRouterLineage
}

/**
 * A running turn's routing state (its text, origin, decision, requests and
 * evidence), or only the mark that it completed.
 */
export type EffortRouterTurn = {
  schema: 1
  sessionId: string
  done?: true
  turn?: {
    turnId: string
    text: string
    steps: readonly unknown[]
    [field: string]: unknown
  }
}

declare module 'claude-code' {
  interface PluginState {
    'effort-router': {
      memory: StateFamily<EffortRouterSession>
      turn: StateFamily<EffortRouterTurn>
    }
  }
}
