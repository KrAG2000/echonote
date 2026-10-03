import type { AppStatus, Settings } from '../../../shared/types'
import { useCaptures, useEvent } from '../lib'
import { useState } from 'react'
import { RecordButton } from '../components/RecordButton'
import { CaptureCard } from '../components/CaptureCard'

export function CapturePage({
  status,
  settings,
  level
}: {
  status: AppStatus
  settings: Settings
  level: number
}): React.JSX.Element {
  const recent = useCaptures({ view: 'recent', limit: 8 })
  const [lastResult, setLastResult] = useState<string | null>(null)
  useEvent((e) => {
    if (e.type === 'capture-result') setLastResult(e.stage === 'transcribed' ? `Heard: “${e.text}”` : e.text)
  })
  const err = status.recording.lastError
  return (
    <div className="page capture-page">
      <section className="capture-hero">
        <RecordButton status={status} level={level} />
        <div className="shortcut-hint">
          {status.shortcut.registered ? (
            <>
              Press <kbd>{settings.shortcut}</kbd> anywhere to start and stop recording.
            </>
          ) : (
            <>
              Global shortcut not active yet — set it up in Settings. Until then, use this button or the tray
              menu.
            </>
          )}
        </div>
        {err && status.recording.state === 'idle' && (
          <div className="callout bad" data-testid="recording-error">
            {err.message}
          </div>
        )}
        {lastResult && (
          <div className="last-result" data-testid="last-result">
            {lastResult}
          </div>
        )}
      </section>
      <h2>Recent</h2>
      {recent.items.length === 0 && !recent.loading && (
        <div className="empty">
          Nothing captured yet. Say something like “Remind me tomorrow at 9 to call the dentist”.
        </div>
      )}
      <div className="cards">
        {recent.items.map((c) => (
          <CaptureCard key={c.id} capture={c} status={status} />
        ))}
      </div>
    </div>
  )
}
