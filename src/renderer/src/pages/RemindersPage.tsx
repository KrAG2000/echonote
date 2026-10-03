import { useState } from 'react'
import type { AppStatus } from '../../../shared/types'
import { useCaptures } from '../lib'
import { CaptureCard } from '../components/CaptureCard'

export function RemindersPage({
  status,
  focusId
}: {
  status: AppStatus
  focusId: string | null
}): React.JSX.Element {
  const [showDone, setShowDone] = useState(false)
  const { items, loading } = useCaptures({ view: 'reminder', includeCompleted: showDone, limit: 500 })
  const now = Date.now()
  const open = items.filter((c) => c.status !== 'completed')
  const overdue = open.filter((c) => c.dueAt && Date.parse(c.dueAt) < now)
  const upcoming = open.filter((c) => !c.dueAt || Date.parse(c.dueAt) >= now)
  const done = items.filter((c) => c.status === 'completed')
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Reminders</h1>
          <p className="lede">
            Delivered as desktop notifications while EchoNote is running (it keeps running in the background
            when you close the window).
            {!status.notificationsSupported &&
              ' Desktop notifications are not supported here; due reminders show in the app.'}
          </p>
        </div>
        <label className="toggle">
          <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> Show
          done
        </label>
      </div>
      {!loading && open.length === 0 && <div className="empty">No upcoming reminders.</div>}
      {overdue.length > 0 && <h2>Due / overdue</h2>}
      <div className="cards">
        {overdue.map((c) => (
          <CaptureCard key={c.id} capture={c} status={status} focused={focusId === c.id} />
        ))}
      </div>
      {upcoming.length > 0 && <h2>Upcoming</h2>}
      <div className="cards">
        {upcoming.map((c) => (
          <CaptureCard key={c.id} capture={c} status={status} focused={focusId === c.id} />
        ))}
      </div>
      {showDone && done.length > 0 && <h2>Done</h2>}
      <div className="cards">
        {showDone && done.map((c) => <CaptureCard key={c.id} capture={c} status={status} />)}
      </div>
    </div>
  )
}
