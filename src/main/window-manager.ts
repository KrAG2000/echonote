import { BrowserWindow, Menu, Tray, nativeImage, screen, type WebPreferences } from 'electron'
import path from 'node:path'
import type { AppPaths } from './paths'
import type { Logger } from './logger'
import type { PushEvent, RecorderState } from '../shared/types'
import { PUSH_CHANNEL } from '../shared/api'

const secureWebPreferences = (preload: string): WebPreferences => ({
  preload,
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  webSecurity: true,
  // The main window hosts the recorder and must keep working while hidden.
  backgroundThrottling: false,
  spellcheck: false
})

export interface TrayActions {
  toggleRecording(): void
  showMain(): void
  quit(): void
}

/** Main dashboard window, the compact capture overlay, and the tray icon. */
export class WindowManager {
  main: BrowserWindow | null = null
  overlay: BrowserWindow | null = null
  tray: Tray | null = null
  private overlayHideTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly paths: AppPaths,
    private readonly logger: Logger,
    private readonly preload: string
  ) {}

  private load(win: BrowserWindow, route: string): void {
    const devUrl = process.env.ELECTRON_RENDERER_URL
    if (devUrl) void win.loadURL(`${devUrl}#${route}`)
    else void win.loadFile(path.join(__dirname, '../renderer/index.html'), { hash: route })
  }

  createMain(show: boolean): BrowserWindow {
    const win = new BrowserWindow({
      width: 1100,
      height: 760,
      minWidth: 760,
      minHeight: 520,
      show: false,
      title: 'EchoNote',
      icon: this.paths.icon,
      backgroundColor: '#111318',
      autoHideMenuBar: true,
      webPreferences: secureWebPreferences(this.preload)
    })
    win.setMenuBarVisibility(false)
    this.main = win
    this.lockDown(win)
    this.load(win, '/')
    win.once('ready-to-show', () => {
      if (show) win.show()
    })
    win.on('closed', () => {
      if (this.main === win) this.main = null
    })
    return win
  }

  createOverlay(): BrowserWindow {
    const width = 360
    const height = 92
    const area = screen.getPrimaryDisplay().workArea
    const win = new BrowserWindow({
      width,
      height,
      x: Math.round(area.x + (area.width - width) / 2),
      y: area.y + 24,
      show: false,
      frame: false,
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      focusable: true,
      title: 'EchoNote capture',
      backgroundColor: '#1b1e26',
      webPreferences: secureWebPreferences(this.preload)
    })
    win.setAlwaysOnTop(true, 'floating')
    this.overlay = win
    this.lockDown(win)
    this.load(win, '/overlay')
    win.on('closed', () => {
      if (this.overlay === win) this.overlay = null
    })
    return win
  }

  /** Renderer windows never navigate away or open new windows. */
  private lockDown(win: BrowserWindow): void {
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', (e, url) => {
      const devUrl = process.env.ELECTRON_RENDERER_URL
      if (!(devUrl && url.startsWith(devUrl))) e.preventDefault()
    })
  }

  showMain(view?: string, captureId?: string): void {
    const win = this.main ?? this.createMain(true)
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    if (view) this.send(win, { type: 'navigate', view, captureId })
  }

  showOverlay(): void {
    if (this.overlayHideTimer) clearTimeout(this.overlayHideTimer)
    this.overlayHideTimer = null
    const win = this.overlay ?? this.createOverlay()
    if (!win.isVisible()) win.showInactive()
  }

  hideOverlay(afterMs = 0): void {
    if (this.overlayHideTimer) clearTimeout(this.overlayHideTimer)
    this.overlayHideTimer = setTimeout(() => this.overlay?.hide(), afterMs)
  }

  /** Sends a command to the window that hosts the recorder. */
  sendToRecorder(evt: PushEvent): boolean {
    if (!this.main || this.main.isDestroyed()) return false
    this.send(this.main, evt)
    return true
  }

  broadcast(evt: PushEvent): void {
    for (const w of [this.main, this.overlay]) if (w && !w.isDestroyed()) this.send(w, evt)
  }

  private send(win: BrowserWindow, evt: PushEvent): void {
    try {
      win.webContents.send(PUSH_CHANNEL, evt)
    } catch (err) {
      this.logger.warn('window: send failed', { err: err as Error })
    }
  }

  createTray(actions: TrayActions): void {
    try {
      this.tray = new Tray(nativeImage.createFromPath(this.paths.trayIcon))
      this.tray.setToolTip('EchoNote')
      this.tray.on('click', () => actions.showMain())
      this.updateTray('idle', '', actions)
    } catch (err) {
      this.logger.warn('tray: unavailable', { err: err as Error })
      this.tray = null
    }
  }

  updateTray(state: RecorderState, shortcut: string, actions: TrayActions): void {
    if (!this.tray) return
    const recording = state === 'recording' || state === 'starting'
    this.tray.setImage(
      nativeImage.createFromPath(recording ? this.paths.trayIconRecording : this.paths.trayIcon)
    )
    this.tray.setToolTip(recording ? 'EchoNote — microphone is recording' : 'EchoNote')
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: recording ? '■ Stop recording' : `● Start recording${shortcut ? `  (${shortcut})` : ''}`,
          enabled: state === 'idle' || state === 'recording',
          click: () => actions.toggleRecording()
        },
        { label: 'Open EchoNote', click: () => actions.showMain() },
        { type: 'separator' },
        { label: 'Quit EchoNote', click: () => actions.quit() }
      ])
    )
  }
}
