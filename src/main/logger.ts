import fs from 'node:fs'
import path from 'node:path'

/**
 * Small rotating file logger. Never pass transcripts, note contents or audio to it:
 * callers log ids, codes, sizes and timings only.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void
  info(msg: string, meta?: Record<string, unknown>): void
  warn(msg: string, meta?: Record<string, unknown>): void
  error(msg: string, meta?: Record<string, unknown>): void
  readonly file: string | null
}

const MAX_BYTES = 1024 * 1024
const KEEP_FILES = 3

export function createLogger(dir: string | null, opts: { echo?: boolean } = {}): Logger {
  const file = dir ? path.join(dir, 'echonote.log') : null
  let size = 0
  if (dir && file) {
    fs.mkdirSync(dir, { recursive: true })
    try {
      size = fs.statSync(file).size
    } catch {
      size = 0
    }
  }

  const rotate = (): void => {
    if (!file) return
    for (let i = KEEP_FILES - 1; i >= 1; i--) {
      const from = i === 1 ? file : `${file}.${i - 1}`
      try {
        fs.renameSync(from, `${file}.${i}`)
      } catch {
        /* missing file is fine */
      }
    }
    size = 0
  }

  const write = (level: LogLevel, msg: string, meta?: Record<string, unknown>): void => {
    const line =
      JSON.stringify({ t: new Date().toISOString(), level, msg, ...(meta ? { meta: safeMeta(meta) } : {}) }) +
      '\n'
    if (opts.echo) (level === 'error' ? console.error : console.log)(line.trimEnd())
    if (!file) return
    try {
      if (size + line.length > MAX_BYTES) rotate()
      fs.appendFileSync(file, line)
      size += Buffer.byteLength(line)
    } catch {
      // Logging must never take the app down (e.g. disk full).
    }
  }

  return {
    file,
    debug: (m, x) => write('debug', m, x),
    info: (m, x) => write('info', m, x),
    warn: (m, x) => write('warn', m, x),
    error: (m, x) => write('error', m, x)
  }
}

/** Errors are reduced to name/code/message, and long strings are clipped. */
function safeMeta(meta: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(meta)) {
    if (v instanceof Error) {
      out[k] = { name: v.name, code: (v as NodeJS.ErrnoException).code, message: clip(v.message) }
    } else if (typeof v === 'string') {
      out[k] = clip(v)
    } else {
      out[k] = v
    }
  }
  return out
}

function clip(s: string): string {
  return s.length > 300 ? s.slice(0, 300) + '…' : s
}

export const nullLogger: Logger = createLogger(null)
