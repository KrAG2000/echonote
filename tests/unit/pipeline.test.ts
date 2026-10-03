import { describe, expect, it, vi } from 'vitest'
import { Pipeline } from '../../src/main/services/pipeline'
import { TranscriptionError, type Transcriber } from '../../src/main/services/transcription-engine'
import { ClassificationError, type Classifier } from '../../src/main/services/classification-engine'
import { nullLogger } from '../../src/main/logger'
import { llmJson, memoryDb, testSettings, until } from './helpers'

function setup(opts: {
  transcribe?: Transcriber['transcribe']
  classify?: Classifier['classify']
  llmReady?: () => boolean
  keepAudio?: boolean
}) {
  const store = memoryDb()
  const deleted: string[] = []
  const results: Array<[string, string]> = []
  const transcriber: Transcriber = {
    modelId: 'fake-whisper',
    isReady: () => true,
    ensureReady: async () => undefined,
    transcribe: opts.transcribe ?? (async () => ({ text: 'The staging server uses port 8081', ms: 5 }))
  }
  const classifier: Classifier = {
    modelId: 'fake-llm',
    isReady: opts.llmReady ?? (() => true),
    classify: opts.classify ?? (async () => ({ raw: llmJson(), ms: 5 }))
  }
  const pipeline = new Pipeline({
    db: store.db,
    captures: store.captures,
    reminders: store.reminders,
    transcriber,
    classifier,
    logger: nullLogger,
    settings: () => testSettings({ keepAudio: opts.keepAudio ?? false }),
    deleteAudio: async (p) => {
      deleted.push(p)
    },
    events: {
      changed: () => undefined,
      activity: () => undefined,
      result: (_id, stage, text) => results.push([stage, text])
    },
    retryDelayMs: 1
  })
  const add = (): string =>
    store.captures.create({ audioPath: '/tmp/x.wav', durationMs: 2000, timezone: 'Asia/Kolkata' }).id
  return { ...store, pipeline, deleted, results, add }
}

