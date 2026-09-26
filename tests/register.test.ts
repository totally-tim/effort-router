import type { Engine } from 'claude-code/testing'
import { describe, expect, test, tier } from 'claude-code/testing'

import { configOf, keyIn } from '../hooks/register'
import { HOME, LOG_FILE, world } from './fixtures/world'

tier('user')

const STARTED = { cwd: '/work', surface: 'terminal', isInteractive: true } as const

async function step(
  $: Engine,
  turnId: string,
  index: number,
  effort: string,
  agentId?: string,
): Promise<void> {
  const stream = $.turn.step({
    turnId,
    index,
    model: 'claude-opus-5-5',
    effort: effort as 'xhigh',
    messageCount: 1 + index,
    ...(agentId ? { agentId } : {}),
  })

  for await (const chunk of stream) {
    void chunk
  }

  await stream.result
}

async function complete($: Engine, turnId: string): Promise<void> {
  await $.turn.complete({
    turnId,
    answer: 'done',
    durationMs: 10,
    isAborted: false,
    reason: 'answer',
  })
}

/**
 * Draws the main loop's spinner, or a turn's closing line, and returns the
 * text the router let through.
 */
async function spinner($: Engine, drawn: string[], requestId = 'the-session'): Promise<string | undefined> {
  await $.ui.render({
    surface: 'terminal',
    component: 'Spinner',
    requestId,
    props: { word: 'Baking', message: null, suffix: '…', mode: 'thinking' },
  } as never)

  return drawn.at(-1)
}

async function closing($: Engine, drawn: string[], requestId: string): Promise<string | undefined> {
  await $.ui.render({
    surface: 'terminal',
    component: 'TurnDuration',
    requestId,
    props: { word: 'Baked', durationMs: 3000 },
  } as never)

  return drawn.at(-1)
}

async function command($: Engine, args: string): Promise<string | undefined> {
  const result = await $.command.run({
    command: 'effort-router',
    args,
    origin: { kind: 'composer' },
  } as never)

  return result.text
}

