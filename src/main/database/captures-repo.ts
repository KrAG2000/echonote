import { randomUUID } from 'node:crypto'
import type { Db } from './connection'
import { transaction } from './connection'
import type { Capture, CaptureStatus, Category, ListQuery } from '../../shared/types'

interface CaptureRow {
  id: string
  transcript: string | null
  category: Category | null
  title: string | null
  summary: string | null
  action: string | null
  original_date_expression: string | null
  due_at: string | null
  time_defaulted: number
  timezone: string
  status: CaptureStatus
  confirmation_reason: string | null
  audio_path: string | null
  audio_duration_ms: number | null
  created_at: string
  updated_at: string
  completed_at: string | null
  transcription_model: string | null
  classification_model: string | null
  classify_attempts: number
  transcribe_attempts: number
  error_code: string | null
  error_message: string | null
  timings: string | null
}

export interface ClassificationResult {
  category: Category
  title: string
  summary: string
  action: string | null
  originalDateExpression: string | null
  dueAt: string | null
  timeDefaulted: boolean
  needsConfirmation: boolean
  confirmationReason: string | null
  model: string
}

export function rowToCapture(r: CaptureRow): Capture {
  return {
    id: r.id,
    transcript: r.transcript,
    category: r.category,
    title: r.title,
    summary: r.summary,
    action: r.action,
    originalDateExpression: r.original_date_expression,
    dueAt: r.due_at,
    timeDefaulted: r.time_defaulted === 1,
    timezone: r.timezone,
    status: r.status,
    confirmationReason: r.confirmation_reason,
    hasAudio: !!r.audio_path,
    audioDurationMs: r.audio_duration_ms,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    completedAt: r.completed_at,
    transcriptionModel: r.transcription_model,
    classificationModel: r.classification_model,
    classifyAttempts: r.classify_attempts,
    errorCode: r.error_code,
    errorMessage: r.error_message
  }
}

const now = (): string => new Date().toISOString()

export class CapturesRepo {
  constructor(private readonly db: Db) {}

  create(input: {
    audioPath: string
    durationMs: number
    timezone: string
    timings?: Record<string, number>
  }): Capture {
    const id = randomUUID()
    const t = now()
    this.db
      .prepare(
        `INSERT INTO captures (id, timezone, status, audio_path, audio_duration_ms, created_at, updated_at, timings)
         VALUES (?, ?, 'processing', ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.timezone,
        input.audioPath,
        Math.round(input.durationMs),
        t,
        t,
        JSON.stringify(input.timings ?? {})
      )
    return this.get(id)!
  }

  get(id: string): Capture | null {
    const row = this.db.prepare('SELECT * FROM captures WHERE id = ?').get(id) as CaptureRow | undefined
    return row ? rowToCapture(row) : null
  }

  getAudioPath(id: string): string | null {
    const row = this.db.prepare('SELECT audio_path FROM captures WHERE id = ?').get(id) as
      { audio_path: string | null } | undefined
    return row?.audio_path ?? null
  }

  list(q: ListQuery): Capture[] {
    const where: string[] = []
    const params: Array<string | number> = []
    switch (q.view) {
      case 'inbox':
        where.push(`status IN ('processing','failed','inbox','needs_confirmation')`)
        break
      case 'task':
      case 'reminder':
      case 'idea':
      case 'reference':
        where.push('category = ?')
        params.push(q.view)
        where.push(q.includeCompleted ? `status IN ('ready','completed')` : `status = 'ready'`)
        break
      case 'recent':
      case 'all':
        if (!q.includeCompleted) where.push(`status != 'completed'`)
        break
    }
    const search = q.search?.trim()
    if (search) {
      const like = '%' + search.replace(/[\\%_]/g, (c) => '\\' + c) + '%'
      where.push(
        `(transcript LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\' OR action LIKE ? ESCAPE '\\')`
      )
      params.push(like, like, like, like)
    }
    const order =
      q.view === 'reminder' || q.view === 'task'
        ? `ORDER BY status = 'completed', due_at IS NULL, due_at ASC, created_at DESC`
        : 'ORDER BY created_at DESC'
    const sql = `SELECT * FROM captures ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ${order} LIMIT ?`
    params.push(q.limit ?? 300)
    return (this.db.prepare(sql).all(...params) as unknown as CaptureRow[]).map(rowToCapture)
  }

