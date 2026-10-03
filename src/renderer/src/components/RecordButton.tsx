import { useEffect, useState } from 'react'
import type { AppStatus } from '../../../shared/types'
import { api, fmtDuration } from '../lib'

export function RecordButton({ status, level }: { status: AppStatus; level: number }): React.JSX.Element {
  const st = status.recording.state
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (st !== 'recording') return
    const t = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(t)
  }, [st])
  const elapsed = status.recording.startedAt ? now - status.recording.startedAt : 0
  const label =
    st === 'idle'
      ? 'Start recording'
      : st === 'starting'
        ? 'Starting…'
        : st === 'recording'
          ? 'Stop'
          : 'Saving…'
  return (
    <div className="record-wrap">
      <button
        className={`record-btn ${st}`}
        onClick={() => void api.toggleRecording()}
        disabled={st === 'starting' || st === 'stopping'}
        aria-label={label}
        data-testid="record-button"
        style={{
          boxShadow: st === 'recording' ? `0 0 0 ${6 + level * 40}px rgba(239,68,68,0.18)` : undefined
        }}
      >
        {st === 'recording' ? <span className="stop-square" /> : <span className="mic-glyph">🎙</span>}
      </button>
      <div className="record-label" data-testid="record-state">
        {st === 'recording' ? (
          <>
            <span className="rec-dot" /> Recording {fmtDuration(elapsed)}
          </>
        ) : (
          label
        )}
      </div>
    </div>
  )
}
