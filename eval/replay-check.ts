import { strict as assert } from 'node:assert'
const tests: [string, () => unknown][] = []
const describe = (_name: string, run: () => void) => run()
const test = (name: string, run: () => unknown) => { tests.push([name, run]) }
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ProjectFs } from '../hooks/context'
import { extract, legacyRequest, routingVersion } from './replay'

async function fixture(rows: unknown[], run: (path: string) => unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'effort-replay-'))
  try {
    const path = join(dir, 'session.jsonl')
    writeFileSync(path, rows.map(r => JSON.stringify(r)).join('\n'))
    await run(path)
  } finally { rmSync(dir, { recursive: true, force: true }) }
}
const at = (n: number) => `2026-09-20T00:00:0${n}.000Z`
const user = (text: string, n: number) => ({ type: 'user', entrypoint: 'cli', cwd: '/work', timestamp: at(n), message: { content: text } })
const assistant = (id: string, blocks: unknown[], n: number) => ({ type: 'assistant', timestamp: at(n), effort: 'high', message: { id, content: blocks, usage: { input_tokens: 10, output_tokens: 20 } } })

describe('historical replay boundaries', () => {
  test('initial routing excludes later evidence and credential reads stay out of judge evidence', () => fixture([
    user('How does this work?', 0),
    assistant('a', [{ type: 'tool_use', id: 'read', name: 'Read', input: { file_path: '/work/app.ts' } }], 1),
    { type: 'user', timestamp: at(2), message: { content: [{ type: 'tool_result', tool_use_id: 'read', content: 'button.onclick = () => count++; '.repeat(8) }] } },
    assistant('b', [{ type: 'tool_use', id: 'secret', name: 'Read', input: { file_path: '/work/secrets/providers.json' } }], 3),
    { type: 'user', timestamp: at(4), message: { content: [{ type: 'tool_result', tool_use_id: 'secret', content: 'DO_NOT_EXPORT_THIS_VALUE' }] } },
    assistant('c', [{ type: 'text', text: 'The click handler increments the counter.' }], 5),
    user('Yes, implement that.', 6),
    assistant('d', [{ type: 'text', text: 'The continued task uses the earlier inspected click handler. '.repeat(4) }], 7),
  ], async path => {
    const rows = await extract(path, 'claude')
    assert.equal(rows.length, 2)
    assert.equal(rows[0]!.input.context!.observations.length, 0)
    assert.equal(rows[0]!.discovery[0]!.target, '/work/app.ts')
    assert.ok(!rows[0]!.judgeEvidence.includes('DO_NOT_EXPORT_THIS_VALUE'))
    assert.equal(rows[1]!.input.context!.previousTask!.observations[0]!.target, '/work/app.ts')
    assert.ok(!JSON.stringify(rows[1]!.input).includes('DO_NOT_EXPORT_THIS_VALUE'))
    assert.ok(!rows[0]!.judgeEvidence.includes('continued task'))
  }))
  test('Codex shell output does not become a Claude inspection event', () => fixture([
    { type: 'session_meta', payload: { cwd: '/work' } },
    { type: 'response_item', timestamp: at(0), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Explain the parser.' }] } },
    { type: 'response_item', timestamp: at(1), payload: { type: 'function_call', name: 'exec_command', call_id: 'tool', arguments: '{"cmd":"cat parser.ts"}' } },
    { type: 'response_item', timestamp: at(2), payload: { type: 'function_call_output', call_id: 'tool', output: 'parser source '.repeat(20) } },
    { type: 'token_usage_record', timestamp: at(3), payload: { usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 10 } } },
  ], async path => {
    const [row] = await extract(path, 'codex')
    assert.deepEqual(row!.discovery, [])
    assert.ok(row!.judgeEvidence.includes('parser source'))
    assert.equal(row!.outcome.requests, 1); assert.equal(row!.outcome.cacheRead, 80)
  }))
  test('the frozen comparison request never receives new task evidence', () => {
    const body = legacyRequest({ request: 'Explain it', context: { observations: [{ tool: 'Read', text: 'new evidence' }] } }) as any
    assert.deepEqual(body.state, { request: 'Explain it' })
    assert.deepEqual(Object.keys(body.questions), ['effort'])
  })
  test('earlier exchanges keep answer tails; shell actions end discovery but not task memory', () => fixture([
    user('Explain alpha.', 0),
    assistant('a', [{ type: 'text', text: 'FIRST_ANSWER_HEAD ' + 'detail '.repeat(200) + 'TAIL_MARKER' }], 1),
    user('Update beta.', 2),
    assistant('b', [{ type: 'tool_use', id: 'edit', name: 'Bash', input: { command: 'modify beta' } }], 3),
    { type: 'user', timestamp: at(4), message: { content: [{ type: 'tool_result', tool_use_id: 'edit', content: 'changed beta '.repeat(20) }] } },
    assistant('c', [{ type: 'tool_use', id: 'read', name: 'Read', input: { file_path: '/work/beta.ts' } }], 5),
    { type: 'user', timestamp: at(6), message: { content: [{ type: 'tool_result', tool_use_id: 'read', content: 'source after mutation '.repeat(20) }] } },
    user('Explain gamma.', 7),
    assistant('d', [{ type: 'text', text: 'Gamma explanation. '.repeat(20) }], 8),
  ], async path => {
    const rows = await extract(path, 'claude')
    assert.equal(rows.length, 3)
    assert.deepEqual(rows[1]!.discovery, [])
    assert.ok(rows[2]!.input.earlier![0]!.answer!.startsWith('FIRST_ANSWER_HEAD'))
    assert.ok(rows[2]!.input.earlier![0]!.answer!.includes('TAIL_MARKER'))
    // The live router observes every inspection of the turn, including one after an edit.
    assert.equal(rows[2]!.input.context!.previousTask!.observations[0]!.target, '/work/beta.ts')
  }))
  test('the latest background reply is the previous answer; the original task stays the task', () => fixture([
    user('Migrate the applications.', 0),
    assistant('a', [{ type: 'text', text: 'Application deployment has finished. The migration now needs DNS cutover and verification of the new records. Pending: sign in to DNS.' }], 1),
    { ...user('Image copy finished', 2), isMeta: true, origin: { kind: 'task-notification' } },
    assistant('b', [{ type: 'text', text: 'LATEST_BACKGROUND_REPLY: please sign in to the DNS console.' }], 3),
    user('I logged you in.', 4),
    assistant('c', [{ type: 'text', text: 'Continuing the DNS cutover with the existing application inventory. I will check each new record and verify that all services remain reachable.' }], 5),
  ], async path => {
    const rows = await extract(path, 'claude')
    assert.equal(rows.length, 2)
    assert.equal(rows[0]!.outcome.requests, 1)
    const input = rows[1]!.input
    assert.equal(input.previousRequest, 'Migrate the applications.')
    assert.equal(input.previousAnswer, 'LATEST_BACKGROUND_REPLY: please sign in to the DNS console.')
    assert.equal(input.context!.previousTask!.request, 'Migrate the applications.')
    assert.ok(input.context!.previousTask!.answer!.includes('sign in to DNS'))
    assert.ok(!JSON.stringify(input.earlier).includes('LATEST_BACKGROUND_REPLY'))
  }))
  test('a stamped user message with a notification envelope is retained', () => {
    const text = '<task-notification>Example</task-notification> Explain this XML.'
    return fixture([
      { ...user(text, 0), origin: { kind: 'composer' } },
      assistant('a', [{ type: 'text', text: 'The XML represents a background completion notification. This is a user-provided example to explain, rather than an actual event from a running background task.' }], 1),
      user('Continue the explanation.', 2),
      assistant('b', [{ type: 'text', text: 'The tag wraps the details of the completed task. A real notification may include its identifier, its completion status, and a summary of the output.' }], 3),
    ], async path => {
      const rows = await extract(path, 'claude')
      assert.equal(rows.length, 2)
      assert.equal(rows[1]!.input.previousRequest, text)
    })
  })
  test('memory keeps the final visible text of a turn, not text from before its tool calls', () => fixture([
    user('Check the build and report.', 0),
    assistant('a', [{ type: 'text', text: 'EARLY_TEXT before running the build.' }, { type: 'tool_use', id: 'run', name: 'Bash', input: { command: 'make' } }], 1),
    { type: 'user', timestamp: at(2), message: { content: [{ type: 'tool_result', tool_use_id: 'run', content: 'build ok '.repeat(20) }] } },
    assistant('b', [{ type: 'text', text: 'FINAL_TEXT: the build passes.' }], 3),
    user('Now summarize the result for the team.', 4),
    assistant('c', [{ type: 'text', text: 'Summary for the team: the build passes on the current branch and no action is needed from anyone today.' }], 5),
  ], async path => {
    const rows = await extract(path, 'claude')
    assert.equal(rows[1]!.input.previousAnswer, 'FINAL_TEXT: the build passes.')
    assert.ok(rows[0]!.judgeEvidence.includes('EARLY_TEXT'))
  }))
})

