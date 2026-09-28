import type { EngineInterface, On, PluginOptions, StateRead } from 'claude-code'

import {
  Breaker,
  type ClassifyConfig,
  type ClassifyInput,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  classifyAll,
  isClassified,
  inputVariants,
  systemOneUrlOf,
} from './classify'
import { type CacheOutcome, CacheTracker } from './cache'
import { DecisionLog, firstTurnOf } from './decision-log'
import { NOTIFICATION, type Entered, type Submission, batchTaskOf, claim, deliveredIndexOf, enteredOf, taskMemoryOf, unclaimedOf } from './batch'
import { addObservation, boundedContext, isTaskNotification, needsConcurrencyReasoning, observationOf, projectOf, repositoryOf, type Repository, type TaskContext } from './context'
import type { Host as EngineHost, SystemOneEnv } from './host'
import { EMPTY_MEMORY, afterNotification, afterTask, continuationOf, inputOf, type Memory } from './memory'
import {
  CHOICES,
  type Level,
  type Probabilities,
  cueFloorOf,
  clamp,
  escalationOf,
  higherOf,
  isLevel,
  raisedBy,
  rankOf,
  routeOf,
} from './policy'
import {
  Held,
  type HeldSession,
  type HeldTurn,
  type HoldResult,
  type Lineage,
  type Memory as SavedMemory,
  type Plain,
  SCHEMA,
  checkpointOf,
  checkpointPathOf,
  heldSessionOf,
  heldTurnOf,
  isCheckpointName,
  mergedSubmissionsOf,
  plainOf,
  resumedFrom,
  saveOf,
} from './session-state'

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
  /** The hook budget left too little time to check pending evidence or a due retry before this request. */
  deferred?: { remainingMs: number; neededMs: number; evidence?: true; retry?: true }
  durationMs?: number
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number }
  /** Cache reuse against the previous main-conversation request of the same conversation and model, by the `/context` ledger rule. */
  cache?: CacheOutcome
  /** The effort passed on differs from that previous request's; a correlation, not a cause. */
  effortChanged?: true
}

type Verdict = {
  level?: Level
  reason: string
  cue?: Level
  probabilities?: Probabilities
  workProbabilities?: Probabilities
  workLevel?: Level
  evidenceFloor?: Level
  confidence?: number
  latencyMs?: number
  contextSufficient?: boolean
  contextHeld?: boolean
  missing?: string[]
  continuation?: boolean
  /** The classifier gave no answer: `paused` sent no request. */
  failed?: 'paused' | 'request'
  recovery?: true
  /** On a discovery entry: the turn's earlier sufficient-context level, applied instead of this lower answer. */
  assessedFloor?: Level
}

type MidTurnRecord = {
  text_head: string
  pick?: Level
  reason: string
  probabilities?: Probabilities
  latency_ms?: number
  raised: boolean
}

type Turn = {
  turnId: string
  text: string
  taskNotification?: boolean
  stepZeroEffort?: Effort
  base?: Level
  raisedTo?: Level
  reason?: string
  cue?: Level
  probabilities?: Probabilities
  workProbabilities?: Probabilities
  workLevel?: Level
  evidenceFloor?: Level
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
  context?: TaskContext
  contextSufficient?: boolean
  contextHeld?: boolean
  /** The highest level a sufficient-context decision chose in this turn; releasing a hold never goes below it. */
  assessedFloor?: Level
  missing?: string[]
  continuation?: boolean
  evidenceVersion: number
  checkedVersion: number
  hasActed: boolean
  discovery: Verdict[]
  discovering?: Promise<void>
  /** Set while the turn has no answered decision: the earliest retry on a later request. */
  recoverAt?: number
  /** Why the turn's latest assessment got no answer; kept while `recoverAt` is set, whatever `reason` says. */
  failure?: string
  /** Retries made so far: the backoff exponent. */
  recoveries: number
  /** Prompts queued over the previous turn that may have entered this one with its own; the first request settles them. */
  queued?: Submission[]
  /** Several prompts entered this turn together; `confirmed` when the transcript showed which. */
  batch?: { count: number; confirmed: boolean; floor?: Level }
  /** Prompts the engine delivered into this turn while it ran. */
  delivered?: Entered[]
  /** The prompt that started the turn, once matched: its origin and the turn it was queued over. */
  startedBy?: { origin: string; over?: string }
  /** Decided while the takeover of the held memory was pending: the prompts it brings join the turn later. */
  takeoverPending?: true
  /** Fingerprints of the user messages that entered the turn and no matched prompt claims, read at its first request. */
  unclaimed?: string[]
  /** The inherited level when this decision saw unresolved task memory. */
  memoryHeld?: { lastLevel?: Level }
}

/** A turn's data, as one plugin instance hands a running turn to the next after a reload. */
type PlainTurn = Plain<Turn>

/**
 * The engine calls the router makes, with the values it holds in the session
 * (`$.state`) for the instance after a reload.
 */
