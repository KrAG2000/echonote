import type { AppStatus, RuntimeStatus } from '../../../shared/types'

const LABEL: Record<RuntimeStatus['state'], string> = {
  missing_model: 'not installed',
  missing_runtime: 'runtime missing',
  stopped: 'stopped',
  starting: 'loading…',
  ready: 'ready',
  busy: 'working…',
  error: 'error',
  insufficient_memory: 'low memory'
}

const tone = (s: RuntimeStatus['state']): string =>
  s === 'ready' || s === 'busy' ? 'ok' : s === 'starting' || s === 'stopped' ? 'warn' : 'bad'

export function StatusPills({
  status,
  onClick
}: {
  status: AppStatus
  onClick?: () => void
}): React.JSX.Element {
  return (
    <div className="pills" onClick={onClick} title="Local model status — click for details">
      <div className={`pill ${tone(status.speech.state)}`} data-testid="pill-speech">
        <span className="pill-dot" /> Speech: {LABEL[status.speech.state]}
      </div>
      <div className={`pill ${tone(status.llm.state)}`} data-testid="pill-llm">
        <span className="pill-dot" /> AI: {LABEL[status.llm.state]}
      </div>
      <div className="pill muted">🔒 Runs on this computer</div>
    </div>
  )
}
