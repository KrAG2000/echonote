import type { CapturesRepo } from '../database/captures-repo'
import type { RemindersRepo } from '../database/reminders-repo'
import type { Db } from '../database/connection'
import { transaction } from '../database/connection'
import type { Logger } from '../logger'
import type { Transcriber } from './transcription-engine'
import { TranscriptionError } from './transcription-engine'
import type { Classifier } from './classification-engine'
import { ClassificationError } from './classification-engine'
import { validateClassification } from './validation-service'
import type { PipelineActivity, Settings } from '../../shared/types'
import { CATEGORY_LABELS, LIMITS } from '../../shared/constants'

export interface PipelineEvents {
  changed(): void
  result(captureId: string, stage: 'transcribed' | 'classified' | 'failed', text: string): void
  activity(): void
}

export interface PipelineDeps {
  db: Db
  captures: CapturesRepo
  reminders: RemindersRepo
  transcriber: Transcriber
  classifier: Classifier
  logger: Logger
  settings: () => Settings
  deleteAudio: (path: string) => Promise<void>
  events: PipelineEvents
  /** Lets tests run retries without waiting. */
  retryDelayMs?: number
}

/**
 * Capture -> transcript -> classification, as two independent serial queues.
 *
 * Invariants:
 *  - the transcript is persisted before classification starts
 *  - a classification failure never touches the transcript; the capture stays in the inbox
 *  - each capture id is queued at most once per stage (dedupe), and results are applied with
 *    conditional UPDATEs, so retries are idempotent and never create duplicate records
 */
export class Pipeline {
  private tQueue: string[] = []
  private cQueue: string[] = []
  private tRunning: string | null = null
  private cRunning: string | null = null
  private stopped = false

  constructor(private readonly d: PipelineDeps) {}

  activity(): PipelineActivity {
    return {
      transcribing: this.tRunning,
      classifying: this.cRunning,
      queuedTranscription: [...this.tQueue],
      queuedClassification: [...this.cQueue]
    }
  }

  enqueueTranscription(id: string): void {
    if (this.stopped || this.tRunning === id || this.tQueue.includes(id)) return
    if (this.tQueue.length >= LIMITS.maxQueueLength) return // stays 'processing' in the DB; resume() picks it up
    this.tQueue.push(id)
    this.d.events.activity()
    void this.pumpTranscription()
  }

  enqueueClassification(id: string): void {
    if (this.stopped || this.cRunning === id || this.cQueue.includes(id)) return
    if (this.cQueue.length >= LIMITS.maxQueueLength) return
    this.mark(id, 'classificationQueued')
    this.cQueue.push(id)
    this.d.events.activity()
    void this.pumpClassification()
  }

  /** Re-queues persisted work: used at startup and whenever a runtime becomes ready. */
  resume(): void {
    for (const id of this.d.captures.idsByStatus('failed')) {
      const c = this.d.captures.get(id)
      if (c?.errorCode === 'SPEECH_RUNTIME_UNAVAILABLE' && this.d.captures.resetForTranscription(id)) {
        this.d.events.changed()
      }
    }
    for (const id of this.d.captures.idsByStatus('processing')) this.enqueueTranscription(id)
    if (this.d.classifier.isReady()) {
      for (const id of this.d.captures.pendingClassification(LIMITS.maxClassifyAttempts))
        this.enqueueClassification(id)
    }
  }

  /** User-initiated retry from the UI. */
  retry(id: string): { ok: boolean; message: string } {
    const c = this.d.captures.get(id)
    if (!c) return { ok: false, message: 'Capture not found.' }
    if (c.status === 'failed') {
      if (!this.d.captures.resetForTranscription(id)) {
        return { ok: false, message: 'The audio for this capture is no longer available.' }
      }
      this.d.events.changed()
      this.enqueueTranscription(id)
      return { ok: true, message: 'Transcription queued.' }
    }
    if (c.status === 'inbox' || c.status === 'needs_confirmation') {
      transaction(this.d.db, () => {
        this.d.captures.resetForClassification(id)
        this.d.reminders.syncForCapture(id)
      })
      this.d.events.changed()
      this.enqueueClassification(id)
      return {
        ok: true,
        message: this.d.classifier.isReady()
          ? 'Organizing again…'
          : 'Queued; it will be organized once the language model is ready.'
      }
    }
    return { ok: false, message: 'Nothing to retry for this capture.' }
  }

  stop(): void {
    this.stopped = true
    this.tQueue = []
    this.cQueue = []
  }

  // -------------------------------------------------------------------------

  private async pumpTranscription(): Promise<void> {
    if (this.tRunning) return
    while (!this.stopped && this.tQueue.length) {
      const id = this.tQueue.shift()!
      this.tRunning = id
      this.d.events.activity()
      try {
        await this.transcribeOne(id)
      } catch (err) {
        this.d.logger.error('pipeline: transcription crashed', { id, err: err as Error })
      }
      this.tRunning = null
      this.d.events.activity()
    }
  }

