import { strict as assert } from 'node:assert'
const describe = (_name: string, run: () => void) => run()
const test = (name: string, run: () => void) => { run(); console.log(`PASS ${name}`) }
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extract, legacyRequest } from './replay'

function fixture(rows: unknown[], run: (path: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'effort-replay-'))
  try {
    const path = join(dir, 'session.jsonl')
    writeFileSync(path, rows.map(r => JSON.stringify(r)).join('\n'))
    run(path)
  } finally { rmSync(dir, { recursive: true, force: true }) }
}
const at = (n: number) => `2026-09-20T00:00:0${n}.000Z`
const user = (text: string, n: number) => ({ type: 'user', entrypoint: 'cli', cwd: '/work', timestamp: at(n), message: { content: text } })
const assistant = (id: string, blocks: unknown[], n: number) => ({ type: 'assistant', timestamp: at(n), effort: 'high', message: { id, content: blocks, usage: { input_tokens: 10, output_tokens: 20 } } })

describe('historical replay boundaries', () => {
  test('initial routing excludes later evidence and credential reads stay out of judge evidence', () => {
    fixture([
      user('How does this work?', 0),
      assistant('a', [{ type: 'tool_use', id: 'read', name: 'Read', input: { file_path: '/work/app.ts' } }], 1),
      { type: 'user', timestamp: at(2), message: { content: [{ type: 'tool_result', tool_use_id: 'read', content: 'button.onclick = () => count++; '.repeat(8) }] } },
      assistant('b', [{ type: 'tool_use', id: 'secret', name: 'Read', input: { file_path: '/work/secrets/providers.json' } }], 3),
      { type: 'user', timestamp: at(4), message: { content: [{ type: 'tool_result', tool_use_id: 'secret', content: 'DO_NOT_EXPORT_THIS_VALUE' }] } },
      assistant('c', [{ type: 'text', text: 'The click handler increments the counter.' }], 5),
      user('Yes, implement that.', 6),
      assistant('d', [{ type: 'text', text: 'The continued task uses the earlier inspected click handler. '.repeat(4) }], 7),
    ], path => {
      const rows = extract(path, 'claude')
      assert.equal(rows.length, 2)
      assert.equal(rows[0]!.input.context!.observations.length, 0)
      assert.equal(rows[0]!.discovery[0]!.target, '/work/app.ts')
      assert.ok(!rows[0]!.judgeEvidence.includes('DO_NOT_EXPORT_THIS_VALUE'))
      assert.equal(rows[1]!.input.context!.previousTask!.observations[0]!.target, '/work/app.ts')
      assert.ok(!rows[0]!.judgeEvidence.includes('continued task'))
    })
  })
  test('Codex shell output does not become a Claude inspection event', () => {
    fixture([
      { type: 'session_meta', payload: { cwd: '/work' } },
      { type: 'response_item', timestamp: at(0), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Explain the parser.' }] } },
      { type: 'response_item', timestamp: at(1), payload: { type: 'function_call', name: 'exec_command', call_id: 'tool', arguments: '{"cmd":"cat parser.ts"}' } },
      { type: 'response_item', timestamp: at(2), payload: { type: 'function_call_output', call_id: 'tool', output: 'parser source '.repeat(20) } },
      { type: 'token_usage_record', timestamp: at(3), payload: { usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 10 } } },
    ], path => {
      const [row] = extract(path, 'codex')
      assert.deepEqual(row!.discovery, [])
      assert.ok(row!.judgeEvidence.includes('parser source'))
      assert.equal(row!.outcome.requests, 1); assert.equal(row!.outcome.cacheRead, 80)
    })
  })
  test('the frozen comparison request never receives new task evidence', () => {
    const body = legacyRequest({ request: 'Explain it', context: { observations: [{ tool: 'Read', text: 'new evidence' }] } }) as any
    assert.deepEqual(body.state, { request: 'Explain it' })
    assert.deepEqual(Object.keys(body.questions), ['effort'])
  })
  test('earlier exchanges use answer heads and shell actions end discovery', () => {
    fixture([
      user('Explain alpha.', 0),
      assistant('a', [{ type: 'text', text: 'FIRST_ANSWER_HEAD ' + 'detail '.repeat(200) + 'TAIL_MARKER' }], 1),
      user('Update beta.', 2),
      assistant('b', [{ type: 'tool_use', id: 'edit', name: 'Bash', input: { command: 'modify beta' } }], 3),
      { type: 'user', timestamp: at(4), message: { content: [{ type: 'tool_result', tool_use_id: 'edit', content: 'changed beta '.repeat(20) }] } },
      assistant('c', [{ type: 'tool_use', id: 'read', name: 'Read', input: { file_path: '/work/beta.ts' } }], 5),
      { type: 'user', timestamp: at(6), message: { content: [{ type: 'tool_result', tool_use_id: 'read', content: 'source after mutation '.repeat(20) }] } },
      user('Explain gamma.', 7),
      assistant('d', [{ type: 'text', text: 'Gamma explanation. '.repeat(20) }], 8),
    ], path => {
      const rows = extract(path, 'claude')
      assert.equal(rows.length, 3)
      assert.deepEqual(rows[1]!.discovery, [])
      assert.ok(rows[2]!.input.earlier![0]!.answer!.startsWith('FIRST_ANSWER_HEAD'))
      assert.ok(!rows[2]!.input.earlier![0]!.answer!.includes('TAIL_MARKER'))
    })
  })
})
