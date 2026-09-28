/**
 * What the router keeps of a conversation between plugin instances and
 * processes. Each store matches one lifecycle the host guarantees:
 *
 * - `$.state` holds values for the running conversation. They survive a hot
 *   reload of the plugin's code, and the host drops them when the
 *   conversation changes (`/clear`, `/resume`) or the process ends. A
 *   reloaded instance adopts the running turn and the task memory from there.
 * - Checkpoint files beside the decision log keep the task memory of a
 *   conversation that a later `/resume` or `claude --resume` returns to. They
 *   hold bounded, redacted excerpts of typed requests and answers, and no
 *   tool output. Each plugin instance writes only its own file and names the
 *   save it went on from, so no process overwrites another's; a resume
 *   restores memory only when the saves form one line, however many there
 *   are, and otherwise starts without memory and keeps the session's effort
 *   for its first turn.
 *
 * Values of another schema, session or project are ignored, never migrated.
 */
import type {
  EffortRouterLineage,
  EffortRouterMemory,
  EffortRouterSession,
  EffortRouterSubmission,
  EffortRouterTurn,
} from '../types/effort-router'
import { excerpt } from './context'
import { isLevel } from './policy'

export const SCHEMA = 1

/**
 * Task memory (the history, latest answer, last turn and previous task that
 * later typed prompts are classified with) and what a later instance or
 * process needs to go on with it: the inherited level, project and baseline.
 */
export type Memory = EffortRouterMemory
export type Lineage = EffortRouterLineage
export type Submission = EffortRouterSubmission
/** The conversation's state an instance holds in `$.state` for the next instance after a reload. */
export type HeldSession = EffortRouterSession
/** One running turn's state, or a mark that the turn completed. */
export type HeldTurn = EffortRouterTurn

/** The task memory saved for a conversation a later resume returns to. */
export type Checkpoint = {
  schema: 1
  sessionId: string
  project: string
  /** The plugin instance that saved it; only that instance writes its file. */
  writer: string
  /** How many times the writer saved, this save included. */
  seq: number
  /** The saves this one went on from. */
  parents: string[]
  savedAt: number
  memory: Memory
}

/** A record's data without its in-flight promises: what one plugin instance can hand another. */
export type Plain<T> = { [K in keyof T as NonNullable<T[K]> extends PromiseLike<unknown> ? never : K]: T[K] }

export function plainOf<T extends object>(value: T): Plain<T> {
  return JSON.parse(JSON.stringify(value, (_key, item: unknown) => (item instanceof Promise ? undefined : item))) as Plain<T>
}

export type HoldResult = { isSet: boolean; version: number }

/**
 * One `$.state` value this instance writes with compare-and-set. Writes run
 * one at a time, and each writes the newest snapshot, so a burst of changes
 * costs one write.
 *
 * A write that misses means another instance of the plugin wrote the value
 * since this one read or wrote it. By default (`lose`) this one then stops
 * writing it for good: a running turn another instance took over or wrote
 * again is that instance's. With `wait`, for a value this instance is taking
 * over, a miss before any write landed means the earlier instance wrote after
 * the read: nothing is written until a read of a later moment has been merged
 * and `resume` names its version. Once a write landed, a miss loses it for
 * good there too.
 */
export class Held<T> {
  private chain: Promise<void> = Promise.resolve()
  private isDirty = false
  /** Another instance wrote the value after this one held it: never written again. */
  isLost = false
  /** The host refused or lacks the call, or a takeover gave up: nothing is held, and no other owner is known. */
  isUnavailable = false
  /** A write of this holder landed: it holds the value. */
  isEstablished = false
  /**
   * Taking over, the version the host reported when a write missed: the
   * lowest version a read that can go on must have. Undefined otherwise.
   */
  missed: number | undefined

  constructor(
    private readonly snapshot: () => T | undefined,
    public version = 0,
    private readonly firstMiss: 'lose' | 'wait' = 'lose',
  ) {}