type Host = EngineHost & {
  heldMemory: (sessionId: string) => Promise<StateRead<unknown>>
  holdMemory: (sessionId: string, value: HeldSession, ifVersion: number) => Promise<HoldResult>
  heldTurn: (turnId: string) => Promise<StateRead<unknown>>
  holdTurn: (turnId: string, value: HeldTurn, ifVersion: number) => Promise<HoldResult>
  /** The names of the files in a directory. */
  fileNames: (dir: string) => Promise<string[]>
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
 * Why a turn that the router routes still has no classifier answer for its
 * own decision; undefined once any assessment of the turn has answered. Read
 * from the recovery state, not from `reason`, which later checks overwrite.
 */
function unansweredOf(turn: Turn): string | undefined {
  return !turn.manual && turn.recoverAt !== undefined ? turn.failure ?? 'failed' : undefined
}

/**
 * The effort a decision keeps when context is missing: the turn's own effort,
 * or for a turn set by hand the session's usual level, so a level set by hand
 * never becomes a routed pick that a later turn inherits.
 */
function heldEffortOf(turn: Turn): Effort | undefined {
  return turn.manual ? undefined : turn.stepZeroEffort
}

/**
 * How much longer than the classifier timeout `turn.complete` waits for a
 * classification still in flight before it logs the turn without one; the
 * whole wait stays inside the hook's 10-second budget.
 */
const SETTLE_MARGIN_MS = 500
const SETTLE_MAX_MS = 9000

/**
 * How long the first request of a batched turn waits for the transcript that
 * says which queued prompts entered it.
 */
const BATCH_READ_MS = 1000

/**
 * A turn whose decision got no answer retries on a later model request, never
 * on elapsed time alone and never while the breaker is open, for as long as
 * the turn runs. Each failed attempt doubles the wait from RECOVERY_MS up to
 * MAX_RECOVERY_MS (1, 2, 4, then 5 minutes), one retry in flight at a time.
 */
const RECOVERY_MS = 60_000
const MAX_RECOVERY_MS = 300_000

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
    stat: async path => {
      const stat = await $.fs.stat(path, { resolve: true })

      return { kind: stat.kind, ...(stat.realPath ? { realPath: stat.realPath } : {}) }
    },
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
    promptsSinceAnswer: async () => {
      const rows = await $.session.messages()
      let start = rows.length

      while (start > 0 && rows[start - 1]!.role === 'user') start -= 1

      return rows.slice(start).map(row => row.text)
    },
    cwd: () => $.session.cwd(),
    root: () => $.session.root(),
    registerCommand: spec => $.command.register(spec),
    redraw: () => $.ui.invalidate('ui.render'),
    say: text => $.ui.log(text),
    heldMemory: id => $.state.get({ plugin: 'effort-router', key: 'memory', id }),
    holdMemory: (id, value, ifVersion) => $.state.set({ plugin: 'effort-router', key: 'memory', id }, value, { ifVersion }),
    heldTurn: id => $.state.get({ plugin: 'effort-router', key: 'turn', id }),
    holdTurn: (id, value, ifVersion) => $.state.set({ plugin: 'effort-router', key: 'turn', id }, value, { ifVersion }),
    fileNames: async dir => (await $.fs.list(dir)).filter(entry => entry.kind === 'file').map(entry => entry.name),
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

/** Takeover writes of the memory after a reload, the restore's included, before the earlier instance keeps it. */
const MAX_TAKEOVERS = 4

/** What a merge of the held session left, to tell this instance's later changes apart (see `mergeHeld`). */
type Merged = {
  submissions: readonly Submission[]
  memory: string
  mode: Mode
  currentTurnId?: string
  lastRecord?: Record<string, unknown>
  /** The parts this instance changed since a merge: they stay its own at every later merge. */
  local: { memory?: true; mode?: true; currentTurnId?: true; lastRecord?: true }
}

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
  // Shared live/replay task memory; pending submissions remain plain data.
  let memory: Memory = EMPTY_MEMORY
  let submissions: Submission[] = []
  const verdicts = new WeakMap<Submission, Promise<Level | undefined>>()
  let lastLevel: Level | undefined
  let repository: Repository | undefined
  // Task memory belongs to the project, not to the shell's current directory or a worktree of the same repository.
  let projectRoot: string | undefined
  let project: string | undefined
  let isInteractive: boolean | undefined
  // Cache outcomes of main-conversation requests across turns: a diagnostic of
  // reported usage, scoped to this load of the plugin and one conversation.
  const cache = new CacheTracker()
  // The conversation this instance serves: its id names the log, the checkpoint
  // and the held values. A new conversation in the same process moves on to the
  // next generation, and work begun for an earlier one touches nothing of it.
  let generation = 0
  let sessionId: string | undefined
  let binding: Promise<void> | undefined
  // Do not publish empty state while a resume is still restoring memory.
  let isRestored = false
  // Turns that started before the held prompts of the instance before a reload
  // were merged; they are matched to their prompts once the merge lands.
  let isMerged = false
  let started: { turn: Turn; text: string }[] = []
  let heldMemory = memoryHolder()
  // A takeover of the held memory after a reload: the writes made, the retry
  // in flight, the last merge, and a checkpoint left for once it is held.
  let takeovers = 0
  let retaking: Promise<void> | undefined
  let lastMerge: Merged | undefined
  let isSaveSkipped = false
  // The writer of the held memory this instance is taking over: only that instance may write it meanwhile.
  let takingOverFrom: string | undefined
  const heldTurns = new Map<string, Held<HeldTurn>>()
  const adopting = new Map<string, Promise<Turn | undefined>>()
  let saving: Promise<void> = Promise.resolve()
  // Where this instance's resume checkpoints come from and how many it saved.
  let lineage: Lineage | undefined
  // The usual level a log of an earlier version recorded for the conversation.
  let loggedBaseline: Effort | undefined

  /**
   * Whether the router acts in this session. Headless sessions (`claude -p`,
   * the SDKs) run prompts that tools wrote, which the eval never measured, so
   * they keep their effort unless `headless` is on.
   */
  function isActive(): boolean {
    return mode !== 'off' && (config.headless || isInteractive !== false)
  }
  let health = 'not asked yet'
  let classifierOk = false
  // Each classification request gets the next number, for the process: a
  // session reset or `/clear` keeps counting. A result is stale when a request
  // sent after it already settled the other way. A stale result still answers
  // its own turn but changes neither the breaker nor the health line, so late
  // failures cannot pause a classifier that has answered since, and a late
  // answer cannot hide a newer failure. Failures of overlapping requests all count.
  let asked = 0
  let newestAnswered = 0
  let newestFailed = 0
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

    const logged = log?.firstOf('baseline') ?? loggedBaseline
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
   * Opens this instance's decision log for the conversation running now:
   * `<session>.<writer>.jsonl`, a file no other instance or process writes.
   * After a reload, `/resume` or `claude --resume` the new instance starts
   * its own file and leaves the earlier ones as they are.
   */
  function openLog(host: Host): Promise<void> {
    const epoch = generation

    logOpening ??= (async () => {
      try {
        await bind(host)
        const dir = expandHome(config.logDir, await host.home())
        const id = sessionId ?? (await host.sessionId()).replace(/\.jsonl$/, '')
        const opened = new DecisionLog(`${dir}/${id}.${lineage?.writer ?? await writerOf(host)}.jsonl`, host.writeText)
        // Earlier versions wrote one `<session>.jsonl`; it is only read, for the usual level.
        // A new session has no log yet; reading one would log an engine error.
        const legacy = `${dir}/${id}.jsonl`
        const earlier = await host.exists(legacy) ? await host.readText(legacy).catch(() => undefined) : undefined

        if (epoch === generation) {
          log = opened
          loggedBaseline = earlier === undefined ? undefined : firstTurnOf(earlier.split('\n'))?.baseline as Effort | undefined
        }
      } catch {
        if (epoch === generation) log = undefined
      }
    })()

    return logOpening
  }

  /** The task memory as later turns read it. */
  function memoryOf(): SavedMemory {
    return { ...memory, lastLevel, project, projectRoot, baseline }
  }

  function applyMemory(saved: SavedMemory): void {
    memory = { history: [...saved.history], lastTurn: saved.lastTurn, previousTask: saved.previousTask, latestAnswer: saved.latestAnswer }
    lastLevel = saved.lastLevel
    project = saved.project
    projectRoot = saved.projectRoot
    baseline = saved.baseline
  }

  /** What this instance holds of the conversation for the next instance: nothing before it knows which. */
  function memoryHolder(): Held<HeldSession> {
    const epoch = generation

    // A reload takes the memory over from the instance before it: a miss before
    // any write landed waits for a later read (see `retake`).
    return new Held(() => epoch !== generation || sessionId === undefined ? undefined : {
      schema: SCHEMA, sessionId, memory: memoryOf(), submissions, mode,
      ...(currentTurnId !== undefined ? { currentTurnId } : {}),
      ...(lastRecord !== undefined ? { lastRecord } : {}),
      ...(lineage !== undefined ? { checkpoint: lineage } : {}),
    }, 0, 'wait')
  }

  function holdMemory(host: Host): Promise<void> {
    const id = sessionId

    return id === undefined || !isRestored ? Promise.resolve() : heldMemory.hold((value, ifVersion) => host.holdMemory(id, value, ifVersion))
  }

  /**
   * Binds this instance to the conversation running now, once per
   * conversation, and restores its task memory: what the instance before a
   * reload held, else the checkpoint of this very conversation (a resume).
   */
  function bind(host: Host): Promise<void> {
    const epoch = generation

    binding ??= (async () => {
      try {
        const id = (await host.sessionId()).replace(/\.jsonl$/, '')
        if (epoch !== generation) return
        sessionId = id
        await restore(host, id, epoch)
        if (epoch === generation) isRestored = true
      } finally {
        // Also after a failed restore: those turns are matched to what this instance saw.
        // A takeover that missed matches them once its next read merges the earlier instance's prompts.
        if (epoch === generation) {
          isMerged = true
          if (!isTakingOver()) matchStarted()
        }
      }
    })().catch(() => undefined)

    return binding
  }

  async function restore(host: Host, id: string, epoch: number): Promise<void> {
    let isHeld = false
    // One read: every read of this dispatch would return the same moment.
    const read = await host.heldMemory(id).catch(() => undefined)
    if (epoch !== generation) return

    if (!read) {
      heldMemory.isUnavailable = true
    } else {
      heldMemory.version = read.version
      const held = heldSessionOf(read.value, id)
      if (held) {
        isHeld = true
        // This instance saves to a file of its own, going on from the one before the reload.
        const writer = await writerOf(host)
        if (epoch !== generation) return
        lineage = held.checkpoint ? {
          writer, seq: 0, parents: saveOf(held.checkpoint),
          ...(held.checkpoint.diverged ? { diverged: true as const } : {}),
        } : undefined
        mergeHeld(held)
        takingOverFrom = held.checkpoint?.writer
        // Taking the memory over makes the earlier instance's later writes miss.
        // A miss means it wrote after the read: the takeover goes on at a later hook (see `retake`).
        takeovers = 1
        await heldMemory.hold((value, ifVersion) => host.holdMemory(id, value, ifVersion))
        if (epoch !== generation) return
      }
    }

    if (isHeld && lineage !== undefined) return

    const memory = await checkpointed(host, id, epoch).catch(() => undefined)
    if (epoch !== generation) return
    if (memory && !isHeld) applyMemory(memory)
    // A later read tells this instance's own changes apart from this state.
    lastMerge ??= mergeOf([])
    lineage ??= { writer: await writerOf(host), seq: 0, parents: [] }
  }

  function mergeOf(held: readonly Submission[]): Merged {
    return { submissions: held, memory: JSON.stringify(memoryOf()), mode, currentTurnId, lastRecord, local: {} }
  }

  /**
   * Merges the held session into this instance. The first merge takes the
   * memory and mode and puts the held prompts before this instance's own. A
   * later one, after a missed takeover, takes each part only while this
   * instance has not changed it: a turn completed, a mode set or a turn
   * started here is newer than the held value, at this merge and every later
   * one. A kept part keeps the baseline it changed from.
   */
  function mergeHeld(held: HeldSession): void {
    const last = lastMerge
    const local = { ...last?.local }
    if (last) {
      if (JSON.stringify(memoryOf()) !== last.memory) local.memory = true
      if (mode !== last.mode) local.mode = true
      if (currentTurnId !== last.currentTurnId) local.currentTurnId = true
      if (lastRecord !== last.lastRecord) local.lastRecord = true
    } else {
      // Set here before the first merge: this instance's own.
      if (currentTurnId !== undefined) local.currentTurnId = true
      if (lastRecord !== undefined) local.lastRecord = true
    }

    if (!local.memory) applyMemory(held.memory)
    if (!local.mode && (MODES as readonly (string | undefined)[]).includes(held.mode)) mode = held.mode as Mode
    if (!local.currentTurnId && held.currentTurnId !== undefined) currentTurnId = held.currentTurnId
    if (!local.lastRecord && held.lastRecord !== undefined) lastRecord = held.lastRecord
    // Prompts this instance saw, including any submitted while the read was
    // on the way, are newer than the held ones.
    const merged = mergedSubmissionsOf(last?.submissions ?? [], held.submissions, submissions)
    submissions = merged.submissions
    const now = mergeOf(merged.held)
    lastMerge = {
      ...now,
      ...(last && local.memory ? { memory: last.memory } : {}),
      ...(last && local.mode ? { mode: last.mode } : {}),
      ...(last && local.currentTurnId ? { currentTurnId: last.currentTurnId } : {}),
      ...(last && local.lastRecord ? { lastRecord: last.lastRecord } : {}),
      local,
    }
  }

  /**
   * Goes on with a takeover whose write missed, from a hook later than the
   * miss. Every read of one dispatch returns one moment, so a read below the
   * version the miss reported is that moment again: it writes nothing. A read
   * at or above it is merged (see `mergeHeld`) and written at its own
   * version. The takeover ends when anyone but the instance it takes over
   * from wrote the memory (another reload, or an owner it cannot name), and
   * after too many misses.
   */
  function retake(host: Host): Promise<void> {
    const held = heldMemory
    const id = sessionId
    if (held.missed === undefined || held.isLost || held.isUnavailable || id === undefined) return Promise.resolve()
    if (retaking) return retaking
    const epoch = generation

    const attempt = (async () => {
      const read = await host.heldMemory(id).catch(() => undefined)
      if (epoch !== generation || heldMemory !== held || held.missed === undefined) return
      if (!read) {
        held.isUnavailable = true
        matchStarted()
        saveSkipped(host)
        return
      }
      if (read.version < held.missed) return
      const value = heldSessionOf(read.value, id)
      const writer = value?.checkpoint?.writer
      if (!value || writer === undefined || writer !== takingOverFrom) {
        // No later merge comes: turns that waited are matched to what this instance has.
        held.isLost = true
        matchStarted()
        return
      }
      mergeHeld(value)
      // The earlier instance's prompts are here: turns that started meanwhile are matched to them.
      matchStarted()
      // Before its first save this instance goes on from the earlier instance's latest.
      if (lineage && lineage.seq === 0 && value.checkpoint) {
        lineage.parents = saveOf(value.checkpoint)
        if (value.checkpoint.diverged) lineage.diverged = true
      }
      takeovers += 1
      held.resume(read.version)
      await held.hold((snapshot, ifVersion) => host.holdMemory(id, snapshot, ifVersion))
      if (epoch !== generation) return
      // Given up, not taken by another owner: this instance holds nothing but keeps its own saves.
      if (held.missed !== undefined && takeovers >= MAX_TAKEOVERS) held.isUnavailable = true
      saveSkipped(host)
    })().catch(() => undefined)

    retaking = attempt
    void attempt.then(() => {
      if (retaking === attempt) retaking = undefined
    })

    return attempt
  }

  /**
   * Makes the save a pending takeover skipped, once the takeover held the
   * memory or ended without another owner taking it. The save names the
   * earlier instance's last merged save as its parent: if that instance saves
   * too, a resume finds two branches and restores nothing.
   */
  function saveSkipped(host: Host): void {
    const held = heldMemory
    if (!isSaveSkipped || held.isLost || !(held.isEstablished || held.isUnavailable)) return
    isSaveSkipped = false
    void remember(host)
  }

  /** A name for this instance's checkpoint file, unique to it. */
  async function writerOf(host: Host): Promise<string> {
    return `${(await host.now()).toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  }

  /**
   * The task memory saved for this conversation: a conversation a resume
   * returned to. Restored only when its saves form one line in this project;
   * branched saves restore nothing, and the first turn keeps the session's
   * effort (see `resumedFrom`).
   */
  async function checkpointed(host: Host, id: string, epoch: number): Promise<SavedMemory | undefined> {
    const dir = expandHome(config.logDir, await host.home())
    // A log directory not created yet holds no checkpoint; listing it would log an engine error.
    const names = await host.exists(dir) ? (await host.fileNames(dir)).filter(name => isCheckpointName(name, id)) : []
    const files = await Promise.all(names.map(async name => ({ name, text: (await host.readText(`${dir}/${name}`).catch(() => undefined)) ?? '' })))
    const root = await host.root()
    const current = await projectOf(root, { exists: path => host.exists(path), stat: path => host.stat(path), read: path => host.readText(path) })
    const resumed = resumedFrom(files, id, current)
    const writer = await writerOf(host)
    if (epoch !== generation) return undefined
    lineage = { writer, seq: 0, parents: resumed.parents, ...(resumed.diverged ? { diverged: true as const } : {}) }

    return resumed.memory
  }

  /**
   * Hands the task memory on: to the next instance after a reload, and to a
   * later resume as the checkpoint. Only the instance that owns the memory
   * saves it; the one before a reload has lost it.
   */
  function remember(host: Host): Promise<void> {
    const id = sessionId
    const memory = memoryOf()
    const own = lineage
    const held = heldMemory

    saving = saving.then(async () => {
      await holdMemory(host)
      // Another owner took the memory over: its saves go on, never this instance's.
      if (id === undefined || own === undefined || held.isLost) return
      // Still taking the memory over: the save waits for the outcome (see `saveSkipped`).
      if (held.missed !== undefined && !held.isUnavailable) {
        if (held === heldMemory) isSaveSkipped = true
        return
      }
      // Only this instance writes its file, so no save of another process or instance is replaced.
      const path = checkpointPathOf(expandHome(config.logDir, await host.home()), id, own.writer)
      const checkpoint = checkpointOf(id, memory, own, await host.now())
      if (!checkpoint || !path) return
      await host.writeText(path, JSON.stringify(checkpoint))
      own.seq = checkpoint.seq
      await held.hold((value, ifVersion) => host.holdMemory(id, value, ifVersion))
    }).catch(() => undefined)

    return saving
  }

  /** Holds a running turn for the instance after a reload. */
  function holdTurn(host: Host, turn: Turn): void {
    const id = sessionId
    if (id === undefined || turns.get(turn.turnId) !== turn) return
    let held = heldTurns.get(turn.turnId)
    if (!held) {
      held = heldTurnFor(turn)
      heldTurns.set(turn.turnId, held)
    }
    void held.hold((value, ifVersion) => host.holdTurn(turn.turnId, value, ifVersion))
  }

  function heldTurnFor(turn: Turn, version = 0): Held<HeldTurn> {
    const epoch = generation
    const id = sessionId

    return new Held(() => {
      if (epoch !== generation || id === undefined) return undefined
      // A completed turn leaves only a mark, so its data does not stay in the session.
      if (!turns.has(turn.turnId)) return { schema: SCHEMA, sessionId: id, done: true }
      return turns.get(turn.turnId) === turn ? { schema: SCHEMA, sessionId: id, turn: plainOf(turn) } : undefined
    }, version)
  }

  /** Marks a completed turn in the session, so no later instance adopts it. */
  function releaseTurn(host: Host, turnId: string): void {
    const held = heldTurns.get(turnId)
    heldTurns.delete(turnId)
    if (held) void held.hold((value, ifVersion) => host.holdTurn(turnId, value, ifVersion))
  }

  /**
   * The running turn the instance before a reload started, taken over from the
   * session; undefined when nothing holds it.
   */
  function adopt(host: Host, turnId: string): Promise<Turn | undefined> {
    const known = turns.get(turnId)
    if (known) return Promise.resolve(known)
    const epoch = generation
    let adoption = adopting.get(turnId)

    if (!adoption) {
      adoption = (async () => {
        await bind(host)
        const read = await host.heldTurn(turnId).catch(() => undefined)
        if (epoch !== generation || sessionId === undefined) return undefined
        if (turns.has(turnId)) return turns.get(turnId)
        const held = read ? heldTurnOf(read.value, sessionId, turnId) : undefined
        if (!read || !held) return undefined
        const turn = turnOf(turnId)
        Object.assign(turn, held)
        heldTurns.set(turnId, heldTurnFor(turn, read.version))
        // Taking the turn over makes the earlier instance's later writes miss.
        holdTurn(host, turn)
        if (turn.isSettled || turn.steps.length === 0) {
          turn.decided = turn.isSettled ? Promise.resolve() : undefined
        } else {
          // The earlier instance's decision never landed: decide here.
          void startDecision(host, turn)
        }
        return turn
      })().finally(() => adopting.delete(turnId))
      adopting.set(turnId, adoption)
    }

    return adoption
  }

  /**
   * Matches a starting turn to the prompt that started it and to earlier
   * prompts queued with it, and takes them out of the pending ones.
   */
  function matchSubmission(turn: Turn, text: string): void {
    // The newest match: a batch starts one turn, so earlier entries can remain.
    let index = submissions.findLastIndex(s => s.text === text)
    const entering = submissions.filter(s => s.entering)
    // Hooks below prompt.submit may rewrite text before turn.start runs.
    if (index < 0 && entering.length === 1) index = submissions.indexOf(entering[0]!)
    const matched = index >= 0 ? submissions[index] : undefined
    // Earlier prompts queued over the same turn and not delivered into it may
    // have entered this turn with the matched one; the first request settles
    // which did, and none can enter a later turn.
    const earlier = matched?.over === undefined ? [] : submissions.slice(0, index).filter(s => s.over === matched.over)
    if (matched && earlier.length > 0) turn.queued = [...earlier, matched]
    submissions = submissions.filter(s => s !== matched && !earlier.includes(s))
    // Origin is authoritative when the preceding submission is available.
    // A reload between the two hooks can leave only the notification envelope.
    turn.taskNotification = matched ? matched.origin === NOTIFICATION : isTaskNotification(text)
    if (matched) turn.startedBy = { origin: matched.origin, ...(matched.over !== undefined ? { over: matched.over } : {}) }
  }

  /** Matches the turns that started before the held prompts were merged, in the order they started. */
  function matchStarted(): void {
    for (const { turn, text } of started.splice(0)) {
      if (turns.get(turn.turnId) === turn) matchSubmission(turn, text)
    }
    for (const turn of turns.values()) {
      if (turn.takeoverPending) joinLate(turn, turn.text)
    }
  }

  /** A takeover of the held memory missed and waits for its next read: the earlier instance may still add prompts. */
  function isTakingOver(): boolean {
    return heldMemory.missed !== undefined && !heldMemory.isLost && !heldMemory.isUnavailable
  }

  /**
   * Task memory can be stale: a takeover write missed and no later read was
   * merged at or above that version, whether the takeover still waits, the
   * host refused it or it ran out of attempts. The last two stay so for the
   * rest of the conversation: decisions can raise effort, never lower it
   * below the session's.
   */
  function isMemoryStale(): boolean {
    return heldMemory.missed !== undefined
  }

  /**
   * A turn decided while the takeover was pending was matched without the
   * prompts the earlier instance took meanwhile. Once they are merged, the
   * turn's own prompt is matched, and the prompts queued with it leave the
   * pending ones: the queue they waited in started this turn, so none can
   * enter a later one. Only a prompt the turn's first request showed entered
   * it joins its task and can raise it. Without that proof a queued prompt can
   * only keep effort up; it never becomes remembered task.
   */
  function joinLate(turn: Turn, text: string): void {
    delete turn.takeoverPending
    const unclaimed = turn.unclaimed
    delete turn.unclaimed
    if (!turn.startedBy) {
      const index = submissions.findLastIndex(s => s.text === text)
      if (index < 0) return
      const [own] = submissions.splice(index, 1)
      turn.taskNotification = own!.origin === NOTIFICATION
      turn.startedBy = { origin: own!.origin, ...(own!.over !== undefined ? { over: own!.over } : {}) }
    }
    const over = turn.startedBy.over
    const late = over === undefined ? [] : submissions.filter(s => s.over === over)
    if (late.length === 0) return
    submissions = submissions.filter(s => !late.includes(s))
    const joined = unclaimed ? late.filter(s => claim(unclaimed, s.text)) : []
    const top = (unclaimed ? joined : late).reduce<Level | undefined>((a, s) => (s.level && (!a || rankOf(s.level) > rankOf(a)) ? s.level : a), undefined)
    const chosen = levelOf(turn) ?? (isLevel(turn.stepZeroEffort) ? turn.stepZeroEffort : undefined)
    const raised = top !== undefined && chosen !== undefined && rankOf(top) > rankOf(chosen)
    if (raised) turn.raisedTo = top
    if (joined.length > 0) {
      const task = batchTaskOf([...joined, { text: turn.text, origin: turn.taskNotification ? NOTIFICATION : turn.startedBy.origin }])
      turn.text = task.request
      turn.taskNotification = task.notification
    }
    if (joined.length > 0 || raised) {
      turn.batch = {
        count: (turn.batch?.count ?? 1) + joined.length, confirmed: unclaimed !== undefined,
        ...(raised ? { floor: top } : turn.batch?.floor ? { floor: turn.batch.floor } : {}),
      }
    }
  }

  /** Decides the turn's level, and holds the turn once it is decided. */
  function startDecision(host: Host, turn: Turn): Promise<void> {
    turn.decided = prepare(host)
      .then(() => decide(host, turn))
      .catch(error => {
        turn.reason = `fallback: ${messageOf(error)}`
      })
      .finally(() => {
        turn.isSettled = true
        holdTurn(host, turn)
      })

    return turn.decided
  }

  /**
   * Forgets the previous conversation: `/clear` and an in-process `/resume`
   * go on under another session id in the same process, and its turns must not
   * inherit the old one's exchanges, levels or log. A reload starts here too,
   * and restores what the instance before it held.
   */
  function resetSession(): void {
    generation += 1
    sessionId = undefined
    binding = undefined
    isRestored = false
    isMerged = false
    started = []
    lineage = undefined
    loggedBaseline = undefined
    heldMemory = memoryHolder()
    takeovers = 0
    retaking = undefined
    lastMerge = undefined
    isSaveSkipped = false
    takingOverFrom = undefined
    heldTurns.clear()
    adopting.clear()
    turns.clear()
    memory = EMPTY_MEMORY
    submissions = []
    lastLevel = undefined
    repository = undefined
    projectRoot = undefined
    project = undefined
    cache.reset()
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

    return Promise.all([ready, bind(host), openLog(host), spinnerIdOf(host)]).then(() => undefined)
  }

  async function spinnerIdOf(host: Host): Promise<void> {
    const epoch = generation
    const id = (await host.sessionId().catch(() => undefined))?.replace(/\.jsonl$/, '')

    if (epoch === generation) mainSpinnerId ??= id
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
    // The turn's own decision has no answer yet, even where a later check
    // replaced the fallback reason (budget spent, deferred by the hook budget).
    const unanswered = unansweredOf(turn)
    const failure = unanswered ?? (turn.reason?.startsWith('fallback') ? turn.reason.replace(/^fallback:?\s*/, '') || 'failed' : undefined)
    let note: string | undefined

    if (turn.manual) {
      note = 'set by hand'
    } else if (last.yielded) {
      note = undefined
    } else if (mode === 'enforce' && failure !== undefined && turn.raisedTo && last.sent === turn.raisedTo) {
      note = 'raised by your message'
    } else if (failure !== undefined) {
      // Said in every mode: a classifier that gave no answer is worth the
      // note even in shadow, where nothing was rewritten. The failure is this
      // turn's assessment; `retrying` says the classifier has answered since.
      const retrying = classifierOk && unanswered !== undefined
      note = `router: ${failure}${retrying ? ', retrying' : ''}`
    } else if (mode === 'shadow') {
      const would = level ? raisedBy(level, escalationOf(turn.errors), config.ceiling) : undefined

      note = would && would !== last.sent ? `router: ${would}` : undefined
    } else if (level && last.would && rankOf(last.would) > rankOf(level)) {
      note = 'raised after failed tool calls'
    } else if (turn.raisedTo && turn.base && rankOf(turn.raisedTo) > rankOf(turn.base) && isLevel(last.sent) && rankOf(last.sent) >= rankOf(turn.raisedTo)) {
      // A prompt that has not reached a request yet raised nothing that went out.
      note = 'raised by your message'
    } else if (turn.reason === 'cue') {
      note = 'you asked to think hard'
    } else if (turn.reason === 'insufficient context') {
      note = 'router: needs context'
    } else if (turn.reason === 'work in progress') {
      note = 'kept for active work'
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
  async function verdictOf(host: Host, inputs: readonly ClassifyInput[], seen?: Effort): Promise<Verdict> {
    const cue = cueFloorOf(inputs[0]?.request ?? '')

    // Without a key the router is not set up and changes nothing. A paused or
    // failing classifier still honors a deep-reasoning phrase: those are the
    // person's own words.
    if (!key) {
      return { cue, reason: `fallback: ${keyProblem}` }
    }

    if (breaker.isOpen(await host.now())) {
      return { level: cue, cue, reason: cue ? 'cue' : 'fallback: classifier paused', failed: 'paused' }
    }

    const epoch = generation
    const requestNo = ++asked
    const result = await classifyAll(host, classifier, key, inputs)
    const isOk = isClassified(result)
    const isCurrent = requestNo > (isOk ? newestFailed : newestAnswered)

    // An earlier conversation cannot change this one's health or breaker.
    if (epoch !== generation) {
      return { level: cue, cue, reason: 'fallback: conversation changed', failed: 'request' }
    }

    if (isCurrent) {
      breaker.record(isOk, await host.now())

      if (isOk) {
        newestAnswered = Math.max(newestAnswered, requestNo)
      } else {
        newestFailed = Math.max(newestFailed, requestNo)
      }
    }

    if (!isClassified(result)) {
      if (isCurrent) {
        health = `failing (${result.failure})`
        classifierOk = false

        if (breaker.isOpen(await host.now())) {
          sayOnce(
            host,
            'paused',
            `classifier failing (${result.failure}); turns keep the session's effort for 5 minutes. /effort-router status has details.`,
          )
        }
      }

      return {
        level: cue,
        cue,
        reason: cue ? 'cue' : `fallback: ${result.failure}`,
        latencyMs: result.latencyMs,
        failed: 'request',
      }
    }

    if (isCurrent) {
      health = `ok (${result.latencyMs} ms)`
      classifierOk = true
      // A later outage in this session is announced again.
      said.delete('paused')
    }

    const routed = routeOf(result, inputs[0]!, isLevel(seen) ? seen : isLevel(baseline) ? baseline : config.ceiling,
      config.threshold, config.floor, config.ceiling)

    return {
      ...routed,
      cue,
      probabilities: result.probabilities,
      workProbabilities: result.workProbabilities,
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
  function inputsOf(text: string, context?: TaskContext, continuesTask?: boolean): ClassifyInput[] {
    return inputVariants(inputOf(memory, text, context, continuesTask), config.ensemble)
  }

  /**
   * Sets `turn.base` and `turn.reason` for the turn's typed prompt, or carries
   * the previous pick over to a turn that started without one.
   */
  async function decide(host: Host, turn: Turn): Promise<void> {
    // A missed takeover goes on with one bounded read before this decision
    // reads the memory. The read runs inside the decision, which shadow mode
    // does not wait for, so it never holds a shadow request.
    if (isTakingOver()) await Promise.race([retake(host), host.sleep(BATCH_READ_MS)])
    if (turns.get(turn.turnId) !== turn) return
    // Memory still unresolved: no decision may lower effort on it.
    const stale = isMemoryStale()
    if (stale) turn.memoryHeld = lastLevel ? { lastLevel } : {}
    // A turn that started while a missed takeover waited for its next read:
    // the earlier instance may have taken this turn's prompts after the first
    // read. Without that read, it is matched to what is here and held.
    const deferred = started.find(s => s.turn === turn)
    let unresolved = false
    let entered: Promise<string[] | undefined> | undefined
    if (deferred) {
      started = started.filter(s => s !== deferred)
      matchSubmission(turn, deferred.text)
      if (isTakingOver()) {
        unresolved = true
        // What entered this turn, read once: for its batch now, and as the
        // only proof a prompt merged later entered it.
        entered = promptRowsOf(host)
      }
    }
    const members = turn.queued ? await joinBatch(host, turn, entered) : []
    if (deferred && unresolved && turns.get(turn.turnId) === turn) {
      turn.unclaimed = unclaimedOf(await entered, [deferred.text, ...members.map(m => m.text)])
      turn.takeoverPending = true
      // A merge that landed meanwhile has brought the earlier instance's prompts.
      if (!isTakingOver()) joinLate(turn, turn.text)
    }
    const floor = members.length > 0 ? floorOf(host, members).catch(() => undefined) : undefined
    const cwd = await host.cwd().catch(() => repository?.cwd ?? '')
    const root = await host.root().catch(() => projectRoot ?? cwd)
    const current = root === projectRoot && project !== undefined ? project
      : await projectOf(root, { exists: path => host.exists(path), stat: path => host.stat(path), read: path => host.readText(path) })
    if (turns.get(turn.turnId) !== turn) return
    // A shell `cd` refreshes the summary only; entering or leaving a worktree keeps the project.
    // Moving to another project starts fresh task memory.
    if (project !== undefined && current !== project) { memory = EMPTY_MEMORY; lastLevel = undefined }
    projectRoot = root
    project = current
    if (!repository || repository.cwd !== cwd) {
      const collected = cwd ? await repositoryOf(cwd, async path => await host.exists(path) ? host.readText(path) : undefined) : { cwd, summary: '' }
      if (turns.get(turn.turnId) !== turn) return
      repository = collected
    }
    turn.context = boundedContext({ repository, observations: turn.context?.observations ?? [], ...(memory.previousTask ? { previousTask: memory.previousTask } : {}) })
    if (turn.text.trim() === '') {
      turn.base = lastLevel
      turn.reason = lastLevel ? 'inherit' : 'fallback: no previous pick'
      // A level inherited from memory that can be stale keeps at least the session's effort.
      const kept = stale && !turn.manual && isLevel(turn.stepZeroEffort) ? clamp(turn.stepZeroEffort, config.floor, config.ceiling) : undefined
      if (kept && (!turn.base || rankOf(turn.base) < rankOf(kept))) {
        turn.base = kept
        turn.reason = 'held: memory takeover pending'
      }

      return
    }

    const verdict = await verdictOf(host, inputsOf(turn.text, turn.context), heldEffortOf(turn))

    turn.base = verdict.level
    turn.reason = verdict.reason
    turn.cue = verdict.cue
    turn.probabilities = verdict.probabilities
    turn.workProbabilities = verdict.workProbabilities
    turn.workLevel = verdict.workLevel
    turn.evidenceFloor = verdict.evidenceFloor
    turn.confidence = verdict.confidence
    turn.latencyMs = verdict.latencyMs
    turn.contextSufficient = verdict.contextSufficient
    turn.contextHeld = verdict.contextHeld
    turn.assessedFloor = verdict.contextSufficient === true ? verdict.level : undefined
    turn.missing = verdict.missing
    turn.continuation = verdict.continuation
    // The saves of a resumed conversation branched, so its memory was not restored:
    // until a typed turn completes, turns keep at least the session's effort.
    // Likewise while a takeover of the held memory is pending: it can be stale.
    const holding = lineage?.diverged ? 'held: resumed memory diverged' : unresolved || stale ? 'held: memory takeover pending' : undefined
    const held = holding && !turn.manual && isLevel(turn.stepZeroEffort) ? clamp(turn.stepZeroEffort, config.floor, config.ceiling) : undefined
    if (held) {
      if (!turn.base || rankOf(turn.base) < rankOf(held)) {
        turn.base = held
        turn.reason = holding!
      }
      turn.assessedFloor = turn.assessedFloor ? higherOf(turn.assessedFloor, held) : held
    }
    if (verdict.failed && verdict.level === undefined) {
      turn.recoverAt = await recoverAtOf(host, verdict, turn)
      turn.failure = failureOf(verdict)
    }
    // A batch does the work of every prompt in it: an earlier prompt's own verdict can raise the turn, never lower it.
    const top = await floor
    const chosen = levelOf(turn) ?? (isLevel(turn.stepZeroEffort) ? turn.stepZeroEffort : undefined)
    if (top && chosen && rankOf(top) > rankOf(chosen) && turn.batch && turns.get(turn.turnId) === turn) {
      turn.raisedTo = top
      turn.batch.floor = top
    }
  }

  function failureOf(verdict: Verdict): string {
    return verdict.reason.replace(/^fallback:?\s*/, '') || 'failed'
  }

  /**
   * Prompts queued over one turn enter the next together as separate user
   * messages, while `turn.start` carries only the last. The engine names no
   * submission, so the user messages after the transcript's last answer say
   * which queued candidates entered; when the transcript cannot say, every
   * candidate counts, which can only raise effort. Returns the earlier
   * prompts that entered.
   */
  async function joinBatch(host: Host, turn: Turn, read = promptRowsOf(host)): Promise<Submission[]> {
    const own = turn.queued!.at(-1)!
    const earlier = turn.queued!.slice(0, -1)
    turn.queued = undefined
    const rows = await read
    const confirmed = enteredOf(earlier, rows, turn.text)
    const members = confirmed ?? earlier
    if (members.length === 0) return []
    const task = batchTaskOf([...members, { text: turn.text, origin: own.origin }])
    turn.text = task.request
    turn.taskNotification = task.notification
    turn.batch = { count: members.length + 1, confirmed: confirmed !== undefined }

    return members
  }

  /** The user messages after the transcript's last answer, oldest first; undefined when not read in time. */
  function promptRowsOf(host: Host): Promise<string[] | undefined> {
    return Promise.race([
      host.promptsSinceAnswer().catch(() => undefined),
      host.sleep(BATCH_READ_MS).then(() => undefined),
    ])
  }

  /** The highest mid-turn verdict among a batch's earlier prompts, waiting at most the classifier timeout. */
  async function floorOf(host: Host, members: readonly Submission[]): Promise<Level | undefined> {
    const levels = await Promise.race([
      Promise.all(members.map(m => verdicts.get(m) ?? m.level)),
      host.sleep(config.timeoutMs).then(() => members.map(m => m.level)),
    ])

    return levels.reduce<Level | undefined>((top, level) => (level && (!top || rankOf(level) > rankOf(top)) ? level : top), undefined)
  }

  /** A paused check sent nothing, so its retry waits only for the breaker. */
  async function recoverAtOf(host: Host, verdict: Verdict, turn: Turn): Promise<number> {
    return (await host.now()) + (verdict.failed === 'paused' ? 0 : Math.min(RECOVERY_MS * 2 ** turn.recoveries, MAX_RECOVERY_MS))
  }

  function retainForUnassessedEvidence(turn: Turn, reason: string): void {
    if (turn.manual || !turn.context) return
    // Later, unassessed source must not silently keep an earlier low pick.
    const retained = isLevel(turn.stepZeroEffort) ? turn.stepZeroEffort : config.ceiling
    const current = levelOf(turn)
    // A failed decision holds nothing a later answer may release; only missing context does.
    const held = turn.contextHeld === true || (current !== undefined && rankOf(retained) > rankOf(current))
    turn.base = higherOf(current ?? retained, retained)
    const previous = turn.continuation ? turn.context.previousTask : undefined
    if (needsConcurrencyReasoning(`${turn.text}\n${previous?.request ?? ''}`, [...turn.context.observations, ...(previous?.observations ?? [])])) {
      turn.evidenceFloor = clamp('high', config.floor, config.ceiling)
      turn.base = higherOf(turn.base, turn.evidenceFloor)
    }
    turn.reason = reason
    turn.contextSufficient = false
    turn.contextHeld = held && (!turn.evidenceFloor || rankOf(retained) > rankOf(turn.evidenceFloor))
    turn.missing = ['unassessed_evidence']
  }

  async function discover(host: Host, turn: Turn): Promise<void> {
    if (!turn.text.trim() || !turn.context || turn.manual) return
    const version = turn.evidenceVersion
    if (turn.recoverAt === undefined && version === turn.checkedVersion) return
    // A decision without an answer is retried on a model request, never on elapsed time alone.
    const isRecovery = isRecoveryDue(turn, await host.now())
    if (!isRecovery && version === turn.checkedVersion) return
    if (!isRecovery && turn.discovery.filter(d => !d.recovery).length >= 2) {
      turn.checkedVersion = version
      retainForUnassessedEvidence(turn, 'discovery budget exhausted')
      return
    }
    if (isRecovery) turn.recoveries += 1
    const undecided = turn.recoverAt !== undefined
    const context = boundedContext(turn.context)
    const verdict: Verdict = { ...await verdictOf(host, inputsOf(turn.text, context, turn.continuation), turn.stepZeroEffort), ...(isRecovery ? { recovery: true as const } : {}) }
    if (turns.get(turn.turnId) !== turn) return
    if (verdict.failed) {
      if (undecided) {
        turn.recoverAt = await recoverAtOf(host, verdict, turn)
        turn.failure = failureOf(verdict)
      }
    } else {
      turn.recoverAt = undefined
      turn.failure = undefined
    }
    if (verdict.level === undefined) {
      retainForUnassessedEvidence(turn, `fallback: discovery ${verdict.reason.replace(/^fallback:\s*/, '')}`)
      // A paused check sent nothing: it neither spends the budget nor settles the evidence.
      if (verdict.failed !== 'paused') {
        turn.checkedVersion = version
        turn.discovery.push(verdict)
      }
      refresh(host)
      return
    }
    turn.checkedVersion = version
    const current = levelOf(turn) ?? (isLevel(turn.stepZeroEffort) ? turn.stepZeroEffort : undefined)
    if (verdict.contextSufficient === true) turn.assessedFloor = higherOf(turn.assessedFloor ?? verdict.level, verdict.level)
    const canLower = turn.contextHeld === true && verdict.contextSufficient === true && !turn.hasActed
    const applied = !current || canLower || rankOf(verdict.level) > rankOf(current)
    const contextHeld = verdict.contextHeld === true && (applied || turn.contextHeld === true)
    // A released hold returns to the turn's earlier sufficient-context decision, never below it.
    const floored = applied && turn.assessedFloor !== undefined && rankOf(turn.assessedFloor) > rankOf(verdict.level)
    if (applied) {
      turn.base = floored ? turn.assessedFloor : verdict.level
    } else {
      turn.base ??= isLevel(turn.stepZeroEffort) ? turn.stepZeroEffort : undefined
    }
    // The assessment is current even when work already started at higher effort.
    const retainedDecision = floored || (!applied && !contextHeld && (verdict.contextHeld === true || (current !== undefined && rankOf(current) > rankOf(verdict.level))))
    turn.reason = retainedDecision ? (turn.hasActed ? 'work in progress' : 'retained effort') : verdict.reason
    turn.probabilities = verdict.probabilities
    turn.workProbabilities = verdict.workProbabilities
    turn.workLevel = verdict.workLevel
    turn.evidenceFloor = verdict.evidenceFloor
    turn.confidence = verdict.confidence
    turn.latencyMs = verdict.latencyMs
    turn.contextSufficient = verdict.contextSufficient
    turn.contextHeld = contextHeld
    turn.missing = verdict.missing
    turn.continuation = verdict.continuation
    // The log counts how often the earlier sufficient decision stopped a lowering.
    turn.discovery.push(floored ? { ...verdict, assessedFloor: turn.assessedFloor } : verdict)
    refresh(host)
  }

  /** Whether the turn's unanswered decision may retry on this request. */
  function isRecoveryDue(turn: Turn, now: number): boolean {
    return turn.recoverAt !== undefined && now >= turn.recoverAt && !breaker.isOpen(now)
  }

  /**
   * Classifies a message typed while the turn runs. It can raise the rest of
   * the turn above the level it has, never lower it.
   */
  async function reconsider(host: Host, turn: Turn, text: string): Promise<Level | undefined> {
    await turn.decided
    if (turns.get(turn.turnId) !== turn) return undefined

    const verdict = await verdictOf(host, [{ request: text, previousRequest: turn.text,
      context: { ...turn.context, observations: turn.context?.observations ?? [], previousTask: {
        request: turn.text, level: levelOf(turn), observations: turn.context?.observations ?? [],
      } } }], heldEffortOf(turn))
    // A prompt that waited for the turn to end keeps its verdict for the batch it enters.
    if (turns.get(turn.turnId) !== turn) return verdict.level
    // A successful message assessment permits a retry of the unanswered task on its next request.
    const retries = !verdict.failed && turn.recoverAt !== undefined && !turn.manual
    if (retries) turn.recoverAt = Math.min(turn.recoverAt!, await host.now())
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
      // The round trip: in enforce mode the next request waits on it, spending that request's hook budget.
      ...(verdict.latencyMs !== undefined ? { latency_ms: verdict.latencyMs } : {}),
      raised: isRaised,
    })

    if (isRaised || retries) {
      refresh(host)
    }

    return verdict.level
  }

  /**
   * The level a later turn without a typed prompt inherits from this one: only
   * a level the router chose. A typed turn without an answer passes on the
   * session effort the router kept for it, or a higher earlier pick, even when a
   * failed discovery set that kept effort as the turn's level. A turn set
   * by hand keeps no level of its own and drops an earlier pick below the usual
   * level. Neither a level set by hand nor another source's effort (a yielded
   * request) is inherited.
   */
  function inheritedOf(turn: Turn): Level | undefined {
    const routed = turn.steps.at(-1)?.would ?? levelOf(turn)

    // A turn whose own decision never got an answer ran at a kept fallback, such as the
    // effort that a failed discovery retained: it can raise an earlier level, never replace it.
    if (routed && unansweredOf(turn) !== undefined) {
      return lastLevel ? higherOf(lastLevel, routed) : routed
    }

    if (routed || turn.text.trim() === '') {
      return routed ?? lastLevel
    }

    if (!turn.manual) {
      const kept = turn.stepZeroEffort

      return isLevel(kept) ? (lastLevel ? higherOf(lastLevel, kept) : kept) : lastLevel
    }

    return lastLevel && isLevel(baseline) && rankOf(lastLevel) < rankOf(baseline) ? undefined : lastLevel
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
        evidenceVersion: 0,
        checkedVersion: 0,
        hasActed: false,
        discovery: [],
        recoveries: 0,
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

  // `/clear` and an in-process `/resume` end the conversation here and go on
  // under another session id without a `session.start`: nothing of this one
  // may reach the next. Its memory is already saved at each turn's end.
  on('session.end', async ($, e, next) => {
    resetSession()

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    const turn = turnOf(e.turnId)
    turn.text = e.text
    if (isMerged && !isTakingOver()) {
      matchSubmission(turn, e.text)
    } else {
      // After a reload the held prompts are still on the way, also while a
      // missed takeover waits for its next read. The envelope stands in until
      // they are merged, before the turn's first decision.
      turn.taskNotification = isTaskNotification(e.text)
      started.push({ turn, text: e.text })
    }
    currentTurnId = e.turnId
    const host = hostOf($)
    holdTurn(host, turn)
    void holdMemory(host)

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined || !isActive()) {
      // An untracked main request breaks the chain of consecutive requests.
      if (e.agentId === undefined) cache.gap()
      return yield* next(e)
    }

    const host = hostOf($)
    // A takeover of the memory that missed goes on here, without holding the request.
    void retake(host)
    // A reload can hand a running turn to this instance between its requests.
    const known = turns.get(e.turnId)
    const turn = known ?? await adopt(host, e.turnId) ?? turnOf(e.turnId)
    const isFirst = turn.steps.length === 0
    if (!known) currentTurnId = e.turnId

    if (isFirst) {
      // A conversation that changed without `session.end` starts over here,
      // before this turn is decided with the old one's memory.
      const id = await host.sessionId().then(id => id.replace(/\.jsonl$/, ''), () => undefined)
      if (sessionId !== undefined && id !== undefined && id !== sessionId) {
        resetSession()
        turns.set(turn.turnId, turn)
        currentTurnId = turn.turnId
      }

      turn.stepZeroEffort = e.effort

      await prepare(host).catch(() => undefined)

      const usual = await baselineOf(host, e.model, e.effort).catch(() => e.effort)
      void holdMemory(host)

      if (e.effort !== undefined && (e.effort === 'max' || e.effort !== usual)) {
        turn.manual = true
      }

      void startDecision(host, turn)
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
        void turn.decided?.then(() => {
          const level = levelOf(turn)

          // Requests that went out before the pick landed get it in the log.
          for (const step of turn.steps) {
            if (level && !step.would) {
              step.would = raisedBy(level, escalationOf(turn.errors), config.ceiling)
            }
          }

          holdTurn(host, turn)
          refresh(host)
        })
      }
    } else if (mode === 'enforce' && !turn.isSettled) {
      // A turn taken over before its decision landed waits for its own.
      await turn.decided
    }

    // A message typed mid-turn may still be in classification; enforce mode
    // lets it land so the raise reaches this request.
    if (!isFirst && mode === 'enforce' && turn.reconsidered) {
      await Promise.race([turn.reconsidered, host.sleep(config.timeoutMs)])
    }

    let deferred: StepRecord['deferred']
    if (!isFirst && turn.isSettled) {
      const neededMs = config.timeoutMs + SETTLE_MARGIN_MS
      const remainingMs = next.budget.remainingMs
      const canWait = mode !== 'enforce' || remainingMs > neededMs
      // Logged so production logs show how often the budget, not the classifier, skipped a check.
      if (!canWait && !turn.discovering && !turn.manual && turn.text.trim() !== '' && turn.context) {
        const evidence = turn.evidenceVersion !== turn.checkedVersion
        const retry = isRecoveryDue(turn, await host.now())
        if (evidence || retry) {
          deferred = { remainingMs: Math.round(remainingMs), neededMs, ...(evidence ? { evidence: true as const } : {}), ...(retry ? { retry: true as const } : {}) }
        }
      }
      if (!canWait && turn.evidenceVersion !== turn.checkedVersion) {
        retainForUnassessedEvidence(turn, 'discovery deferred: hook budget')
      } else if (!turn.discovering && canWait) {
        turn.discovering = discover(host, turn).catch(() => undefined).finally(() => { turn.discovering = undefined; holdTurn(host, turn) })
      }
      if (mode === 'enforce' && canWait) await turn.discovering
    }

    const isYielded = !isFirst && e.effort !== turn.stepZeroEffort
    const level = levelOf(turn)
    const would = level ? raisedBy(level, escalationOf(turn.errors), config.ceiling) : undefined
    const sent = mode === 'enforce' && would && !isYielded && !turn.manual ? would : e.effort

    const stepRecord: StepRecord = {
      index: e.index,
      seen: e.effort,
      sent,
      ...(would ? { would } : {}),
      ...(isYielded ? { yielded: true as const } : {}),
      ...(deferred ? { deferred } : {}),
    }
    turn.steps.push(stepRecord)
    if (mode === 'shadow' && turn.discovering) {
      const escalations = escalationOf(turn.errors)
      void turn.discovering.then(() => {
        if (turns.get(turn.turnId) !== turn) return
        const predicted = levelOf(turn)
        if (predicted) stepRecord.would = raisedBy(predicted, escalations, config.ceiling)
        holdTurn(host, turn)
      })
    }
    holdTurn(host, turn)

    if (isFirst || sent !== turn.steps[turn.steps.length - 2]?.sent) {
      refresh(host)
    }

    const started = await host.now()
    const result = yield* next(sent === e.effort ? e : { ...e, effort: sent })
    stepRecord.durationMs = Math.max(0, (await host.now()) - started)

    if (result?.usage) {
      stepRecord.usage = { input: result.usage.input_tokens, output: result.usage.output_tokens,
        cacheRead: result.usage.cache_read_input_tokens, cacheWrite: result.usage.cache_creation_input_tokens }
      turn.usage.input += result.usage.input_tokens
      turn.usage.output += result.usage.output_tokens
      turn.usage.cacheRead += result.usage.cache_read_input_tokens
      turn.usage.cacheWrite += result.usage.cache_creation_input_tokens
    }
    holdTurn(host, turn)

    // After the response, so the request never waits on the diagnostic. A
    // request without usage is skipped, as Claude Code's own ledger skips it.
    if (stepRecord.usage) {
      Object.assign(stepRecord, cache.record({
        conversation: await host.sessionId().catch(() => undefined),
        model: result?.usage?.model ?? e.model,
        effort: sent,
        usage: stepRecord.usage,
        at: await host.now(),
      }))
    }

    return result
  })

  on('prompt.submit', async ($, e, next) => {
    // A prompt typed over a running turn, with or without wait, can enter that
    // turn or start its own after it, so every submission is kept. Only an
    // idle submission starts its turn inside `next`.
    const submitted: Submission = { text: e.text, origin: e.origin.kind, entering: e.turnId === undefined, ...(e.turnId === undefined ? {} : { over: e.turnId }) }
    submissions = [...submissions, submitted].slice(-32)
    let result
    try {
      result = await next(e)
    } catch (error) {
      submissions = submissions.filter(s => s !== submitted)
      throw error
    }
    if (result.drop !== undefined) submissions = submissions.filter(s => s !== submitted)
    else { submitted.text = result.text; submitted.entering = false }
    void holdMemory(hostOf($))
    const turn = e.turnId === undefined ? undefined : turns.get(e.turnId) ?? await adopt(hostOf($), e.turnId)

    // `wait` changes nothing about delivery: the engine queues every prompt
    // typed mid-turn and delivers it at the running turn's next tool result.
    const isMidTurnTyped =
      turn !== undefined &&
      TYPED_ORIGINS.includes(e.origin.kind) &&
      e.text.trim() !== ''

    if (isActive() && isMidTurnTyped) {
      const host = hostOf($)

      // Raises only ever go up, so order does not matter: each message is
      // classified at once, and the step waits for all of them together.
      // A prompt that enters the next turn instead keeps its verdict there.
      const verdict = reconsider(host, turn, e.text).catch(() => undefined)
      verdicts.set(submitted, verdict)
      const reconsidering = verdict.then(level => {
        if (level) submitted.level = level
        holdTurn(host, turn)
        return holdMemory(host)
      })

      turn.reconsidered = turn.reconsidered
        ? Promise.all([turn.reconsidered, reconsidering]).then(() => undefined)
        : reconsidering
    }

    return result
  })

  // The engine delivers a prompt queued over the running turn into it as a
  // `queued_command` attachment, which names no submission: the whole prompt
  // inside a known frame matches the entry, which then belongs to this turn
  // and cannot enter a later one. Only the engine's own delivery counts. The attachment arrives after the request's effort was
  // chosen, so it records the delivery; the raise came from the verdict.
  on('prompt.attachment', { type: 'queued_command' }, async ($, e, next) => {
    const host = hostOf($)
    if (e.agentId === undefined && isActive()) {
      await bind(host)
      if (currentTurnId !== undefined) await adopt(host, currentTurnId)
    }
    const index = e.agentId === undefined && e.origin.kind === 'engine' ? deliveredIndexOf(submissions, e.text, currentTurnId) : -1

    if (index >= 0) {
      const [delivered] = submissions.splice(index, 1)
      const turn = currentTurnId ? turns.get(currentTurnId) : undefined

      if (turn) {
        (turn.delivered ??= []).push({ text: delivered!.text, origin: delivered!.origin })
        holdTurn(host, turn)
      }
      await holdMemory(host)
    }

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    // After a reload the running turn may still be held by the instance before.
    if (e.agentId === undefined && (currentTurnId === undefined || !turns.has(currentTurnId)) && isActive()) {
      const host = hostOf($)
      await bind(host)
      if (currentTurnId !== undefined) await adopt(host, currentTurnId)
    }
    // The turn the call ran in, taken before it finishes: a tool that settles
    // after its turn ended must not count toward the next turn.
    const turn = e.agentId === undefined && currentTurnId ? turns.get(currentTurnId) : undefined
    const result = await next(e)

    const toolResult = result as { isError?: boolean; text?: string; deny?: string; isReadOnly?: boolean } | undefined
    const isFailed = toolResult?.isError === true || typeof toolResult?.deny === 'string'

    if (turn && turns.get(turn.turnId) === turn) {
      if (toolResult?.isError === true) turn.errors += 1
      if (!toolResult?.deny && !['Read', 'Grep', 'Glob'].includes(e.tool) && toolResult?.isReadOnly !== true) turn.hasActed = true
      const observation = observationOf(e.tool, e as unknown as Record<string, unknown>, toolResult?.text ?? '', isFailed)
      if (observation && turn.context) {
        const updated = addObservation(turn.context.observations, observation)
        if (JSON.stringify(updated) !== JSON.stringify(turn.context.observations)) {
          turn.context.observations = updated
          if (observation.tool !== 'Glob') turn.evidenceVersion += 1
        }
      }
      holdTurn(hostOf($), turn)
    }

    return result
  })

  on('turn.complete', async ($, e, next) => {
    const epoch = generation
    // A reload can hand the turn to this instance for its completion alone.
    if (e.agentId === undefined && !turns.has(e.turnId) && isActive()) await adopt(hostOf($), e.turnId)
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
    // A takeover of the memory that missed goes on before this completion changes the memory.
    await retake(host)

    if (turn && turn.steps.length > 0) {
      const pending = [turn.decided, turn.reconsidered, turn.discovering].filter(Boolean)

      if (pending.length > 0) {
        await Promise.race([Promise.all(pending), host.sleep(Math.min(config.timeoutMs + SETTLE_MARGIN_MS, SETTLE_MAX_MS))])
      }
      if (turns.get(turn.turnId) !== turn) return result

      lastRecord = {
        type: 'turn',
        ts: new Date(await host.now()).toISOString(),
        turnId: turn.turnId,
        mode,
        prompt_len: turn.text.length,
        prompt_head: turn.text.slice(0, 200),
        probabilities: turn.probabilities,
        work_probabilities: turn.workProbabilities,
        work_level: turn.workLevel,
        evidence_floor: turn.evidenceFloor,
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
        context_sufficient: turn.contextSufficient,
        context_held: turn.contextHeld,
        assessed_floor: turn.assessedFloor,
        task_notification: turn.taskNotification,
        ...(turn.batch ? { batch: turn.batch } : {}),
        ...(turn.delivered ? { delivered: turn.delivered.map(d => ({ origin: d.origin, text_head: d.text.slice(0, 200) })) } : {}),
        missing_context: turn.missing,
        continuation: turn.continuation,
        discovery: turn.discovery,
        evidence: turn.context?.observations.map(o => ({ tool: o.tool, target: o.target, chars: o.text.length })),
        outcome: {
          reason: e.reason,
          duration_ms: e.durationMs,
          usage: turn.usage,
        },
      }

      await log?.append(lastRecord)
      // The conversation changed meanwhile: nothing of this turn reaches the next one.
      if (epoch !== generation) return result

      // Background completions get their own decision, but cannot replace the user's task.
      // Their reply is what the user sees last, so it becomes the previous answer only.
      if (turn.taskNotification) memory = afterNotification(memory, e.answer)
      else {
        if (turn.text.trim() !== '' && lineage?.diverged) delete lineage.diverged
        let inherited = inheritedOf(turn)
        // A turn decided on memory that could be stale never lowers the level a merge brought in meanwhile.
        if (turn.memoryHeld && inherited && lastLevel && lastLevel !== turn.memoryHeld.lastLevel) inherited = higherOf(inherited, lastLevel)
        lastLevel = inherited ? clamp(inherited, config.floor, config.ceiling) : undefined
        memory = afterTask(memory, { request: taskMemoryOf(turn.text, turn.delivered ?? []), answer: e.answer, level: lastLevel,
          continuation: continuationOf(turn.continuation, turn.text),
          continued: turn.context?.previousTask, observations: turn.context?.observations ?? [],
          turn: { toolErrors: turn.errors, requests: turn.steps.length, interrupted: e.isAborted } })
      }
    }

    turns.delete(e.turnId)
    releaseTurn(host, e.turnId)
    if (turn && turn.steps.length > 0) await remember(host)

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

    const pausedMs = breaker.pausedForMs(await host.now())
    const running = currentTurnId ? turns.get(currentTurnId) : undefined
    const failure = running ? unansweredOf(running) : undefined
    const unanswered = running && failure !== undefined
      ? `turn: no classifier answer yet (${failure}); retries on a later request`
      : undefined
    const last = lastRecord
      ? `last: would ${String(lastRecord.would_pick)} · sent ${String(lastRecord.sent)} · ${String(lastRecord.reason)}`
      : 'last: none yet'
    const cacheLine = cache.line()

    return {
      text: [
        `mode ${mode}; range ${config.floor}-${config.ceiling}; threshold ${config.threshold}; ensemble ${config.ensemble ? 'on' : 'off'}`,
        `classifier: ${classifier.url} (${classifier.model}); ${health}${pausedMs > 0 ? `; paused ${Math.ceil(pausedMs / 1000)} s more` : ''}`,
        `key: ${keyProblem ? `${keyProblem}${keyDetail ? ` (${keyDetail})` : ''}` : 'loaded'}`,
        ...(unanswered ? [unanswered] : []),
        last,
        ...(cacheLine ? [cacheLine] : []),
        `log: ${log?.path ?? 'none'}`,
        `memory: ${lineage?.diverged ? 'not restored: saved histories are inconsistent or unreadable; the next turn keeps the session effort' : lineage && lineage.seq > 0 ? 'saved for resume' : 'not saved yet'}`,
      ].join('\n'),
    }
  })
}
