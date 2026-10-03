import { afterEach, describe, expect, it } from 'vitest'
import { ReminderService, type Notifier } from '../../src/main/services/reminder-service'
import { nullLogger } from '../../src/main/logger'
import { memoryDb } from './helpers'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function addReminder(store: ReturnType<typeof memoryDb>, dueAt: string, title = 'Call dentist'): string {
  const c = store.captures.create({ audioPath: '/tmp/a.wav', durationMs: 1000, timezone: 'Asia/Kolkata' })
  store.captures.setTranscript(c.id, 'remind me to ' + title, 'w')
  store.captures.applyClassification(c.id, {
    category: 'reminder',
    title,
    summary: title,
    action: title,
    originalDateExpression: 'x',
    dueAt,
    timeDefaulted: false,
    needsConfirmation: false,
    confirmationReason: null,
    model: 'm'
  })
  store.reminders.syncForCapture(c.id)
  return c.id
}

function fakeNotifier(supported = true, succeeds = true) {
  const shown: Array<{ title: string; body: string }> = []
  const n: Notifier = {
    isSupported: () => supported,
    show: (x) => {
      shown.push(x)
      return succeeds
    }
  }
  return { n, shown }
}

const services: ReminderService[] = []
afterEach(() => services.splice(0).forEach((s) => s.stop()))

function service(store: ReturnType<typeof memoryDb>, n: Notifier, enabled = true) {
  const delivered: string[] = []
  const s = new ReminderService(store.reminders, store.captures, n, nullLogger, {
    notificationsEnabled: () => enabled,
    onDelivered: (id) => delivered.push(id)
  })
  services.push(s)
  return { s, delivered }
}

describe('ReminderService', () => {
  it('delivers a due reminder exactly once', () => {
    const store = memoryDb()
    const id = addReminder(store, '2026-10-08T03:30:00.000Z')
    const { n, shown } = fakeNotifier()
    const { s, delivered } = service(store, n)
    expect(s.tick(new Date('2026-10-08T03:29:00Z'))).toBe(0)
    expect(s.tick(new Date('2026-10-08T03:30:01Z'))).toBe(1)
    expect(s.tick(new Date('2026-10-08T03:31:00Z'))).toBe(0)
    expect(shown).toHaveLength(1)
    expect(shown[0].title).toMatch(/Call dentist/)
    expect(delivered).toEqual([id])
    expect(store.reminders.getByCapture(id)!.status).toBe('delivered')
  })

  it('labels reminders missed while the app was closed as overdue', () => {
    const store = memoryDb()
    addReminder(store, '2026-10-08T03:30:00.000Z')
    const { n, shown } = fakeNotifier()
    service(store, n).s.tick(new Date('2026-10-08T09:00:00Z'))
    expect(shown[0].body).toMatch(/Overdue/)
  })

  it('pending reminders survive a restart (database is the source of truth)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'echonote-rem-'))
    const file = path.join(dir, 'db.sqlite')
    const a = memoryDb(file)
    const id = addReminder(a, '2026-10-08T03:30:00.000Z')
    a.db.close()

    const b = memoryDb(file) // "restart"
    expect(b.reminders.getByCapture(id)!.status).toBe('pending')
    const { n, shown } = fakeNotifier()
    service(b, n).s.tick(new Date('2026-10-08T03:31:00Z'))
    expect(shown).toHaveLength(1)
    b.db.close()

    const c = memoryDb(file) // second restart: must not deliver again
    const second = fakeNotifier()
    service(c, second.n).s.tick(new Date('2026-10-08T04:00:00Z'))
    expect(second.shown).toHaveLength(0)
    c.db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('keeps the reminder visible in-app when notifications are unsupported', () => {
    const store = memoryDb()
    const id = addReminder(store, '2026-10-08T03:30:00.000Z')
    const { n, shown } = fakeNotifier(false)
    const { s, delivered } = service(store, n)
    s.tick(new Date('2026-10-08T03:31:00Z'))
    expect(shown).toHaveLength(0)
    expect(delivered).toEqual([id]) // UI gets told so it can show it
  })

  it('records a failed notification', () => {
    const store = memoryDb()
    const id = addReminder(store, '2026-10-08T03:30:00.000Z')
    const { n } = fakeNotifier(true, false)
    service(store, n).s.tick(new Date('2026-10-08T03:31:00Z'))
    expect(store.reminders.getByCapture(id)!.status).toBe('failed')
  })

  it('fires on its own timer for a near-future reminder', async () => {
    const store = memoryDb()
    addReminder(store, new Date(Date.now() + 300).toISOString())
    const { n, shown } = fakeNotifier()
    service(store, n).s.start()
    await new Promise((r) => setTimeout(r, 900))
    expect(shown).toHaveLength(1)
  })
})