  hold(write: (value: T, ifVersion: number) => Promise<HoldResult>): Promise<void> {
    this.isDirty = true
    this.chain = this.chain.then(async () => {
      if (!this.isDirty || this.isLost || this.isUnavailable || this.missed !== undefined) return
      this.isDirty = false
      const value = this.snapshot()
      if (value === undefined) return
      const result = await write(value, this.version)
      if (result.isSet) {
        this.version = result.version
        this.isEstablished = true
      } else if (this.isEstablished || this.firstMiss === 'lose') {
        this.isLost = true
      } else {
        // The snapshot is not written at the reported version: it lacks what was written there.
        this.missed = result.version
        this.isDirty = true
      }
    }).catch(() => {
      this.isUnavailable = true
    })

    return this.chain
  }

  /** Goes on taking over after merging a read at `version`, at least `missed`: the next write goes out at it. */
  resume(version: number): void {
    if (this.missed === undefined || version < this.missed) return
    this.version = version
    this.missed = undefined
  }
}

/** Two submissions of the same prompt: same text and origin, over the same turn. */
function sameSubmission(a: Submission, b: Submission): boolean {
  return a.text === b.text && a.origin === b.origin && a.over === b.over
}

/**
 * Pending prompts after the held ones are read again. `base` holds the
 * objects that stand for the held prompts the last read merged, `theirs` the
 * prompts held now, `ours` this instance's list. A held prompt the earlier
 * instance added since arrives; one it matched to a turn since leaves; one
 * this instance matched stays matched; this instance's own prompts stay.
 * `held` is the base for the next read.
 */
export function mergedSubmissionsOf(
  base: readonly Submission[], theirs: readonly Submission[], ours: readonly Submission[],
): { submissions: Submission[]; held: Submission[] } {
  const added = [...theirs]
  const paired = new Map<Submission, Submission>()

  for (const known of base) {
    const index = added.findIndex(held => sameSubmission(held, known))
    if (index >= 0) paired.set(known, added.splice(index, 1)[0]!)
  }

  const kept = ours.filter(s => !base.includes(s) || paired.has(s))
  // Their later fields (whether it entered a turn, its level) are the earlier instance's to set.
  for (const s of kept) if (paired.has(s)) Object.assign(s, paired.get(s))

  return {
    submissions: [...kept.filter(s => base.includes(s)), ...added, ...kept.filter(s => !base.includes(s))].slice(-32),
    held: [...base.filter(s => paired.has(s)), ...added],
  }
}

const NAME = /^[\w-]+$/

/** The file one writer saves a conversation's checkpoints to. */
export function checkpointPathOf(dir: string, sessionId: string, writer: string): string | undefined {
  return NAME.test(sessionId) && NAME.test(writer) ? `${dir.replace(/\/$/, '')}/${sessionId}.memory.${writer}.json` : undefined
}

/** Whether `name` is a checkpoint file of the conversation `sessionId`. */
export function isCheckpointName(name: string, sessionId: string): boolean {
  return name.startsWith(`${sessionId}.memory.`) && name.endsWith('.json')
}

const MAX_HISTORY = 3

/** Memory as a checkpoint carries it: bounded, redacted text, and no tool output. */
function savedMemoryOf(memory: Memory): Memory {
  const task = memory.previousTask

  return {
    history: memory.history.slice(-MAX_HISTORY).map(h => ({
      request: excerpt(h.request, 4000),
      ...(h.answer !== undefined ? { answer: excerpt(h.answer, 1000) } : {}),
    })),
    ...(memory.lastTurn ? { lastTurn: {
      toolErrors: memory.lastTurn.toolErrors, requests: memory.lastTurn.requests, interrupted: memory.lastTurn.interrupted,
    } } : {}),
    ...(memory.lastLevel ? { lastLevel: memory.lastLevel } : {}),
    ...(task ? { previousTask: {
      request: excerpt(task.request, 1500),
      ...(task.answer !== undefined ? { answer: excerpt(task.answer, 1200) } : {}),
      ...(task.level !== undefined ? { level: task.level } : {}),
      observations: [],
    } } : {}),
    ...(memory.latestAnswer !== undefined ? { latestAnswer: excerpt(memory.latestAnswer, 1000) } : {}),
    ...(memory.project !== undefined ? { project: memory.project } : {}),
    ...(memory.projectRoot !== undefined ? { projectRoot: memory.projectRoot } : {}),
    ...(memory.baseline !== undefined ? { baseline: memory.baseline } : {}),
  }
}