describe('register', () => {
  test('a key file holds the key as a JSON field or alone', () => {
    expect(keyIn('{"TYPESAFE_API_KEY": "a", "OTHER": "b"}', 'TYPESAFE_API_KEY')).toBe('a')
    expect(keyIn('{"GATEWAY_KEY": "g"}', 'GATEWAY_KEY')).toBe('g')
    expect(keyIn('{"OTHER": "b"}', 'TYPESAFE_API_KEY')).toBeUndefined()
    expect(keyIn('sk-alone\n', 'TYPESAFE_API_KEY')).toBe('sk-alone')
    expect(keyIn('two words', 'TYPESAFE_API_KEY')).toBeUndefined()
  })

  test('options left empty fall back to the TypeSafe environment and hosted Jev', () => {
    expect(configOf({ baseUrl: '', model: ' ', keyFile: '' })).toMatchObject({
      baseUrl: undefined,
      model: undefined,
      keyFile: undefined,
      keyName: 'TYPESAFE_API_KEY',
      mode: 'shadow',
      threshold: 0.95,
    })
  })

  test('shadow sends the session effort and logs the pick', async ($, on) => {
    const w = world(on)

    await $.session.start(STARTED)
    await $.turn.start({ text: 'push the PR', turnId: 't1' })
    await step($, 't1', 0, 'xhigh')
    await step($, 't1', 1, 'xhigh')
    await complete($, 't1')

    expect(w.sent).toEqual(['xhigh', 'xhigh'])
    expect(w.posts[0]?.init?.headers?.Authorization).toBe('Bearer k')

    const [record] = w.records()

    expect(record).toMatchObject({
      type: 'turn',
      mode: 'shadow',
      reason: 'classifier',
      session_effort: 'xhigh',
      would_pick: 'low',
      sent: 'xhigh',
      prompt_head: 'push the PR',
    })

    expect(record?.outcome).toMatchObject({ usage: { output: 20, cacheRead: 200 } })
    expect(await closing($, w.drawn, 'line-1')).toBe('Baked at xhigh effort (router: low)')
  })

  test('the spinner and the closing line say the level each turn went out at', async ($, on) => {
    const w = world(on, { answers: [{ low: 0.98, medium: 0.02 }, { xhigh: 1 }] })

    await $.session.start(STARTED)
    await command($, 'enforce')
    await closing($, w.drawn, 'from-before')
    await $.turn.start({ text: 'push the PR', turnId: 't1' })
    await step($, 't1', 0, 'xhigh')

    expect(await spinner($, w.drawn)).toBe('Baking… at low effort')
    expect(await spinner($, w.drawn, 'agent-7'), 'a subagent spinner is left alone').toBe('Baking…')

    await complete($, 't1')

    expect(await closing($, w.drawn, 'line-1')).toBe('Baked at low effort')

    await $.turn.start({ text: 'design the plugin system', turnId: 't2' })
    await step($, 't2', 0, 'xhigh')
    await complete($, 't2')

    expect(await closing($, w.drawn, 'line-2')).toBe('Baked at xhigh effort')
    expect(await closing($, w.drawn, 'line-1'), 'a redraw keeps each line to its turn').toBe('Baked at low effort')
    expect(await closing($, w.drawn, 'from-before'), 'a line from before the router is left alone').toBe('Baked')
    expect(w.said, 'nothing went wrong, so nothing is said in the transcript').toEqual([])
  })

  test('a closing line drawn mid-turn leaves the turn its own label', async ($, on) => {
    const w = world(on)

    await $.session.start(STARTED)
    await command($, 'enforce')
    await $.turn.start({ text: 'push the PR', turnId: 't1' })
    await step($, 't1', 0, 'xhigh')
    // A subagent's turn closes while the main turn runs, and its line draws
    // first.
    await closing($, w.drawn, 'a-subagent-line')
    await complete($, 't1')

    expect(await closing($, w.drawn, 'line-1')).toBe('Baked at low effort')
  })

  test('enforce sends the pick on every request of the turn', async ($, on) => {
    const w = world(on)

    await $.session.start(STARTED)
    expect(await command($, 'enforce')).toBe('mode enforce for this session')

    await $.turn.start({ text: 'push the PR', turnId: 't1' })
    await step($, 't1', 0, 'xhigh')
    await step($, 't1', 1, 'xhigh')
    await complete($, 't1')

    expect(w.sent).toEqual(['low', 'low'])
    expect(w.records()[0]).toMatchObject({ mode: 'enforce', sent: 'low' })
  })

  test('the ensemble asks each distinct context once and averages over all three', async ($, on) => {
    const w = world(on, { answers: [{ low: 1 }, { low: 1 }, { xhigh: 1 }] })

    await $.session.start(STARTED)
    await command($, 'enforce')

    for (const turnId of ['t1', 't2']) {
      await $.turn.start({ text: 'push the PR', turnId })
      await step($, turnId, 0, 'xhigh')
      await complete($, turnId)
    }

    // Turn 2: the previous exchange and the history context are the same
    // request (no earlier exchanges yet), the last-turn context differs.
    // Mean: low 0.67, xhigh 0.33, below the 0.95 threshold until xhigh.
    expect(w.posts).toHaveLength(3)
    expect(w.sent).toEqual(['low', 'xhigh'])
    expect(JSON.parse(String(w.posts[2]?.init?.body)).state.previous_turn).toEqual({
      failed_tool_calls: 0,
      model_requests: 1,
      interrupted: false,
    })
  })

  test('a subagent request is never touched', async ($, on) => {
    const w = world(on)

    await $.session.start(STARTED)
    await command($, 'enforce')
    await $.turn.start({ text: 'push the PR', turnId: 't1' })
    await step($, 't1', 0, 'xhigh')
    await step($, 'sub', 0, 'high', 'agent-1')

    expect(w.sent).toEqual(['low', 'high'])
    expect(w.posts).toHaveLength(1)
  })

  test('a failing classifier keeps the session effort', async ($, on) => {
    const w = world(on, { answers: [503] })

    await $.session.start(STARTED)
    await command($, 'enforce')
    await $.turn.start({ text: 'refactor the parser', turnId: 't1' })
    await step($, 't1', 0, 'xhigh')
    await complete($, 't1')

    expect(w.sent).toEqual(['xhigh'])
    expect(w.records()[0]).toMatchObject({ reason: 'fallback: http 503', sent: 'xhigh' })
    expect(await closing($, w.drawn, 'line-1')).toBe('Baked at xhigh effort (router: http 503)')
    expect(await command($, 'status')).toContain('failing (http 503)')
  })

  test('shadow says when the classifier gave no answer, too', async ($, on) => {
    const w = world(on, { answers: [503] })

    await $.session.start(STARTED)
    await $.turn.start({ text: 'refactor the parser', turnId: 't1' })
    await step($, 't1', 0, 'xhigh')
    await complete($, 't1')

    expect(w.sent).toEqual(['xhigh'])
    expect(w.records()[0]).toMatchObject({ mode: 'shadow', reason: 'fallback: http 503' })
    expect(await closing($, w.drawn, 'line-1')).toBe('Baked at xhigh effort (router: http 503)')
  })

  test('a classifier that does not answer in time keeps the session effort', async ($, on) => {
    const w = world(on, { answers: ['hang'] })

    await $.session.start(STARTED)
    await command($, 'enforce')
    await $.turn.start({ text: 'refactor the parser', turnId: 't1' })

    const stepping = step($, 't1', 0, 'xhigh')

    await w.clock.settle()
    expect(w.sent, 'the request waits for the classifier').toEqual([])

    await w.clock.advance(5000)
    await stepping

    expect(w.sent).toEqual(['xhigh'])
  })

  test('three failures pause the classifier', async ($, on) => {
    const w = world(on, { answers: [503] })

    await $.session.start(STARTED)
    await command($, 'enforce')

    for (const turnId of ['t1', 't2', 't3', 't4']) {
      await $.turn.start({ text: 'refactor the parser', turnId })
      await step($, turnId, 0, 'xhigh')
      await complete($, turnId)
    }

    // With the ensemble, turn n asks with up to three distinct contexts:
    // 1 + 2 + 3 calls, three failed classifications, then the pause.
    expect(w.posts).toHaveLength(6)
    expect(w.records()[3]).toMatchObject({ reason: 'fallback: classifier paused' })
  })

  test('another source changing effort mid-turn wins', async ($, on) => {
    const w = world(on)

    await $.session.start(STARTED)
    await command($, 'enforce')
    await $.turn.start({ text: 'push the PR', turnId: 't1' })
    await step($, 't1', 0, 'xhigh')
    await step($, 't1', 1, 'medium')

    expect(w.sent).toEqual(['low', 'medium'])
  })

  test('two failed tools raise the rest of the turn by one level', async ($, on) => {
    const w = world(on)

    on('tool.call', () => ({ isError: true, result: 'Exit code 1' }))

    await $.session.start(STARTED)
    await command($, 'enforce')
    await $.turn.start({ text: 'push the PR', turnId: 't1' })
    await step($, 't1', 0, 'xhigh')
    await $.tool.call({ tool: 'Bash', command: 'git push' })
    await $.tool.call({ tool: 'Bash', command: 'git push' })
    await step($, 't1', 1, 'xhigh')
    await complete($, 't1')

    expect(w.sent).toEqual(['low', 'medium'])
    expect(w.records()[0]).toMatchObject({ tool_errors: 2 })
  })

  test('a deep-reasoning phrase sets a floor of xhigh', async ($, on) => {
    const w = world(on)

    await $.session.start(STARTED)
    await command($, 'enforce')
    await $.turn.start({ text: 'think hard: push the PR', turnId: 't1' })
    await step($, 't1', 0, 'medium')
    await complete($, 't1')

    expect(w.sent).toEqual(['xhigh'])
    expect(w.records()[0]).toMatchObject({ reason: 'cue', cue: 'xhigh' })
  })

  test('a turn without a typed prompt inherits the previous pick', async ($, on) => {
    const w = world(on)

    await $.session.start(STARTED)
    await command($, 'enforce')
    await $.turn.start({ text: 'push the PR', turnId: 't1' })
    await step($, 't1', 0, 'xhigh')
    await complete($, 't1')
    await $.turn.start({ text: '', turnId: 't2' })
    await step($, 't2', 0, 'xhigh')
    await complete($, 't2')

    expect(w.sent).toEqual(['low', 'low'])
    expect(w.posts).toHaveLength(1)
    expect(w.records()[1]).toMatchObject({ reason: 'inherit' })
  })

  test('without a key the router says so once and changes nothing', async ($, on) => {
    const w = world(on, { env: {} })

    await $.session.start(STARTED)
    await command($, 'enforce')

    for (const turnId of ['t1', 't2']) {
      await $.turn.start({ text: 'push the PR', turnId })
      await step($, turnId, 0, 'xhigh')
      await complete($, turnId)
    }

    expect(w.sent).toEqual(['xhigh', 'xhigh'])
    expect(w.posts).toHaveLength(0)
    expect(w.said).toEqual(['no API key (set TYPESAFE_API_KEY, or the keyFile option); effort stays as set.'])
    expect(await closing($, w.drawn, 'line-1')).toBe('Baked at xhigh effort (router: no API key)')
    expect(await command($, 'status')).toContain('key: no API key')
  })

  test('the base URL and model come from the TypeSafe environment', async ($, on) => {
    const w = world(on, {
      env: { TYPESAFE_API_KEY: 'gw', TYPESAFE_BASE_URL: 'https://gateway.test/decide/', TYPESAFE_DEFAULT_MODEL: 'jev-1.13.0' },
    })

    await $.session.start(STARTED)
    await $.turn.start({ text: 'push the PR', turnId: 't1' })
    await step($, 't1', 0, 'xhigh')
    await complete($, 't1')

    expect(w.posts[0]?.url).toBe('https://gateway.test/decide/v1/systemone')
    expect(w.posts[0]?.init?.headers?.Authorization).toBe('Bearer gw')
    expect(JSON.parse(String(w.posts[0]?.init?.body))).toMatchObject({ model: 'jev-1.13.0' })
    expect(await command($, 'status')).toContain('https://gateway.test/decide/v1/systemone (jev-1.13.0)')
  })

  test('a classifier that keeps failing is said once, when the router pauses', async ($, on) => {
    const w = world(on, { answers: [401] })

    await $.session.start(STARTED)
    await command($, 'enforce')

    for (const turnId of ['t1', 't2', 't3', 't4']) {
      await $.turn.start({ text: `push the PR ${turnId}`, turnId })
      await step($, turnId, 0, 'xhigh')
      await complete($, turnId)
    }

    expect(w.sent).toEqual(['xhigh', 'xhigh', 'xhigh', 'xhigh'])
    expect(w.said).toEqual([
      "classifier failing (http 401: key rejected); turns keep the session's effort for 5 minutes. /effort-router status has details.",
    ])
  })

  test('wrong labels the last turn in the log', async ($, on) => {
    const w = world(on)

    await $.session.start(STARTED)
    await $.turn.start({ text: 'push the PR', turnId: 't1' })
    await step($, 't1', 0, 'xhigh')
    await complete($, 't1')

    expect(await command($, 'wrong medium')).toBe('labeled turn t1 as medium')
    expect(await command($, 'wrong huge')).toContain('usage')
    expect(w.records()[1]).toMatchObject({ type: 'label', turnId: 't1', level: 'medium', would_pick: 'low' })
    expect(w.files.has(LOG_FILE)).toBe(true)
    expect(HOME).toBe('/Users/t')
  })

  test('a harder message typed mid-turn raises the rest of the turn', async ($, on) => {
    const w = world(on, { answers: [{ low: 0.98, medium: 0.02 }, { xhigh: 1 }] })

    on('prompt.submit', ($, e) => ({ text: e.text }))

    await $.session.start(STARTED)
    await command($, 'enforce')
    await $.turn.start({ text: 'push the PR', turnId: 't1' })
    await step($, 't1', 0, 'xhigh')
    await $.prompt.submit({
      text: 'actually, redesign the release process first',
      turnId: 't1',
      wait: false,
      origin: { kind: 'composer' },
    })
    await step($, 't1', 1, 'xhigh')
    await complete($, 't1')

    expect(w.sent).toEqual(['low', 'xhigh'])
    expect(await closing($, w.drawn, 'line-1')).toBe('Baked at xhigh effort (raised by your message)')
    expect(w.records()[0]).toMatchObject({
      would_pick: 'low',
      raised_to: 'xhigh',
      mid_turn: [{ pick: 'xhigh', raised: true }],
    })
  })

  test('an easier message typed mid-turn never lowers the turn', async ($, on) => {
    const w = world(on, { answers: [{ medium: 0.05, high: 0.95 }, { low: 1 }] })

    on('prompt.submit', ($, e) => ({ text: e.text }))

    await $.session.start(STARTED)
    await command($, 'enforce')
    await $.turn.start({ text: 'debug the flaky upload test', turnId: 't1' })
    await step($, 't1', 0, 'xhigh')
    await $.prompt.submit({ text: 'thanks', turnId: 't1', wait: false, origin: { kind: 'composer' } })
    await step($, 't1', 1, 'xhigh')

    expect(w.sent).toEqual(['high', 'high'])
  })

  test('queued prompts and messages nobody typed are not classified mid-turn', async ($, on) => {
    const w = world(on)

    on('prompt.submit', ($, e) => ({ text: e.text }))

    await $.session.start(STARTED)
    await command($, 'enforce')
    await $.turn.start({ text: 'push the PR', turnId: 't1' })
    await step($, 't1', 0, 'xhigh')
    await $.prompt.submit({ text: 'next: redesign it', turnId: 't1', wait: true, origin: { kind: 'composer' } })
    await $.prompt.submit({ text: 'task finished', turnId: 't1', wait: false, origin: { kind: 'task-notification' } } as never)
    await step($, 't1', 1, 'xhigh')

    expect(w.posts).toHaveLength(1)
    expect(w.sent).toEqual(['low', 'low'])
  })

  test('an effort set by hand pauses the router until it is back at the usual level', async ($, on) => {
    const w = world(on)

    await $.session.start(STARTED)
    await command($, 'enforce')

    for (const [turnId, effort] of [['t1', 'xhigh'], ['t2', 'high'], ['t3', 'xhigh']] as const) {
      await $.turn.start({ text: 'push the PR', turnId })
      await step($, turnId, 0, effort)
      await complete($, turnId)
    }

    expect(w.sent).toEqual(['low', 'high', 'low'])
    expect(w.records()[1]).toMatchObject({ manual: true, baseline: 'xhigh', sent: 'high' })
  })

  test('max is always a choice made by hand', async ($, on) => {
    const w = world(on, { saved: { 'claude-opus-5-5': 'max' } })

    await $.session.start(STARTED)
    await command($, 'enforce')
    await $.turn.start({ text: 'push the PR', turnId: 't1' })
    await step($, 't1', 0, 'max')

    expect(w.sent).toEqual(['max'])
    expect(await spinner($, w.drawn)).toBe('Baking… at max effort (set by hand)')
  })

  test('a session launched at a level other than the saved one stays as launched', async ($, on) => {
    const w = world(on, { saved: { 'claude-opus-5-5': 'xhigh' } })

    await $.session.start(STARTED)
    await command($, 'enforce')
    await $.turn.start({ text: 'push the PR', turnId: 't1' })
    await step($, 't1', 0, 'medium')

    expect(w.sent).toEqual(['medium'])
  })

  test('a reload recovers the usual level from the log', async ($, on) => {
    const earlier = JSON.stringify({ type: 'turn', turnId: 't0', baseline: 'xhigh' })
    const w = world(on, { files: { [LOG_FILE]: `${earlier}\n` } })

    await $.session.start(STARTED)
    await command($, 'enforce')
    await $.turn.start({ text: 'push the PR', turnId: 't1' })
    await step($, 't1', 0, 'high')

    expect(w.sent, 'high differs from the logged usual level').toEqual(['high'])
  })

  test('a reload keeps the records the session already logged', async ($, on) => {
    const earlier = JSON.stringify({ type: 'turn', turnId: 't0', would_pick: 'high' })
    const w = world(on, { files: { [LOG_FILE]: `${earlier}\n` } })

    await $.session.start(STARTED)
    await $.turn.start({ text: 'push the PR', turnId: 't1' })
    await step($, 't1', 0, 'xhigh')
    await complete($, 't1')

    expect(w.records().map(record => record.turnId)).toEqual(['t0', 't1'])
  })

  test('a headless session keeps its effort by default', async ($, on) => {
    const w = world(on)

    await $.session.start({ ...STARTED, isInteractive: false, surface: null })
    await command($, 'enforce')
    await $.turn.start({ text: 'push the PR', turnId: 't1' })
    await step($, 't1', 0, 'xhigh')
    await complete($, 't1')

    expect(w.sent).toEqual(['xhigh'])
    expect(w.posts).toHaveLength(0)
    expect(w.records()).toHaveLength(0)
  })

  test('without a key even a deep-reasoning phrase changes nothing', async ($, on) => {
    const w = world(on, { env: {} })

    await $.session.start(STARTED)
    await command($, 'enforce')
    await $.turn.start({ text: 'think hard: push the PR', turnId: 't1' })
    await step($, 't1', 0, 'medium')

    expect(w.sent).toEqual(['medium'])
  })

  test('a failing classifier still honors a deep-reasoning phrase', async ($, on) => {
    const w = world(on, { answers: [503] })

    await $.session.start(STARTED)
    await command($, 'enforce')
    await $.turn.start({ text: 'think hard: push the PR', turnId: 't1' })
    await step($, 't1', 0, 'medium')

    expect(w.sent).toEqual(['xhigh'])
  })

  test('shadow logs a pick that lands after the request went out', async ($, on) => {
    const w = world(on, { answers: [{ after: 2000, answer: { low: 0.98, medium: 0.02 } }] })

    await $.session.start(STARTED)
    await $.turn.start({ text: 'push the PR', turnId: 't1' })
    await step($, 't1', 0, 'xhigh')

    expect(w.sent, 'shadow does not wait for the classifier').toEqual(['xhigh'])

    const completing = complete($, 't1')

    await w.clock.advance(2000)
    await completing

    expect(w.records()[0]).toMatchObject({ would_pick: 'low', sent: 'xhigh' })
  })

  test('mid-turn classifications run together and wait at most the timeout', async ($, on) => {
    const w = world(on, { answers: [{ low: 0.98, medium: 0.02 }, 'hang'] })

    on('prompt.submit', ($, e) => ({ text: e.text }))

    await $.session.start(STARTED)
    await command($, 'enforce')
    await $.turn.start({ text: 'push the PR', turnId: 't1' })
    await step($, 't1', 0, 'xhigh')

    for (const text of ['one more thing', 'and another', 'and a third']) {
      await $.prompt.submit({ text, turnId: 't1', wait: false, origin: { kind: 'composer' } })
    }

    const stepping = step($, 't1', 1, 'xhigh')

    await w.clock.settle()
    expect(w.sent).toEqual(['low'])

    await w.clock.advance(5000)
    await stepping

    expect(w.sent).toEqual(['low', 'low'])
    expect(w.posts).toHaveLength(4)
  })

  test('a new session in the same process starts over', async ($, on) => {
    const w = world(on)

    await $.session.start(STARTED)
    await command($, 'enforce')
    await $.turn.start({ text: 'push the PR', turnId: 't1' })
    await step($, 't1', 0, 'xhigh')
    await complete($, 't1')

    w.session.id = 'after-clear'

    await $.session.start(STARTED)
    await $.turn.start({ text: '', turnId: 't2' })
    await step($, 't2', 0, 'xhigh')
    await complete($, 't2')

    expect(w.records().map(record => record.turnId)).toEqual(['t1'])
    expect(w.records('after-clear')).toMatchObject([{ turnId: 't2', reason: 'fallback: no previous pick' }])
    expect(w.sent).toEqual(['low', 'xhigh'])
  })

  test('a new session resolves the key again', async ($, on) => {
    const w = world(on)

    await $.session.start(STARTED)
    await $.turn.start({ text: 'push the PR', turnId: 't1' })
    await step($, 't1', 0, 'xhigh')
    await complete($, 't1')

    // `/clear` in the same process; the key file or the environment may have
    // been fixed since the first session read it.
    w.session.id = 'after-clear'
    await $.session.start(STARTED)
    await $.turn.start({ text: 'push the PR', turnId: 't2' })
    await step($, 't2', 0, 'xhigh')
    await complete($, 't2')

    expect(
      w.envReads.filter(name => name === 'TYPESAFE_API_KEY'),
      'each session reads the key once',
    ).toHaveLength(2)
    expect(w.posts, 'the second session classifies').toHaveLength(2)
  })

  test('a tool failure that settles after its turn ended counts nowhere', async ($, on) => {
    const w = world(on)

    on('tool.call', async () => {
      await w.clock.sleep(1000)

      return { isError: true, result: 'Exit code 1' }
    })

    await $.session.start(STARTED)
    await command($, 'enforce')
    await $.turn.start({ text: 'push the PR', turnId: 't1' })
    await step($, 't1', 0, 'xhigh')

    const late = [$.tool.call({ tool: 'Bash', command: 'false' }), $.tool.call({ tool: 'Bash', command: 'false' })]

    await complete($, 't1')
    await $.turn.start({ text: 'push the PR', turnId: 't2' })
    await step($, 't2', 0, 'xhigh')
    await w.clock.advance(1000)
    await Promise.all(late)
    await step($, 't2', 1, 'xhigh')
    await complete($, 't2')

    expect(w.sent).toEqual(['low', 'low', 'low'])
    expect(w.records().map(record => record.tool_errors)).toEqual([0, 0])
  })

  test('off leaves every request alone and asks nothing', async ($, on) => {
    const w = world(on)

    await $.session.start(STARTED)
    await command($, 'off')
    await $.turn.start({ text: 'push the PR', turnId: 't1' })
    await step($, 't1', 0, 'xhigh')

    expect(w.sent).toEqual(['xhigh'])
    expect(w.posts).toHaveLength(0)
  })
})
