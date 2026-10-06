import type { Args, On } from 'claude-code'
import { type MockClock, mock } from 'claude-code/testing'

// The native test runner supplies this timer; plugin types exclude DOM globals.
declare function setTimeout(callback: () => void, milliseconds: number): unknown

export const HOME = '/Users/t'
export const LOG_FILE = `${HOME}/.local/state/effort-router/the-session.jsonl`

export function logFileOf(sessionId: string): string {
  return `${HOME}/.local/state/effort-router/${sessionId}.jsonl`
}

export type Probabilities = Readonly<Record<string, number>>

export type WorldOptions = {
  /**
   * What the classifier answers, in order; the last repeats. A number is an
   * HTTP status without a body; `'hang'` never answers; `{ after, answer }`
   * answers once the mock clock has moved `after` milliseconds.
   */
  answers?: readonly (Probabilities | number | 'hang' | { after: number; answer: Probabilities })[]
  /**
   * An answer chosen by the request the classifier reads, ahead of `answers`.
   */
  answerOf?: (request: string) => Probabilities | undefined
  /**
   * The environment besides HOME; by default `TYPESAFE_API_KEY` is set.
   */
  env?: Readonly<Record<string, string>>
  /**
   * Files that exist before the session starts, by absolute path. The text
   * `<directory>` makes the path a directory, which a read rejects.
   */
  files?: Readonly<Record<string, string>>
  /**
   * Where a symbolic link lands, by the link's path; `fs.stat` follows it.
   */
  links?: Readonly<Record<string, string>>
  /**
   * Effort levels saved per model under `modelSettings`; none when absent.
   */
  saved?: Readonly<Record<string, string>>
  contexts?: readonly ('sufficient' | 'missing_target' | 'missing_scope' | 'missing_evidence')[]
  /** The probability each context answer gives its choice, in step with `contexts`; 1 when absent. */
  contextProbabilities?: readonly number[]
  relations?: readonly ('new' | 'continuation')[]
  /** Real delays let the native hook budget exercise its deadline. */
  wallDelays?: Readonly<Record<number, number>>
  /**
   * The input-token usage each model request reports, in order; the last
   * repeats. By default every request reads 100 cached tokens and writes 5.
   */
  usages?: readonly { input: number; cacheRead: number; cacheWrite: number }[]
}

export type World = {
  clock: MockClock
  posts: Args<'http.fetch'>[]
  sent: (string | number | undefined)[]
  /**
   * The lines the router said in the transcript.
   */
  said: string[]
  /**
   * The text of each spinner or closing line the router let through, as the
   * engine would draw it.
   */
  drawn: string[]
  /**
   * The environment variables read, in order: each session's re-read of the
   * setup shows here.
   */
  envReads: string[]
  files: Map<string, string>
  /**
   * Every path a read rejected because it is a directory, as the engine logs it.
   */
  directoryReads: string[]
  /**
   * A session's decision records across its log files: each plugin instance
   * writes `<session>.<writer>.jsonl`, and an earlier version's single
   * `<session>.jsonl` comes first.
   */
  records: (sessionId?: string) => Record<string, unknown>[]
  /**
   * The id `$.session.id` answers; set it to start another session.
   */
  session: { id: string }
  /**
   * What `$.session.cwd` and `$.session.root` answer; a shell `cd` moves only `cwd`.
   */
  location: { cwd: string; root: string }
  /**
   * What `$.session.messages` answers, oldest first; `null` makes the read fail.
   */
  transcript: { rows: { role: 'user' | 'assistant'; text: string }[] | null }
  /**
   * The values held in the session (`$.state`), kept per conversation as the
   * host keeps them: `session.end` drops them, and after the session id
   * changes nothing of the last one is read. Versions count up across all
   * values, as the host's do. `write` stands in for another instance of the
   * plugin; `clear` for a new process.
   */
  state: {
    read: (key: string, id: string) => { value: unknown; version: number }
    write: (key: string, id: string, value: unknown) => number
    clear: () => void
    writes: number
    /** Delays the memory read to reproduce a prompt arriving during restore. */
    gate?: Promise<void>
    /**
     * The host reads one moment per dispatch. `freeze` fixes the moment every
     * read returns until `thaw`, as for the reads of one dispatch; a write
     * always meets the current version, and a missed one reports it.
     */
    freeze: () => void
    thaw: () => void
    /** Runs after each memory read while set: another instance writing between a read and a write. */
    afterRead?: () => void
    /** While set, the host refuses every read and write of the memory. */
    refuse?: boolean
    /** Each conditional write of the memory: the version it was given and whether it landed. */
    memorySets: { ifVersion: number | undefined; isSet: boolean }[]
  }
}

