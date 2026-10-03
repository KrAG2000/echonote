import { useState } from 'react'
import type { AppStatus } from '../../../shared/types'
import { useCaptures } from '../lib'
import { CaptureCard } from '../components/CaptureCard'

const META = {
  task: { title: 'Tasks', lede: 'Things you intend to do.', empty: 'No open tasks.' },
  idea: { title: 'Ideas', lede: 'Possibilities worth coming back to.', empty: 'No ideas captured yet.' },
  reference: {
    title: 'Reference',
    lede: 'Facts and details worth remembering.',
    empty: 'No reference notes yet.'
  }
} as const

export function CategoryPage({
  category,
  status,
  focusId
}: {
  category: 'task' | 'idea' | 'reference'
  status: AppStatus
  focusId: string | null
}): React.JSX.Element {
  const [showDone, setShowDone] = useState(false)
  const [filter, setFilter] = useState('')
  const { items, loading } = useCaptures({
    view: category,
    includeCompleted: showDone,
    search: filter || undefined,
    limit: 500
  })
  const m = META[category]
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{m.title}</h1>
          <p className="lede">{m.lede}</p>
        </div>
        <div className="row">
          <input
            className="filter"
            placeholder="Filter…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          {category === 'task' && (
            <label className="toggle">
              <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} />{' '}
              Show done
            </label>
          )}
        </div>
      </div>
      {!loading && items.length === 0 && <div className="empty">{m.empty}</div>}
      <div className="cards">
        {items.map((c) => (
          <CaptureCard key={c.id} capture={c} status={status} focused={focusId === c.id} />
        ))}
      </div>
    </div>
  )
}
