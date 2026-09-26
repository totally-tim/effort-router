import type { Args, On } from 'claude-code'
import { type MockClock, mock } from 'claude-code/testing'

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
   * The environment besides HOME; by default `TYPESAFE_API_KEY` is set.
   */
  env?: Readonly<Record<string, string>>
  /**
   * Files that exist before the session starts, by absolute path.
   */
  files?: Readonly<Record<string, string>>
  /**
   * Effort levels saved per model under `modelSettings`; none when absent.
   */
  saved?: Readonly<Record<string, string>>
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
  records: (sessionId?: string) => Record<string, unknown>[]
  /**
   * The id `$.session.id` answers; set it to start another session.
   */
  session: { id: string }
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

  on('session.id', () => ({ value: session.id }))
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
    const text = files.get(e.path)

    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text }
  })

  on('fs.exists', ($, e) => ({ value: files.has(e.path) }))

  on('fs.write', ($, e) => {
    files.set(e.path, e.text)

    return { value: undefined }
  })

  on('http.fetch', async ($, e) => {
    posts.push(e)

    const answer = answers[Math.min(posts.length, answers.length) - 1]

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

    const text = JSON.stringify({
      model: 'jev-1.13.0',
      answers: { effort: { type: 'choice', choice: 'low', probabilities, confidence: 0.5 } },
    })

    return { value: { status: 200, ok: true, headers: {}, text } }
  })

  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))

  on('turn.step', async function* ($, e) {
    sent.push(e.effort)

    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn',
      usage: {
        model: e.model,
        input_tokens: 1,
        output_tokens: 10,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 5,
      },
    }
  })

  const records = (sessionId = 'the-session') =>
    (files.get(logFileOf(sessionId)) ?? '')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as Record<string, unknown>)

  return { clock, posts, sent, said, drawn, envReads, files, records, session }
}