describe('Pipeline', () => {
  it('transcribes, persists, classifies and deletes audio', async () => {
    const t = setup({})
    const id = t.add()
    t.pipeline.enqueueTranscription(id)
    await until(() => t.captures.get(id)!.status === 'ready')
    const c = t.captures.get(id)!
    expect(c.transcript).toBe('The staging server uses port 8081')
    expect(c.category).toBe('reference')
    expect(c.hasAudio).toBe(false)
    expect(t.deleted).toEqual(['/tmp/x.wav'])
    expect(t.results.map((r) => r[0])).toEqual(['transcribed', 'classified'])
  })

  it('keeps audio when retention is enabled', async () => {
    const t = setup({ keepAudio: true })
    const id = t.add()
    t.pipeline.enqueueTranscription(id)
    await until(() => t.captures.get(id)!.status === 'ready')
    expect(t.captures.get(id)!.hasAudio).toBe(true)
    expect(t.deleted).toEqual([])
  })

  it('persists the transcript before classification finishes', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const t = setup({
      classify: async () => {
        await gate
        return { raw: llmJson(), ms: 1 }
      }
    })
    const id = t.add()
    t.pipeline.enqueueTranscription(id)
    await until(() => t.pipeline.activity().classifying === id)
    expect(t.captures.get(id)!.transcript).toMatch(/8081/)
    expect(t.captures.get(id)!.status).toBe('inbox')
    release()
    await until(() => t.captures.get(id)!.status === 'ready')
  })

  it('LLM unavailable: transcript is saved in the inbox, then organized on resume', async () => {
    let ready = false
    const classify = vi.fn(async () => ({ raw: llmJson(), ms: 1 }))
    const t = setup({ llmReady: () => ready, classify })
    const id = t.add()
    t.pipeline.enqueueTranscription(id)
    await until(() => t.captures.get(id)!.errorCode === 'LLM_UNAVAILABLE')
    expect(t.captures.get(id)!.status).toBe('inbox')
    expect(t.captures.get(id)!.transcript).toMatch(/8081/)
    expect(t.captures.get(id)!.classifyAttempts).toBe(0)
    expect(classify).not.toHaveBeenCalled()

    ready = true
    t.pipeline.resume()
    await until(() => t.captures.get(id)!.status === 'ready')
    expect(t.captures.list({ view: 'all', includeCompleted: true })).toHaveLength(1)
  })

  it('invalid model output is retried once, then kept in the inbox', async () => {
    const classify = vi.fn(async () => ({ raw: 'not json at all', ms: 1 }))
    const t = setup({ classify })
    const id = t.add()
    t.pipeline.enqueueTranscription(id)
    await until(() => t.captures.get(id)!.errorCode === 'INVALID_MODEL_OUTPUT')
    expect(classify).toHaveBeenCalledTimes(2)
    const c = t.captures.get(id)!
    expect(c.status).toBe('inbox')
    expect(c.transcript).toMatch(/8081/)
  })

  it('a malformed first answer can be repaired by the retry', async () => {
    const classify = vi
      .fn<Classifier['classify']>()
      .mockResolvedValueOnce({ raw: '{"category":"shopping"}', ms: 1 })
      .mockResolvedValueOnce({ raw: llmJson(), ms: 1 })
    const t = setup({ classify })
    const id = t.add()
    t.pipeline.enqueueTranscription(id)
    await until(() => t.captures.get(id)!.status === 'ready')
    expect(classify).toHaveBeenCalledTimes(2)
  })

  it('LLM timeout keeps the capture and counts an attempt', async () => {
    const t = setup({
      classify: async () => {
        throw new ClassificationError('LLM_TIMEOUT', 'slow')
      }
    })
    const id = t.add()
    t.pipeline.enqueueTranscription(id)
    await until(() => t.captures.get(id)!.errorCode === 'LLM_TIMEOUT')
    expect(t.captures.get(id)!.classifyAttempts).toBe(1)
  })

  it('retry is idempotent: duplicate enqueues and retries never duplicate records', async () => {
    const t = setup({})
    const id = t.add()
    t.pipeline.enqueueTranscription(id)
    t.pipeline.enqueueTranscription(id)
    await until(() => t.captures.get(id)!.status === 'ready')
    t.pipeline.resume()
    expect(t.pipeline.retry(id).ok).toBe(false) // ready items are not retried
    expect(t.captures.list({ view: 'all', includeCompleted: true })).toHaveLength(1)
  })

  it('recovers an omitted reminder date from the transcript and schedules exactly one reminder', async () => {
    const classify = vi
      .fn<Classifier['classify']>()
      .mockResolvedValueOnce({ raw: llmJson({ category: 'reminder', date_expression: null }), ms: 1 })
      .mockResolvedValue({
        raw: llmJson({ category: 'reminder', date_expression: 'tomorrow at 9 am' }),
        ms: 1
      })
    const t = setup({
      classify,
      transcribe: async () => ({ text: 'Remind me tomorrow at 9 am to call mom', ms: 1 })
    })
    const id = t.add()
    t.pipeline.enqueueTranscription(id)
    await until(() => t.captures.get(id)!.status === 'ready')
    // The first answer omitted the date, but the validator recovered it from the transcript.
    expect(t.captures.get(id)!.dueAt).not.toBeNull()
    expect(t.reminders.listWithCaptures(true)).toHaveLength(1)
  })

  it('user retry of a needs_confirmation item re-classifies the same record', async () => {
    const classify = vi
      .fn<Classifier['classify']>()
      .mockResolvedValueOnce({ raw: llmJson({ needs_confirmation: true, reason: 'unsure' }), ms: 1 })
      .mockResolvedValue({ raw: llmJson(), ms: 1 })
    const t = setup({ classify })
    const id = t.add()
    t.pipeline.enqueueTranscription(id)
    await until(() => t.captures.get(id)!.status === 'needs_confirmation')
    expect(t.pipeline.retry(id).ok).toBe(true)
    await until(() => t.captures.get(id)!.status === 'ready')
    expect(t.captures.list({ view: 'all', includeCompleted: true }).map((c) => c.id)).toEqual([id])
  })

  it('transcription timeout marks failed and keeps audio for retry', async () => {
    let fail = true
    const t = setup({
      transcribe: async () => {
        if (fail) throw new TranscriptionError('TRANSCRIPTION_TIMEOUT', 'too slow')
        return { text: 'hello there', ms: 1 }
      }
    })
    const id = t.add()
    t.pipeline.enqueueTranscription(id)
    await until(() => t.captures.get(id)!.status === 'failed')
    expect(t.captures.get(id)!.hasAudio).toBe(true)
    expect(t.deleted).toEqual([])
    fail = false
    expect(t.pipeline.retry(id).ok).toBe(true)
    await until(() => t.captures.get(id)!.status === 'ready')
  })

  it('a crashed transcription worker gets one automatic retry', async () => {
    const transcribe = vi
      .fn<Transcriber['transcribe']>()
      .mockRejectedValueOnce(new TranscriptionError('TRANSCRIPTION_FAILED', 'crash'))
      .mockResolvedValue({ text: 'The staging server uses port 8081', ms: 1 })
    const t = setup({ transcribe })
    const id = t.add()
    t.pipeline.enqueueTranscription(id)
    await until(() => t.captures.get(id)!.status === 'ready')
    expect(transcribe).toHaveBeenCalledTimes(2)
  })

  it('empty transcript does not create a misleading note', async () => {
    const t = setup({ transcribe: async () => ({ text: '', ms: 1 }) })
    const id = t.add()
    t.pipeline.enqueueTranscription(id)
    await until(() => t.captures.get(id)!.status === 'failed')
    expect(t.captures.get(id)!.errorCode).toBe('EMPTY_TRANSCRIPT')
    expect(t.captures.get(id)!.category).toBeNull()
  })

  it('resume() re-queues work left over from a previous session', async () => {
    const t = setup({})
    const a = t.add() // processing, never transcribed
    t.pipeline.resume()
    await until(() => t.captures.get(a)!.status === 'ready')
  })

  it('does not overwrite an item the user filed manually while it was queued', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const t = setup({
      classify: async () => {
        await gate
        return { raw: llmJson({ category: 'idea' }), ms: 1 }
      }
    })
    const id = t.add()
    t.pipeline.enqueueTranscription(id)
    await until(() => t.pipeline.activity().classifying === id)
    t.captures.update(id, { category: 'task', status: 'ready', title: 'Mine' })
    release()
    await until(() => t.pipeline.activity().classifying === null)
    expect(t.captures.get(id)!.category).toBe('task')
    expect(t.captures.get(id)!.title).toBe('Mine')
  })
})
