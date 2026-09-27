/** Bounded evidence shared by the live router and transcript replay. */
export type Observation = { tool: string; target?: string; text: string }
export type Repository = { cwd: string; summary: string }
export type Task = { request: string; answer?: string; level?: string; observations: Observation[] }
export type TaskContext = { repository?: Repository; observations: Observation[]; previousTask?: Task }

export const MAX_OBSERVATIONS = 4
const SENSITIVE = /(?:^|[\/\\\s"'=])(?:\.env(?:\.[\w-]+)*|\.envrc|\.npmrc|\.pypirc|\.netrc|\.git-credentials|\.kube[\/\\]+config|\.docker[\/\\]+config\.json|id_(?:rsa|ed25519|ecdsa|dsa)(?:\.pub)?|(?:secrets?|credentials?)(?:\.[\w-]+)*|providers\.json|[^/\s]*\.(?:pem|key))(?=$|[\/\\\s"':*?])/i

export function sensitiveSource(text: string): boolean { return SENSITIVE.test(text) }

/** Output must name a path; prose such as "rejects invalid credentials" is evidence. */
export function sensitiveOutput(text: string): boolean {
  return text.split(/[\s"'=<>]+/).some(token => /[./\\]/.test(token) && sensitiveSource(token))
}

export function redact(text: string): string {
  return text.replace(/-----BEGIN [^-]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY(?: BLOCK)?-----|$)/g, '[redacted private key]')
    .replace(/(\bauthorization["']?\s*[:=][ \t]*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s"'][^\r\n]*)/gi, '$1[redacted]')
    .replace(/(\b[a-z][\w+.-]*:\/\/)[^/\s@]+@/gi, '$1[redacted]@')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk-[\w-]{12,}|[sr]k_(?:live|test)_[\w]+|gh[pousr]_[\w]{16,}|xox[baprs]-[\w-]+|AKIA[A-Z0-9]{16}|eyJ[\w-]+\.[\w-]+\.[\w-]+)\b/g, '[redacted]')
    .replace(/(\b(?:[\w-]*(?:authorization|api[_-]?key|token|password|secret)[\w-]*|[\w-]+_PASS|client-key-data|auth)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,"'}]+)/gi, '$1[redacted]')
}

export function excerpt(text: string, limit: number): string {
  const clean = redact(text)
  const marker = '\n[truncated]\n'
  const head = Math.floor((limit - marker.length) * 0.7)
  return clean.length <= limit ? clean : `${clean.slice(0, head)}${marker}${clean.slice(-(limit - marker.length - head))}`
}

/** Only successful inspection tools contribute evidence. Shell output is omitted. */
export function observationOf(tool: string, input: Record<string, unknown>, text: string, failed = false): Observation | undefined {
  if (failed || !['Read', 'Grep', 'Glob'].includes(tool) || !text.trim()) return undefined
  if (SENSITIVE.test(JSON.stringify(input)) || (tool !== 'Read' && sensitiveOutput(text))) return undefined
  if (/^\s*(?:No (?:files|matches)(?: found)?[.!]?|\[?empty\]?)\s*$/i.test(text)) return undefined
  if (tool === 'Grep' && input.output_mode !== 'content') return undefined
  const target = String(input.file_path ?? input.path ?? input.pattern ?? '')
  if (SENSITIVE.test(target)) return undefined
  return { tool, ...(target ? { target: excerpt(target, 240) } : {}), text: excerpt(text, 1600) }
}

export function hasTargetEvidence(observations: readonly Observation[]): boolean {
  return observations.some(o => o.tool === 'Read' || o.tool === 'Grep')
}

export function addObservation(observations: readonly Observation[], next: Observation): Observation[] {
  const all = [...observations.filter(item => item.tool !== next.tool || item.target !== next.target || item.text !== next.text), next]
  const sources = all.filter(o => o.tool !== 'Glob').slice(-MAX_OBSERVATIONS)
  const room = MAX_OBSERVATIONS - sources.length
  const kept = new Set([...sources, ...(room > 0 ? all.filter(o => o.tool === 'Glob').slice(-room) : [])])
  return all.filter(o => kept.has(o))
}

export function isContinuation(request: string): boolean {
  return /^(?:yes[,.!]?\s*)?(?:do (?:it|that)|go ahead|continue|proceed|implement (?:it|that|the plan)|make (?:those|these) changes|carry on)[.!\s]*$/i.test(request.trim()) || /^yes[.!\s]*$/i.test(request.trim())
}

export function hasUnresolvedReference(request: string): boolean {
  return !/```/.test(request) && /\b(?:how (?:does|do) (?:this|that|it|these|those) work|explain (?:this|that|it)|fix (?:this|that|it)|refactor (?:this|that|it))\b/i.test(request)
}

export function isSelfContainedReply(request: string): boolean {
  return /^(?:reply|respond|say)(?: with)? (?:exactly |only |just )?(?:"[^"\n]{1,60}"|'[^'\n]{1,60}'|OK|yes|no|hello|ready|done|pong)[.!]?$/i.test(request.trim())
}

export function hasRoutingInstruction(text: string): boolean {
  return /(?:\b(?:classifier|router|systemone|rubric)\s*[:!-][^\n]{0,100}\b(?:ignore|output|choose|pick|return)\b|\bignore\b[^\n]{0,80}\b(?:instructions|rubric)\b[^\n]{0,80}\b(?:low|medium|high|xhigh|effort|classifier|systemone)\b)/i.test(text)
}

/** Explicit concurrency operations justify a floor for semantic code analysis. */
export function needsConcurrencyReasoning(request: string, observations: readonly Observation[]): boolean {
  if (!/\b(?:explain|understand|review|audit|debug|prove|analy[sz]e|reason about)\b|\bhow\b[^\n]{0,60}\bworks?\b/i.test(request)) return false
  return observations.some(o => /\b(?:smp_(?:mb|rmb|wmb|mb__after_spinlock|cond_load_acquire)|memory_order_(?:acquire|release|acq_rel|seq_cst)|atomic_thread_fence|atomic_compare_exchange(?:_weak|_strong)?|compare_exchange(?:_weak|_strong)?|Atomics\.compareExchange|Ordering::(?:Acquire|Release|AcqRel|SeqCst))\b/.test(o.text))
}

export function boundedContext(context: TaskContext): TaskContext {
  const observations = (items: Observation[]) => items.slice(-MAX_OBSERVATIONS).map(o => ({
    tool: o.tool.slice(0, 40), ...(o.target ? { target: excerpt(o.target, 240) } : {}), text: excerpt(o.text, 1600),
  }))
  return {
    ...(context.repository ? { repository: { cwd: context.repository.cwd, summary: excerpt(context.repository.summary, 1600) } } : {}),
    observations: observations(context.observations),
    ...(context.previousTask ? { previousTask: {
      request: excerpt(context.previousTask.request, 1500), answer: excerpt(context.previousTask.answer ?? '', 1200),
      level: context.previousTask.level, observations: observations(context.previousTask.observations),
    } } : {}),
  }
}

/** A repository description is a prior, not proof that a task's target was inspected. */
export async function repositoryOf(cwd: string, read: (path: string) => Promise<string | undefined>): Promise<Repository> {
  const parts = await Promise.all(['README.md', 'package.json', 'Cargo.toml', 'pyproject.toml'].map(async name => {
    const value = await read(`${cwd.replace(/\/$/, '')}/${name}`).catch(() => undefined)
    return value ? `${name}: ${excerpt(value, 650)}` : ''
  }))
  return { cwd, summary: excerpt(parts.filter(Boolean).join('\n'), 1600) }
}
