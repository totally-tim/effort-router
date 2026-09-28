/**
 * Prompt-cache reuse between consecutive requests of the main conversation,
 * judged from the usage the API reported for each.
 *
 * The rule is the one Claude Code 2.1.283 applies in its `/context` cache
 * ledger: a request misses when it reads less than 95% of the smaller of the
 * two prompts from cache and falls at least 2,000 tokens short. A request
 * after one that used no cache at all is cold. This is a diagnostic over
 * token counts, not a host guarantee. Where the server placed or lost the
 * cache is not observable, so a miss that coincides with an effort change is
 * a correlation: idle expiry, compaction and host request shapes miss too.
 */

export type CacheUsage = { input: number; cacheRead: number; cacheWrite: number }

export type CacheOutcome = 'hit' | 'miss' | 'cold'

/** The share of the reusable prompt a request must read to hit. */
export const HIT_SHARE = 0.95

/** A shortfall below this many tokens is never a miss. */
export const MISS_TOKENS = 2000

/** Every input token of a request: uncached, written and read. */
export function promptOf(usage: CacheUsage): number {
  return usage.input + usage.cacheRead + usage.cacheWrite
}

export function cacheOutcomeOf(before: CacheUsage, after: CacheUsage): CacheOutcome {
  if (before.cacheRead + before.cacheWrite === 0 && after.cacheRead + after.cacheWrite > 0) {
    return 'cold'
  }

  const reusable = Math.min(promptOf(before), promptOf(after))

  return after.cacheRead < HIT_SHARE * reusable && reusable - after.cacheRead >= MISS_TOKENS ? 'miss' : 'hit'
}

/** The cache outcomes of the requests one tracker compared. */
export type CacheTally = {
  /** Requests compared with the request before them. */
  compared: number
  misses: number
  /** Tokens written to the cache by requests that missed. */
  recached: number
  /** Compared requests whose effort differed from the request before them. */
  changes: number
  changeMisses: number
}

export type TrackedRequest = {
  /** The conversation the request belongs to; a new one starts a new scope. */
  conversation?: string
  /** The model that answered: a cache belongs to one model. */
  model: string
  effort?: string | number
  /** Absent when the request failed or reported no usage. */
  usage?: CacheUsage
  at: number
}

/**
 * Compares each main-conversation request with the previous one of the same
 * conversation and model. Its scope starts at the first request it sees, so
 * after a reload of the plugin it counts only what it saw since.
 */
export class CacheTracker {
  private last: { conversation?: string; model: string; effort?: string | number; usage: CacheUsage } | undefined
  tally: CacheTally = { compared: 0, misses: 0, recached: 0, changes: 0, changeMisses: 0 }
  /** When the current scope started; undefined before its first request. */
  since: number | undefined

  record(request: TrackedRequest): { cache?: CacheOutcome; effortChanged?: true } {
    // Claude Code's ledger also skips a request without usage: nothing was
    // read or written, and the next request compares with the one before.
    if (!request.usage) return {}

    if (this.last && this.last.conversation !== request.conversation) {
      this.reset()
    }

    const last = this.last
    this.last = { conversation: request.conversation, model: request.model, effort: request.effort, usage: request.usage }
    this.since ??= request.at

    // The first request of a scope has nothing to compare with, and a model
    // switch forfeits the cache by design: neither is an outcome.
    if (!last || last.model !== request.model) return {}

    const cache = cacheOutcomeOf(last.usage, request.usage)
    const changed = last.effort !== request.effort
    const miss = cache === 'miss'

    this.tally = {
      compared: this.tally.compared + 1,
      misses: this.tally.misses + (miss ? 1 : 0),
      recached: this.tally.recached + (miss ? request.usage.cacheWrite : 0),
      changes: this.tally.changes + (changed ? 1 : 0),
      changeMisses: this.tally.changeMisses + (changed && miss ? 1 : 0),
    }

    return changed ? { cache, effortChanged: true } : { cache }
  }

  /** A main request went by unseen: the next one has nothing to compare with. */
  gap(): void {
    this.last = undefined
  }

  reset(): void {
    this.last = undefined
    this.tally = { compared: 0, misses: 0, recached: 0, changes: 0, changeMisses: 0 }
    this.since = undefined
  }

  /** The status line; undefined until two requests were compared. */
  line(): string | undefined {
    const { compared, misses, recached, changes, changeMisses } = this.tally

    if (compared === 0 || this.since === undefined) return undefined

    const tokens = recached >= 1000 ? `${(recached / 1000).toFixed(1)}k` : String(recached)
    const since = new Date(this.since).toISOString().slice(11, 16)

    return `cache since ${since} UTC (usage estimate): misses at ${changeMisses} of ${changes} requests after an effort change, ` +
      `${misses - changeMisses} of ${compared - changes} others; ${tokens} tokens re-cached`
  }
}
