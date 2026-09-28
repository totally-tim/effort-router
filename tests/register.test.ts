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

  test('an existing session recovers after the outage cooldown without a reset', async ($, on) => {
    // Literal requests collapse the ensemble to one distinct call per turn.
    const w = world(on, { answers: [503, 503, 503, { low: 1 }] })
    await $.session.start(STARTED)
    await command($, 'enforce')
    for (const turnId of ['t1', 't2', 't3', 'paused']) {
      await $.turn.start({ text: 'Reply with exactly OK.', turnId })
      await step($, turnId, 0, 'xhigh')
      if (turnId === 'paused') {
        await w.clock.advance(300001)
        await w.clock.settle()
        expect(w.posts, 'time passing alone does not retry during a running turn').toHaveLength(3)
        await step($, turnId, 1, 'xhigh')
        expect(w.posts, 'the next request of the running turn retries once').toHaveLength(4)
      }
      await complete($, turnId)
    }
    expect(w.posts).toHaveLength(4)
    expect(w.records()[3]).toMatchObject({ reason: 'retained effort', sent: 'xhigh' })
    expect(w.records()[3]?.steps).toMatchObject([{ sent: 'xhigh' }, { sent: 'xhigh' }])
    for (const turnId of ['recovered', 'still-healthy']) {
      await $.turn.start({ text: 'Reply with exactly OK.', turnId })
      await step($, turnId, 0, 'xhigh')
      expect(await spinner($, w.drawn)).toBe('Baking… at low effort')
      await complete($, turnId)
    }
    expect(w.posts).toHaveLength(6)
    expect(w.sent).toEqual(['xhigh', 'xhigh', 'xhigh', 'xhigh', 'xhigh', 'low', 'low'])
    expect(await command($, 'status')).toContain('ok (')
    expect(w.records()[4]).toMatchObject({ reason: 'classifier', context_sufficient: true, sent: 'low' })
  })

  test('needs context is a healthy abstention and does not stick to the next task', async ($, on) => {
    const w = world(on, { contexts: ['missing_evidence', 'sufficient'] })
    await $.session.start(STARTED)
    await command($, 'enforce')
    await $.turn.start({ text: 'Investigate the migration plan.', turnId: 'unclear' })
    await step($, 'unclear', 0, 'xhigh')
    expect(await spinner($, w.drawn)).toBe('Baking… at xhigh effort (router: needs context)')
    expect(await command($, 'status')).toContain('ok (')
    await complete($, 'unclear')
    await $.turn.start({ text: 'Reply with exactly OK.', turnId: 'literal' })
    await step($, 'literal', 0, 'xhigh')
    expect(await spinner($, w.drawn)).toBe('Baking… at low effort')
    await complete($, 'literal')
    expect(w.sent).toEqual(['xhigh', 'low'])
    expect(w.records()[1]).toMatchObject({ reason: 'classifier', context_sufficient: true })
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
    expect([...w.files.keys()].some(path => path.startsWith(LOG_FILE.replace(/\.jsonl$/, '.')) && path.endsWith('.jsonl'))).toBe(true)
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

  // `wait` only asks a prompt to wait its turn: the engine delivers every prompt typed mid-turn at the
  // running turn's next tool result either way (PromptSubmitInput.wait; Claude Code 2.1.283 with
  // Opus 5.5 delivered a ctrl+x Enter prompt as a `queued_command` attachment inside the turn).
  test('a queued prompt is classified like any typed prompt; messages nobody typed are not', async ($, on) => {
    const w = world(on, { answers: [{ low: 0.98, medium: 0.02 }, { xhigh: 1 }] })

    on('prompt.submit', ($, e) => ({ text: e.text }))

    await $.session.start(STARTED)
    await command($, 'enforce')
    await $.turn.start({ text: 'push the PR', turnId: 't1' })
    await step($, 't1', 0, 'xhigh')

    for (const origin of [{ kind: 'task-notification' }, { kind: 'peer' }, { kind: 'plugin', name: 'other' }, { kind: 'sdk' }]) {
      await $.prompt.submit({ text: 'task finished', turnId: 't1', wait: false, origin } as never)
    }

    await step($, 't1', 1, 'xhigh')

    expect(w.posts).toHaveLength(1)
    expect(w.sent).toEqual(['low', 'low'])

    await $.prompt.submit({ text: 'next: redesign it', turnId: 't1', wait: true, origin: { kind: 'composer' } })
    await step($, 't1', 2, 'xhigh')

    expect(w.posts).toHaveLength(2)
    expect(w.sent).toEqual(['low', 'low', 'xhigh'])
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

  test('inspection resolves an abstention before work and reconsideration is bounded', async ($, on) => {
    const w = world(on, { contexts: ['missing_target', 'sufficient'] })
    on('tool.call', ($, e) => ({ result: {}, text: `Source ${'file_path' in e ? e.file_path : ''}: button.onclick = () => count++`, isReadOnly: true }))
    await $.session.start(STARTED)
    await command($, 'enforce')
    await $.turn.start({ text: 'How does this work?', turnId: 't1' })
    await step($, 't1', 0, 'high')
    expect(w.sent).toEqual(['high'])
    await $.tool.call({ tool: 'Read', file_path: '/work/index.html' })
    await step($, 't1', 1, 'high')
    expect(w.sent).toEqual(['high', 'low'])
    for (let i = 2; i < 6; i++) {
      await $.tool.call({ tool: 'Read', file_path: `/work/file${i}.ts` })
      await step($, 't1', i, 'high')
    }
    await complete($, 't1')
    expect(w.records()[0]?.discovery).toHaveLength(2)
    expect(w.records()[0]?.context_sufficient).toBe(false)
    expect(w.records()[0]?.reason).toBe('discovery budget exhausted')
    expect(w.sent.at(-1)).toBe('high')
    const body = JSON.parse(w.posts[1]!.init!.body!)
    expect(body.state.task_context.observations[0].target).toBe('/work/index.html')
  })

  test('discovery cannot lower effort after an action or use a subagent read', async ($, on) => {
    const w = world(on, { contexts: ['missing_target', 'sufficient'] })
    on('tool.call', ($, e) => ({ result: {}, text: 'source code', ...(e.tool === 'Read' ? { isReadOnly: true as const } : {}) }))
    await $.session.start(STARTED)
    await command($, 'enforce')
    await $.turn.start({ text: 'Fix this', turnId: 't1' })
    await step($, 't1', 0, 'high')
    await $.tool.call({ tool: 'Read', file_path: '/work/app.ts', agentId: 'child' } as never)
    await step($, 't1', 1, 'high')
    expect(w.posts).toHaveLength(1)
    await $.tool.call({ tool: 'Bash', command: 'make change' })
    await $.tool.call({ tool: 'Read', file_path: '/work/app.ts' })
    await step($, 't1', 2, 'high')
    expect(w.sent).toEqual(['high', 'high', 'high'])
    expect(await spinner($, w.drawn)).toBe('Baking… at high effort (kept for active work)')
    await complete($, 't1')
    expect(w.records()[0]).toMatchObject({ reason: 'work in progress', context_sufficient: true, context_held: false, missing_context: [] })
  })

  test('resolved context clears the warning when the new pick equals the retained effort', async ($, on) => {
    const w = world(on, { contexts: ['missing_evidence', 'sufficient'], answers: [{ low: 1 }, { high: 1 }] })
    on('tool.call', () => ({ result: {}, text: 'function start() { return run() }', isReadOnly: true }))
    await $.session.start(STARTED)
    await command($, 'enforce')
    await $.turn.start({ text: 'Explain the application', turnId: 't1' })
    await step($, 't1', 0, 'high')
    expect(await spinner($, w.drawn)).toContain('router: needs context')
    await $.tool.call({ tool: 'Read', file_path: '/work/app.ts' })
    await step($, 't1', 1, 'high')
    expect(await spinner($, w.drawn)).toBe('Baking… at high effort')
    await complete($, 't1')
    expect(w.records()[0]).toMatchObject({ context_sufficient: true, context_held: false, reason: 'classifier' })
  })

  test('a partial context outage is reported as a failure and recovers on the next turn', async ($, on) => {
    const w = world(on, { answers: [{ low: 1 }, { low: 1 }, { low: 1 }, { low: 1 }, 503, { low: 1 }] })
    await $.session.start(STARTED)
    await command($, 'enforce')
    for (let i = 0; i < 2; i++) {
      await $.turn.start({ text: `Check item ${i}`, turnId: `prior${i}` })
      await step($, `prior${i}`, 0, 'xhigh')
      await complete($, `prior${i}`)
    }
    await $.turn.start({ text: 'Check the next item', turnId: 'outage' })
    await step($, 'outage', 0, 'xhigh')
    expect(JSON.parse(w.posts[4]!.init!.body!).state.earlier_exchanges).toHaveLength(1)
    expect(w.sent.at(-1)).toBe('xhigh')
    expect(await spinner($, w.drawn)).toContain('router: context assessment: http 503')
    expect(await command($, 'status')).toContain('failing (context assessment: http 503)')
    await complete($, 'outage')
    await $.turn.start({ text: 'Check the remaining item', turnId: 'recovered' })
    await step($, 'recovered', 0, 'xhigh')
    expect(w.sent.at(-1)).toBe('low')
    expect(await command($, 'status')).toContain('ok (')
  })

  test('background completions preserve the user task, its effort and pending answer tail', async ($, on) => {
    const w = world(on)
    on('prompt.submit', ($, e) => ({ text: e.text }))
    await $.session.start(STARTED)
    await command($, 'enforce')
    const original = 'Think hard about migrating the applications after DNS login.'
    await $.turn.start({ text: original, turnId: 'task' })
    await step($, 'task', 0, 'xhigh')
    await $.turn.complete({ turnId: 'task', answer: 'Migration progress. ' + 'detail '.repeat(400) + 'Pending: sign in to DNS.', durationMs: 10, isAborted: false, reason: 'answer' })
    for (let i = 0; i < 4; i++) {
      const turnId = `notification${i}`
      const text = i === 0 ? 'Image copy finished' : '<task-notification><summary>Image copy finished</summary></task-notification>'
      await $.prompt.submit({ text, wait: false, origin: { kind: 'task-notification' } })
      await $.turn.start({ text, turnId })
      await step($, turnId, 0, 'xhigh')
      await complete($, turnId)
    }
    await $.turn.start({ text: 'Continue', turnId: 'followup' })
    await step($, 'followup', 0, 'xhigh')
    const followups = w.posts.map(p => JSON.parse(p.init!.body!)).filter(b => b.state.request === 'Continue')
    expect(followups.length > 0).toBe(true)
    for (const { state } of followups) {
      expect(state.previous_request).toBe(original)
      // The latest visible reply answered a background completion; the task keeps its pending tail.
      expect(state.previous_answer).toBe('done')
      expect(state.task_context.previousTask.answer).toContain('Pending: sign in to DNS.')
      expect(state.task_context.previousTask).toMatchObject({ request: original, level: 'xhigh' })
      expect(JSON.stringify(state)).not.toContain('Image copy finished')
    }
    expect(w.sent.at(-1)).toBe('xhigh')
    await complete($, 'followup')
    expect(w.records().filter(r => r.task_notification)).toHaveLength(4)
    await $.turn.start({ text: 'Reply OK', turnId: 'new-task' })
    await step($, 'new-task', 0, 'xhigh')
    expect(w.sent.at(-1)).toBe('low')
  })

  test('a shell cd keeps the task memory; a project move starts fresh', async ($, on) => {
    const w = world(on)
    await $.session.start(STARTED)
    await command($, 'enforce')
    await $.turn.start({ text: 'Migrate the hosting projects.', turnId: 'task' })
    await step($, 'task', 0, 'xhigh')
    await $.turn.complete({ turnId: 'task', answer: 'Pending: sign in to DNS.', durationMs: 10, isAborted: false, reason: 'answer' })
    w.location.cwd = '/work/hosting'
    await $.turn.start({ text: 'logged in', turnId: 'followup' })
    await step($, 'followup', 0, 'xhigh')
    const followup = JSON.parse(w.posts.at(-1)!.init!.body!).state
    expect(followup.previous_request).toBe('Migrate the hosting projects.')
    expect(followup.task_context.repository.cwd).toBe('/work/hosting')
    expect(followup.task_context.previousTask.request).toBe('Migrate the hosting projects.')
    await complete($, 'followup')
    w.location.cwd = '/other'
    w.location.root = '/other'
    await $.turn.start({ text: 'Explain the build.', turnId: 'moved' })
    await step($, 'moved', 0, 'xhigh')
    const moved = JSON.parse(w.posts.at(-1)!.init!.body!).state
    expect(moved.previous_request).toBeUndefined()
    expect(moved.task_context.previousTask).toBeUndefined()
  })

  test('entering and leaving a worktree of the same repository keeps the task memory', async ($, on) => {
    const w = world(on, { files: { '/work/.git': '<directory>', '/work/.claude/worktrees/wt/.git': 'gitdir: /work/.git/worktrees/wt\n', '/work/.git/worktrees/wt/commondir': '../..\n',
      '/work/sibling-wt/.git': 'gitdir: ../.git/worktrees/sibling-wt\n', '/work/.git/worktrees/sibling-wt/commondir': '../..\n' } })
    await $.session.start(STARTED)
    await command($, 'enforce')
    await $.turn.start({ text: 'Migrate the hosting projects.', turnId: 'task' })
    await step($, 'task', 0, 'xhigh')
    await $.turn.complete({ turnId: 'task', answer: 'Pending: sign in to DNS.', durationMs: 10, isAborted: false, reason: 'answer' })
    let previous = 'Migrate the hosting projects.'
    for (const [turnId, root] of [['in-worktree', '/work/.claude/worktrees/wt'], ['relative-worktree', '/work/sibling-wt'], ['back', '/work']] as const) {
      w.location.cwd = root
      w.location.root = root
      await $.turn.start({ text: `logged in (${turnId})`, turnId })
      await step($, turnId, 0, 'xhigh')
      const state = JSON.parse(w.posts.at(-1)!.init!.body!).state
      expect([turnId, state.previous_request, state.task_context.previousTask?.request]).toEqual([turnId, previous, previous])
      await complete($, turnId)
      previous = `logged in (${turnId})`
    }
  })

  test('a worktree of another repository or a plain directory is a new project', async ($, on) => {
    const w = world(on, { files: { '/work/.git': '<directory>', '/other/.git': '<directory>', '/other/.claude/worktrees/wt/.git': 'gitdir: /other/.git/worktrees/wt\n',
      '/other/.git/worktrees/wt/commondir': '../..\n', '/work/mod/.git': 'gitdir: ../.git/modules/mod\n' } })
    await $.session.start(STARTED)
    await command($, 'enforce')
    for (const [turnId, root] of [['start', '/work'], ['other-worktree', '/other/.claude/worktrees/wt'], ['submodule', '/work/mod'], ['plain', '/plain']] as const) {
      w.location.cwd = root
      w.location.root = root
      await $.turn.start({ text: `Explain the build (${turnId}).`, turnId })
      await step($, turnId, 0, 'xhigh')
      const state = JSON.parse(w.posts.at(-1)!.init!.body!).state
      expect([turnId, state.previous_request, state.task_context.previousTask]).toEqual([turnId, undefined, undefined])
      await complete($, turnId)
    }
  })

  test('a symbolic link to the repository and a worktree of it share one project, reading no .git directory', async ($, on) => {
    const w = world(on, { files: { '/work/.git': '<directory>', '/work/.claude/worktrees/wt/.git': 'gitdir: /work/.git/worktrees/wt\n',
      '/work/.git/worktrees/wt/commondir': '../..\n' }, links: { '/link': '/work' } })
    w.location.cwd = '/link'
    w.location.root = '/link'
    await $.session.start(STARTED)
    await command($, 'enforce')
    await $.turn.start({ text: 'Migrate the hosting projects.', turnId: 'task' })
    await step($, 'task', 0, 'xhigh')
    await $.turn.complete({ turnId: 'task', answer: 'Pending: sign in to DNS.', durationMs: 10, isAborted: false, reason: 'answer' })
    w.location.cwd = '/work/.claude/worktrees/wt'
    w.location.root = '/work/.claude/worktrees/wt'
    await $.turn.start({ text: 'logged in', turnId: 'in-worktree' })
    await step($, 'in-worktree', 0, 'xhigh')
    const state = JSON.parse(w.posts.at(-1)!.init!.body!).state
    expect([state.previous_request, state.task_context.previousTask?.request]).toEqual(['Migrate the hosting projects.', 'Migrate the hosting projects.'])
    // The engine logs a rejected read of a directory as an error.
    expect(w.directoryReads).toEqual([])
  })

  test('a background reply becomes the previous answer without replacing the task', async ($, on) => {
    const w = world(on)
    on('prompt.submit', ($, e) => ({ text: e.text }))
    await $.session.start(STARTED)
    await command($, 'enforce')
    const original = 'Think hard about migrating the applications.'
    await $.turn.start({ text: original, turnId: 'task' })
    await step($, 'task', 0, 'xhigh')
    await $.turn.complete({ turnId: 'task', answer: 'Started the moves; a monitor reports progress.', durationMs: 10, isAborted: false, reason: 'answer' })
    const text = '<task-notification><summary>Move finished</summary></task-notification>'
    await $.prompt.submit({ text, wait: false, origin: { kind: 'task-notification' } })
    await $.turn.start({ text, turnId: 'notification' })
    await step($, 'notification', 0, 'xhigh')
    await $.turn.complete({ turnId: 'notification', answer: 'The move finished. Please sign in to Squarespace so I can switch DNS.', durationMs: 10, isAborted: false, reason: 'answer' })
    await $.turn.start({ text: 'logged in', turnId: 'followup' })
    await step($, 'followup', 0, 'xhigh')
    const bodies = w.posts.map(p => JSON.parse(p.init!.body!)).filter(b => b.state.request === 'logged in')
    expect(bodies.length > 0).toBe(true)
    for (const { state } of bodies) {
      expect(state.previous_request).toBe(original)
      expect(state.previous_answer).toContain('sign in to Squarespace')
      expect(state.task_context.previousTask).toMatchObject({ request: original, level: 'xhigh' })
      expect(state.task_context.previousTask.answer).toContain('Started the moves')
      expect(JSON.stringify(state)).not.toContain('Move finished')
    }
    await complete($, 'followup')
    await $.turn.start({ text: 'Anything else?', turnId: 'next' })
    await step($, 'next', 0, 'xhigh')
    expect(JSON.parse(w.posts.at(-1)!.init!.body!).state.previous_answer).toBe('done')
  })

  test('unapplied abstention or failure cannot reopen lowering of a confident pick', async ($, on) => {
    const w = world(on, { answers: [{ xhigh: 1 }, { low: 1 }, { low: 1 }, { xhigh: 1 }, 503, { low: 1 }],
      contexts: ['sufficient', 'missing_scope', 'sufficient', 'sufficient', 'sufficient', 'sufficient'] })
    on('tool.call', (_$, e) => ({ result: {}, text: `source ${'file_path' in e ? e.file_path : ''}`, isReadOnly: true }))
    for (const turnId of ['abstention', 'failure']) {
      // Fresh session keeps the classifier calls for each turn deduplicated.
      await $.session.start(STARTED)
      await command($, 'enforce')
      await $.turn.start({ text: 'Explain the application', turnId })
      await step($, turnId, 0, 'high')
      await $.tool.call({ tool: 'Read', file_path: '/work/a.ts' })
      await step($, turnId, 1, 'high')
      expect(await spinner($, w.drawn)).not.toContain('router: needs context')
      await $.tool.call({ tool: 'Read', file_path: '/work/b.ts' })
      await step($, turnId, 2, 'high')
      expect(await spinner($, w.drawn)).not.toContain('kept for active work')
      await complete($, turnId)
    }
    expect(w.sent).toEqual(['xhigh', 'xhigh', 'xhigh', 'xhigh', 'xhigh', 'xhigh'])
  })

  test('a user-typed notification envelope remains part of the user task', async ($, on) => {
    const w = world(on)
    on('prompt.submit', ($, e) => ({ text: e.text }))
    await $.session.start(STARTED)
    await command($, 'enforce')
    const text = '<task-notification>Example</task-notification> Explain this XML.'
    await $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })
    await $.turn.start({ text, turnId: 'user' })
    await step($, 'user', 0, 'xhigh')
    await complete($, 'user')
    expect(w.records()[0]?.task_notification).toBe(false)
    await $.turn.start({ text: 'Continue', turnId: 'next' })
    await step($, 'next', 0, 'xhigh')
    expect(w.posts.map(p => JSON.parse(p.init!.body!)).filter(b => b.state.request === 'Continue')
      .every(b => b.state.task_context.previousTask.request === text)).toBe(true)
  })

  test('an equal-level unapplied abstention cannot reopen lowering of a confident pick', async ($, on) => {
    const w = world(on, { answers: [{ xhigh: 1 }, { low: 1 }, { low: 1 }], contexts: ['sufficient', 'missing_scope', 'sufficient'] })
    on('tool.call', (_$, e) => ({ result: {}, text: `source ${'file_path' in e ? e.file_path : ''}`, isReadOnly: true }))
    await $.session.start(STARTED)
    await command($, 'enforce')
    await $.turn.start({ text: 'Explain the application', turnId: 't1' })
    await step($, 't1', 0, 'xhigh')
    await $.tool.call({ tool: 'Read', file_path: '/work/a.ts' })
    await step($, 't1', 1, 'xhigh')
    expect(await spinner($, w.drawn)).not.toContain('router: needs context')
    await $.tool.call({ tool: 'Read', file_path: '/work/b.ts' })
    await step($, 't1', 2, 'xhigh')
    await complete($, 't1')
    expect(w.sent).toEqual(['xhigh', 'xhigh', 'xhigh'])
    expect(w.records()[0]).toMatchObject({ context_held: false, context_sufficient: true, reason: 'retained effort' })
  })

  test('successful discovery after initial failure clears the failure without inventing active work', async ($, on) => {
    const w = world(on, { answers: [503, { low: 1 }] })
    on('tool.call', () => ({ result: {}, text: 'button.onclick = () => count++', isReadOnly: true }))
    await $.session.start(STARTED)
    await command($, 'enforce')
    await $.turn.start({ text: 'Explain the application', turnId: 't1' })
    await step($, 't1', 0, 'high')
    await $.tool.call({ tool: 'Read', file_path: '/work/app.ts' })
    await step($, 't1', 1, 'high')
    await complete($, 't1')
    expect(w.sent).toEqual(['high', 'high'])
    expect(w.records()[0]).toMatchObject({ context_held: false, context_sufficient: true, reason: 'retained effort' })
    expect(await command($, 'status')).toContain('ok (')
  })

  test('a downstream prompt rewrite retains the submitted origin', async ($, on) => {
    const w = world(on)
    const rewritten = '<task-notification>Example</task-notification> Explain this XML.'
    on('prompt.submit', () => ({ text: rewritten }))
    await $.session.start(STARTED)
    await command($, 'enforce')
    await $.prompt.submit({ text: 'Explain the example.', wait: false, origin: { kind: 'composer' } })
    await $.turn.start({ text: rewritten, turnId: 'rewritten' })
    await step($, 'rewritten', 0, 'xhigh')
    await complete($, 'rewritten')
    expect(w.records()[0]?.task_notification).toBe(false)
  })

  test('late concurrency evidence raises even a low baseline after the remote discovery budget', async ($, on) => {
    const w = world(on)
    on('tool.call', ($, e) => ({ result: {}, text: 'file_path' in e && String(e.file_path).endsWith('atomic.ts') ? 'head.compare_exchange_weak(n, n->next)' : 'button.onclick = () => count++', isReadOnly: true }))
    await $.session.start(STARTED)
    await command($, 'enforce')
    await $.turn.start({ text: 'How does this work?', turnId: 't1' })
    await step($, 't1', 0, 'low')
    for (const [index, file] of ['one.ts', 'two.ts', 'atomic.ts'].entries()) {
      await $.tool.call({ tool: 'Read', file_path: `/work/${file}` })
      await step($, 't1', index + 1, 'low')
    }
    expect(w.sent).toEqual(['low', 'low', 'low', 'high'])
    expect(w.posts).toHaveLength(3)
  })

  test('failed discovery cannot retain a low pick on unassessed concurrency code', async ($, on) => {
    const w = world(on, { answers: [{ low: 1 }, { low: 1 }, 503] })
    on('tool.call', ($, e) => ({ result: {}, text: 'file_path' in e && String(e.file_path).endsWith('atomic.ts') ? 'head.compare_exchange_weak(n, n->next)' : 'button.onclick = () => count++', isReadOnly: true }))
    await $.session.start(STARTED)
    await command($, 'enforce')
    await $.turn.start({ text: 'Explain the implementation.', turnId: 't1' })
    await step($, 't1', 0, 'low')
    await $.tool.call({ tool: 'Read', file_path: '/work/counter.ts' })
    await step($, 't1', 1, 'low')
    await $.tool.call({ tool: 'Read', file_path: '/work/atomic.ts' })
    await step($, 't1', 2, 'low')
    await complete($, 't1')
    expect(w.sent).toEqual(['low', 'low', 'high'])
    expect(w.records()[0]?.missing_context).toEqual(['unassessed_evidence'])
  })

  test('discovery keeps an established continuation when the classifier changes its mind', async ($, on) => {
    const w = world(on, { contexts: ['sufficient', 'missing_scope', 'missing_scope', 'sufficient'], relations: ['new', 'continuation', 'continuation', 'new'] })
    on('tool.call', () => ({ result: {}, text: 'button.onclick = () => count++', isReadOnly: true }))
    await $.session.start(STARTED)
    await command($, 'enforce')
    await $.turn.start({ text: 'Think hard about the design.', turnId: 't1' })
    await step($, 't1', 0, 'high')
    await complete($, 't1')
    await $.turn.start({ text: 'Please carry out the proposed design.', turnId: 't2' })
    await step($, 't2', 0, 'high')
    await $.tool.call({ tool: 'Read', file_path: '/work/app.ts' })
    await step($, 't2', 1, 'high')
    await complete($, 't2')
    expect(w.sent).toEqual(['xhigh', 'xhigh', 'xhigh'])
    expect(w.records()[1]?.continuation).toBe(true)
    expect(w.posts.some(p => JSON.parse(p.init!.body!).state.continues_current_task === true)).toBe(true)
  })

  test('shadow discovery fills the prediction for the request it would have changed', async ($, on) => {
    const w = world(on, { answers: [{ low: 1 }, { after: 100, answer: { low: 1 } }], contexts: ['missing_target', 'sufficient'] })
    on('tool.call', () => ({ result: {}, text: 'button.onclick = () => count++', isReadOnly: true }))
    await $.session.start(STARTED)
    await $.turn.start({ text: 'How does this work?', turnId: 't1' })
    await step($, 't1', 0, 'high')
    await w.clock.settle()
    await $.tool.call({ tool: 'Read', file_path: '/work/app.ts' })
    await step($, 't1', 1, 'high')
    await w.clock.advance(100)
    await complete($, 't1')
    expect(w.sent).toEqual(['high', 'high'])
    expect((w.records()[0]?.steps as { would: string }[])[1]?.would).toBe('low')
  })

  test('manual max cannot escape into an automatic empty turn, which preserves task context', async ($, on) => {
    const w = world(on, { contexts: ['missing_scope'], saved: { 'claude-opus-5-5': 'xhigh' } })
    await $.session.start(STARTED)
    await command($, 'enforce')
    await $.turn.start({ text: 'Design the queue.', turnId: 't1' })
    await step($, 't1', 0, 'max')
    await complete($, 't1')
    await $.turn.start({ text: '', turnId: 't2' })
    await step($, 't2', 0, 'xhigh')
    await complete($, 't2')
    await $.turn.start({ text: 'Continue.', turnId: 't3' })
    await step($, 't3', 0, 'xhigh')
    await complete($, 't3')
    const latest = JSON.parse(w.posts.at(-1)!.init!.body!)
    expect(latest.state.task_context.previousTask.request).toBe('Design the queue.')
    expect(w.records()[1]?.would_pick).toBe('xhigh')
    expect(w.sent).toEqual(['max', 'xhigh', 'xhigh'])
  })

  test('shadow discovery does not block requests or leak a late completion into a cleared session', async ($, on) => {
    const w = world(on, { answers: [{ low: 1 }, { after: 2000, answer: { low: 1 } }], contexts: ['missing_target', 'sufficient'] })
    on('tool.call', () => ({ result: {}, text: 'button.onclick = () => count++', isReadOnly: true }))
    await $.session.start(STARTED)
    await $.turn.start({ text: 'How does this work?', turnId: 't1' })
    await step($, 't1', 0, 'high')
    await w.clock.settle()
    await $.tool.call({ tool: 'Read', file_path: '/work/index.html' })
    await step($, 't1', 1, 'high')
    expect(w.sent).toEqual(['high', 'high'])
    const completing = complete($, 't1')
    await w.clock.settle()
    w.session.id = 'after-clear'
    await $.session.start(STARTED)
    await w.clock.advance(2000)
    await completing
    expect(w.records()).toEqual([])
    expect(w.records('after-clear')).toEqual([])
    await $.turn.start({ text: '', turnId: 't2' })
    await step($, 't2', 0, 'high')
    await complete($, 't2')
    expect(w.records('after-clear')[0]).toMatchObject({ reason: 'fallback: no previous pick' })
  })
})
