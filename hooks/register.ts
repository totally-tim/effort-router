import type { EngineInterface, On, PluginOptions } from 'claude-code'

import {
  Breaker,
  type ClassifyConfig,
  type ClassifyInput,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  classifyAll,
  isClassified,
  systemOneUrlOf,
} from './classify'
import { DecisionLog } from './decision-log'
import type { Host, SystemOneEnv } from './host'
import {
  CHOICES,
  type Level,
  type Probabilities,
  cueFloorOf,
  escalationOf,
  higherOf,
  isLevel,
  pickOf,
  raisedBy,
  rankOf,
} from './policy'

export const COMMAND_NAME = 'effort-router'

const MODES = ['off', 'shadow', 'enforce'] as const

type Mode = (typeof MODES)[number]

type Effort = Level | number

type Config = {
  mode: Mode
  ensemble: boolean
  headless: boolean
  floor: Level
  ceiling: Level
  threshold: number
  /**
   * Unset: `TYPESAFE_BASE_URL`, else hosted Jev.
   */
  baseUrl?: string
  /**
   * Unset: `TYPESAFE_DEFAULT_MODEL`, else `jev-latest`.
   */
  model?: string
  /**
   * Unset: the key is `TYPESAFE_API_KEY`.
   */
  keyFile?: string
  keyName: string
  logDir: string
  timeoutMs: number
}

type StepRecord = {
  index: number
  seen?: Effort
  sent?: Effort
  would?: Level
  yielded?: true
}

type Verdict = {
  level?: Level
  reason: string
  cue?: Level
  probabilities?: Probabilities
  confidence?: number
  latencyMs?: number
}

type MidTurnRecord = {
  text_head: string
  pick?: Level
  reason: string
  probabilities?: Probabilities
  raised: boolean
}

type Turn = {
  turnId: string
  text: string
  stepZeroEffort?: Effort
  base?: Level
  raisedTo?: Level
  reason?: string
  cue?: Level
  probabilities?: Probabilities
  confidence?: number
  latencyMs?: number
  decided?: Promise<void>
  isSettled?: true
  reconsidered?: Promise<void>
  manual?: true
  midTurn: MidTurnRecord[]
  errors: number
  steps: StepRecord[]
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number }
}

/**
 * The origins of text a person typed: the prompt box, or Remote Control.
 */
const TYPED_ORIGINS: readonly string[] = ['composer', 'bridge']

/**
 * The turn's level before tool-failure escalation: its pick, or a higher
 * level a message typed mid-turn raised it to.
 */
function levelOf(turn: Turn): Level | undefined {
  if (turn.raisedTo && (!turn.base || rankOf(turn.raisedTo) > rankOf(turn.base))) {
    return turn.raisedTo
  }

  return turn.base
}

/**
 * How much longer than the classifier timeout `turn.complete` waits for a
 * classification still in flight before it logs the turn without one; the
 * whole wait stays inside the hook's 10-second budget.
 */
const SETTLE_MARGIN_MS = 500
const SETTLE_MAX_MS = 9000

export function configOf(options: PluginOptions): Config {
  const text = (name: string, fallback: string) => {
    const value = options[name]

    return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
  }

  const number = (name: string, fallback: number, min: number, max: number) => {
    const value = Number(options[name])

    return Number.isFinite(value) && value >= min && value <= max ? value : fallback
  }

  const optional = (name: string) => {
    const value = text(name, '')

    return value === '' ? undefined : value
  }

  const mode = text('mode', 'shadow')
  const floor = text('floor', 'low')
  const ceiling = text('ceiling', 'xhigh')

  return {
    mode: (MODES as readonly string[]).includes(mode) ? (mode as Mode) : 'shadow',
    floor: isLevel(floor) ? floor : 'low',
    ceiling: isLevel(ceiling) ? ceiling : 'xhigh',
    ensemble: options.ensemble !== false && options.ensemble !== 'false',
    headless: options.headless === true || options.headless === 'true',
    threshold: number('threshold', 0.95, 0.5, 0.99),
    baseUrl: optional('baseUrl'),
    model: optional('model'),
    keyFile: optional('keyFile'),
    keyName: text('keyName', 'TYPESAFE_API_KEY'),
    logDir: text('logDir', '~/.local/state/effort-router'),
    timeoutMs: number('timeoutMs', 5000, 200, 8000),
  }
}

