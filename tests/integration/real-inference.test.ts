/**
 * Runs the real bundled runtimes (resources/bin) against real model files. Nothing is mocked.
 * Models are taken from ECHONOTE_MODELS_DIR or ~/.config/EchoNote/models (run
 * `npm run models:prepare` first). Tests skip if a binary or model is missing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { WhisperEngine } from '../../src/main/services/transcription-engine'
import { LlamaEngine } from '../../src/main/services/classification-engine'
import { validateClassification } from '../../src/main/services/validation-service'
import { Pipeline } from '../../src/main/services/pipeline'
import { loadManifest } from '../../src/main/services/model-manager'
import { createLogger } from '../../src/main/logger'
import { openDatabase } from '../../src/main/database/connection'
import { CapturesRepo } from '../../src/main/database/captures-repo'
import { RemindersRepo } from '../../src/main/database/reminders-repo'
import { DEFAULT_SETTINGS } from '../../src/shared/constants'

const root = path.join(__dirname, '../..')
const bin = path.join(root, 'resources/bin/linux-x64')
const modelsDir = process.env.ECHONOTE_MODELS_DIR || path.join(os.homedir(), '.config/EchoNote/models')
const manifest = loadManifest(path.join(root, 'resources/models.json'))
const speech = manifest.models.find((m) => m.id === DEFAULT_SETTINGS.speechModelId)!
const llm = manifest.models.find(
  (m) => m.id === (process.env.ECHONOTE_TEST_LLM || DEFAULT_SETTINGS.llmModelId)
)!
const speechPath = path.join(modelsDir, speech.fileName)
const llmPath = path.join(modelsDir, llm.fileName)
const fixture = (n: string): string => path.join(root, 'tests/fixtures', `${n}.wav`)
const logger = createLogger(null)

const haveSpeech = fs.existsSync(path.join(bin, 'whisper-server')) && fs.existsSync(speechPath)
const haveLlm = fs.existsSync(path.join(bin, 'llama-server')) && fs.existsSync(llmPath)
const report: string[] = []

afterAll(() => {
  if (!report.length) return
  const out = path.join(root, 'test-results')
  fs.mkdirSync(out, { recursive: true })
  fs.writeFileSync(path.join(out, 'integration-bench.txt'), report.join('\n') + '\n')
})

describe.skipIf(!haveSpeech)('whisper.cpp (real model)', () => {
  const whisper = new WhisperEngine(logger)
  beforeAll(async () => {
    await whisper.configure(path.join(bin, 'whisper-server'), speechPath, speech.id)
    const t0 = Date.now()
    await whisper.ensureReady()
    report.push(`[bench] whisper ${speech.id} cold start: ${Date.now() - t0} ms`)
  })
  afterAll(() => whisper.server?.stop())

  it('transcribes the JFK sample accurately', async () => {
    const r = await whisper.transcribe(fixture('jfk'), 'en')
    report.push(`[bench] whisper jfk.wav (11.0 s audio): ${r.ms} ms`)
    expect(r.text.toLowerCase()).toContain('ask not what your country can do for you')
  })

  it('transcribes short synthetic notes', async () => {
    for (const n of ['task', 'reference', 'reminder']) {
      const r = await whisper.transcribe(fixture(n), 'en')
      report.push(`[bench] whisper ${n}.wav: ${r.ms} ms -> "${r.text}"`)
      expect(r.text.length).toBeGreaterThan(10)
    }
    expect((await whisper.transcribe(fixture('task'), 'en')).text.toLowerCase()).toContain('login')
  })

  it('reports a missing audio file as a structured error', async () => {
    await expect(whisper.transcribe('/nonexistent.wav', 'en')).rejects.toMatchObject({
      code: 'AUDIO_MISSING'
    })
  })

  it('restarts after the worker is killed', async () => {
    whisper.server!['child']!.kill('SIGKILL')
    await new Promise((r) => setTimeout(r, 200))
    await expect(whisper.transcribe(fixture('task'), 'en')).resolves.toBeTruthy()
  })
})

describe.skipIf(!haveLlm)('llama.cpp (real model)', () => {
  const llama = new LlamaEngine(logger)
  beforeAll(async () => {
    await llama.configure(path.join(bin, 'llama-server'), llmPath, llm.id, 2048)
    const t0 = Date.now()
    await llama.server!.start()
    report.push(`[bench] llama ${llm.id} cold start: ${Date.now() - t0} ms`)
  })
  afterAll(() => llama.server?.stop())

  const ref = new Date()
  const cases: Array<[string, string]> = [
    ['The staging server uses port 8081, not 8080.', 'reference'],
    ['Remind me tomorrow at 7 pm to call the dentist.', 'reminder'],
    ['I need to fix the login bug on the settings page.', 'task'],
    ['I could build a tool that explains database query plans in plain English.', 'idea'],
    ['My passport number is stored in the blue folder in the top drawer.', 'reference'],
    ['Buy milk and eggs on the way home.', 'task'],
    ['What if the app could summarize my week every Sunday.', 'idea'],
    ['Pay the electricity bill on the 15th.', 'reminder']
  ]

  it('classifies real transcripts into the expected categories', async () => {
    const times: number[] = []
    let correct = 0
    for (const [t, expected] of cases) {
      const out = await llama.classify(t)
      times.push(out.ms)
      const v = validateClassification(out.raw, t, ref, { defaultHour: 9 })
      expect(v.ok, out.raw).toBe(true)
      if (!v.ok) continue
      const got = v.value.category
      if (got === expected) correct++
      report.push(
        `[bench] llm ${out.ms} ms  expected=${expected} got=${got}  title="${v.value.title}" date="${v.value.originalDateExpression}" due=${v.value.dueAt} confirm=${v.value.needsConfirmation}`
      )
    }
    const sorted = [...times].sort((a, b) => a - b)
    report.push(
      `[bench] llm warm latency: median ${sorted[Math.floor(sorted.length / 2)]} ms, max ${sorted[sorted.length - 1]} ms, accuracy ${correct}/${cases.length}`
    )
    expect(correct).toBeGreaterThanOrEqual(cases.length - 2)
  })

  it('extracts the reminder date phrase instead of inventing one', async () => {
    const t = 'Remind me tomorrow at 7 pm to call the dentist.'
    const v = validateClassification((await llama.classify(t)).raw, t, ref, { defaultHour: 9 })
    expect(v.ok).toBe(true)
    if (!v.ok) return
    const due = new Date(v.value.dueAt!)
    const tomorrow = new Date(ref)
    tomorrow.setDate(ref.getDate() + 1)
    expect(due.toDateString()).toBe(tomorrow.toDateString())
    expect(due.getHours()).toBe(19)
  })

  it('does not attach a deadline to an undated task', async () => {
    const t = 'Investigate why the background worker keeps retrying failed jobs.'
    const v = validateClassification((await llama.classify(t)).raw, t, ref, { defaultHour: 9 })
    expect(v.ok && v.value.dueAt).toBe(null)
  })
})

describe.skipIf(!haveSpeech || !haveLlm)('full pipeline with real models', () => {
  it('audio -> transcript -> classification -> reminder, persisted in SQLite', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'echonote-int-'))
    const db = openDatabase(path.join(tmp, 'db.sqlite'))
    const captures = new CapturesRepo(db)
    const reminders = new RemindersRepo(db)
    const whisper = new WhisperEngine(logger)
    const llama = new LlamaEngine(logger)
    await whisper.configure(path.join(bin, 'whisper-server'), speechPath, speech.id)
    await llama.configure(path.join(bin, 'llama-server'), llmPath, llm.id, 2048)
    await Promise.all([whisper.ensureReady(), llama.server!.start()])
    const audio = path.join(tmp, 'a.wav')
    fs.copyFileSync(fixture('task'), audio)
    const pipeline = new Pipeline({
      db,
      captures,
      reminders,
      transcriber: whisper,
      classifier: llama,
      logger,
      settings: () => DEFAULT_SETTINGS,
      deleteAudio: async (p) => fs.rmSync(p, { force: true }),
      events: { changed: () => undefined, activity: () => undefined, result: () => undefined }
    })
    const c = captures.create({ audioPath: audio, durationMs: 3000, timezone: 'Asia/Kolkata' })
    const t0 = Date.now()
    pipeline.enqueueTranscription(c.id)
    while (
      !['ready', 'needs_confirmation', 'failed'].includes(captures.get(c.id)!.status) &&
      Date.now() - t0 < 60_000
    ) {
      await new Promise((r) => setTimeout(r, 50))
    }
    report.push(`[bench] full pipeline (task.wav): ${Date.now() - t0} ms`)
    const done = captures.get(c.id)!
    expect(done.transcript?.toLowerCase()).toContain('login')
    expect(done.category).toBe('task')
    expect(fs.existsSync(audio)).toBe(false) // deleted after successful transcription
    await whisper.server?.stop()
    await llama.server?.stop()
    db.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  })
})