describe('delivery, resets and project identity', () => {
  const answer = (id: string, n: number, text = `Answer ${id}: ${'the requested change is complete and verified. '.repeat(3)}`) => assistant(id, [{ type: 'text', text }], n)
  test('prompts delivered together are one task, as the batch helper defines it', () => fixture([
    user('Explain the retry policy.', 0), answer('a', 1),
    { ...user('HARD-TASK: redesign the scheduler.', 2), origin: { kind: 'human' } },
    { ...user('Reply with OK.', 2), origin: { kind: 'human' } },
    answer('b', 3, 'OK. The scheduler redesign needs a plan for fairness and starvation before any change.'),
    user('Continue.', 4), answer('c', 5),
  ], async path => {
    const rows = await extract(path, 'claude')
    assert.equal(rows.length, 3)
    assert.equal(rows[1]!.input.request, 'HARD-TASK: redesign the scheduler.\n\nReply with OK.')
    assert.equal(rows[1]!.input.previousRequest, 'Explain the retry policy.')
    assert.deepEqual(rows[1]!.provenance!.batch, 2)
    assert.equal(rows[2]!.input.previousRequest, 'HARD-TASK: redesign the scheduler.\n\nReply with OK.')
  }))
  test('a prompt that reached no model is neither a task nor memory', () => fixture([
    user('Explain the retry policy.', 0), answer('a', 1),
    user('Delete the build folder.', 2),
    { type: 'user', timestamp: at(3), message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } },
    user('Explain the cache policy instead.', 4), answer('b', 5),
  ], async path => {
    const rows = await extract(path, 'claude')
    assert.deepEqual(rows.map(r => r.input.request), ['Explain the retry policy.', 'Explain the cache policy instead.'])
    assert.equal(rows[1]!.input.previousRequest, 'Explain the retry policy.')
    assert.equal(rows[1]!.provenance!.batch, undefined)
  }))
  test('an interruption after the model answered is how the last turn went', () => fixture([
    user('Refactor the parser.', 0), answer('a', 1),
    { type: 'user', timestamp: at(2), message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } },
    user('Explain the lexer instead.', 3), answer('b', 4),
  ], async path => {
    const rows = await extract(path, 'claude')
    assert.deepEqual(rows[1]!.input.previousTurn, { toolErrors: 0, requests: 1, interrupted: true })
  }))
  test('prompts absorbed by the running turn join its task memory, not its classified request', () => fixture([
    user('Write the migration guide.', 0),
    { type: 'attachment', timestamp: at(1), attachment: { type: 'queued_command', prompt: 'Keep it to one page.', origin: { kind: 'human' } } },
    { type: 'attachment', timestamp: at(1), attachment: { type: 'queued_command', prompt: '<task-notification>done</task-notification>', origin: { kind: 'task-notification' } } },
    answer('a', 2), user('Publish it.', 3), answer('b', 4),
  ], async path => {
    const rows = await extract(path, 'claude')
    assert.equal(rows[0]!.input.request, 'Write the migration guide.')
    assert.equal(rows[0]!.provenance!.delivered, 2)
    assert.equal(rows[1]!.input.previousRequest, 'Write the migration guide.\n\nKeep it to one page.')
  }))
  test('/clear starts empty memory', () => fixture([
    user('Explain the retry policy.', 0), answer('a', 1),
    { ...user('<command-name>/clear</command-name>\n<command-message>clear</command-message>', 2) },
    user('Continue.', 3), answer('b', 4),
  ], async path => {
    const rows = await extract(path, 'claude')
    assert.equal(rows[1]!.input.previousRequest, undefined)
    assert.equal(rows[1]!.input.context!.previousTask, undefined)
    assert.equal(rows[1]!.provenance!.cleared, true)
  }))
  test('root moves follow project identity; a gone directory keeps memory and is marked', () => {
    // A worktree of /work, another repository, and a directory that no longer exists.
    const disk: Record<string, string | null> = { '/work/.git': null, '/work/.claude/worktrees/wt/.git': 'gitdir: /work/.git/worktrees/wt\n',
      '/work/.git/worktrees/wt/commondir': '../..\n', '/other/.git': null }
    const known = (p: string) => p in disk || Object.keys(disk).some(k => k.startsWith(`${p}/`))
    const fs: ProjectFs = {
      exists: async p => known(p),
      stat: async p => { if (!known(p)) throw Error('ENOENT'); return { kind: typeof disk[p] === 'string' ? 'file' : 'dir', realPath: p } },
      read: async p => { const t = disk[p]; if (typeof t !== 'string') throw Error('EISDIR'); return t },
    }
    const moved = (dir: string, n: number) => ({ type: 'relocated', timestamp: at(n), relocatedCwd: dir })
    return fixture([
      user('Migrate the hosting projects.', 0), answer('a', 1),
      moved('/work/.claude/worktrees/wt', 2), { ...user('logged in', 3), cwd: '/work/.claude/worktrees/wt' }, answer('b', 4),
      moved('/gone/tree', 5), user('Keep going.', 6), answer('c', 7),
      moved('/other', 8), user('Explain the build.', 9), answer('d', 10),
    ], async path => {
      const rows = await extract(path, 'claude', { fs })
      assert.equal(rows[1]!.input.previousRequest, 'Migrate the hosting projects.')
      assert.equal(rows[1]!.provenance!.project, undefined)
      assert.equal(rows[2]!.input.previousRequest, 'logged in')
      assert.equal(rows[2]!.provenance!.project, 'unverified')
      assert.equal(rows[3]!.input.previousRequest, 'Keep going.')
      assert.equal(rows[3]!.provenance!.project, 'unverified')
    })
  })
  test('a move between known repositories starts empty memory; a shell cd does not', () => {
    const fs: ProjectFs = {
      exists: async p => ['/work', '/work/.git', '/other', '/other/.git'].includes(p),
      stat: async p => ({ kind: 'dir', realPath: p }),
      read: async () => { throw Error('EISDIR') },
    }
    return fixture([
      user('Migrate the hosting projects.', 0), answer('a', 1),
      { ...user('Now check the logs.', 2), cwd: '/work/nested/repo' }, answer('b', 3),
      { type: 'relocated', timestamp: at(4), relocatedCwd: '/other' }, user('Explain the build.', 5), answer('c', 6),
    ], async path => {
      const rows = await extract(path, 'claude', { fs })
      assert.equal(rows[1]!.input.previousRequest, 'Migrate the hosting projects.')
      assert.equal(rows[2]!.input.previousRequest, undefined)
      assert.equal(rows[2]!.input.context!.previousTask, undefined)
    })
  })
  test('memory the live router derived from classifier answers is marked unknown', () => fixture([
    user('Explain the retry policy.', 0), answer('a', 1),
    user('Add jitter to it.', 2), answer('b', 3),
    user('Continue.', 4), answer('c', 5),
  ], async path => {
    const rows = await extract(path, 'claude')
    assert.equal(rows[0]!.provenance!.unknown, undefined)
    assert.deepEqual(rows[1]!.provenance!.unknown, ['previousTask.level'])
    // Whether "Add jitter to it." continued the retry task depends on the classifier's relation answer.
    assert.deepEqual(rows[2]!.provenance!.unknown, ['previousTask.level', 'previousTask.request'])
  }))
})