/**
 * Answers, beneath the router, everything it reads of a session: the
 * environment, the session id, the command registry, the transcript, the
 * spinner and closing lines, the classifier and the model requests. Keeps
 * what the router did.
 */
export function world(on: On, options: WorldOptions = {}): World {
  const clock = mock.clock(on)
  const posts: Args<'http.fetch'>[] = []
  const sent: (string | number | undefined)[] = []
  const said: string[] = []
  const drawn: string[] = []
  const envReads: string[] = []
  const files = new Map<string, string>(Object.entries(options.files ?? {}))
  const directoryReads: string[] = []
  // A path through a link: the link's target, then the rest of the path.
  const realOf = (path: string): string => {
    for (const [link, target] of Object.entries(options.links ?? {})) {
      if (path === link || path.startsWith(`${link}/`)) return realOf(target + path.slice(link.length))
    }
    return path
  }
  const answers = options.answers ?? [{ low: 0.98, medium: 0.02, high: 0, xhigh: 0 }]

  // Answers the environment and records each lookup. One handler per event,
  // so this fixture answers `env.get` itself instead of using `mock.env`.
  const environment: Record<string, string | undefined> = {
    HOME,
    ...(options.env ?? { TYPESAFE_API_KEY: 'k' }),
  }

  on('env.get', ($, e) => {
    envReads.push(e.name)

    return { value: environment[e.name] }
  })

  on('session.start', ($, e) => ({ cwd: e.cwd }))
  const session = { id: 'the-session' }

  const held = new Map<string, { value: unknown; version: number }>()
  let frozen: Map<string, { value: unknown; version: number }> | undefined
  let versions = 0
  const slotOf = (key: string, id: string | undefined) => JSON.stringify([session.id, key, id ?? ''])
  const state: World['state'] = {
    read: (key, id) => held.get(slotOf(key, id)) ?? { value: undefined, version: 0 },
    write: (key, id, value) => {
      versions += 1
      held.set(slotOf(key, id), { value: JSON.parse(JSON.stringify(value)), version: versions })

      return versions
    },
    clear: () => held.clear(),
    writes: 0,
    freeze: () => {
      frozen = new Map(held)
    },
    thaw: () => {
      frozen = undefined
    },
    memorySets: [],
  }

  on('session.end', ($, e) => {
    held.clear()

    return { sessionId: e.sessionId }
  })

  on('state.get', async ($, e) => {
    if (e.key === 'memory' && state.gate) await state.gate
    if (e.key === 'memory' && state.refuse) return { deny: 'state refused' }
    const { value, version } = frozen
      ? frozen.get(slotOf(e.key, e.id as string)) ?? { value: undefined, version: 0 }
      : state.read(e.key, e.id as string)

    if (e.key === 'memory') state.afterRead?.()

    return { value: { value: value as never, version } }
  })
  on('state.set', ($, e) => {
    if (e.key === 'memory' && state.refuse) return { deny: 'state refused' }
    const current = state.read(e.key, e.id as string).version

    if (e.ifVersion !== undefined && e.ifVersion !== current) {
      if (e.key === 'memory') state.memorySets.push({ ifVersion: e.ifVersion, isSet: false })
      return { value: { isSet: false as const, version: current } }
    }

    state.writes += 1
    if (e.key === 'memory') state.memorySets.push({ ifVersion: e.ifVersion, isSet: true })

    return { value: { isSet: true as const, version: state.write(e.key, e.id as string, e.value) } }
  })

  on('session.id', () => ({ value: session.id }))
  const location = { cwd: '/work', root: '/work' }
  on('session.cwd', () => ({ value: location.cwd }))
  on('session.root', () => ({ value: location.root }))
  const transcript: World['transcript'] = { rows: [] }
  on('session.messages', () => {
    if (transcript.rows === null) throw new Error('transcript unavailable')
    return { value: transcript.rows.map(row => ({ ...row, toolUses: [] })) }
  })
  on('settings.read', () => ({
    value: {
      modelSettings: Object.fromEntries(
        Object.entries(options.saved ?? {}).map(([model, effortLevel]) => [model, { effortLevel }]),
      ),
    },
  }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.log', ($, e) => {
    said.push(e.text)

    return { value: undefined }
  })
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.render', ($, e) => {
    const props = e.props as { word?: string; suffix?: string }
    const text = e.component === 'Spinner' ? `${props.word}${props.suffix}` : `${props.word}`

    drawn.push(text)

    return { type: 'Text', children: [text] }
  })

  on('fs.read', ($, e) => {
    const text = files.get(realOf(e.path))

    if (text === '<directory>') {
      directoryReads.push(e.path)

      return { deny: `EISDIR: ${e.path}` }
    }

    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text }
  })

  on('fs.exists', ($, e) => ({ value: files.has(realOf(e.path)) || [...files.keys()].some(path => path.startsWith(`${realOf(e.path).replace(/\/$/, '')}/`)) }))

  on('fs.stat', ($, e) => {
    const real = realOf(e.path)
    const text = files.get(real)
    const isDir = text === '<directory>' || [...files.keys()].some(path => path.startsWith(`${real}/`))

    if (text === undefined && !isDir) return { deny: `ENOENT: ${e.path}` }

    return { value: { kind: isDir ? 'dir' : 'file', size: text?.length ?? 0, mtimeMs: 0, isLink: real !== e.path,
      ...(e.resolve ? { realPath: real } : {}) } }
  })
  on('fs.list', ($, e) => {
    const dir = `${(e.path ?? '').replace(/\/$/, '')}/`
    const names = [...files.keys()].filter(path => path.startsWith(dir) && !path.slice(dir.length).includes('/')).map(path => path.slice(dir.length))

    return { value: names.sort().map(name => ({ name, kind: 'file' as const, size: files.get(`${dir}${name}`)!.length, isLink: false })) }
  })

  on('fs.write', ($, e) => {
    files.set(e.path, e.text)

    return { value: undefined }
  })

  on('http.fetch', async ($, e) => {
    posts.push(e)
    const wall = options.wallDelays?.[posts.length]
    if (wall) await new Promise<void>(resolve => setTimeout(resolve, wall))

    const request = String((JSON.parse(String(e.init?.body ?? '{}')) as { state?: { request?: unknown } }).state?.request ?? '')
    const answer = options.answerOf?.(request) ?? answers[Math.min(posts.length, answers.length) - 1]

    if (answer === 'hang') {
      return new Promise(() => undefined)
    }

    if (typeof answer === 'number') {
      return { value: { status: answer, ok: false, headers: {}, text: '' } }
    }

    let probabilities = answer as Probabilities

    if (answer && 'after' in answer && typeof answer.after === 'number') {
      await clock.sleep(answer.after)
      probabilities = answer.answer as Probabilities
    }

    const context = options.contexts?.[Math.min(posts.length, options.contexts.length) - 1] ?? 'sufficient'
    const relation = options.relations?.[Math.min(posts.length, options.relations.length) - 1] ?? 'new'
    const contextProbability = options.contextProbabilities?.[Math.min(posts.length, options.contextProbabilities.length) - 1] ?? 1
    const text = JSON.stringify({
      model: 'jev-1.13.0',
      answers: {
        effort: { type: 'choice', choice: 'low', probabilities, confidence: 0.5 },
        context: { type: 'choice', choice: context, probabilities: { [context]: contextProbability } },
        relation: { type: 'choice', choice: relation, probabilities: { [relation]: 1 } },
        work: { type: 'choice', choice: 'mechanical', probabilities: { mechanical: 1 } },
      },
    })

    return { value: { status: 200, ok: true, headers: {}, text } }
  })

  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))

  on('turn.step', async function* ($, e) {
    sent.push(e.effort)
    const usage = options.usages?.[Math.min(sent.length, options.usages.length) - 1]

    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn',
      usage: {
        model: e.model,
        input_tokens: usage?.input ?? 1,
        output_tokens: 10,
        cache_read_input_tokens: usage?.cacheRead ?? 100,
        cache_creation_input_tokens: usage?.cacheWrite ?? 5,
      },
    }
  })

  // A session's records: its first log and that log's parts, then the logs of later instances.
  const records = (sessionId = 'the-session') => {
    const first = logFileOf(sessionId)
    const prefix = first.replace(/\.jsonl$/, '.')
    // An earlier version's single log and its numbered parts first, then each
    // instance's own logs in the order they were created.
    const rank = (path: string) => path === first ? 0 : /^\d+\.jsonl$/.test(path.slice(prefix.length)) ? Number(path.slice(prefix.length).split('.')[0]) : Infinity

    return [...files.keys()]
      .filter(path => path === first || (path.startsWith(prefix) && path.endsWith('.jsonl')))
      .sort((a, b) => rank(a) === rank(b) ? 0 : rank(a) - rank(b))
      .flatMap(path => files.get(path)!.split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>))
  }

  return { clock, posts, sent, said, drawn, envReads, files, directoryReads, records, session, location, transcript, state }
}
