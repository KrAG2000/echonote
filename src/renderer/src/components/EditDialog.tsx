import { useState } from 'react'
import type { Capture, Category } from '../../../shared/types'
import { CATEGORIES } from '../../../shared/types'
import { CATEGORY_LABELS } from '../../../shared/constants'
import { api, fromLocalInput, toLocalInput } from '../lib'

export function EditDialog({
  capture,
  confirmMode,
  onClose
}: {
  capture: Capture
  confirmMode: boolean
  onClose: () => void
}): React.JSX.Element {
  const [category, setCategory] = useState<Category | ''>(capture.category ?? '')
  const [title, setTitle] = useState(capture.title ?? '')
  const [summary, setSummary] = useState(capture.summary ?? '')
  const [action, setAction] = useState(capture.action ?? '')
  const [due, setDue] = useState(toLocalInput(capture.dueAt))
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const save = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    const r = await api.updateCapture({
      id: capture.id,
      category: category || null,
      title: title.trim() || null,
      summary: summary.trim() || null,
      action: action.trim() || null,
      dueAt: fromLocalInput(due),
      ...(confirmMode || capture.status === 'inbox' ? { confirm: true } : {})
    })
    setSaving(false)
    if (r.ok) onClose()
    else setError(r.error.message)
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Edit item">
        <h3>{confirmMode ? 'Review and confirm' : 'Edit'}</h3>
        {capture.confirmationReason && <div className="callout warn">{capture.confirmationReason}</div>}
        <label>
          Category
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value as Category)}
            data-testid="edit-category"
          >
            <option value="" disabled>
              Choose…
            </option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABELS[c]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Title
          <input
            value={title}
            maxLength={80}
            onChange={(e) => setTitle(e.target.value)}
            data-testid="edit-title"
          />
        </label>
        <label>
          Summary
          <textarea value={summary} maxLength={400} rows={3} onChange={(e) => setSummary(e.target.value)} />
        </label>
        {(category === 'task' || category === 'reminder') && (
          <>
            <label>
              Action
              <input value={action} maxLength={200} onChange={(e) => setAction(e.target.value)} />
            </label>
            <label>
              {category === 'reminder' ? 'Remind me at' : 'Due (optional)'}
              <div className="row">
                <input
                  type="datetime-local"
                  value={due}
                  onChange={(e) => setDue(e.target.value)}
                  data-testid="edit-due"
                />
                {due && (
                  <button className="ghost" onClick={() => setDue('')}>
                    Clear
                  </button>
                )}
              </div>
            </label>
            {capture.originalDateExpression && (
              <div className="hint">You said: “{capture.originalDateExpression}”</div>
            )}
          </>
        )}
        <details className="transcript">
          <summary>Original transcript</summary>
          <p>{capture.transcript}</p>
        </details>
        {error && <div className="callout bad">{error}</div>}
        <div className="modal-actions">
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" onClick={() => void save()} disabled={saving} data-testid="edit-save">
            {confirmMode || capture.status === 'inbox' ? 'Save & confirm' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