  /** Transcription succeeded: persist transcript and move to the inbox for classification. */
  setTranscript(id: string, transcript: string, model: string): void {
    this.db
      .prepare(
        `UPDATE captures SET transcript = ?, transcription_model = ?, status = 'inbox', error_code = NULL,
           error_message = NULL, updated_at = ? WHERE id = ? AND status IN ('processing','failed')`
      )
      .run(transcript, model, now(), id)
  }

  markTranscribeAttempt(id: string): void {
    this.db.prepare('UPDATE captures SET transcribe_attempts = transcribe_attempts + 1 WHERE id = ?').run(id)
  }

  getTranscribeAttempts(id: string): number {
    const row = this.db.prepare('SELECT transcribe_attempts FROM captures WHERE id = ?').get(id) as
      { transcribe_attempts: number } | undefined
    return row?.transcribe_attempts ?? 0
  }

  setTranscriptionFailed(id: string, code: string, message: string): void {
    this.db
      .prepare(
        `UPDATE captures SET status = 'failed', error_code = ?, error_message = ?, updated_at = ?
         WHERE id = ? AND status IN ('processing','failed')`
      )
      .run(code, message, now(), id)
  }

  /** Back to processing so the transcription worker picks it up again. */
  resetForTranscription(id: string): boolean {
    const r = this.db
      .prepare(
        `UPDATE captures SET status = 'processing', error_code = NULL, error_message = NULL, transcribe_attempts = 0,
           updated_at = ? WHERE id = ? AND status = 'failed' AND audio_path IS NOT NULL`
      )
      .run(now(), id)
    return Number(r.changes) > 0
  }

  clearAudio(id: string): void {
    this.db.prepare('UPDATE captures SET audio_path = NULL WHERE id = ?').run(id)
  }

  /** Records a classification failure without touching the transcript. */
  setClassificationError(id: string, code: string, message: string, countAttempt: boolean): void {
    this.db
      .prepare(
        `UPDATE captures SET error_code = ?, error_message = ?, updated_at = ?,
           classify_attempts = classify_attempts + ? WHERE id = ? AND status = 'inbox'`
      )
      .run(code, message, now(), countAttempt ? 1 : 0, id)
  }

  /**
   * Applies a validated classification. Only captures still in the inbox are updated, so a
   * retried or duplicated job can never overwrite a capture the user has already handled.
   */
  applyClassification(id: string, c: ClassificationResult): boolean {
    const r = this.db
      .prepare(
        `UPDATE captures SET category = ?, title = ?, summary = ?, action = ?, original_date_expression = ?,
           due_at = ?, time_defaulted = ?, status = ?, confirmation_reason = ?, classification_model = ?,
           classify_attempts = classify_attempts + 1, error_code = NULL, error_message = NULL, updated_at = ?
         WHERE id = ? AND status = 'inbox'`
      )
      .run(
        c.category,
        c.title,
        c.summary,
        c.action,
        c.originalDateExpression,
        c.dueAt,
        c.timeDefaulted ? 1 : 0,
        c.needsConfirmation ? 'needs_confirmation' : 'ready',
        c.confirmationReason,
        c.model,
        now(),
        id
      )
    return Number(r.changes) > 0
  }

  /** Puts a classified capture back into the inbox for re-classification. */
  resetForClassification(id: string): boolean {
    const r = this.db
      .prepare(
        `UPDATE captures SET status = 'inbox', classify_attempts = 0, error_code = NULL, error_message = NULL,
           updated_at = ? WHERE id = ? AND transcript IS NOT NULL AND status IN ('inbox','needs_confirmation','ready')`
      )
      .run(now(), id)
    return Number(r.changes) > 0
  }

