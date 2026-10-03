import type { AppStatus } from '../../../shared/types'
import { useCaptures } from '../lib'
import { CaptureCard } from '../components/CaptureCard'

export function InboxPage({
  status,
  focusId
}: {
  status: AppStatus
  focusId: string | null
}): React.JSX.Element {
  const { items, loading } = useCaptures({ view: 'inbox', limit: 500 })
  const confirm = items.filter((c) => c.status === 'needs_confirmation')
  const pending = items.filter((c) => c.status === 'processing' || c.status === 'inbox')
  const failed = items.filter((c) => c.status === 'failed')
  return (
    <div className="page">
      <h1>Inbox</h1>
      <p className="lede">
        Captures that still need transcription, organizing, or your confirmation. Nothing here is lost.
      </p>
      {!loading && items.length === 0 && <div className="empty">Inbox zero. Everything is organized.</div>}
      {confirm.length > 0 && <h2>Needs confirmation</h2>}
      <div className="cards">
        {confirm.map((c) => (
          <CaptureCard key={c.id} capture={c} status={status} focused={focusId === c.id} />
        ))}
      </div>
      {pending.length > 0 && <h2>Being processed / waiting</h2>}
      <div className="cards">
        {pending.map((c) => (
          <CaptureCard key={c.id} capture={c} status={status} focused={focusId === c.id} />
        ))}
      </div>
      {failed.length > 0 && <h2>Failed — retry or delete</h2>}
      <div className="cards">
        {failed.map((c) => (
          <CaptureCard key={c.id} capture={c} status={status} focused={focusId === c.id} />
        ))}
      </div>
    </div>
  )
}
