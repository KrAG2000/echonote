import { app, dialog } from 'electron'
import { resolvePaths } from './paths'
import { EchoApp } from './app'
import { registerIpc } from './ipc/handlers'

// --- Process-level configuration (must happen before 'ready') ------------------------------

if (process.env.ECHONOTE_USER_DATA) app.setPath('userData', process.env.ECHONOTE_USER_DATA)

// Global shortcuts on Wayland go through the XDG desktop portal.
app.commandLine.appendSwitch('enable-features', 'GlobalShortcutsPortal')
// The recorder's AudioContext is started by a shortcut, not a click inside the page.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
// Test hook: feed a WAV file in place of the microphone (used by the end-to-end tests).
if (process.env.ECHONOTE_FAKE_AUDIO) {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream')
  app.commandLine.appendSwitch('use-file-for-fake-audio-capture', process.env.ECHONOTE_FAKE_AUDIO)
}

const argv = process.argv
const hidden = argv.includes('--hidden')
const toggle = argv.includes('--toggle')

if (!app.requestSingleInstanceLock()) {
  // Another instance owns the data directory; it receives our argv via 'second-instance'.
  app.quit()
} else {
  let echo: EchoApp | null = null
  let shuttingDown = false

  app.on('second-instance', (_e, args) => echo?.handleSecondInstance(args))

  app.whenReady().then(async () => {
    try {
      echo = new EchoApp(resolvePaths())
      registerIpc(echo)
      await echo.init({ hidden, toggle })
    } catch (err) {
      echo?.logger.error('app: fatal startup error', { err: err as Error })
      dialog.showErrorBox(
        'EchoNote could not start',
        `${(err as Error).message}\n\nYour notes have not been modified. Logs: ${app.getPath('userData')}/logs`
      )
      app.exit(1)
    }
  })

  app.on('before-quit', (e) => {
    if (!echo || shuttingDown) return
    if (echo.onBeforeQuit()) {
      e.preventDefault()
      return
    }
    e.preventDefault()
    shuttingDown = true
    void echo.shutdown().finally(() => app.exit(0))
  })

  // With close-to-background the main window only hides; this fires only if it really closed.
  app.on('window-all-closed', () => app.quit())

  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => app.quit())
}
