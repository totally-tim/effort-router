import { readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** The live router's default `logDir`. */
const LOG_DIR = join(homedir(), '.local/state/effort-router')

const logNames = new Map<string, string[]>()
const orcaChats = new Map<string, boolean>()

/**
 * The transcript entrypoints whose prompts a person typed in a session: the
 * terminal (`cli`), plus the SDK host (`sdk-ts`) when the session is a chat
 * that Orca opened. A transcript records nothing of Orca. The live router
 * marks each turn of such a chat `orca_chat` in its decision log, so the log
 * is the only witness.
 */
export function entrypointsOf(session: string, logDir = LOG_DIR): readonly string[] {
  return isOrcaChat(session, logDir) ? ['cli', 'sdk-ts'] : ['cli']
}

/** Whether a decision log of `session` under `logDir` marks a turn `orca_chat`; the folder is listed once. */
function isOrcaChat(session: string, logDir: string): boolean {
  const key = JSON.stringify([logDir, session])
  const known = orcaChats.get(key)
  if (known !== undefined) return known

  let names = logNames.get(logDir)
  if (!names) {
    try { names = readdirSync(logDir).filter(name => name.endsWith('.jsonl')) } catch { names = [] }
    logNames.set(logDir, names)
  }

  const marked = names.some(name => {
    if (!name.startsWith(`${session}.`)) return false
    try { return readFileSync(join(logDir, name), 'utf8').includes('"orca_chat":true') } catch { return false }
  })

  orcaChats.set(key, marked)
  return marked
}
