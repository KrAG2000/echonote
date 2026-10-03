import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { migrate, openDatabase } from '../../src/main/database/connection'
import { MIGRATIONS } from '../../src/main/database/migrations'
import { memoryDb } from './helpers'

const classified = {
  category: 'reminder' as const,
  title: 'Call dentist',
  summary: 'Call the dentist.',
  action: 'Call the dentist',
  originalDateExpression: 'tomorrow',
  dueAt: '2026-10-08T03:30:00.000Z',
  timeDefaulted: true,
  needsConfirmation: false,
  confirmationReason: null,
  model: 'test-llm'
}

function newInboxCapture(
  captures: ReturnType<typeof memoryDb>['captures'],
  transcript = 'Remind me tomorrow to call the dentist'
) {
  const c = captures.create({ audioPath: '/tmp/a.wav', durationMs: 1500, timezone: 'Asia/Kolkata' })
  captures.setTranscript(c.id, transcript, 'test-whisper')
  return c.id
}

describe('migrations', () => {
  it('creates the schema and records versions', () => {
    const { db } = memoryDb()
    const versions = (
      db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>
    ).map((r) => r.version)
    expect(versions).toEqual(MIGRATIONS.map((m) => m.version))
  })

  it('is idempotent', () => {
    const { db } = memoryDb()
    expect(migrate(db)).toEqual([])
  })

  it('persists data across reopen', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'echonote-db-'))
    const file = path.join(dir, 'test.db')
    const a = memoryDb(file)
    const id = newInboxCapture(a.captures)
    a.db.close()
    const b = openDatabase(file)
    expect(
      (b.prepare('SELECT transcript FROM captures WHERE id = ?').get(id) as { transcript: string }).transcript
    ).toMatch(/dentist/)
    b.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('CapturesRepo', () => {
  it('creates a processing capture with audio', () => {
    const { captures } = memoryDb()
    const c = captures.create({ audioPath: '/tmp/a.wav', durationMs: 1234, timezone: 'UTC' })
    expect(c.status).toBe('processing')
    expect(c.hasAudio).toBe(true)
    expect(c.transcript).toBeNull()
  })

  it('setTranscript moves to inbox and keeps the transcript', () => {
    const { captures } = memoryDb()
    const id = newInboxCapture(captures)
    const c = captures.get(id)!
    expect(c.status).toBe('inbox')
    expect(c.transcript).toMatch(/dentist/)
    expect(c.transcriptionModel).toBe('test-whisper')
  })

  it('classification errors never touch the transcript', () => {
    const { captures } = memoryDb()
    const id = newInboxCapture(captures)
    captures.setClassificationError(id, 'INVALID_MODEL_OUTPUT', 'bad', true)
    const c = captures.get(id)!
    expect(c.status).toBe('inbox')
    expect(c.transcript).toMatch(/dentist/)
    expect(c.classifyAttempts).toBe(1)
    expect(c.errorCode).toBe('INVALID_MODEL_OUTPUT')
  })

  it('applyClassification only applies once (idempotent)', () => {
    const { captures } = memoryDb()
    const id = newInboxCapture(captures)
    expect(captures.applyClassification(id, classified)).toBe(true)
    expect(captures.applyClassification(id, { ...classified, title: 'Other' })).toBe(false)
    expect(captures.get(id)!.title).toBe('Call dentist')
    expect(captures.list({ view: 'all' })).toHaveLength(1)
  })

  it('lists by view and searches transcripts, titles and summaries', () => {
    const { captures } = memoryDb()
    const a = newInboxCapture(captures, 'The staging server uses port 8081')
    captures.applyClassification(a, {
      ...classified,
      category: 'reference',
      title: 'Staging port',
      dueAt: null
    })
    newInboxCapture(captures, 'Something unclassified')
    expect(captures.list({ view: 'reference' }).map((c) => c.id)).toEqual([a])
    expect(captures.list({ view: 'inbox' })).toHaveLength(1)
    expect(captures.list({ view: 'all', search: '8081' }).map((c) => c.id)).toEqual([a])
    expect(captures.list({ view: 'all', search: 'staging port' }).map((c) => c.id)).toEqual([a])
    expect(captures.list({ view: 'all', search: '%' })).toHaveLength(0) // LIKE wildcards are escaped
  })

  it('completion hides items from default views', () => {
    const { captures } = memoryDb()
    const id = newInboxCapture(captures)
    captures.applyClassification(id, { ...classified, category: 'task', dueAt: null })
    captures.update(id, { status: 'completed' })
    expect(captures.list({ view: 'task' })).toHaveLength(0)
    expect(captures.list({ view: 'task', includeCompleted: true })).toHaveLength(1)
    expect(captures.get(id)!.completedAt).not.toBeNull()
  })

  it('transcription failure keeps audio for retry; reset requires audio', () => {
    const { captures } = memoryDb()
    const c = captures.create({ audioPath: '/tmp/a.wav', durationMs: 1000, timezone: 'UTC' })
    captures.setTranscriptionFailed(c.id, 'TRANSCRIPTION_TIMEOUT', 'slow')
    expect(captures.get(c.id)!.status).toBe('failed')
    expect(captures.getAudioPath(c.id)).toBe('/tmp/a.wav')
    expect(captures.resetForTranscription(c.id)).toBe(true)
    expect(captures.get(c.id)!.status).toBe('processing')
    captures.setTranscriptionFailed(c.id, 'X', 'y')
    captures.clearAudio(c.id)
    expect(captures.resetForTranscription(c.id)).toBe(false)
  })
})

describe('RemindersRepo.syncForCapture', () => {
  it('creates exactly one pending reminder for a ready reminder', () => {
    const { captures, reminders } = memoryDb()
    const id = newInboxCapture(captures)
    captures.applyClassification(id, classified)
    reminders.syncForCapture(id)
    reminders.syncForCapture(id)
    const all = reminders.listWithCaptures(true)
    expect(all).toHaveLength(1)
    expect(all[0].status).toBe('pending')
    expect(all[0].dueAt).toBe(classified.dueAt)
  })

  it('does not schedule unconfirmed reminders', () => {
    const { captures, reminders } = memoryDb()
    const id = newInboxCapture(captures)
    captures.applyClassification(id, { ...classified, needsConfirmation: true })
    expect(reminders.syncForCapture(id)).toBeNull()
  })

  it('re-arms when the due time changes, cancels on completion', () => {
    const { captures, reminders } = memoryDb()
    const id = newInboxCapture(captures)
    captures.applyClassification(id, classified)
    const r = reminders.syncForCapture(id)!
    expect(reminders.claim(r.id)).toBe(true)
    expect(reminders.claim(r.id)).toBe(false) // second claim must fail: no duplicate delivery
    captures.update(id, { dueAt: '2026-10-09T03:30:00.000Z' })
    expect(reminders.syncForCapture(id)!.status).toBe('pending')
    captures.update(id, { status: 'completed' })
    expect(reminders.syncForCapture(id)!.status).toBe('cancelled')
  })

  it('cascades on capture delete', () => {
    const { captures, reminders } = memoryDb()
    const id = newInboxCapture(captures)
    captures.applyClassification(id, classified)
    reminders.syncForCapture(id)
    captures.delete(id)
    expect(reminders.getByCapture(id)).toBeNull()
  })

  it('due() returns only pending reminders at or before now', () => {
    const { captures, reminders } = memoryDb()
    const id = newInboxCapture(captures)
    captures.applyClassification(id, classified)
    reminders.syncForCapture(id)
    expect(reminders.due(new Date('2026-10-08T03:29:59Z'))).toHaveLength(0)
    expect(reminders.due(new Date('2026-10-08T03:30:00Z'))).toHaveLength(1)
  })
})

describe('SettingsRepo', () => {
  it('returns defaults and persists validated patches', () => {
    const { settings } = memoryDb()
    expect(settings.get().defaultReminderHour).toBe(9)
    expect(settings.update({ defaultReminderHour: 7, keepAudio: true }).defaultReminderHour).toBe(7)
    expect(settings.get().keepAudio).toBe(true)
  })

  it('rejects invalid values', () => {
    const { settings } = memoryDb()
    expect(() => settings.update({ defaultReminderHour: 30 })).toThrow()
    expect(() => settings.update({ bogus: 1 } as never)).toThrow()
  })

  it('ignores corrupt stored values', () => {
    const { db, settings } = memoryDb()
    db.prepare("INSERT INTO settings (key, value) VALUES ('defaultReminderHour', '\"oops\"')").run()
    expect(settings.get().defaultReminderHour).toBe(9)
  })
})
