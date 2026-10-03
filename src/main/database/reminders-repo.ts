import { randomUUID } from 'node:crypto'
import type { Db } from './connection'
import { transaction } from './connection'
import type { Reminder, ReminderStatus, ReminderWithCapture } from '../../shared/types'
import { CapturesRepo } from './captures-repo'

interface ReminderRow {
  id: string
  capture_id: string
  due_at: string
  status: ReminderStatus
  delivered_at: string | null
  attempts: number
  last_error: string | null
}

const toReminder = (r: ReminderRow): Reminder => ({
  id: r.id,
  captureId: r.capture_id,
  dueAt: r.due_at,
  status: r.status,
  deliveredAt: r.delivered_at,
  attempts: r.attempts,
  lastError: r.last_error
})

const now = (): string => new Date().toISOString()

export class RemindersRepo {
  private readonly captures: CapturesRepo

  constructor(private readonly db: Db) {
    this.captures = new CapturesRepo(db)
  }

  getByCapture(captureId: string): Reminder | null {
    const r = this.db.prepare('SELECT * FROM reminders WHERE capture_id = ?').get(captureId) as
      ReminderRow | undefined
    return r ? toReminder(r) : null
  }

  /**
   * Makes the reminders table agree with the capture. A reminder is pending exactly when the
   * capture is an accepted ('ready') reminder with a due time. Idempotent: calling it twice
   * never creates a second row (capture_id is UNIQUE) and never re-arms a delivered reminder
   * unless the due time changed.
   */
  syncForCapture(captureId: string): Reminder | null {
    return transaction(this.db, () => {
      const c = this.captures.get(captureId)
      const existing = this.getByCapture(captureId)
      const shouldBePending = !!c && c.category === 'reminder' && c.status === 'ready' && !!c.dueAt
      if (shouldBePending) {
        if (!existing) {
          const t = now()
          this.db
            .prepare(
              `INSERT INTO reminders (id, capture_id, due_at, status, attempts, created_at, updated_at)
               VALUES (?, ?, ?, 'pending', 0, ?, ?)`
            )
            .run(randomUUID(), captureId, c.dueAt, t, t)
        } else if (existing.dueAt !== c.dueAt || existing.status === 'cancelled') {
          this.db
            .prepare(
              `UPDATE reminders SET due_at = ?, status = 'pending', delivered_at = NULL, attempts = 0, last_error = NULL,
                 updated_at = ? WHERE capture_id = ?`
            )
            .run(c.dueAt, now(), captureId)
        }
      } else if (existing && existing.status === 'pending') {
        this.db
          .prepare(`UPDATE reminders SET status = 'cancelled', updated_at = ? WHERE capture_id = ?`)
          .run(now(), captureId)
      }
      return this.getByCapture(captureId)
    })
  }

  /** Pending reminders due at or before `at`. */
  due(at: Date): Reminder[] {
    return (
      this.db
        .prepare(`SELECT * FROM reminders WHERE status = 'pending' AND due_at <= ? ORDER BY due_at ASC`)
        .all(at.toISOString()) as unknown as ReminderRow[]
    ).map(toReminder)
  }

  nextPendingDueAt(): string | null {
    const r = this.db.prepare(`SELECT MIN(due_at) AS d FROM reminders WHERE status = 'pending'`).get() as {
      d: string | null
    }
    return r.d
  }

  /**
   * Atomically claims a pending reminder for delivery. Returns false if another tick already
   * claimed it, which is what prevents duplicate notifications.
   */
  claim(id: string): boolean {
    const r = this.db
      .prepare(
        `UPDATE reminders SET status = 'delivered', delivered_at = ?, attempts = attempts + 1, updated_at = ?
         WHERE id = ? AND status = 'pending'`
      )
      .run(now(), now(), id)
    return Number(r.changes) > 0
  }

  markFailed(id: string, error: string): void {
    this.db
      .prepare(`UPDATE reminders SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?`)
      .run(error, now(), id)
  }

  listWithCaptures(includePast: boolean): ReminderWithCapture[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM reminders ${includePast ? '' : `WHERE status IN ('pending','delivered','failed')`} ORDER BY due_at ASC`
      )
      .all() as unknown as ReminderRow[]
    const out: ReminderWithCapture[] = []
    for (const r of rows) {
      const capture = this.captures.get(r.capture_id)
      if (capture) out.push({ ...toReminder(r), capture })
    }
    return out
  }
}
