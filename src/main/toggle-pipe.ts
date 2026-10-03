import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import type { Logger } from './logger'

/**
 * Fast path for the desktop keyboard shortcut.
 *
 * Launching a second EchoNote instance with `--toggle` works everywhere, but from an AppImage it
 * takes ~2.7 s (FUSE mount + Electron start) before the running instance hears about it. Instead,
 * the running app listens on a named pipe in $XDG_RUNTIME_DIR (a per-user 0700 directory), and the
 * shortcut command writes one byte to it (~10 ms). If EchoNote is not running, the command falls back
 * to launching it with `--toggle`.
 */
export function togglePipePath(userData: string): string {
  const base = process.env.XDG_RUNTIME_DIR || os.tmpdir()
  const tag = crypto.createHash('sha1').update(userData).digest('hex').slice(0, 10)
  return path.join(base, 'echonote', `toggle-${tag}`)
}

export class TogglePipe {
  private stream: net.Socket | null = null

  constructor(
    readonly file: string,
    private readonly logger: Logger,
    private readonly onToggle: () => void
  ) {}

  start(): boolean {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
      try {
        if (!fs.statSync(this.file).isFIFO()) fs.rmSync(this.file, { force: true })
      } catch {
        /* does not exist */
      }
      if (!fs.existsSync(this.file)) execFileSync('mkfifo', ['-m', '600', this.file])
      // O_RDWR keeps the pipe open between writers, so we never see EOF and never block on open.
      // net.Socket (libuv pipe handle) handles the non-blocking fd; fs streams fail with EAGAIN.
      const fd = fs.openSync(this.file, fs.constants.O_RDWR | fs.constants.O_NONBLOCK)
      this.stream = new net.Socket({ fd, readable: true, writable: false })
      this.stream.on('data', (chunk: Buffer) => {
        for (let i = 0; i < chunk.length; i++) this.onToggle()
      })
      this.stream.on('error', (err) => this.logger.warn('toggle-pipe: error', { err }))
      this.logger.info('toggle-pipe: listening')
      return true
    } catch (err) {
      this.logger.warn('toggle-pipe: unavailable', { err: err as Error })
      return false
    }
  }

  stop(): void {
    this.stream?.destroy()
    this.stream = null
    fs.rmSync(this.file, { force: true })
  }
}

/**
 * Shell command for the desktop shortcut: write to the pipe if EchoNote is running, otherwise
 * start it with --toggle. `exe` is the AppImage path (or electron + app path in development).
 */
export function shortcutCommand(pipe: string, exe: string[]): string {
  const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`
  const script =
    'f=$1; shift; if [ -p "$f" ] && printf t | timeout 1 tee "$f" >/dev/null; then exit 0; fi; exec "$@" --toggle'
  return ['sh', '-c', script, 'echonote-toggle', pipe, ...exe].map(q).join(' ')
}
