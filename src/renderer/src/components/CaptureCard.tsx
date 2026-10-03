import { useEffect, useRef, useState } from 'react'
import type { AppStatus, Capture, Category } from '../../../shared/types'
import { CATEGORIES } from '../../../shared/types'
import { CATEGORY_LABELS } from '../../../shared/constants'
import { api, fmtAgo, fmtDue } from '../lib'
import { EditDialog } from './EditDialog'

function processingLabel(c: Capture, status: AppStatus): string | null {
  const p = status.pipeline
  if (c.status === 'processing') {
    if (p.transcribing === c.id) return 'Transcribing…'
    if (status.speech.state !== 'ready' && status.speech.state !== 'busy')
      return 'Waiting for the speech model…'
    return 'Queued for transcription…'
  }
  if (c.status === 'inbox') {
    if (p.classifying === c.id) return 'Organizing…'
    if (p.queuedClassification.includes(c.id)) return 'Queued for organizing…'
    if (c.errorCode === 'LLM_UNAVAILABLE' || status.llm.state !== 'ready')
      return 'Saved. Waiting for the AI model to organize it.'
  }
  return null
}

export function CaptureCard({
  capture: c,
  status,
  focused
}: {
  capture: Capture
  status: AppStatus
  focused?: boolean
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [focused])

  const run = async (fn: () => Promise<{ ok: boolean; error?: { message: string } }>): Promise<void> => {
    setBusy(true)
    setMsg(null)
    const r = await fn()
    setBusy(false)
    if (!r.ok) setMsg(r.error?.message ?? 'Failed')
  }

  // Reminders need a date, so filing as a reminder opens the editor instead of saving directly.
  const quickCategorize = async (category: Category): Promise<void> => {
    if (category === 'reminder') {
      await run(() => api.updateCapture({ id: c.id, category }))
      setEditing(true)
    } else {
      await run(() => api.updateCapture({ id: c.id, category, confirm: true }))
    }
  }

  const proc = processingLabel(c, status)
  const done = c.status === 'completed'
  const actionable = c.category === 'task' || c.category === 'reminder'
  const title =
    c.title ??
    (c.transcript ? c.transcript.slice(0, 70) + (c.transcript.length > 70 ? '…' : '') : 'New recording')
  const overdue = c.dueAt && !done && Date.parse(c.dueAt) < Date.now()

  return (
    <div
      ref={ref}
      className={`card ${done ? 'done' : ''} ${focused ? 'focused' : ''} status-${c.status}`}
      data-testid="capture-card"
      data-capture-id={c.id}
      data-category={c.category ?? ''}
      data-status={c.status}
    >
      <div className="card-head">
        {actionable && c.status !== 'needs_confirmation' && c.status !== 'inbox' && (
          <input
            type="checkbox"
            className="check"
            checked={done}
            aria-label={done ? 'Mark as not done' : 'Mark as done'}
            onChange={() => void run(() => api.updateCapture({ id: c.id, completed: !done }))}
            data-testid="complete-toggle"
          />
        )}
        <div className="card-title" data-testid="capture-title">
          {title}
        </div>
        <div className="card-meta">
          {c.category && <span className={`chip cat-${c.category}`}>{CATEGORY_LABELS[c.category]}</span>}
          {c.status === 'needs_confirmation' && <span className="chip warn">Needs confirmation</span>}
          {c.status === 'failed' && <span className="chip bad">Failed</span>}
          <span className="ago">{fmtAgo(c.createdAt)}</span>
        </div>
      </div>

      {c.dueAt && (
        <div className={`due ${overdue ? 'overdue' : ''}`}>
          ⏰ {fmtDue(c.dueAt)}
          {c.timeDefaulted && <span className="hint"> (no time given, default used)</span>}
          {c.originalDateExpression && <span className="hint"> · you said “{c.originalDateExpression}”</span>}
        </div>
      )}
      {c.summary && c.summary !== c.title && <div className="summary">{c.summary}</div>}
      {c.confirmationReason && c.status === 'needs_confirmation' && (
        <div className="callout warn">{c.confirmationReason}</div>
      )}
      {proc && (
        <div className="processing">
          <span className="spinner" /> {proc}
        </div>
      )}
      {c.status === 'failed' && c.errorMessage && <div className="callout bad">{c.errorMessage}</div>}
      {c.status === 'inbox' && c.errorCode && c.errorCode !== 'LLM_UNAVAILABLE' && c.errorMessage && (
        <div className="callout bad">Could not organize automatically: {c.errorMessage}</div>
      )}
      {c.transcript && c.title && (
        <details className="transcript">
          <summary>Transcript</summary>
          <p data-testid="capture-transcript">{c.transcript}</p>
        </details>
      )}

      <div className="card-actions">
        {c.status === 'inbox' && c.transcript && !proc?.startsWith('Organizing') && (
          <div className="quick-cats">
            File as:
            {CATEGORIES.map((cat) => (
              <button
                key={cat}
                className="ghost small"
                disabled={busy}
                onClick={() => void quickCategorize(cat)}
              >
                {CATEGORY_LABELS[cat]}
              </button>
            ))}
          </div>
        )}
        <div className="spacer" />
        {c.status === 'needs_confirmation' && (
          <button
            className="primary small"
            disabled={busy}
            onClick={() => setEditing(true)}
            data-testid="confirm-button"
          >
            Review & confirm
          </button>
        )}
        {(c.status === 'failed' ||
          ((c.status === 'inbox' || c.status === 'needs_confirmation') && c.transcript)) && (
          <button
            className="ghost small"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const r = await api.retryCapture(c.id)
                if (r.ok) setMsg(r.data)
                return r
              })
            }
            data-testid="retry-button"
          >
            {c.status === 'failed' ? 'Retry transcription' : 'Re-run AI'}
          </button>
        )}
        {c.transcript && c.status !== 'processing' && (
          <button
            className="ghost small"
            disabled={busy}
            onClick={() => setEditing(true)}
            data-testid="edit-button"
          >
            Edit
          </button>
        )}
        {confirmDelete ? (
          <>
            <button
              className="danger small"
              disabled={busy}
              onClick={() => void run(() => api.deleteCapture(c.id))}
              data-testid="delete-confirm"
            >
              Delete permanently
            </button>
            <button className="ghost small" onClick={() => setConfirmDelete(false)}>
              Keep
            </button>
          </>
        ) : (
          <button className="ghost small" onClick={() => setConfirmDelete(true)} data-testid="delete-button">
            Delete
          </button>
        )}
      </div>
      {msg && <div className="hint">{msg}</div>}
      {editing && (
        <EditDialog
          capture={c}
          confirmMode={c.status === 'needs_confirmation'}
          onClose={() => setEditing(false)}
        />
      )}
    </div>
  )
}