/** The next save of `lineage`'s writer; undefined until a turn resolved the project the memory belongs to. */
export function checkpointOf(sessionId: string, memory: Memory, lineage: Lineage, savedAt: number): Checkpoint | undefined {
  return memory.project === undefined ? undefined : {
    schema: SCHEMA, sessionId, project: memory.project, writer: lineage.writer, seq: lineage.seq + 1, parents: lineage.parents,
    savedAt, memory: savedMemoryOf(memory),
  }
}

/** What an instance's lineage names as the save it went on from. */
export function saveOf(lineage: Lineage): string[] {
  return lineage.seq > 0 ? [`${lineage.writer}#${lineage.seq}`] : lineage.parents
}

/** A fingerprint of a checkpoint file's text, or of its absence. */
export function fingerprintOf(text: string | undefined): string {
  if (text === undefined) return 'absent'
  // Two 32-bit FNV-1a hashes with different offsets, and the length.
  let a = 0x811c9dc5
  let b = 0x050c5d1f

  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    a = Math.imul(a ^ code, 0x01000193) >>> 0
    b = Math.imul(b ^ code, 0x01000193) >>> 0
  }

  return `${text.length}:${a.toString(36)}:${b.toString(36)}`
}

/**
 * At most this many saves a new save names as its parents. Naming fewer can
 * only leave more newest saves for a later resume, which then restores nothing.
 */
const MAX_PARENTS = 64

type Save = { id: string; parents: string[]; text: string; isValid: boolean }

function saveIn(name: string, text: string, sessionId: string): Save {
  try {
    const parsed: unknown = JSON.parse(text)

    if (isObject(parsed) && parsed.schema === SCHEMA && parsed.sessionId === sessionId && typeof parsed.writer === 'string'
      && name === `${sessionId}.memory.${parsed.writer}.json` && Number.isInteger(parsed.seq) && (parsed.seq as number) >= 1
      && Array.isArray(parsed.parents) && parsed.parents.every(p => typeof p === 'string')) {
      return { id: `${parsed.writer}#${parsed.seq as number}`, parents: parsed.parents as string[], text, isValid: true }
    }
  } catch {
    // Unreadable: a save of unknown origin.
  }

  return { id: `file:${name}:${fingerprintOf(text)}`, parents: [], text, isValid: false }
}

/**
 * Why a resume restored nothing: several saves are newest (`branched`), the
 * newest save cannot be read or holds malformed memory (`unreadable`), or the
 * saves do not all lead to the newest one (`unlinked`, as with a cycle).
 */
export type Divergence = 'branched' | 'unreadable' | 'unlinked'

/** What a process starting on a conversation takes from its checkpoint files. */
export type Resumed = {
  memory?: Memory
  /** The saves the new instance goes on from. */
  parents: string[]
  /** No memory was restored for a reason in `reason`, and the first turn keeps the session's effort. */
  diverged: boolean
  reason?: Divergence
}

/**
 * Restores memory from the conversation's checkpoint files only when they form
 * one line: exactly one save is no other save's parent, and every save leads
 * to it through the parents. The number of files proves nothing, because every
 * plugin instance leaves its own and none is removed, so it sets no limit.
 * Branches (two processes went on from one save), a newest save that cannot be
 * read, another schema, and saves outside the line restore nothing. The next
 * save then names the newest saves and those outside every line as its
 * parents, at most `MAX_PARENTS` of them, so a later resume finds one line
 * again. A save that no file holds any more is not evidence either way. The
 * same files always give the same answer, in time linear in the files.
 */
export function resumedFrom(files: readonly { name: string; text: string }[], sessionId: string, project: string): Resumed {
  const saves = files.map(file => saveIn(file.name, file.text, sessionId))

  if (saves.length === 0) {
    return { parents: [], diverged: false }
  }

  const referenced = new Set(saves.flatMap(save => save.parents))
  const leaves = saves.filter(save => !referenced.has(save.id))
  const lined = linedTo(leaves, saves)
  const unlinked = saves.filter(save => !lined.has(save.id))
  const leaf = leaves[0]

  if (leaves.length === 1 && leaf?.isValid && unlinked.length === 0) {
    const memory = memoryOfCheckpoint(leaf.text, sessionId, project)
    // Memory saved in another project is not this task's; a malformed save is not trusted.
    const isOtherProject = memory === undefined && (JSON.parse(leaf.text) as { project?: unknown }).project !== project

    return memory ? { memory, parents: [leaf.id], diverged: false }
      : isOtherProject ? { parents: [leaf.id], diverged: false } : { parents: [leaf.id], diverged: true, reason: 'unreadable' }
  }

  const reason: Divergence = leaves.some(save => !save.isValid) ? 'unreadable' : leaves.length > 1 ? 'branched' : 'unlinked'
  const parents = [...new Set([...leaves, ...unlinked].map(save => save.id))].sort().slice(0, MAX_PARENTS)

  return { parents, diverged: true, reason }
}

