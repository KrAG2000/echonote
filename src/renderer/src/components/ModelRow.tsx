import { useState } from 'react'
import type { ModelFileStatus } from '../../../shared/types'
import { api, fmtMB } from '../lib'

export function ModelRow({ m, active }: { m: ModelFileStatus; active?: boolean }): React.JSX.Element {
  const [err, setErr] = useState<string | null>(null)
  const pct = m.sizeBytes ? Math.min(100, (m.downloadedBytes / m.sizeBytes) * 100) : 0
  const download = async (): Promise<void> => {
    setErr(null)
    const r = await api.downloadModel(m.id)
    if (!r.ok) setErr(r.error.message)
  }
  const error = err ?? m.error?.message ?? null
  return (
    <div className="model-row" data-testid={`model-${m.id}`}>
      <div className="model-info">
        <div className="model-name">
          {m.name} {active && <span className="chip">in use</span>}
        </div>
        <div className="hint">
          {fmtMB(m.sizeBytes)} · {m.license} · {m.description}
        </div>
        {(m.downloading || m.verifying) && (
          <div className="progress">
            <div className="bar" style={{ width: `${m.verifying ? 100 : pct}%` }} />
            <span>
              {m.verifying ? 'Verifying checksum…' : `${fmtMB(m.downloadedBytes)} / ${fmtMB(m.sizeBytes)}`}
            </span>
          </div>
        )}
        {error && !m.downloading && <div className="callout bad">{error}</div>}
      </div>
      <div className="model-actions">
        {m.verified ? (
          <span className="chip ok">✓ Installed &amp; verified</span>
        ) : m.downloading ? (
          <button className="ghost small" onClick={() => void api.cancelDownload(m.id)}>
            Cancel
          </button>
        ) : (
          <button
            className="primary small"
            onClick={() => void download()}
            disabled={m.verifying}
            data-testid={`download-${m.id}`}
          >
            {m.downloadedBytes > 0 && !m.installed
              ? 'Resume download'
              : error
                ? 'Retry download'
                : 'Download'}
          </button>
        )}
      </div>
    </div>
  )
}
