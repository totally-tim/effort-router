/**
 * The most a log file grows before the log moves on to a new file. `$.fs.read`
 * reads at most 4 MiB, and a reloaded plugin must be able to read its log.
 */
export const MAX_LOG_BYTES = 3 * 1024 * 1024

const byteLength = (text: string): number => new TextEncoder().encode(text).byteLength

/**
 * One session's JSONL decision log. `$.fs.write` replaces a whole file, so
 * the log keeps its lines and writes them all each time, one write at a time.
 * A write that fails is dropped; the next one carries every line again.
 *
 * `existing` is the file's text when the log opens: a reload of the plugin
 * mid-session starts with empty memory, and would otherwise overwrite the
 * session's earlier records. Past `maxBytes` the log continues in
 * `<name>.<n>.jsonl` and leaves the full file as it is.
 */
export class DecisionLog {
  private lines: string[]
  private bytes: number
  private part = 0
  private pending: Promise<void> = Promise.resolve()
  private first: Record<string, unknown> | undefined

  constructor(
    public path: string,
    private readonly write: (path: string, text: string) => Promise<void>,
    existing = '',
    private readonly maxBytes = MAX_LOG_BYTES,
  ) {
    this.lines = existing.split('\n').filter(line => line.trim() !== '')
    this.bytes = this.lines.reduce((sum, line) => sum + byteLength(line) + 1, 0)
    this.first = firstTurnOf(this.lines)
  }

  /**
   * `key` of the session's first turn record: what a reloaded plugin
   * recovers of the session.
   */
  firstOf(key: string): unknown {
    return this.first?.[key]
  }

  append(record: object): Promise<void> {
    const line = JSON.stringify(record)

    if (!this.first && (record as { type?: unknown }).type === 'turn') {
      this.first = record as Record<string, unknown>
    }

    if (this.lines.length > 0 && this.bytes + byteLength(line) + 1 > this.maxBytes) {
      this.part += 1
      this.path = this.path.replace(/(\.\d+)?\.jsonl$/, `.${this.part}.jsonl`)
      this.lines = []
      this.bytes = 0
    }

    this.lines.push(line)
    this.bytes += byteLength(line) + 1

    const text = this.lines.join('\n') + '\n'
    const path = this.path

    this.pending = this.pending
      .then(() => this.write(path, text))
      .catch(() => undefined)

    return this.pending
  }
}

/** The first turn record of a log's lines: what a later instance recovers of the session. */
export function firstTurnOf(lines: readonly string[]): Record<string, unknown> | undefined {
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>

      if (parsed.type === 'turn') {
        return parsed
      }
    } catch {
      // A line another writer tore; skip it.
    }
  }

  return undefined
}
