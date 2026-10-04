import { useEffect, useState } from 'react'
import type { AppStatus, Diagnostics, Settings } from '../../../shared/types'
import { api } from '../lib'
import { ModelRow } from '../components/ModelRow'

/** Converts a keydown into an Electron accelerator string, or null for a bare modifier. */
function toAccelerator(e: React.KeyboardEvent): string | null {
  const mods: string[] = []
  if (e.ctrlKey) mods.push('Ctrl')
  if (e.altKey) mods.push('Alt')
  if (e.shiftKey) mods.push('Shift')
  if (e.metaKey) mods.push('Super')
  const code = e.code
  let key: string | null = null
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3)
  else if (/^Digit\d$/.test(code)) key = code.slice(5)
  else if (/^F\d{1,2}$/.test(code)) key = code
  else if (code === 'Space') key = 'Space'
  else if (
    ['Enter', 'Tab', 'Backspace', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown'].includes(code)
  )
    key = code
  else if (code.startsWith('Arrow')) key = code.slice(5)
  if (!key) return null
  if (mods.length === 0 && !/^F\d/.test(key)) return null // require a modifier for non-function keys
  return [...mods, key].join('+')
}

export function SettingsPage({
  status,
  settings,
  onSettings,
  onToast,
  onRunSetup
}: {
  status: AppStatus
  settings: Settings
  onSettings: (s: Settings) => void
  onToast: (level: 'info' | 'success' | 'error', msg: string) => void
  onRunSetup: () => void
}): React.JSX.Element {
  const [capturing, setCapturing] = useState(false)
  const [shortcutError, setShortcutError] = useState<string | null>(null)
  const [diag, setDiag] = useState<Diagnostics | null>(null)
  const [deleteText, setDeleteText] = useState('')
  const [deleteModels, setDeleteModels] = useState(false)

  useEffect(() => {
    void api.diagnostics().then((r) => r.ok && setDiag(r.data))
  }, [status.llm.state, status.speech.state])

  const update = async (patch: Partial<Settings>): Promise<boolean> => {
    const r = await api.updateSettings(patch)
    if (r.ok) {
      onSettings(r.data)
      return true
    }
    onToast('error', r.error.message)
    return false
  }

  const onShortcutKey = async (e: React.KeyboardEvent): Promise<void> => {
    e.preventDefault()
    if (e.key === 'Escape') {
      setCapturing(false)
      return
    }
    const acc = toAccelerator(e)
    if (!acc) return
    setCapturing(false)
    const r = await api.updateSettings({ shortcut: acc })
    if (r.ok) {
      onSettings(r.data)
      setShortcutError(null)
      onToast('success', `Shortcut set to ${acc}`)
    } else {
      setShortcutError(r.error.message)
    }
  }

  const runDesktop = async (
    fn: () => Promise<{ ok: boolean; error?: { message: string } }>
  ): Promise<void> => {
    const r = await fn()
    if (r.ok) {
      setShortcutError(null)
      onToast('success', 'Desktop shortcut updated.')
    } else setShortcutError(r.error?.message ?? 'Failed')
  }

  const speechModels = status.models.filter((m) => m.kind === 'speech')
  const llmModels = status.models.filter((m) => m.kind === 'llm')

  return (
    <div className="page settings">
      <h1>Settings</h1>

      <section>
        <h2>Recording shortcut</h2>
        <div className="row">
          <button
            className={`shortcut-field ${capturing ? 'capturing' : ''}`}
            onClick={() => setCapturing(true)}
            onKeyDown={(e) => capturing && void onShortcutKey(e)}
            onBlur={() => setCapturing(false)}
            data-testid="shortcut-field"
          >
            {capturing ? 'Press the new shortcut… (Esc to cancel)' : settings.shortcut}
          </button>
          <span className={`chip ${status.shortcut.registered ? 'ok' : 'bad'}`} data-testid="shortcut-chip">
            {status.shortcut.method === 'global'
              ? 'active'
              : status.shortcut.method === 'desktop'
                ? 'active (GNOME keyboard shortcut)'
                : 'not active'}
          </span>
          {status.shortcut.desktopShortcutAvailable &&
            status.shortcut.method !== 'global' &&
            (status.shortcut.method === 'desktop' ? (
              <button className="ghost small" onClick={() => void runDesktop(api.removeDesktopShortcut)}>
                Remove GNOME shortcut
              </button>
            ) : (
              <button
                className="primary small"
                onClick={() => void runDesktop(api.installDesktopShortcut)}
                data-testid="install-desktop-shortcut"
              >
                Set up GNOME shortcut
              </button>
            ))}
        </div>
        {(shortcutError || (!status.shortcut.registered && status.shortcut.message)) && (
          <div className="callout bad" data-testid="shortcut-error">
            {shortcutError ?? status.shortcut.message}
          </div>
        )}
        <p className="hint">
          Session: {status.sessionType}. On GNOME with Wayland, apps cannot grab keys directly, so EchoNote
          adds a GNOME keyboard shortcut (visible in Settings → Keyboard → Custom Shortcuts) that runs{' '}
          <code>EchoNote --toggle</code>. On other desktops, bind a custom keyboard shortcut to the EchoNote
          AppImage path followed by <code>--toggle</code>.
        </p>
      </section>

      <section>
        <h2>Speech recognition</h2>
        <label className="field">
          Model
          <select
            value={settings.speechModelId}
            onChange={(e) => void update({ speechModelId: e.target.value })}
          >
            {speechModels.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
                {m.verified ? '' : ' (not downloaded)'}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Language
          <select
            value={settings.speechLanguage}
            onChange={(e) => void update({ speechLanguage: e.target.value as Settings['speechLanguage'] })}
          >
            <option value="en">English</option>
            <option value="hi">Hindi / Hinglish (needs the multilingual model)</option>
            <option value="auto">Auto-detect (needs the multilingual model)</option>
          </select>
        </label>
        {settings.speechLanguage !== 'en' && settings.speechModelId.includes('.en') && (
          <div className="callout warn">
            English-only models ignore this setting. Choose “Whisper small (multilingual)”.
          </div>
        )}
        {speechModels.map((m) => (
          <ModelRow key={m.id} m={m} active={m.id === settings.speechModelId} />
        ))}
        <div className="row">
          <span className="hint">
            Status: {status.speech.state}
            {status.speech.message ? ` — ${status.speech.message}` : ''}
            {status.speech.loadMs ? ` · loaded in ${(status.speech.loadMs / 1000).toFixed(1)} s` : ''}
          </span>
          <button className="ghost small" onClick={() => void api.retryLoad('speech')}>
            Restart speech engine
          </button>
        </div>
      </section>

      <section>
        <h2>AI model (organizing)</h2>
        <label className="field">
          Model
          <select value={settings.llmModelId} onChange={(e) => void update({ llmModelId: e.target.value })}>
            {llmModels.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
                {m.verified ? '' : ' (not downloaded)'}
              </option>
            ))}
          </select>
        </label>
        {llmModels.map((m) => (
          <ModelRow key={m.id} m={m} active={m.id === settings.llmModelId} />
        ))}
        <div className="row">
          <span className="hint" data-testid="llm-status">
            Status: {status.llm.state}
            {status.llm.message ? ` — ${status.llm.message}` : ''}
            {status.llm.loadMs ? ` · loaded in ${(status.llm.loadMs / 1000).toFixed(1)} s` : ''}
          </span>
          <button className="ghost small" onClick={() => void api.retryLoad('llm')}>
            Restart AI model
          </button>
          {status.llm.state === 'insufficient_memory' && (
            <button className="ghost small" onClick={() => void api.retryLoad('llm', true)}>
              Load anyway
            </button>
          )}
        </div>
        <label className="field">
          Unload the AI model after inactivity
          <select
            value={settings.llmIdleUnloadMinutes}
            onChange={(e) => void update({ llmIdleUnloadMinutes: Number(e.target.value) })}
          >
            <option value={0}>Never (fastest)</option>
            <option value={10}>After 10 minutes</option>
            <option value={30}>After 30 minutes</option>
            <option value={120}>After 2 hours</option>
          </select>
        </label>
      </section>

      <section>
        <h2>Reminders & behaviour</h2>
        <label className="field">
          Default time when you give a day but no time
          <select
            value={settings.defaultReminderHour}
            onChange={(e) => void update({ defaultReminderHour: Number(e.target.value) })}
          >
            {Array.from({ length: 24 }, (_, h) => (
              <option key={h} value={h}>
                {String(h).padStart(2, '0')}:00
              </option>
            ))}
          </select>
        </label>
        <label className="toggle">
          <input
            type="checkbox"
            checked={settings.notificationsEnabled}
            onChange={(e) => void update({ notificationsEnabled: e.target.checked })}
          />
          Desktop notifications for reminders
        </label>
        <button
          className="ghost small"
          onClick={() =>
            void api
              .testNotification()
              .then((r) =>
                onToast(
                  r.ok && r.data ? 'success' : 'error',
                  r.ok && r.data ? 'Test notification sent.' : 'Notifications are not supported here.'
                )
              )
          }
        >
          Send test notification
        </button>
        <label className="toggle">
          <input
            type="checkbox"
            checked={settings.closeToBackground}
            onChange={(e) => void update({ closeToBackground: e.target.checked })}
          />
          Keep running in the background when the window is closed (needed for reminders and the shortcut)
        </label>
        <label className="toggle">
          <input
            type="checkbox"
            checked={settings.launchAtLogin}
            onChange={(e) => void update({ launchAtLogin: e.target.checked })}
          />
          Launch at login (installed app only)
        </label>
        <p className="hint">
          Reminders are delivered only while EchoNote is running. Missed reminders are shown as overdue at
          next launch.
        </p>
      </section>

      <section>
        <h2>Privacy & data</h2>
        <label className="toggle">
          <input
            type="checkbox"
            checked={settings.keepAudio}
            onChange={(e) => void update({ keepAudio: e.target.checked })}
          />
          Keep audio recordings after transcription
        </label>
        <p className="hint">
          By default, audio is deleted as soon as it has been transcribed; only the text is kept. If
          transcription fails, the audio is kept so you can retry. Nothing is ever uploaded.
        </p>
        <div className="row">
          <button className="ghost small" onClick={() => void api.openDataFolder()}>
            Open data folder
          </button>
          <button
            className="ghost small"
            onClick={() =>
              void api
                .exportDiagnostics(false)
                .then((r) => r.ok && r.data && onToast('success', `Saved to ${r.data}`))
            }
          >
            Export diagnostics (no personal content)
          </button>
          <button className="ghost small" onClick={onRunSetup}>
            Run setup again
          </button>
        </div>
        <div className="danger-zone">
          <b>Delete all data</b>
          <p className="hint">
            Permanently deletes every capture, reminder, setting, pending audio file and log.
          </p>
          <label className="toggle">
            <input
              type="checkbox"
              checked={deleteModels}
              onChange={(e) => setDeleteModels(e.target.checked)}
            />{' '}
            Also delete downloaded models
          </label>
          <div className="row">
            <input
              placeholder='Type "DELETE" to confirm'
              value={deleteText}
              onChange={(e) => setDeleteText(e.target.value)}
            />
            <button
              className="danger small"
              disabled={deleteText !== 'DELETE'}
              onClick={() => void api.deleteAllData(deleteModels)}
            >
              Delete everything
            </button>
          </div>
        </div>
      </section>

      <section>
        <h2>Diagnostics</h2>
        {diag && (
          <table className="diag">
            <tbody>
              <tr>
                <td>Version</td>
                <td>
                  EchoNote {diag.appVersion} · Electron {diag.electron} · Node {diag.node}
                </td>
              </tr>
              <tr>
                <td>System</td>
                <td>
                  {diag.platform} · {diag.sessionType} · {diag.cpu} ({diag.cpuCount} threads) ·{' '}
                  {diag.availableMemMB} / {diag.totalMemMB} MB free
                </td>
              </tr>
              <tr>
                <td>Runtimes</td>
                <td>
                  <pre>{diag.nativeVersions ?? 'not found'}</pre>
                </td>
              </tr>
              <tr>
                <td>Data</td>
                <td>
                  <code>{diag.paths.userData}</code>
                </td>
              </tr>
              <tr>
                <td>Models</td>
                <td>
                  <code>{diag.paths.models}</code>
                </td>
              </tr>
              <tr>
                <td>Logs</td>
                <td>
                  <code>{diag.paths.logs}</code>
                </td>
              </tr>
              <tr>
                <td>Captures</td>
                <td>
                  {Object.entries(diag.counts)
                    .map(([k, v]) => `${k}: ${v}`)
                    .join(' · ') || 'none'}
                </td>
              </tr>
              <tr>
                <td>Recent timings</td>
                <td>
                  <TimingTable rows={diag.recentTimings} />
                </td>
              </tr>
            </tbody>
          </table>
        )}
        <div className="row">
          <button className="ghost small" onClick={() => void api.quit()}>
            Quit EchoNote completely
          </button>
        </div>
      </section>
    </div>
  )
}

function TimingTable({ rows }: { rows: Diagnostics['recentTimings'] }): React.JSX.Element {
  const span = (t: Record<string, number>, a: string, b: string): string =>
    t[a] && t[b] ? `${((t[b] - t[a]) / 1000).toFixed(2)}s` : '–'
  if (!rows.length) return <span className="hint">No captures yet.</span>
  return (
    <table className="timings">
      <thead>
        <tr>
          <th>Shortcut→rec</th>
          <th>Audio→transcript</th>
          <th>Transcribe</th>
          <th>LLM</th>
          <th>Stop→organized</th>
        </tr>
      </thead>
      <tbody>
        {rows.slice(0, 8).map(({ captureId, timings: t }) => (
          <tr key={captureId}>
            <td>{span(t, 'shortcutReceived', 'recordingStarted')}</td>
            <td>{span(t, 'audioFinalized', 'transcriptPersisted')}</td>
            <td>{span(t, 'transcriptionStarted', 'transcriptionFinished')}</td>
            <td>{span(t, 'llmStarted', 'llmFinished')}</td>
            <td>{span(t, 'recordingStopped', 'finalPersisted')}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
