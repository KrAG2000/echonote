export interface Toast {
  id: string
  level: 'info' | 'success' | 'error'
  message: string
}

export function Toasts({ toasts }: { toasts: Toast[] }): React.JSX.Element {
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.level}`}>
          {t.message}
        </div>
      ))}
    </div>
  )
}
