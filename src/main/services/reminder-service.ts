import type { RemindersRepo } from '../database/reminders-repo'
import type { CapturesRepo } from '../database/captures-repo'
import type { Logger } from '../logger'

export interface Notifier {
  isSupported(): boolean
  /** Returns false if the notification could not be shown. */
  show(n: { title: string; body: string; captureId: string }): boolean
}

/** Longest the scheduler sleeps, so wall-clock jumps and suspend/resume are noticed promptly. */
const MAX_SLEEP_MS = 30_000
/** Reminders more than this late (e.g. app was closed) are labelled overdue when delivered. */
const OVERDUE_AFTER_MS = 2 * 60_000

/**
 * Delivers reminders from the SQLite table. The database is the source of truth; the timer is
 * only a wake-up. Each reminder is claimed (pending -> delivered) in a single conditional
 * UPDATE before the notification is shown, so a reminder is never delivered twice.
 * Reminders that came due while the app was not running are delivered once at startup,
 * marked as overdue.
 */
export class ReminderService {
  private timer: NodeJS.Timeout | null = null
  private running = false

  constructor(
    private readonly reminders: RemindersRepo,
    private readonly captures: CapturesRepo,
    private readonly notifier: Notifier,
    private readonly logger: Logger,
    private readonly opts: {
      notificationsEnabled: () => boolean
      onDelivered: (captureId: string, title: string, shown: boolean) => void
    }
  ) {}

  start(): void {
    this.running = true
    this.tick()
  }

  stop(): void {
    this.running = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /** Call after any change that may affect the next due time. */
  reschedule(): void {
    if (!this.running) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.schedule()
  }

  tick(now: Date = new Date()): number {
    let delivered = 0
    try {
      for (const r of this.reminders.due(now)) {
        if (!this.reminders.claim(r.id)) continue
        const c = this.captures.get(r.captureId)
        const title = c?.title ?? 'Reminder'
        const late = now.getTime() - Date.parse(r.dueAt) > OVERDUE_AFTER_MS
        const body =
          (late ? `Overdue (was due ${new Date(r.dueAt).toLocaleString()}). ` : '') +
          (c?.action || c?.summary || c?.transcript || '').slice(0, 180)
        let shown = false
        if (this.opts.notificationsEnabled() && this.notifier.isSupported()) {
          try {
            shown = this.notifier.show({ title: `⏰ ${title}`, body, captureId: r.captureId })
          } catch (err) {
            this.logger.warn('reminders: notification threw', { err: err as Error })
          }
          if (!shown) this.reminders.markFailed(r.id, 'Desktop notification could not be shown.')
        }
        this.logger.info('reminders: delivered', { id: r.id, late, shown })
        this.opts.onDelivered(r.captureId, title, shown)
        delivered++
      }
    } catch (err) {
      this.logger.error('reminders: tick failed', { err: err as Error })
    }
    if (this.running) this.schedule()
    return delivered
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer)
    let wait = MAX_SLEEP_MS
    try {
      const next = this.reminders.nextPendingDueAt()
      if (next) wait = Math.max(250, Math.min(MAX_SLEEP_MS, Date.parse(next) - Date.now()))
    } catch (err) {
      this.logger.error('reminders: schedule failed', { err: err as Error })
    }
    this.timer = setTimeout(() => this.tick(), wait)
  }
}
