import { useEffect, useRef, useState } from 'react'
import type { AppStatus, Settings } from '../../../shared/types'
import { api, fmtMB, unwrap } from '../lib'
import { ModelRow } from '../components/ModelRow'
import { StatusPills } from '../components/StatusPills'

/** First-run setup: explains local processing, downloads + verifies models, tests the mic. */
export function SetupPage({
  status,
  settings,
  onSettings,
  onDone
}: {
  status: AppStatus
  settings: Settings
  onSettings: (s: Settings) => void
  onDone: () => void
}): React.JSX.Element {
  const speech = status.models.find((m) => m.id === settings.speechModelId)
  const llm = status.models.find((m) => m.id === settings.llmModelId)
  const required = [speech, llm].filter((m): m is NonNullable<typeof m> => !!m)
  const missing = required.filter((m) => !m.verified)
  const totalMissing = missing.reduce((n, m) => n + m.sizeBytes, 0)
  const anyDownloading = required.some((m) => m.downloading || m.verifying)
  const [error, setError] = useState<string | null>(null)
  const [mic, setMic] = useState<'untested' | 'testing' | 'ok' | 'silent' | string>('untested')
  const [micLevel, setMicLevel] = useState(0)
  const stopRef = useRef<(() => void) | null>(null)

  useEffect(() => () => stopRef.current?.(), [])

  const downloadAll = async (): Promise<void> => {
    setError(null)
    for (const m of missing) {
      const r = await api.downloadModel(m.id)
      if (!r.ok) {
        setError(r.error.message)
        return
      }
    }
  }

  const testMic = async (): Promise<void> => {
    setMic('testing')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const ctx = new AudioContext()
      const analyser = ctx.createAnalyser()
      ctx.createMediaStreamSource(stream).connect(analyser)
      const data = new Float32Array(analyser.fftSize)
      let max = 0
      const iv = setInterval(() => {
        analyser.getFloatTimeDomainData(data)
        const peak = data.reduce((p, v) => Math.max(p, Math.abs(v)), 0)
        max = Math.max(max, peak)
        setMicLevel(peak)
      }, 60)
      const stop = (): void => {
        clearInterval(iv)
        stream.getTracks().forEach((t) => t.stop())
        void ctx.close()
        setMicLevel(0)
      }
      stopRef.current = stop
      setTimeout(() => {
        stop()
        setMic(max > 0.02 ? 'ok' : 'silent')
      }, 3000)
    } catch (err) {
      const name = (err as DOMException).name
      setMic(
        name === 'NotAllowedError'
          ? 'Microphone access was denied. Allow it in your system privacy settings and try again.'
          : name === 'NotFoundError'
            ? 'No microphone found. Connect one and try again.'
            : `Microphone error: ${(err as Error).message}`
      )
    }
  }

  const finish = async (): Promise<void> => {
    try {
      onSettings(unwrap(await api.updateSettings({ setupCompleted: true })))
      onDone()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const pickLlm = async (id: string): Promise<void> => {
    const r = await api.updateSettings({ llmModelId: id })
    if (r.ok) onSettings(r.data)
  }

  return (
    <div className="setup">
      <div className="setup-card">
        <h1>
          <span className="brand-dot" /> Welcome to EchoNote
        </h1>
        <p className="lede">
          Press a shortcut, say what's on your mind, and EchoNote turns it into a task, reminder, idea or
          reference note.
        </p>
        <div className="callout ok">
          🔒 Speech recognition (whisper.cpp) and the AI model (llama.cpp) run{' '}
          <b>entirely on this computer</b>. Your recordings, transcripts and notes are never sent anywhere.
          The only network access is downloading the model files below, once, from Hugging Face.
        </div>

        <h2>1. Download the local models</h2>
        {required.map((m) => (
          <ModelRow key={m.id} m={m} active />
        ))}
        {missing.length > 0 && (
          <button
            className="primary"
            onClick={() => void downloadAll()}
            disabled={anyDownloading}
            data-testid="setup-download"
          >
            {anyDownloading ? 'Downloading…' : `Download ${fmtMB(totalMissing)}`}
          </button>
        )}
        {llm && (
          <div className="hint">
            Low on memory? Use the smaller model instead:{' '}
            <select
              value={settings.llmModelId}
              onChange={(e) => void pickLlm(e.target.value)}
              disabled={anyDownloading}
            >
              {status.models
                .filter((m) => m.kind === 'llm')
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name} ({fmtMB(m.sizeBytes)})
                  </option>
                ))}
            </select>
          </div>
        )}
        {error && <div className="callout bad">{error}</div>}

        <h2>2. Test your microphone</h2>
        <div className="row">
          <button className="ghost" onClick={() => void testMic()} disabled={mic === 'testing'}>
            {mic === 'testing' ? 'Listening… say something' : 'Test microphone'}
          </button>
          <div className="meter">
            <div className="meter-fill" style={{ width: `${Math.min(100, micLevel * 300)}%` }} />
          </div>
        </div>
        {mic === 'ok' && <div className="callout ok">Microphone works.</div>}
        {mic === 'silent' && (
          <div className="callout warn">
            The microphone opened but picked up almost no sound. Check the input device and volume in system
            settings.
          </div>
        )}
        {mic !== 'ok' && mic !== 'silent' && mic !== 'untested' && mic !== 'testing' && (
          <div className="callout bad">{mic}</div>
        )}

        <h2>3. Your shortcut</h2>
        <p>
          {status.shortcut.registered ? (
            <>
              Press <kbd>{settings.shortcut}</kbd> from anywhere to start recording, and again to stop. You
              can change it in Settings.
            </>
          ) : status.shortcut.desktopShortcutAvailable ? (
            <>
              On GNOME ({status.sessionType}) apps cannot grab keys directly. Add{' '}
              <kbd>{settings.shortcut}</kbd> as a GNOME keyboard shortcut that starts and stops recording:{' '}
              <button
                className="primary small"
                onClick={() => void api.installDesktopShortcut()}
                data-testid="setup-desktop-shortcut"
              >
                Set up GNOME shortcut
              </button>
            </>
          ) : (
            <>
              The global shortcut could not be registered on this desktop ({status.sessionType}). You can
              record with the in-app button or tray menu, or bind a desktop keyboard shortcut to{' '}
              <code>echonote --toggle</code>.
            </>
          )}
        </p>

        <div className="setup-foot">
          <StatusPills status={status} />
          <div className="spacer" />
          {missing.length > 0 && (
            <button className="ghost" onClick={() => void finish()} data-testid="setup-skip">
              Skip for now
            </button>
          )}
          <button
            className="primary"
            onClick={() => void finish()}
            disabled={missing.length > 0}
            data-testid="setup-finish"
          >
            Start using EchoNote
          </button>
        </div>
        {missing.length > 0 && (
          <div className="hint">
            If you skip, recordings are still saved and will be transcribed and organized once the models are
            installed.
          </div>
        )}
      </div>
    </div>
  )
}
