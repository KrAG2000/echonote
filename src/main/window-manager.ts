import { BrowserWindow, Menu, Tray, nativeImage, screen, type WebPreferences } from 'electron'
import path from 'node:path'
import type { AppPaths } from './paths'
import type { Logger } from './logger'
import type { PushEvent } from '../shared/types'
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

  /** Set by the app: the popup must never be hidden while a recording is in progress. */
  canHideOverlay: () => boolean = () => true

  hideOverlay(afterMs = 0): void {
    if (this.overlayHideTimer) clearTimeout(this.overlayHideTimer)
    this.overlayHideTimer = setTimeout(() => {
      // A result for an earlier note can arrive while a new recording runs; keep the popup then.
      if (this.canHideOverlay()) this.overlay?.hide()
    }, afterMs)
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

  private indicatorTimer: NodeJS.Timeout | null = null

  /**
   * Top-bar recording indicator, like GNOME's screen-recording dot: a red dot exists only while
   * the microphone is recording, a green check is shown for a few seconds after it stops, and
   * otherwise there is no icon at all. Needs a StatusNotifierItem host (on GNOME: the AppIndicator
   * extension); without one the icon is simply not shown.
   */
  setIndicator(kind: 'recording' | 'done' | 'hidden', actions: TrayActions): void {
    if (this.indicatorTimer) clearTimeout(this.indicatorTimer)
    this.indicatorTimer = null
    if (kind === 'hidden') {
      this.tray?.destroy()
      this.tray = null
      return
    }
    try {
      const icon = nativeImage.createFromPath(
        kind === 'recording' ? this.paths.trayIconRecording : this.paths.trayIconDone
      )
      if (!this.tray) {
        this.tray = new Tray(icon)
        this.tray.on('click', () => actions.showMain())
      } else {
        this.tray.setImage(icon)
      }
      this.tray.setToolTip(kind === 'recording' ? 'EchoNote is recording' : 'EchoNote: recording saved')
      this.tray.setContextMenu(
        Menu.buildFromTemplate([
          kind === 'recording'
            ? { label: '■ Stop recording', click: () => actions.toggleRecording() }
            : { label: 'Recording saved', enabled: false },
          { label: 'Open EchoNote', click: () => actions.showMain() }
        ])
      )
    } catch (err) {
      this.logger.warn('indicator: unavailable', { err: err as Error })
      this.tray = null
    }
    if (kind === 'done') {
      this.indicatorTimer = setTimeout(() => this.setIndicator('hidden', actions), 3000)
    }
  }
}