  /** User edits. Returns the updated capture. */
  update(
    id: string,
    patch: {
      category?: Category | null
      title?: string | null
      summary?: string | null
      action?: string | null
      dueAt?: string | null
      status?: CaptureStatus
      timeDefaulted?: boolean
      clearConfirmation?: boolean
    }
  ): Capture | null {
    return transaction(this.db, () => {
      const sets: string[] = []
      const params: Array<string | number | null> = []
      const set = (col: string, v: string | number | null): void => {
        sets.push(`${col} = ?`)
        params.push(v)
      }
      if (patch.category !== undefined) set('category', patch.category)
      if (patch.title !== undefined) set('title', patch.title)
      if (patch.summary !== undefined) set('summary', patch.summary)
      if (patch.action !== undefined) set('action', patch.action)
      if (patch.dueAt !== undefined) set('due_at', patch.dueAt)
      if (patch.timeDefaulted !== undefined) set('time_defaulted', patch.timeDefaulted ? 1 : 0)
      if (patch.status !== undefined) {
        set('status', patch.status)
        set('completed_at', patch.status === 'completed' ? now() : null)
        if (patch.status === 'ready' || patch.status === 'completed') {
          set('error_code', null)
          set('error_message', null)
        }
      }
      if (patch.clearConfirmation) set('confirmation_reason', null)
      set('updated_at', now())
      params.push(id)
      this.db.prepare(`UPDATE captures SET ${sets.join(', ')} WHERE id = ?`).run(...params)
      return this.get(id)
    })
  }

  delete(id: string): { audioPath: string | null } | null {
    return transaction(this.db, () => {
      const audioPath = this.getAudioPath(id)
      const r = this.db.prepare('DELETE FROM captures WHERE id = ?').run(id)
      return Number(r.changes) > 0 ? { audioPath } : null
    })
  }

  mergeTimings(id: string, patch: Record<string, number>): void {
    const row = this.db.prepare('SELECT timings FROM captures WHERE id = ?').get(id) as
      { timings: string | null } | undefined
    if (!row) return
    let cur: Record<string, number> = {}
    try {
      cur = row.timings ? JSON.parse(row.timings) : {}
    } catch {
      cur = {}
    }
    this.db
      .prepare('UPDATE captures SET timings = ? WHERE id = ?')
      .run(JSON.stringify({ ...cur, ...patch }), id)
  }

  recentTimings(limit: number): Array<{ captureId: string; timings: Record<string, number> }> {
    const rows = this.db
      .prepare('SELECT id, timings FROM captures WHERE timings IS NOT NULL ORDER BY created_at DESC LIMIT ?')
      .all(limit) as Array<{ id: string; timings: string }>
    return rows.map((r) => {
      let timings: Record<string, number> = {}
      try {
        timings = JSON.parse(r.timings)
      } catch {
        /* ignore */
      }
      return { captureId: r.id, timings }
    })
  }

  idsByStatus(status: CaptureStatus): string[] {
    return (
      this.db
        .prepare('SELECT id FROM captures WHERE status = ? ORDER BY created_at ASC')
        .all(status) as Array<{
        id: string
      }>
    ).map((r) => r.id)
  }

  /** Inbox captures that still deserve an automatic classification attempt. */
  pendingClassification(maxAttempts: number): string[] {
    return (
      this.db
        .prepare(
          `SELECT id FROM captures WHERE status = 'inbox' AND transcript IS NOT NULL AND classify_attempts < ?
           ORDER BY created_at ASC`
        )
        .all(maxAttempts) as Array<{ id: string }>
    ).map((r) => r.id)
  }

  counts(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const r of this.db
      .prepare('SELECT status, COUNT(*) AS n FROM captures GROUP BY status')
      .all() as Array<{
      status: string
      n: number
    }>) {
      out[r.status] = r.n
    }
    for (const r of this.db
      .prepare(
        `SELECT category, COUNT(*) AS n FROM captures WHERE status = 'ready' AND category IS NOT NULL GROUP BY category`
      )
      .all() as Array<{ category: string; n: number }>) {
      out[`ready_${r.category}`] = r.n
    }
    return out
  }

  allAudioPaths(): string[] {
    return (
      this.db.prepare('SELECT audio_path FROM captures WHERE audio_path IS NOT NULL').all() as Array<{
        audio_path: string
      }>
    ).map((r) => r.audio_path)
  }
}