describe('Codex turns', () => {
  const ms = (n: number) => `2026-09-20T00:00:00.${String(n).padStart(3, '0')}Z`
  const started = (turn: string, n: number) => ({ type: 'event_msg', timestamp: ms(n), payload: { type: 'task_started', turn_id: turn } })
  const ended = (turn: string, n: number, type = 'task_complete') => ({ type: 'event_msg', timestamp: ms(n), payload: { type, turn_id: turn, ...(type === 'turn_aborted' ? { reason: 'interrupted' } : {}) } })
  const said = (text: string, n: number) => ({ type: 'response_item', timestamp: ms(n), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } })
  const reply = (text: string, n: number) => [{ type: 'response_item', timestamp: ms(n), payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } },
    { type: 'token_usage_record', timestamp: ms(n), payload: { usage: { input_tokens: 10, output_tokens: 5 } } }]
  const SKILL = '<skill>\n<name>svpg-skill-update</name>\nUpdate the installed skills to the latest revision.\n</skill>'
  test('a skill command and its expansion in one turn are one task, keyed by the expansion', () => fixture([
    started('a', 0), said('<environment_context>cwd</environment_context>', 1), said('$svpg-skill-update', 343), said(SKILL, 347), ...reply('Updating the skills now.', 400), ended('a', 500),
  ], async path => {
    const rows = await extract(path, 'codex')
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.input.request, `$svpg-skill-update\n\n${SKILL}`)
    assert.equal(rows[0]!.provenance!.batch, 2)
    assert.equal(rows[0]!.timestamp, ms(347))
  }))
  test('plugin recommendations are host text: never the request, and alone never a task', () => fixture([
    started('a', 0), said('<recommended_plugins>\nHere is a list of plugins</recommended_plugins>', 10), said('Update my open issues.', 176), ...reply('Updated the issues.', 200), ended('a', 250),
    started('b', 300), said('<recommended_plugins>\nHere is a list of plugins</recommended_plugins>', 310), said('You are reviewing this change as a code review agent.', 320), ...reply('Review done.', 400), ended('b', 450),
  ], async path => {
    const rows = await extract(path, 'codex')
    assert.deepEqual(rows.map(r => r.input.request), ['Update my open issues.'])
    assert.equal(rows[0]!.provenance!.batch, undefined)
  }))
  test('an aborted turn that reached no model leaves no task and no memory', () => fixture([
    started('a', 0), said('upgrade', 10), said('<turn_aborted>\nThe user interrupted the previous turn.\n</turn_aborted>', 17), ended('a', 18, 'turn_aborted'),
    started('b', 400), said('Update my open issues.', 510), ...reply('Updated the issues.', 600), ended('b', 700),
  ], async path => {
    const rows = await extract(path, 'codex')
    assert.deepEqual(rows.map(r => r.input.request), ['Update my open issues.'])
    assert.equal(rows[0]!.input.previousRequest, undefined)
    assert.equal(rows[0]!.provenance!.unplaced, undefined)
  }))
  test('a turn interrupted after the model answered is remembered as interrupted', () => fixture([
    started('a', 0), said('Refactor the parser.', 10), ...reply('Starting the refactor.', 50), said('<turn_aborted>\ninterrupted\n</turn_aborted>', 60), ended('a', 61, 'turn_aborted'),
    started('b', 100), said('Explain the lexer instead.', 110), ...reply('The lexer splits tokens.', 150), ended('b', 160),
  ], async path => {
    const rows = await extract(path, 'codex')
    assert.deepEqual(rows.map(r => r.input.request), ['Refactor the parser.', 'Explain the lexer instead.'])
    assert.equal(rows[1]!.input.previousRequest, 'Refactor the parser.')
    assert.deepEqual(rows[1]!.input.previousTurn, { toolErrors: 0, requests: 1, interrupted: true })
  }))
  test('a subagent completion is a background reply, and never joins a typed request', () => fixture([
    started('a', 0), said('Build the site.', 10), ...reply('Started a subagent for the build.', 50), ended('a', 60),
    started('b', 100), said('<subagent_notification>build finished</subagent_notification>', 110), ...reply('SUBAGENT_REPLY: the build finished.', 150), ended('b', 160),
    started('c', 200), said('<subagent_notification>tests finished</subagent_notification>', 210), said('Deploy it.', 220), ...reply('Deploying.', 250), ended('c', 260),
  ], async path => {
    const rows = await extract(path, 'codex')
    assert.deepEqual(rows.map(r => r.input.request), ['Build the site.', 'Deploy it.'])
    assert.equal(rows[1]!.input.previousRequest, 'Build the site.')
    assert.equal(rows[1]!.input.previousAnswer, 'SUBAGENT_REPLY: the build finished.')
    // Both prompts entered the turn; only the typed one is the request.
    assert.equal(rows[1]!.provenance!.batch, 2)
  }))
  test('without turn boundaries, prompts are never joined and a dropped prompt is marked', () => fixture([
    { type: 'session_meta', payload: { cwd: '/work' } },
    said('Fix the flaky test.', 10), said('Explain the retry policy.', 20), ...reply('Retries back off exponentially.', 50),
  ], async path => {
    const rows = await extract(path, 'codex')
    assert.deepEqual(rows.map(r => r.input.request), ['Explain the retry policy.'])
    assert.equal(rows[0]!.input.previousRequest, undefined)
    assert.equal(rows[0]!.provenance!.unplaced, 1)
  }))
})

describe('routing fingerprint', () => {
  test('every file under hooks is a routing input, including a module added later', () => {
    const tree = mkdtempSync(join(tmpdir(), 'effort-tree-'))
    try {
      cpSync(fileURLToPath(new URL('../hooks', import.meta.url)), join(tree, 'hooks'), { recursive: true })
      const base = routingVersion(tree)
      assert.equal(base, routingVersion(fileURLToPath(new URL('..', import.meta.url))))
      writeFileSync(join(tree, 'hooks/register.ts'), '// memory behavior changed\n', { flag: 'a' })
      const changedRegister = routingVersion(tree)
      assert.notEqual(changedRegister, base)
      writeFileSync(join(tree, 'hooks/state.ts'), 'export const persisted = true\n')
      assert.notEqual(routingVersion(tree), changedRegister)
    } finally { rmSync(tree, { recursive: true, force: true }) }
  })
})

let failed = 0
for (const [name, run] of tests) {
  try {
    await run()
    console.log(`PASS ${name}`)
  } catch (error) {
    failed++
    console.log(`FAIL ${name}: ${String(error instanceof Error ? error.message : error).split('\n')[0]}`)
  }
}
if (failed > 0) process.exit(1)
