import { useEffect, useState } from 'react'
import type { AppStatus } from '../../../shared/types'
import { useCaptures } from '../lib'
import { CaptureCard } from '../components/CaptureCard'

export function SearchPage({ status }: { status: AppStatus }): React.JSX.Element {
  const [q, setQ] = useState('')
  const [debounced, setDebounced] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 200)
    return () => clearTimeout(t)
  }, [q])
  const { items, loading } = useCaptures({
    view: 'all',
    includeCompleted: true,
    search: debounced || undefined,
    limit: 200
  })
  return (
    <div className="page">
      <h1>Search</h1>
      <input
        className="search-box"
        autoFocus
        placeholder="Search transcripts, titles and summaries…"
        value={q}
        maxLength={200}
        onChange={(e) => setQ(e.target.value)}
        data-testid="search-input"
      />
      {debounced && !loading && (
        <p className="lede">
          {items.length} result{items.length === 1 ? '' : 's'}
        </p>
      )}
      {debounced && !loading && items.length === 0 && (
        <div className="empty">No matches for “{debounced}”.</div>
      )}
      <div className="cards">
        {debounced && items.map((c) => <CaptureCard key={c.id} capture={c} status={status} />)}
      </div>
    </div>
  )
}