  private async pumpClassification(): Promise<void> {
    if (this.cRunning) return
    while (!this.stopped && this.cQueue.length) {
      const id = this.cQueue.shift()!
      this.cRunning = id
      this.d.events.activity()
      try {
        await this.classifyOne(id)
      } catch (err) {
        this.d.logger.error('pipeline: classification crashed', { id, err: err as Error })
      }
      this.cRunning = null
      this.d.events.activity()
    }
  }

  private async transcribeOne(id: string): Promise<void> {
    const { captures, logger } = this.d
    const c = captures.get(id)
    if (!c || c.status !== 'processing') return
    const audioPath = captures.getAudioPath(id)
    if (!audioPath) {
      captures.setTranscriptionFailed(id, 'AUDIO_MISSING', 'The audio for this capture is missing.')
      this.d.events.changed()
      return
    }
    captures.markTranscribeAttempt(id)
    this.mark(id, 'transcriptionStarted')
    let text: string
    try {
      const r = await this.d.transcriber.transcribe(audioPath, this.d.settings().speechLanguage)
      text = r.text
      this.mark(id, 'transcriptionFinished')
      logger.info('pipeline: transcribed', { id, ms: r.ms, chars: text.length })
    } catch (err) {
      const code = err instanceof TranscriptionError ? err.code : 'TRANSCRIPTION_FAILED'
      const message = err instanceof TranscriptionError ? err.message : 'Transcription failed.'
      logger.warn('pipeline: transcription failed', { id, code })
      // A crashed worker gets one automatic retry once it has restarted.
      if (code === 'TRANSCRIPTION_FAILED' && captures.getTranscribeAttempts(id) < 2) {
        setTimeout(() => this.enqueueTranscription(id), this.d.retryDelayMs ?? 3000)
        return
      }
      captures.setTranscriptionFailed(id, code, message)
      this.d.events.changed()
      this.d.events.result(id, 'failed', message)
      return
    }

    if (!text) {
      captures.setTranscriptionFailed(id, 'EMPTY_TRANSCRIPT', 'No speech was detected in this recording.')
      this.d.events.changed()
      this.d.events.result(id, 'failed', 'No speech detected')
      return
    }

    captures.setTranscript(id, text, this.d.transcriber.modelId ?? 'unknown')
    this.mark(id, 'transcriptPersisted')
    if (!this.d.settings().keepAudio) {
      captures.clearAudio(id)
      await this.d
        .deleteAudio(audioPath)
        .catch((err) => logger.warn('pipeline: audio cleanup failed', { err }))
    }
    this.d.events.changed()
    this.d.events.result(id, 'transcribed', text)
    this.enqueueClassification(id)
  }

  private async classifyOne(id: string): Promise<void> {
    const { captures, logger } = this.d
    const c = captures.get(id)
    if (!c || c.status !== 'inbox' || !c.transcript) return
    if (!this.d.classifier.isReady()) {
      captures.setClassificationError(id, 'LLM_UNAVAILABLE', 'Waiting for the language model to load.', false)
      this.d.events.changed()
      return
    }

    let lastError = {
      code: 'INVALID_MODEL_OUTPUT',
      message: 'The model returned output that could not be used.'
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      this.mark(id, 'llmStarted')
      let raw: string
      try {
        const out = await this.d.classifier.classify(c.transcript, { temperature: attempt === 0 ? 0 : 0.3 })
        raw = out.raw
        this.mark(id, 'llmFinished')
        logger.info('pipeline: classified', { id, ms: out.ms, attempt })
      } catch (err) {
        const code = err instanceof ClassificationError ? err.code : 'LLM_FAILED'
        const message = err instanceof ClassificationError ? err.message : 'Classification failed.'
        logger.warn('pipeline: classification failed', { id, code })
        // Unavailable is not the capture's fault: don't spend one of its attempts.
        captures.setClassificationError(id, code, message, code !== 'LLM_UNAVAILABLE')
        this.d.events.changed()
        return
      }

      const v = validateClassification(raw, c.transcript, new Date(), {
        defaultHour: this.d.settings().defaultReminderHour
      })
      this.mark(id, 'validationFinished')
      if (!v.ok) {
        logger.warn('pipeline: invalid model output', { id, code: v.code, attempt })
        lastError = { code: 'INVALID_MODEL_OUTPUT', message: v.message }
        continue
      }

      const applied = transaction(this.d.db, () => {
        const ok = captures.applyClassification(id, {
          ...v.value,
          model: this.d.classifier.modelId ?? 'unknown'
        })
        if (ok) this.d.reminders.syncForCapture(id)
        return ok
      })
      if (!applied) return // user handled it meanwhile
      this.mark(id, 'finalPersisted')
      this.d.events.changed()
      const label = CATEGORY_LABELS[v.value.category]
      this.d.events.result(
        id,
        'classified',
        v.value.needsConfirmation ? `Needs confirmation: ${v.value.title}` : `${label}: ${v.value.title}`
      )
      return
    }
    captures.setClassificationError(id, lastError.code, lastError.message, true)
    this.d.events.changed()
    this.d.events.result(id, 'failed', 'Saved to inbox (could not organize automatically)')
  }

  private mark(id: string, key: string): void {
    try {
      this.d.captures.mergeTimings(id, { [key]: Date.now() })
    } catch {
      /* timings are best-effort */
    }
  }
}
