#!/usr/bin/env bun
/**
 * Shares of main-loop turns at each effort level in the decision logs, per policy. `sent` is the level the
 * turn's first request carried. Each logged candidate replays as that first request. A candidate replaces the
 * first decision, so it applies only where the first request carried that decision (`sent` equals `decided`).
 * Other turns count at `sent` under every policy, as do turns without the candidate: a failed decision sends
 * the same under any rule. The replay covers the log files of v0.4.2 and later, which log candidates.
 *
 * The replay is an upper bound for a candidate that lowers levels. It keeps the continuation floors that the
 * logged rule passed on, and it re-asks nothing: discovery, mid-turn messages and later requests are not replayed.
 * Reads only the logs; prints counts, never prompt text.
 *
 *   bun eval/levels.ts [--logs DIR] [--days 30] [--until ISO-TIME]
 */
import { readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

type Row = Record<string, any>
const args = process.argv.slice(2)
const option = (name: string, fallback: string) => args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1]! : fallback
const logs = option('logs', join(homedir(), '.local/state/effort-router'))
const until = new Date(option('until', new Date().toISOString()))
const since = new Date(until.getTime() - Number(option('days', '30')) * 86_400_000)
const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']
const rank = (level: unknown) => LEVELS.indexOf(String(level))

function turnsOf(name: string): Row[] {
  return readFileSync(join(logs, name), 'utf8').split('\n').flatMap(line => {
    try {
      const row = JSON.parse(line) as Row
      return row.type === 'turn' ? [row] : []
    } catch {
      return []
    }
  })
}

// Each plugin instance writes its own files, so a file holds one version's records.
const files = readdirSync(logs).filter(name => name.endsWith('.jsonl')).map(turnsOf)
const inWindow = (t: Row) => new Date(t.ts) >= since && new Date(t.ts) <= until
const turns = files.flat().filter(inWindow)
const replayed = files.filter(rows => rows.some(t => 'origin' in t || 'candidates' in t || 'decided' in t)).flat().filter(inWindow)
const policies = ['sent', ...new Set(replayed.flatMap(t => Object.keys(t.candidates ?? {})))]
const levelOf = (t: Row, policy: string) => policy !== 'sent' && t.sent === t.decided && t.candidates?.[policy] ? t.candidates[policy] : t.sent
const percent = (n: number, of: number) => of ? `${(100 * n / of).toFixed(1)}%` : '-'
const share = (rows: Row[], policy: string, level: string) => {
  const n = rows.filter(t => levelOf(t, policy) === level).length
  return `${n} (${percent(n, rows.length)})`
}

function levels(title: string, rows: Row[], columns: string[]) {
  const shown = LEVELS.filter(level => rows.some(t => columns.some(p => levelOf(t, p) === level)))
  console.log(`\n${title} (${rows.length} turns)\n`)
  console.log(`| Policy | ${shown.join(' | ')} |\n|---|${shown.map(() => '---:').join('|')}|`)
  for (const policy of columns) console.log(`| ${policy} | ${shown.map(level => share(rows, policy, level)).join(' | ')} |`)
}

console.log(`Window ${since.toISOString()} to ${until.toISOString()}: ${turns.length} turns, ${replayed.length} from v0.4.2 or later, ${replayed.filter(t => t.candidates).length} with candidates.`)
levels('All turns, as sent', turns, ['sent'])
levels('Turns from v0.4.2 or later', replayed, policies)
levels('Of these, classifier fallbacks', replayed.filter(t => String(t.reason).startsWith('fallback')), ['sent'])

console.log('\nxhigh share by origin\n')
console.log(`| Origin | Turns | ${policies.join(' | ')} |\n|---|---:|${policies.map(() => '---:').join('|')}|`)
for (const origin of [...new Set(replayed.map(t => t.origin ?? 'none'))]) {
  const rows = replayed.filter(t => (t.origin ?? 'none') === origin)
  console.log(`| ${origin} | ${rows.length} | ${policies.map(p => share(rows, p, 'xhigh')).join(' | ')} |`)
}

console.log('\nTurns a candidate changes, against sent\n')
console.log('| Policy | Lower | Higher | Lower from xhigh |\n|---|---:|---:|---:|')
for (const policy of policies.slice(1)) {
  const delta = (t: Row) => rank(levelOf(t, policy)) - rank(t.sent)
  console.log(`| ${policy} | ${replayed.filter(t => delta(t) < 0).length} | ${replayed.filter(t => delta(t) > 0).length} | ${replayed.filter(t => delta(t) < 0 && t.sent === 'xhigh').length} |`)
}