/**
 * The engine calls the router makes, each spelled out on `$` so the loader
 * can trace them.
 */
function hostOf($: EngineInterface): Host {
  return {
    now: () => $.clock.now(),
    sleep: ms => $.clock.sleep(ms),
    fetch: (url, init) => $.http.fetch(url, init),
    readText: async path => {
      const raw = await $.fs.read(path)

      return typeof raw === 'string' ? raw : undefined
    },
    writeText: (path, text) => $.fs.write(path, text),
    exists: path => $.fs.exists(path),
    home: () => $.env.get('HOME'),
    systemOneEnv: async () => ({
      apiKey: (await $.env.get('TYPESAFE_API_KEY')) || undefined,
      baseUrl: (await $.env.get('TYPESAFE_BASE_URL')) || undefined,
      model: (await $.env.get('TYPESAFE_DEFAULT_MODEL')) || undefined,
    }),
    savedEffort: async model => {
      const settings = await $.settings.read()
      const perModel = settings.modelSettings as Record<string, { effortLevel?: unknown }> | undefined
      const level = perModel?.[model.replace(/\[.*\]$/, '')]?.effortLevel

      return typeof level === 'string' ? level : undefined
    },
    sessionId: () => $.session.id(),
    registerCommand: spec => $.command.register(spec),
    redraw: () => $.ui.invalidate('ui.render'),
    say: text => $.ui.log(text),
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function expandHome(path: string, home: string | undefined): string {
  return path.startsWith('~/') && home ? `${home}${path.slice(1)}` : path
}

/**
 * The key in a key file: the `keyName` field of a JSON object, or the whole
 * text of a file that holds only the key.
 */
export function keyIn(raw: string, keyName: string): string | undefined {
  let parsed: unknown

  try {
    parsed = JSON.parse(raw)
  } catch {
    const text = raw.trim()

    return text !== '' && !/\s/.test(text) ? text : undefined
  }

  const value = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>)[keyName] : undefined

  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * How many closing lines the router remembers the turn of.
 */
const CLOSING_LINES = 500

export function register(on: On, options: PluginOptions): void {
  const config = configOf(options)
  const breaker = new Breaker()
  const turns = new Map<string, Turn>()

  let mode: Mode = config.mode
  let classifier: ClassifyConfig = {
    url: systemOneUrlOf(config.baseUrl ?? DEFAULT_BASE_URL),
    model: config.model ?? DEFAULT_MODEL,
    timeoutMs: config.timeoutMs,
  }
  let key: string | undefined
  let keyProblem: string | undefined
  let keyDetail: string | undefined
  // The session id is the main loop's spinner id; a subagent's spinner has
  // the agent's id and is left alone.
  let mainSpinnerId: string | undefined
  // The turn whose closing line comes next, and the closing lines drawn so
  // far with the turn each one closed (null: a line from before this plugin
  // served the session).
  let closingNext: Turn | undefined
  const closings = new Map<string, Turn | null>()
  // Setup problems are said once per session in the transcript.
  const said = new Set<string>()
  let log: DecisionLog | undefined
  let ready: Promise<void> | undefined
  let currentTurnId: string | undefined
  let lastRecord: Record<string, unknown> | undefined
  // The last typed exchanges (oldest first), how the last turn went, and the
  // last turn's level, which a turn without a typed prompt inherits.
  let history: { request: string; answer?: string }[] = []
  let lastTurn: ClassifyInput['previousTurn']
  let lastLevel: Level | undefined
  let isInteractive: boolean | undefined

  /**
   * Whether the router acts in this session. Headless sessions (`claude -p`,
   * the SDKs) run prompts that tools wrote, which the eval never measured, so
   * they keep their effort unless `headless` is on.
   */
  function isActive(): boolean {
    return mode !== 'off' && (config.headless || isInteractive !== false)
  }
  let health = 'not asked yet'
  let baseline: Effort | undefined

  /**
   * The effort the session normally runs at: learned once, from the log of a
   * session this plugin already served (after a reload), else from the level
   * saved for the model, else from the first turn's own effort. A turn at any
   * other level was set by hand (`/effort`, `--effort`, the environment).
   */
  async function baselineOf(host: Host, model: string, seen: Effort | undefined): Promise<Effort | undefined> {
    if (baseline !== undefined) {
      return baseline
    }

    const logged = log?.firstOf('baseline')
    const saved = await host.savedEffort(model).catch(() => undefined)

    baseline = (logged as Effort | undefined) ?? (isLevel(saved) ? saved : seen)

    return baseline
  }

  /**
   * Loads the key, opens the session's log and registers the command, once.
   * Also runs lazily from the other hooks, because a reload of the plugin
   * mid-session runs `register` again without a new `session.start`.
   */
  let logOpening: Promise<void> | undefined

  /**
   * Opens the decision log of the session running now, once per session,
   * keeping what a reloaded plugin already wrote to it.
   */
  function openLog(host: Host): Promise<void> {
    logOpening ??= (async () => {
      try {
        const home = await host.home()
        const id = (await host.sessionId()).replace(/\.jsonl$/, '')
        const path = `${expandHome(config.logDir, home)}/${id}.jsonl`
        // A new session has no log yet; reading one would log an engine error.
        // A log that exists but cannot be read (over the 4 MiB read limit) is
        // kept, and this session goes on in a new file beside it.
        const isThere = await host.exists(path)
        const existing = isThere ? await host.readText(path).catch(() => undefined) : undefined
        const target = isThere && existing === undefined ? path.replace(/\.jsonl$/, `.${await host.now()}.jsonl`) : path

        log = new DecisionLog(target, host.writeText, existing)
      } catch {
        log = undefined
      }
    })()

    return logOpening
  }

  /**
   * Forgets the previous session: `/clear` and `/resume` start a new session
   * in the same process, and its turns must not inherit the old one's
   * exchanges, levels or log.
   */
  function resetSession(): void {
    turns.clear()
    history = []
    lastTurn = undefined
    lastLevel = undefined
    baseline = undefined
    currentTurnId = undefined
    lastRecord = undefined
    log = undefined
    logOpening = undefined
    mainSpinnerId = undefined
    closingNext = undefined
    closings.clear()
    said.clear()
    // The key is part of the setup, and a session may have fixed it: a new
    // session reads the key file and the environment again.
    ready = undefined
    key = undefined
    keyProblem = undefined
    keyDetail = undefined
  }

  function prepare(host: Host): Promise<void> {
    ready ??= (async () => {
      const home = await host.home()
      const env: SystemOneEnv = await host.systemOneEnv().catch(() => ({}))

      classifier = {
        url: systemOneUrlOf(config.baseUrl ?? env.baseUrl ?? DEFAULT_BASE_URL),
        model: config.model ?? env.model ?? DEFAULT_MODEL,
        timeoutMs: config.timeoutMs,
      }

      if (config.keyFile) {
        try {
          const raw = await host.readText(expandHome(config.keyFile, home))

          key = raw === undefined ? undefined : keyIn(raw, config.keyName)
          keyProblem = key ? undefined : `no ${config.keyName} in the key file`
        } catch (error) {
          keyProblem = 'key file unreadable'
          keyDetail = messageOf(error)
        }
      } else if (env.apiKey) {
        key = env.apiKey
      } else {
        keyProblem = 'no API key'
        keyDetail = 'set TYPESAFE_API_KEY, or the keyFile option'
      }

      try {
        await host.registerCommand({
          name: COMMAND_NAME,
          description: 'Effort router: status, why, shadow, enforce, off, wrong <level>',
          argumentHint: 'status|why|shadow|enforce|off|wrong <level>',
          immediate: true,
        })
      } catch {
        // Another plugin or the engine holds the name; the router still runs.
      }
    })()

    return Promise.all([ready, openLog(host), spinnerIdOf(host)]).then(() => undefined)
  }

  async function spinnerIdOf(host: Host): Promise<void> {
    mainSpinnerId ??= (await host.sessionId().catch(() => undefined))?.replace(/\.jsonl$/, '')
  }

  /**
   * Says a setup problem once per session, as a dim transcript line.
   */
  function sayOnce(host: Host, topic: string, text: string): void {
    if (!said.has(topic)) {
      said.add(topic)
      host.say(text)
    }
  }

  /**
   * What the spinner and the turn's closing line say about the turn's effort:
   * the level its latest request went out at, and why when the router did
   * not simply pick it. Undefined where the router has nothing to say.
   */
  function phraseOf(turn: Turn): string | undefined {
    const last = turn.steps.at(-1)

    if (!last) {
      return mode === 'enforce' && turn.decided && !turn.isSettled ? 'choosing effort' : undefined
    }

    if (last.sent === undefined) {
      return undefined
    }

    const level = levelOf(turn)
    let note: string | undefined

    if (turn.manual) {
      note = 'set by hand'
    } else if (last.yielded) {
      note = undefined
    } else if (turn.reason?.startsWith('fallback')) {
      // Said in every mode: a classifier that gave no answer is worth the
      // note even in shadow, where nothing was rewritten.
      note = `router: ${turn.reason.replace(/^fallback:?\s*/, '') || 'failed'}`
    } else if (mode === 'shadow') {
      const would = level ? raisedBy(level, escalationOf(turn.errors), config.ceiling) : undefined

      note = would && would !== last.sent ? `router: ${would}` : undefined
    } else if (level && last.would && rankOf(last.would) > rankOf(level)) {
      note = 'raised after failed tool calls'
    } else if (turn.raisedTo && turn.base && rankOf(turn.raisedTo) > rankOf(turn.base)) {
      note = 'raised by your message'
    } else if (turn.reason === 'cue') {
      note = 'you asked to think hard'
    }

    return `at ${String(last.sent)} effort${note ? ` (${note})` : ''}`
  }

  function refresh(host: Host): void {
    try {
      host.redraw()
    } catch {
      // Nothing is drawn in this session (`-p`); the log keeps the decision.
    }
  }

  /**
   * The level one piece of typed text needs. Never rejects: without an answer
   * the level is the cue's, if any, else unset.
   */
  async function verdictOf(host: Host, inputs: readonly ClassifyInput[]): Promise<Verdict> {
    const cue = cueFloorOf(inputs[0]?.request ?? '')
    const floor = cue ? higherOf(config.floor, cue) : config.floor

    // Without a key the router is not set up and changes nothing. A paused or
    // failing classifier still honors a deep-reasoning phrase: those are the
    // person's own words.
    if (!key) {
      return { cue, reason: `fallback: ${keyProblem}` }
    }

    if (breaker.isOpen(await host.now())) {
      return { level: cue, cue, reason: cue ? 'cue' : 'fallback: classifier paused' }
    }

    const result = await classifyAll(host, classifier, key, inputs)

    breaker.record(isClassified(result), await host.now())

    if (!isClassified(result)) {
      health = `failing (${result.failure})`

      if (breaker.isOpen(await host.now())) {
        sayOnce(
          host,
          'paused',
          `classifier failing (${result.failure}); turns keep the session's effort for 5 minutes. /effort-router status has details.`,
        )
      }

      return {
        level: cue,
        cue,
        reason: cue ? 'cue' : `fallback: ${result.failure}`,
        latencyMs: result.latencyMs,
      }
    }

    health = `ok (${result.latencyMs} ms)`

    const unforced = pickOf(result.probabilities, config.threshold, config.floor, config.ceiling)
    const level = pickOf(result.probabilities, config.threshold, floor, higherOf(config.ceiling, floor))

    return {
      level,
      cue,
      reason: rankOf(level) > rankOf(unforced) ? 'cue' : 'classifier',
      probabilities: result.probabilities,
      confidence: result.confidence,
      latencyMs: result.latencyMs,
    }
  }

  /**
   * What the classifier reads for a typed prompt: the prompt with the previous
   * exchange and, with `ensemble` on, the same plus the two exchanges before
   * it, and the same plus how the last turn went. The eval chose this mean of
   * three contexts as the most reliable against under-thinking.
   */
  function inputsOf(text: string): ClassifyInput[] {
    const previousExchange = history.at(-1)
    const base: ClassifyInput = {
      request: text,
      previousRequest: previousExchange?.request,
      previousAnswer: previousExchange?.answer,
    }

    if (!config.ensemble) {
      return [base]
    }

    return [base, { ...base, earlier: history.slice(0, -1).slice(-2) }, { ...base, previousTurn: lastTurn }]
  }

  /**
   * Sets `turn.base` and `turn.reason` for the turn's typed prompt, or carries
   * the previous pick over to a turn that started without one.
   */
  async function decide(host: Host, turn: Turn): Promise<void> {
    if (turn.text.trim() === '') {
      turn.base = lastLevel
      turn.reason = lastLevel ? 'inherit' : 'fallback: no previous pick'

      return
    }

    const verdict = await verdictOf(host, inputsOf(turn.text))

    turn.base = verdict.level
    turn.reason = verdict.reason
    turn.cue = verdict.cue
    turn.probabilities = verdict.probabilities
    turn.confidence = verdict.confidence
    turn.latencyMs = verdict.latencyMs
  }

  /**
   * Classifies a message typed while the turn runs. It can raise the rest of
   * the turn above the level it has, never lower it.
   */
  async function reconsider(host: Host, turn: Turn, text: string): Promise<void> {
    await turn.decided

    const verdict = await verdictOf(host, [{ request: text, previousRequest: turn.text }])
    const current = levelOf(turn) ?? (isLevel(turn.stepZeroEffort) ? turn.stepZeroEffort : undefined)
    const isRaised =
      verdict.level !== undefined && current !== undefined && rankOf(verdict.level) > rankOf(current)

    if (isRaised) {
      turn.raisedTo = verdict.level
    }

    turn.midTurn.push({
      text_head: text.slice(0, 200),
      pick: verdict.level,
      reason: verdict.reason,
      probabilities: verdict.probabilities,
      raised: isRaised,
    })

    if (isRaised) {
      refresh(host)
    }
  }

  function turnOf(turnId: string): Turn {
    let turn = turns.get(turnId)

    if (!turn) {
      turn = {
        turnId,
        text: '',
        midTurn: [],
        errors: 0,
        steps: [],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      }
      turns.set(turnId, turn)
    }

    return turn
  }

  on('session.start', async ($, e, next) => {
    isInteractive = e.isInteractive
    resetSession()

    const result = await next(e)

    await prepare(hostOf($)).catch(() => undefined)

    return result
  })

  on('turn.start', async ($, e, next) => {
    turnOf(e.turnId).text = e.text
    currentTurnId = e.turnId

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined || !isActive()) {
      return yield* next(e)
    }

    const host = hostOf($)
    const turn = turnOf(e.turnId)
    const isFirst = turn.steps.length === 0

    if (isFirst) {
      turn.stepZeroEffort = e.effort

      await prepare(host).catch(() => undefined)

      const usual = await baselineOf(host, e.model, e.effort).catch(() => e.effort)

      if (e.effort !== undefined && (e.effort === 'max' || e.effort !== usual)) {
        turn.manual = true
      }

      turn.decided = prepare(host)
        .then(() => decide(host, turn))
        .catch(error => {
          turn.reason = `fallback: ${messageOf(error)}`
        })
        .finally(() => {
          turn.isSettled = true
        })
      closingNext = turn

      if (keyProblem) {
        sayOnce(host, 'key', `${keyProblem}${keyDetail ? ` (${keyDetail})` : ''}; effort stays as set.`)
      }

      // Shadow mode never holds a request: the pick is drawn and logged when
      // it lands. Enforce mode waits, bounded by the classifier timeout, and
      // says so on the spinner meanwhile.
      if (mode === 'enforce') {
        refresh(host)
        await turn.decided
      } else {
        void turn.decided.then(() => {
          const level = levelOf(turn)

          // Requests that went out before the pick landed get it in the log.
          for (const step of turn.steps) {
            if (level && !step.would) {
              step.would = raisedBy(level, escalationOf(turn.errors), config.ceiling)
            }
          }

          refresh(host)
        })
      }
    }

    // A message typed mid-turn may still be in classification; enforce mode
    // lets it land so the raise reaches this request.
    if (!isFirst && mode === 'enforce' && turn.reconsidered) {
      await Promise.race([turn.reconsidered, host.sleep(config.timeoutMs)])
    }

    const isYielded = !isFirst && e.effort !== turn.stepZeroEffort
    const level = levelOf(turn)
    const would = level ? raisedBy(level, escalationOf(turn.errors), config.ceiling) : undefined
    const sent = mode === 'enforce' && would && !isYielded && !turn.manual ? would : e.effort

    turn.steps.push({
      index: e.index,
      seen: e.effort,
      sent,
      ...(would ? { would } : {}),
      ...(isYielded ? { yielded: true as const } : {}),
    })

    if (isFirst || sent !== turn.steps[turn.steps.length - 2]?.sent) {
      refresh(host)
    }

    const result = yield* next(sent === e.effort ? e : { ...e, effort: sent })

    if (result?.usage) {
      turn.usage.input += result.usage.input_tokens
      turn.usage.output += result.usage.output_tokens
      turn.usage.cacheRead += result.usage.cache_read_input_tokens
      turn.usage.cacheWrite += result.usage.cache_creation_input_tokens
    }

    return result
  })

  on('prompt.submit', async ($, e, next) => {
    const result = await next(e)
    const turn = e.turnId === undefined ? undefined : turns.get(e.turnId)

    const isMidTurnTyped =
      turn !== undefined &&
      !e.wait &&
      TYPED_ORIGINS.includes(e.origin.kind) &&
      e.text.trim() !== ''

    if (isActive() && isMidTurnTyped) {
      const host = hostOf($)

      // Raises only ever go up, so order does not matter: each message is
      // classified at once, and the step waits for all of them together.
      const reconsidering = reconsider(host, turn, e.text).catch(() => undefined)

      turn.reconsidered = turn.reconsidered
        ? Promise.all([turn.reconsidered, reconsidering]).then(() => undefined)
        : reconsidering
    }

    return result
  })

  on('tool.call', async ($, e, next) => {
    // The turn the call ran in, taken before it finishes: a tool that settles
    // after its turn ended must not count toward the next turn.
    const turn = e.agentId === undefined && currentTurnId ? turns.get(currentTurnId) : undefined
    const result = await next(e)

    const isFailed = (result as { isError?: boolean } | undefined)?.isError === true

    if (isFailed && turn && turns.get(turn.turnId) === turn) {
      turn.errors += 1
    }

    return result
  })

  on('turn.complete', async ($, e, next) => {
    // The line that closes this turn claims the phrase at its draw. Arm it
    // again here: a closing line drawn while the turn ran, such as a
    // subagent's, may have taken the arm set at the turn's first request.
    const turnBefore = e.agentId === undefined ? turns.get(e.turnId) : undefined

    if (turnBefore && turnBefore.steps.length > 0) {
      closingNext = turnBefore
    }

    const result = await next(e)

    if (e.agentId !== undefined) {
      return result
    }

    const host = hostOf($)
    const turn = turns.get(e.turnId)

    if (turn && turn.steps.length > 0) {
      const pending = [turn.decided, turn.reconsidered].filter(Boolean)

      if (pending.length > 0) {
        await Promise.race([Promise.all(pending), host.sleep(Math.min(config.timeoutMs + SETTLE_MARGIN_MS, SETTLE_MAX_MS))])
      }

      lastRecord = {
        type: 'turn',
        ts: new Date(await host.now()).toISOString(),
        turnId: turn.turnId,
        mode,
        prompt_len: turn.text.length,
        prompt_head: turn.text.slice(0, 200),
        probabilities: turn.probabilities,
        confidence: turn.confidence,
        latency_ms: turn.latencyMs,
        cue: turn.cue,
        reason: turn.reason,
        session_effort: turn.stepZeroEffort,
        baseline,
        ...(turn.manual ? { manual: true } : {}),
        would_pick: turn.base,
        ...(turn.midTurn.length > 0 ? { mid_turn: turn.midTurn, raised_to: turn.raisedTo } : {}),
        sent: turn.steps[0]?.sent,
        steps: turn.steps,
        tool_errors: turn.errors,
        outcome: {
          reason: e.reason,
          duration_ms: e.durationMs,
          usage: turn.usage,
        },
      }

      await log?.append(lastRecord)

      if (turn.text.trim() !== '') {
        history = [...history, { request: turn.text.slice(0, 4000), answer: e.answer.slice(0, 1000) }].slice(-3)
      }

      lastTurn = { toolErrors: turn.errors, requests: turn.steps.length, interrupted: e.isAborted }
      lastLevel = levelOf(turn) ?? lastLevel
    }

    turns.delete(e.turnId)

    return result
  })

  on('ui.render', { component: 'Spinner' }, ($, e, next) => {
    const turn = currentTurnId ? turns.get(currentTurnId) : undefined
    const phrase = turn && isActive() && e.requestId === mainSpinnerId ? phraseOf(turn) : undefined

    return phrase ? next({ ...e, props: { ...e.props, suffix: `${e.props.suffix} ${phrase}` } }) : next(e)
  })

  on('ui.render', { component: 'TurnDuration' }, ($, e, next) => {
    if (!closings.has(e.requestId)) {
      closings.set(e.requestId, closingNext ?? null)
      closingNext = undefined

      if (closings.size > CLOSING_LINES) {
        closings.delete(closings.keys().next().value as string)
      }
    }

    const turn = closings.get(e.requestId)
    const phrase = turn ? phraseOf(turn) : undefined

    return phrase ? next({ ...e, props: { ...e.props, word: `${e.props.word} ${phrase}` } }) : next(e)
  })

  on('command.run', { command: COMMAND_NAME }, async ($, e) => {
    const host = hostOf($)

    await prepare(host).catch(() => undefined)

    const [verb = 'status', argument] = e.args.trim().split(/\s+/).filter(Boolean)

    if ((MODES as readonly string[]).includes(verb)) {
      mode = verb as Mode
      refresh(host)

      return { text: `mode ${mode} for this session` }
    }

    if (verb === 'why') {
      return {
        text: lastRecord ? JSON.stringify(lastRecord, null, 2) : 'no turn decided yet',
      }
    }

    if (verb === 'wrong' || verb === 'label') {
      const turnId = currentTurnId ?? (lastRecord?.turnId as string | undefined)

      if (!isLevel(argument)) {
        return { text: 'usage: /effort-router wrong <low|medium|high|xhigh|max>' }
      }

      if (!turnId) {
        return { text: 'no turn to label yet' }
      }

      await log?.append({
        type: 'label',
        ts: new Date(await host.now()).toISOString(),
        turnId,
        level: argument,
        would_pick: lastRecord?.turnId === turnId ? lastRecord?.would_pick : undefined,
      })

      return { text: `labeled turn ${turnId.slice(0, 8)} as ${argument}` }
    }

    const last = lastRecord
      ? `last: would ${String(lastRecord.would_pick)} · sent ${String(lastRecord.sent)} · ${String(lastRecord.reason)}`
      : 'last: none yet'

    return {
      text: [
        `mode ${mode}; range ${config.floor}-${config.ceiling}; threshold ${config.threshold}; ensemble ${config.ensemble ? 'on' : 'off'}`,
        `classifier: ${classifier.url} (${classifier.model}); ${health}`,
        `key: ${keyProblem ? `${keyProblem}${keyDetail ? ` (${keyDetail})` : ''}` : 'loaded'}`,
        last,
        `log: ${log?.path ?? 'none'}`,
      ].join('\n'),
    }
  })
}
