import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import type { ModelManager } from './model-manager'
import type { WhisperEngine } from './transcription-engine'
import type { LlamaEngine } from './classification-engine'
import type { Logger } from '../logger'
import type { RuntimeStatus, Settings } from '../../shared/types'

/**
 * Decides when the two inference servers start, which model each uses, and whether the
 * machine has enough free memory for the LLM. Emits 'change' whenever readiness changes.
 */
export class RuntimeManager extends EventEmitter {
  private llmBlocked: string | null = null

  constructor(
    private readonly models: ModelManager,
    readonly whisper: WhisperEngine,
    readonly llama: LlamaEngine,
    private readonly binDir: string,
    private readonly logger: Logger,
    private readonly settings: () => Settings
  ) {
    super()
  }

  private bin(name: string): string {
    return path.join(this.binDir, name)
  }

  speechStatus(): RuntimeStatus {
    const id = this.settings().speechModelId
    if (!fs.existsSync(this.bin('whisper-server'))) {
      return {
        state: 'missing_runtime',
        modelId: id,
        message: 'Speech runtime is missing from this build.',
        loadMs: null
      }
    }
    if (!this.models.isVerified(id)) {
      return { state: 'missing_model', modelId: id, message: 'Speech model not downloaded.', loadMs: null }
    }
    return fromServer(this.whisper.server, id)
  }

  llmStatus(): RuntimeStatus {
    const id = this.settings().llmModelId
    if (!fs.existsSync(this.bin('llama-server'))) {
      return {
        state: 'missing_runtime',
        modelId: id,
        message: 'LLM runtime is missing from this build.',
        loadMs: null
      }
    }
    if (!this.models.isVerified(id)) {
      return { state: 'missing_model', modelId: id, message: 'Language model not downloaded.', loadMs: null }
    }
    if (this.llmBlocked)
      return { state: 'insufficient_memory', modelId: id, message: this.llmBlocked, loadMs: null }
    const s = fromServer(this.llama.server, id)
    if (s.state === 'ready' && this.llama.warming) {
      return { ...s, state: 'starting', message: 'Preparing the model (one-time warm-up)…' }
    }
    if (s.state === 'stopped' && this.settings().llmIdleUnloadMinutes > 0 && this.llama.server) {
      return { ...s, message: 'Unloaded while idle; it reloads automatically.' }
    }
    return s
  }

  async startSpeech(): Promise<void> {
    const id = this.settings().speechModelId
    if (!this.models.isVerified(id)) return
    await this.whisper.configure(this.bin('whisper-server'), this.models.pathFor(id), id)
    this.watch(this.whisper.server)
    this.emit('change')
    this.whisper.server!.resetRestartBudget()
    await this.whisper
      .server!.start()
      .catch((err) => this.logger.warn('runtime: speech start failed', { err }))
    this.emit('change')
  }

  /** Starts the LLM unless free memory is below the model's minimum (override with force). */
  async startLlm(force = false): Promise<void> {
    const id = this.settings().llmModelId
    const entry = this.models.entry(id)
    if (!entry || !this.models.isVerified(id)) return
    const avail = availableMemoryMB()
    if (!force && avail !== null && avail < entry.minMemoryMB) {
      this.llmBlocked = `Only ${avail} MB of memory is free; ${entry.name} needs about ${entry.minMemoryMB} MB. Captures are still saved and will be organized once the model loads.`
      this.logger.warn('runtime: not enough memory for LLM', { avail, need: entry.minMemoryMB })
      this.emit('change')
      return
    }
    this.llmBlocked = null
    this.llama.idleUnloadMinutes = this.settings().llmIdleUnloadMinutes
    await this.llama.configure(
      this.bin('llama-server'),
      this.models.pathFor(id),
      id,
      entry.runtime.contextSize ?? 4096
    )
    this.watch(this.llama.server)
    this.emit('change')
    this.llama.server!.resetRestartBudget()
    // Hold the model back from the pipeline until the prompt cache is warm (set before start(),
    // because the server's own 'ready' event already triggers a pipeline resume).
    this.llama.warming = true
    await this.llama.server!.start().catch((err) => this.logger.warn('runtime: llm start failed', { err }))
    const warmMs = await this.llama.warmUp()
    if (warmMs !== null) this.logger.info('runtime: llm prompt cache warmed', { ms: warmMs })
    this.llama.touch()
    this.emit('change')
  }

  /** For idle-unloaded LLMs: reload on demand when there is work. */
  async ensureLlmLoaded(): Promise<void> {
    if (this.llama.server && this.llama.server.state === 'stopped' && !this.llmBlocked) await this.startLlm()
  }

  async stopAll(): Promise<void> {
    await Promise.all([this.whisper.server?.stop(), this.llama.server?.stop()])
  }

  killAll(): void {
    this.whisper.server?.killNow()
    this.llama.server?.killNow()
  }

  private watched = new WeakSet<object>()
  private watch(server: EventEmitter | null): void {
    if (!server || this.watched.has(server)) return
    this.watched.add(server)
    server.on('state', () => this.emit('change'))
  }
}

function fromServer(
  server: { state: string; lastError: string | null; loadMs: number | null } | null,
  modelId: string
): RuntimeStatus {
  if (!server) return { state: 'stopped', modelId, message: null, loadMs: null }
  const state = server.state as RuntimeStatus['state']
  return { state, modelId, message: server.lastError, loadMs: server.loadMs }
}

/** MemAvailable from /proc/meminfo, in MB (null where unavailable). */
export function availableMemoryMB(): number | null {
  try {
    const m = /MemAvailable:\s+(\d+) kB/.exec(fs.readFileSync('/proc/meminfo', 'utf8'))
    return m ? Math.round(Number(m[1]) / 1024) : null
  } catch {
    return null
  }
}
