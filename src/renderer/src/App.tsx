import { useCallback, useEffect, useState } from 'react'
import { api, useCaptures, useEvent, useSettings, useStatus } from './lib'
import { useRecorderHost } from './useRecorderHost'
import { StatusPills } from './components/StatusPills'
import { Toasts, type Toast } from './components/Toasts'
import { CapturePage } from './pages/CapturePage'
import { InboxPage } from './pages/InboxPage'
import { CategoryPage } from './pages/CategoryPage'
import { RemindersPage } from './pages/RemindersPage'
import { SearchPage } from './pages/SearchPage'
import { SettingsPage } from './pages/SettingsPage'
import { SetupPage } from './pages/SetupPage'

export type View = 'capture' | 'inbox' | 'task' | 'reminder' | 'idea' | 'reference' | 'search' | 'settings'

const NAV: Array<{ view: View; label: string; icon: string }> = [
  { view: 'capture', label: 'Capture', icon: '●' },
  { view: 'inbox', label: 'Inbox', icon: '⬚' },
  { view: 'task', label: 'Tasks', icon: '✓' },
  { view: 'reminder', label: 'Reminders', icon: '⏰' },
  { view: 'idea', label: 'Ideas', icon: '✦' },
  { view: 'reference', label: 'Reference', icon: '❐' },
  { view: 'search', label: 'Search', icon: '⌕' },
  { view: 'settings', label: 'Settings', icon: '⚙' }
]

export function App(): React.JSX.Element {
  const status = useStatus()
  const [settings, setSettings] = useSettings()
  const [view, setView] = useState<View>('capture')
  const [focusId, setFocusId] = useState<string | null>(null)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [forceSetup, setForceSetup] = useState(false)

  const toast = useCallback((level: Toast['level'], message: string) => {
    const id = Math.random().toString(36).slice(2)
    setToasts((t) => [...t.slice(-3), { id, level, message }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), level === 'error' ? 8000 : 4500)
  }, [])

  const { level } = useRecorderHost(toast)
  const inbox = useCaptures({ view: 'inbox', limit: 500 })

  useEvent((e) => {
    if (e.type === 'navigate') {
      if (NAV.some((n) => n.view === e.view)) setView(e.view as View)
      setFocusId(e.captureId ?? null)
    } else if (e.type === 'toast') {
      toast(e.level, e.message)
    } else if (e.type === 'capture-result' && e.stage === 'classified') {
      toast('success', e.text)
    }
  })

  // Keyboard shortcut inside the window as well (Space when nothing is focused).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const tag = (e.target as HTMLElement)?.tagName
      if (
        e.code === 'Space' &&
        !['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(tag) &&
        view === 'capture'
      ) {
        e.preventDefault()
        void api.toggleRecording()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [view])

  if (!status || !settings) return <div className="loading">Starting EchoNote…</div>

  if (!settings.setupCompleted || forceSetup) {
    return (
      <SetupPage
        status={status}
        settings={settings}
        onSettings={setSettings}
        onDone={() => {
          setForceSetup(false)
          setView('capture')
        }}
      />
    )
  }

  const inboxCount = inbox.items.length
  const go = (v: View): void => {
    setView(v)
    setFocusId(null)
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-dot" /> EchoNote
        </div>
        <nav>
          {NAV.map((n) => (
            <button
              key={n.view}
              className={`nav-item ${view === n.view ? 'active' : ''}`}
              onClick={() => go(n.view)}
              data-testid={`nav-${n.view}`}
            >
              <span className="nav-icon">{n.icon}</span>
              {n.label}
              {n.view === 'inbox' && inboxCount > 0 && <span className="badge">{inboxCount}</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <StatusPills status={status} onClick={() => go('settings')} />
        </div>
      </aside>
      <main className="content">
        {status.recording.state !== 'idle' && view !== 'capture' && (
          <div className="rec-banner" onClick={() => go('capture')}>
            <span className="rec-dot" /> Microphone is recording — click to view
          </div>
        )}
        {view === 'capture' && <CapturePage status={status} settings={settings} level={level} />}
        {view === 'inbox' && <InboxPage status={status} focusId={focusId} />}
        {(view === 'task' || view === 'idea' || view === 'reference') && (
          <CategoryPage category={view} status={status} focusId={focusId} />
        )}
        {view === 'reminder' && <RemindersPage status={status} focusId={focusId} />}
        {view === 'search' && <SearchPage status={status} />}
        {view === 'settings' && (
          <SettingsPage
            status={status}
            settings={settings}
            onSettings={setSettings}
            onToast={toast}
            onRunSetup={() => setForceSetup(true)}
          />
        )}
      </main>
      <Toasts toasts={toasts} />
    </div>
  )
}