/** The saves that lead to one of `newest` through the parents; a parent no file holds is skipped. */
function linedTo(newest: readonly Save[], saves: readonly Save[]): Set<string> {
  const byId = new Map(saves.map(save => [save.id, save]))
  const lined = new Set<string>()
  const next = newest.map(save => save.id)

  while (next.length > 0) {
    const save = byId.get(next.pop()!)
    if (!save || lined.has(save.id)) continue
    lined.add(save.id)
    for (const parent of save.parents) next.push(parent)
  }

  return lined
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const isOptional = (value: unknown, type: 'string' | 'number' | 'boolean') => value === undefined || typeof value === type

function isMemory(value: unknown): value is Memory {
  if (!isObject(value) || !Array.isArray(value.history)) return false
  const { lastTurn, previousTask } = value

  return value.history.every(h => isObject(h) && typeof h.request === 'string' && isOptional(h.answer, 'string'))
    && (lastTurn === undefined || (isObject(lastTurn) && typeof lastTurn.toolErrors === 'number'
      && typeof lastTurn.requests === 'number' && typeof lastTurn.interrupted === 'boolean'))
    && (value.lastLevel === undefined || isLevel(value.lastLevel))
    && (previousTask === undefined || (isObject(previousTask) && typeof previousTask.request === 'string'
      && isOptional(previousTask.answer, 'string') && isOptional(previousTask.level, 'string')))
    && isOptional(value.latestAnswer, 'string') && isOptional(value.project, 'string') && isOptional(value.projectRoot, 'string')
    && (value.baseline === undefined || isLevel(value.baseline) || (typeof value.baseline === 'number' && Number.isFinite(value.baseline)))
}

/**
 * The memory a checkpoint restores for `sessionId` in `project`: undefined for
 * another schema, session or project, or for anything malformed.
 */
export function memoryOfCheckpoint(text: string | undefined, sessionId: string, project: string): Memory | undefined {
  let parsed: unknown

  try {
    parsed = JSON.parse(text ?? '')
  } catch {
    return undefined
  }

  if (!isObject(parsed) || parsed.schema !== SCHEMA || parsed.sessionId !== sessionId || parsed.project !== project
    || typeof parsed.writer !== 'string' || typeof parsed.seq !== 'number' || !Array.isArray(parsed.parents)
    || typeof parsed.savedAt !== 'number' || !isMemory(parsed.memory) || parsed.memory.project !== project) {
    return undefined
  }

  return savedMemoryOf(parsed.memory)
}

/** Held memory of this schema and session, else undefined. */
export function heldSessionOf(value: unknown, sessionId: string): HeldSession | undefined {
  const lineage = isObject(value) ? value.checkpoint : undefined

  return isObject(value) && value.schema === SCHEMA && value.sessionId === sessionId && isMemory(value.memory)
    && Array.isArray(value.submissions)
    && value.submissions.every(s => isObject(s) && typeof s.text === 'string' && typeof s.origin === 'string' && typeof s.entering === 'boolean')
    && (lineage === undefined || (isObject(lineage) && typeof lineage.writer === 'string' && typeof lineage.seq === 'number'
      && Array.isArray(lineage.parents) && lineage.parents.every(p => typeof p === 'string')))
    ? value as HeldSession : undefined
}

/** A held running turn of this schema and session, else undefined (also once it completed). */
export function heldTurnOf(value: unknown, sessionId: string, turnId: string): Record<string, unknown> | undefined {
  const turn = isObject(value) && value.schema === SCHEMA && value.sessionId === sessionId && value.done !== true ? value.turn : undefined

  return isObject(turn) && turn.turnId === turnId && typeof turn.text === 'string' && Array.isArray(turn.steps) ? turn : undefined
}
