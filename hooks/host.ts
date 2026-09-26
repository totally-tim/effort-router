import type { CommandSpec, HttpInit, HttpResponse } from 'claude-code'

/**
 * The System One settings a TypeSafe SDK reads from the environment.
 */
export type SystemOneEnv = {
  apiKey?: string
  baseUrl?: string
  model?: string
}

/**
 * What the router uses of the engine. `register.ts` builds it from `$` (the
 * loader traces `$` only through calls spelled `$.noun.event(...)`), and the
 * other modules and the tests work against this shape.
 */
export type Host = {
  now: () => Promise<number>
  sleep: (ms: number) => Promise<void>
  fetch: (url: string, init: HttpInit) => Promise<HttpResponse>
  readText: (path: string) => Promise<string | undefined>
  exists: (path: string) => Promise<boolean>
  writeText: (path: string, text: string) => Promise<void>
  home: () => Promise<string | undefined>
  /**
   * `TYPESAFE_API_KEY`, `TYPESAFE_BASE_URL` and `TYPESAFE_DEFAULT_MODEL`.
   */
  systemOneEnv: () => Promise<SystemOneEnv>
  /**
   * The effort level saved for `model` under `modelSettings`, if any.
   */
  savedEffort: (model: string) => Promise<string | undefined>
  sessionId: () => Promise<string>
  registerCommand: (spec: CommandSpec) => Promise<unknown>
  /**
   * Redraws the spinner and the turn lines the router labels.
   */
  redraw: () => void
  /**
   * One dim line in the transcript, not sent to the model.
   */
  say: (text: string) => void
}
