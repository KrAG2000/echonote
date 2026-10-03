import { spawn, type ChildProcess } from 'node:child_process'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import type { Logger } from '../logger'

/**
 * Supervises one long-lived local inference server (whisper-server or llama-server) bound to
 * 127.0.0.1 on a random free port. Keeps the model warm between requests, restarts it after a
 * crash (bounded), and reports readiness through `state`.
 *
 * Child stdout is discarded and stderr is only kept in a small in-memory ring buffer, because
 * whisper-server prints transcripts; the buffer is surfaced only for startup failures.
 */
export type ServerState = 'stopped' | 'starting' | 'ready' | 'error'

export interface ManagedServerOptions {
  name: string
  binary: string
  /** Arguments excluding --host/--port, which are appended automatically. */
  args: string[]
  healthPath: string
  startupTimeoutMs: number
  logger: Logger
  maxRestarts?: number
  restartWindowMs?: number
}

export class ManagedServer extends EventEmitter {
  state: ServerState = 'stopped'
  port: number | null = null
  lastError: string | null = null
  loadMs: number | null = null

  private child: ChildProcess | null = null
  private stderrTail: string[] = []
  private stopping = false
  private restarts: number[] = []
  private startPromise: Promise<void> | null = null

  constructor(private readonly opts: ManagedServerOptions) {
    super()
  }

  get baseUrl(): string {
    if (!this.port) throw new Error(`${this.opts.name} is not running`)
    return `http://127.0.0.1:${this.port}`
  }

  /** Starts the server (no-op if running) and resolves once /health reports ready. */
  start(): Promise<void> {
    if (this.state === 'ready') return Promise.resolve()
    if (this.startPromise) return this.startPromise
    this.startPromise = this.doStart().finally(() => {
      this.startPromise = null
    })
    return this.startPromise
  }

  private async doStart(): Promise<void> {
    if (!fs.existsSync(this.opts.binary)) {
      this.setState('error', `Runtime binary not found: ${path.basename(this.opts.binary)}`)
      throw new Error(this.lastError!)
    }
    this.stopping = false
    this.stderrTail = []
    this.port = await freePort()
    this.setState('starting', null)
    const t0 = Date.now()
    const args = [...this.opts.args, '--host', '127.0.0.1', '--port', String(this.port)]
    this.opts.logger.info(`${this.opts.name}: starting`, { port: this.port })
    // setpriv --pdeathsig makes the kernel kill the server if EchoNote dies without cleaning up
    // (crash, SIGKILL), so a model never stays resident in memory on its own.
    const [cmd, cmdArgs] = SETPRIV
      ? [SETPRIV, ['--pdeathsig', 'KILL', this.opts.binary, ...args]]
      : [this.opts.binary, args]
    const child = spawn(cmd, cmdArgs, {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, LD_LIBRARY_PATH: path.dirname(this.opts.binary) }
    })
    this.child = child
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (!line.trim()) continue
        this.stderrTail.push(line.slice(0, 300))
        if (this.stderrTail.length > 40) this.stderrTail.shift()
      }
    })
    child.on('error', (err) => {
      this.opts.logger.error(`${this.opts.name}: spawn error`, { err })
      this.lastError = err.message
    })
    child.on('exit', (code, signal) => this.onExit(child, code, signal))

    try {
      await this.waitForHealth(child, t0)
      this.loadMs = Date.now() - t0
      this.setState('ready', null)
      this.opts.logger.info(`${this.opts.name}: ready`, { loadMs: this.loadMs })
    } catch (err) {
      const tail = this.stderrTail.slice(-6).join(' | ')
      this.opts.logger.error(`${this.opts.name}: failed to start`, { err: err as Error, stderr: tail })
      this.kill(child)
      this.setState('error', (err as Error).message)
      throw err
    }
  }

  private async waitForHealth(child: ChildProcess, t0: number): Promise<void> {
    while (Date.now() - t0 < this.opts.startupTimeoutMs) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`${this.opts.name} exited during startup (${child.exitCode ?? child.signalCode})`)
      }
      try {
        const res = await fetch(`http://127.0.0.1:${this.port}${this.opts.healthPath}`, {
          signal: AbortSignal.timeout(1000)
        })
        if (res.ok) return
      } catch {
        /* not listening yet */
      }
      await sleep(150)
    }
    throw new Error(
      `${this.opts.name} did not become ready within ${Math.round(this.opts.startupTimeoutMs / 1000)}s`
    )
  }

  private onExit(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (child !== this.child) return
    this.child = null
    this.port = null
    if (this.stopping) {
      this.setState('stopped', null)
      return
    }
    this.opts.logger.warn(`${this.opts.name}: exited unexpectedly`, { code, signal })
    if (this.state !== 'ready') return // startup failure is handled by doStart
    const window = this.opts.restartWindowMs ?? 5 * 60_000
    const now = Date.now()
    this.restarts = this.restarts.filter((t) => now - t < window)
    if (this.restarts.length >= (this.opts.maxRestarts ?? 3)) {
      this.setState('error', `${this.opts.name} crashed repeatedly; restart it from Settings.`)
      return
    }
    this.restarts.push(now)
    this.setState('stopped', 'Restarting after a crash…')
    setTimeout(() => {
      if (!this.stopping) this.start().catch(() => undefined)
    }, 1000 * this.restarts.length)
  }

  async stop(): Promise<void> {
    this.stopping = true
    const child = this.child
    if (!child) {
      this.setState('stopped', null)
      return
    }
    await new Promise<void>((resolve) => {
      const done = (): void => resolve()
      child.once('exit', done)
      this.kill(child)
      setTimeout(done, 3000)
    })
    this.child = null
    this.port = null
    this.setState('stopped', null)
  }

  /** Synchronous best-effort kill for app shutdown. */
  killNow(): void {
    this.stopping = true
    if (this.child) this.child.kill('SIGKILL')
  }

  /** Resets the crash counter so a user-initiated restart is always attempted. */
  resetRestartBudget(): void {
    this.restarts = []
  }

  private kill(child: ChildProcess): void {
    if (child.exitCode !== null) return
    child.kill('SIGTERM')
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }, 2000).unref()
  }

  private setState(state: ServerState, error: string | null): void {
    this.state = state
    this.lastError = error
    this.emit('state', state)
  }
}

const SETPRIV = ['/usr/bin/setpriv', '/bin/setpriv'].find((p) => fs.existsSync(p)) ?? null

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      srv.close(() => (addr && typeof addr === 'object' ? resolve(addr.port) : reject(new Error('no port'))))
    })
  })
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
