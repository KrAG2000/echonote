import { useEffect, useState } from 'react'
import { api, fmtDuration, useEvent, useStatus } from './lib'

/**
 * Compact always-on-top capture window. Shows that the microphone is live, a stop button and
 * the processing result, so a thought can be captured without opening the dashboard.
 */
export function Overlay(): React.JSX.Element {
  const status = useStatus()
  const [result, setResult] = useState<{ stage: string; text: string } | null>(null)
  const [now, setNow] = useState(Date.now())
  const st = status?.recording.state ?? 'idle'

  useEffect(() => {
    if (st !== 'recording') return
    const t = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(t)
  }, [st])

  useEffect(() => {
    if (st === 'starting') setResult(null)
  }, [st])

  useEvent((e) => {
    if (e.type === 'capture-result') setResult({ stage: e.stage, text: e.text })
  })

  if (!status) return <div className="overlay" />
  const elapsed = status.recording.startedAt ? now - status.recording.startedAt : 0
  const err = status.recording.lastError

  let body: React.JSX.Element
  if (st === 'starting') body = <span>Starting microphone…</span>
  else if (st === 'recording')
    body = (
      <>
        <span className="rec-dot big" />
        <span className="overlay-title">Recording {fmtDuration(elapsed)}</span>
      </>
    )
  else if (st === 'stopping') body = <span>Saving…</span>
  else if (err) body = <span className="overlay-error">{err.message}</span>
  else if (result)
    body = (
      <span className={`overlay-result ${result.stage}`}>
        {result.stage === 'saved' && <span className="spinner" />}
        {result.stage === 'transcribed' && (
          <>
            <span className="spinner" /> Organizing: “{result.text.slice(0, 60)}
            {result.text.length > 60 ? '…' : ''}”
          </>
        )}
        {result.stage !== 'transcribed' && (
          <>
            {' '}
            {result.stage === 'classified' ? '✓ ' : ''}
            {result.text}
          </>
        )}
      </span>
    )
  else body = <span>Ready</span>

  return (
    <div className={`overlay ${st}`}>
      <div className="overlay-body">{body}</div>
      <div className="overlay-actions">
        {st === 'recording' && (
          <button className="danger small" onClick={() => void api.stopRecording()}>
            Stop
          </button>
        )}
        {st === 'idle' && (
          <>
            <button className="ghost small" onClick={() => void api.showMain('inbox')}>
              Open
            </button>
            <button className="ghost small" aria-label="Close" onClick={() => void api.hideOverlay()}>
              ✕
            </button>
          </>
        )}
      </div>
    </div>
  )
}
