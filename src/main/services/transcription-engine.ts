import fs from 'node:fs/promises'
import os from 'node:os'
import { ManagedServer } from './managed-server'
import type { Logger } from '../logger'
import { LIMITS } from '../../shared/constants'

export interface TranscriptionResult {
  text: string
  ms: number
}

export interface Transcriber {
  readonly modelId: string | null
  isReady(): boolean
  ensureReady(): Promise<void>
  transcribe(wavPath: string, language: string): Promise<TranscriptionResult>
}

export class TranscriptionError extends Error {
  constructor(
    readonly code:
      'TRANSCRIPTION_TIMEOUT' | 'TRANSCRIPTION_FAILED' | 'SPEECH_RUNTIME_UNAVAILABLE' | 'AUDIO_MISSING',
    message: string
  ) {
    super(message)
  }
}

/** whisper.cpp's whisper-server, kept warm in a child process. */
export class WhisperEngine implements Transcriber {
  server: ManagedServer | null = null
  modelId: string | null = null
  private config: { binary: string; modelPath: string } | null = null

  constructor(private readonly logger: Logger) {}

  /** (Re)configures the model. Restarts the server only if binary or model changed. */
  async configure(binary: string, modelPath: string, modelId: string): Promise<void> {
    if (this.config?.binary === binary && this.config?.modelPath === modelPath && this.server) return
    await this.server?.stop()
    this.config = { binary, modelPath }
    this.modelId = modelId
    this.server = new ManagedServer({
      name: 'whisper-server',
      binary,
      args: ['-m', modelPath, '-t', String(threadCount()), '--no-timestamps', '-nth', '0.6', '-sns'],
      healthPath: '/health',
      startupTimeoutMs: 60_000,
      logger: this.logger
    })
  }

  isReady(): boolean {
    return this.server?.state === 'ready'
  }

  async ensureReady(): Promise<void> {
    if (!this.server)
      throw new TranscriptionError('SPEECH_RUNTIME_UNAVAILABLE', 'No speech model is installed.')
    try {
      await this.server.start()
    } catch (err) {
      throw new TranscriptionError('SPEECH_RUNTIME_UNAVAILABLE', (err as Error).message)
    }
  }

  async transcribe(wavPath: string, language: string): Promise<TranscriptionResult> {
    await this.ensureReady()
    let audio: Buffer
    try {
      audio = await fs.readFile(wavPath)
    } catch {
      throw new TranscriptionError('AUDIO_MISSING', 'The audio file for this capture is missing.')
    }
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(audio)], { type: 'audio/wav' }), 'capture.wav')
    form.append('response_format', 'json')
    form.append('temperature', '0.0')
    form.append('language', language)
    form.append('no_timestamps', 'true')
    const t0 = Date.now()
    let res: Response
    try {
      res = await fetch(`${this.server!.baseUrl}/inference`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(LIMITS.transcriptionTimeoutMs)
      })
    } catch (err) {
      if ((err as Error).name === 'TimeoutError') {
        throw new TranscriptionError('TRANSCRIPTION_TIMEOUT', 'Transcription took too long.')
      }
      throw new TranscriptionError('TRANSCRIPTION_FAILED', 'The speech engine stopped responding.')
    }
    if (!res.ok)
      throw new TranscriptionError('TRANSCRIPTION_FAILED', `Speech engine error (HTTP ${res.status}).`)
    const body = (await res.json().catch(() => null)) as { text?: unknown; error?: unknown } | null
    if (!body || typeof body.text !== 'string') {
      throw new TranscriptionError('TRANSCRIPTION_FAILED', 'Speech engine returned an unexpected response.')
    }
    return { text: cleanTranscript(body.text), ms: Date.now() - t0 }
  }
}

/** Removes whisper's non-speech markers like [BLANK_AUDIO], (music), [inaudible]. */
export function cleanTranscript(text: string): string {
  return text
    .replace(/\[[^\]]{0,40}\]/g, ' ')
    .replace(/\((?:music|silence|inaudible|applause|laughs?|coughs?|noise|wind|static)[^)]*\)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, LIMITS.maxTranscriptChars)
}

export function threadCount(): number {
  const cpus = os.availableParallelism?.() ?? os.cpus().length
  return Math.max(2, Math.min(8, Math.floor(cpus / 2)))
}
