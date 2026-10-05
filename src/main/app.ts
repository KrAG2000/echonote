import { app, dialog, Notification, session, shell } from 'electron'
import fs from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { AppPaths } from './paths'
import { createLogger, type Logger } from './logger'
import { openDatabase, transaction, type Db } from './database/connection'
import { CapturesRepo } from './database/captures-repo'
import { RemindersRepo } from './database/reminders-repo'
import { SettingsRepo } from './database/settings-repo'
import { loadManifest, ModelManager } from './services/model-manager'
import { WhisperEngine } from './services/transcription-engine'
import { LlamaEngine } from './services/classification-engine'
import { availableMemoryMB, RuntimeManager } from './services/runtime-manager'
import { Pipeline } from './services/pipeline'
import { ReminderService, type Notifier } from './services/reminder-service'
import { RecordingController } from './services/recording-controller'
import {
  AudioError,
  assertNotEmpty,
  deleteAudioFile,
  measureLevels,
  parseWav,
  saveWav
} from './services/audio-store'
import { WindowManager, type TrayActions } from './window-manager'
import { ShortcutManager } from './shortcut-manager'
import { setLaunchAtLogin } from './autostart'
import { TogglePipe, togglePipePath } from './toggle-pipe'
import type {
  RecorderState,
  AppStatus,
  Capture,
  CaptureUpdate,
  Diagnostics,
  PushEvent,
  Settings,
  ShortcutStatus
} from '../shared/types'

const execFileAsync = promisify(execFile)

export class UserError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}

export class EchoApp {
  readonly logger: Logger
  db!: Db
  captures!: CapturesRepo
  reminders!: RemindersRepo
  settingsRepo!: SettingsRepo
  settings!: Settings
  models!: ModelManager
  runtime!: RuntimeManager
  pipeline!: Pipeline
  reminderService!: ReminderService
  recorder!: RecordingController
  windows!: WindowManager
  shortcuts!: ShortcutManager
  private notifications = new Set<Notification>()
  private statusTimer: NodeJS.Timeout | null = null
  private quitting = false
  private quitAfterRecording = false
  private toggleWhenReady = false
  private rendererReady = false
  private hiddenNoticeShown = false
  private trayActions!: TrayActions
  private togglePipe: TogglePipe | null = null
  private topBarIndicator = false
  private lastRecorderState: RecorderState = 'idle'

  constructor(readonly paths: AppPaths) {
    this.logger = createLogger(paths.logs, { echo: !app.isPackaged })
  }

  // -------------------------------------------------------------------------
  // Startup
  // -------------------------------------------------------------------------

  async init(opts: { hidden: boolean; toggle: boolean }): Promise<void> {
    const t0 = Date.now()
    this.logger.info('app: starting', { version: app.getVersion(), packaged: app.isPackaged })
    fs.mkdirSync(this.paths.userData, { recursive: true })

    this.db = openDatabase(this.paths.database)
    this.captures = new CapturesRepo(this.db)
    this.reminders = new RemindersRepo(this.db)
    this.settingsRepo = new SettingsRepo(this.db)
    this.settings = this.settingsRepo.get()

    this.applySessionSecurity()

    this.windows = new WindowManager(this.paths, this.logger, path.join(__dirname, '../preload/index.js'))
    this.windows.createMain(!opts.hidden)
    this.windows.main!.on('close', (e) => this.onMainClose(e))
    // Recorder readiness comes from the renderer itself (recorder:ready), not from page load.
    this.windows.main!.webContents.on('did-start-loading', () => (this.rendererReady = false))
    this.windows.main!.webContents.on('render-process-gone', () => {
      this.rendererReady = false
      if (this.recorder.state !== 'idle') {
        this.recorder.onFailed({ code: 'RECORDING_FAILED', message: 'The recorder window crashed.' })
      }
    })

    this.recorder = new RecordingController(
      (command) =>
        this.windows.sendToRecorder({
          type: 'recorder-command',
          command,
          ...(command === 'start' ? { silenceStopMs: this.settings.silenceStopSeconds * 1000 } : {})
        }),
      () => this.onRecorderChange(),
      this.logger
    )
    this.windows.canHideOverlay = () => this.recorder.state === 'idle'
    this.trayActions = {
      toggleRecording: () => this.toggleRecording('tray'),
      showMain: () => this.windows.showMain(),
      quit: () => app.quit()
    }
    void this.detectTopBar()

    const pipePath = togglePipePath(this.paths.userData)
    this.togglePipe = new TogglePipe(pipePath, this.logger, () => this.toggleRecording('shortcut'))
    this.togglePipe.start()
    // Only the normal profile owns the desktop-wide GNOME shortcut. Instances with a custom data
    // directory (tests, ECHONOTE_USER_DATA) must never rewrite it to point at themselves.
    this.shortcuts = new ShortcutManager(
      this.logger,
      () => this.toggleRecording('shortcut'),
      pipePath,
      !process.env.ECHONOTE_USER_DATA
    )
    void this.shortcuts.register(this.settings.shortcut).then(() => {
      this.pushStatus()
    })

    // Model + runtime management
    // Test hook: simulate a network failure for model downloads (end-to-end tests).
    const offlineFetch: typeof fetch = () => Promise.reject(new TypeError('fetch failed (simulated offline)'))
    this.models = new ModelManager(
      loadManifest(this.paths.manifest),
      this.paths.models,
      this.logger,
      process.env.ECHONOTE_TEST_OFFLINE === '1' ? offlineFetch : fetch
    )
    this.models.on('progress', () => this.pushStatus())
    const whisper = new WhisperEngine(this.logger)
    const llama = new LlamaEngine(this.logger)
    this.runtime = new RuntimeManager(
      this.models,
      whisper,
      llama,
      this.paths.binDir,
      this.logger,
      () => this.settings
    )
    this.runtime.on('change', () => {
      this.pushStatus()
      if (this.runtime.whisper.isReady() || this.runtime.llama.isReady()) this.pipeline?.resume()
    })

    this.pipeline = new Pipeline({
      db: this.db,
      captures: this.captures,
      reminders: this.reminders,
      transcriber: whisper,
      classifier: llama,
      logger: this.logger,
      settings: () => this.settings,
      deleteAudio: (p) => deleteAudioFile(this.paths.audio, p),
      events: {
        changed: () => {
          this.broadcast({ type: 'captures-changed' })
          this.reminderService?.reschedule()
        },
        activity: () => this.pushStatus(),
        result: (captureId, stage, text) => this.onPipelineResult(captureId, stage, text)
      }
    })

    this.reminderService = new ReminderService(this.reminders, this.captures, this.notifier(), this.logger, {
      notificationsEnabled: () => this.settings.notificationsEnabled,
      onDelivered: (_captureId, title, shown) => {
        this.broadcast({ type: 'captures-changed' })
        if (!shown) this.broadcast({ type: 'toast', level: 'info', message: `Reminder due: ${title}` })
      }
    })
    this.reminderService.start()

    if (opts.toggle) this.toggleWhenReady = true
    this.logger.info('app: ui ready', { ms: Date.now() - t0 })

    // Everything below happens in the background; the UI is already usable.
    void this.cleanupOrphanAudio()
    void this.bootRuntimes()
  }

  private async bootRuntimes(): Promise<void> {
    const s = this.settings
    await Promise.all([this.models.verify(s.speechModelId), this.models.verify(s.llmModelId)])
    this.pushStatus()
    this.pipeline.resume() // queue anything left over from the last session
    await this.runtime.startSpeech()
    await this.runtime.startLlm()
    this.pipeline.resume()
  }

  private applySessionSecurity(): void {
    const ses = session.defaultSession
    const devUrl = process.env.ELECTRON_RENDERER_URL
    // No remote content: only the bundled renderer (or the dev server) may be loaded.
    ses.webRequest.onBeforeRequest(
      { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
      (d, cb) => {
        const allowed =
          !!devUrl && (d.url.startsWith(devUrl) || d.url.startsWith(devUrl.replace('http', 'ws')))
        if (!allowed) this.logger.warn('security: blocked request', { url: d.url.slice(0, 80) })
        cb({ cancel: !allowed })
      }
    )
    const deny = process.env.ECHONOTE_TEST_DENY_MIC === '1'
    ses.setPermissionRequestHandler((_wc, permission, cb, details) => {
      const media =
        permission === 'media' &&
        (details as { mediaTypes?: string[] }).mediaTypes?.every((t) => t === 'audio')
      cb(!!media && !deny)
    })
    ses.setPermissionCheckHandler((_wc, permission) => permission === 'media' && !deny)
  }

  // -------------------------------------------------------------------------
  // Recording
  // -------------------------------------------------------------------------

  onRecorderReady(): void {
    this.rendererReady = true
    if (this.toggleWhenReady) {
      this.toggleWhenReady = false
      this.recorder.toggle('cli')
    }
  }

  toggleRecording(source: string): void {
    if (!this.rendererReady) {
      this.toggleWhenReady = true
      return
    }
    this.recorder.toggle(source)
  }

  private onRecorderChange(): void {
    const st = this.recorder.state
    const prev = this.lastRecorderState
    this.lastRecorderState = st
    if (st === 'starting' || st === 'recording' || st === 'stopping') {
      this.windows.setIndicator('recording', this.trayActions)
      if (this.popupEnabled()) this.windows.showOverlay()
    } else if (st === 'idle') {
      const saved = prev === 'stopping' && !this.recorder.lastError
      this.windows.setIndicator(saved ? 'done' : 'hidden', this.trayActions)
      if (this.recorder.lastError) this.windows.hideOverlay(5000)
    }
    this.pushStatus(true)
    if (st === 'idle' && this.quitAfterRecording) setTimeout(() => app.quit(), 300)
  }

  /** The floating popup is only needed when there is no top-bar indicator (unless forced). */
  private popupEnabled(): boolean {
    const mode = this.settings.recordingPopup
    return mode === 'on' || (mode === 'auto' && !this.topBarIndicator)
  }

  /** Is a StatusNotifierItem host (e.g. GNOME's AppIndicator extension) running? */
  private async detectTopBar(): Promise<void> {
    try {
      const { stdout } = await execFileAsync(
        'gdbus',
        [
          'call',
          '--session',
          '--dest',
          'org.freedesktop.DBus',
          '--object-path',
          '/org/freedesktop/DBus',
          '--method',
          'org.freedesktop.DBus.NameHasOwner',
          'org.kde.StatusNotifierWatcher'
        ],
        { timeout: 3000 }
      )
      this.topBarIndicator = stdout.includes('true')
    } catch {
      this.topBarIndicator = false
    }
    this.logger.info('indicator: top bar available', { available: this.topBarIndicator })
    this.pushStatus()
  }

  async submitRecording(p: {
    wav: Uint8Array
    durationMs: number
    startedAt: number
    stoppedAt: number
    voiced?: boolean
  }): Promise<{ captureId: string }> {
    const receivedAt = Date.now()
    try {
      const info = parseWav(p.wav)
      if (p.voiced === false) {
        throw new AudioError('EMPTY_RECORDING', 'No speech was detected, so nothing was saved.')
      }
      assertNotEmpty(info, measureLevels(p.wav).peak)
      const file = await saveWav(this.paths.audio, p.wav)
      const timings: Record<string, number> = {
        recordingStarted: p.startedAt,
        recordingStopped: p.stoppedAt,
        audioFinalized: receivedAt,
        audioPersisted: Date.now()
      }
      if (this.recorder.requestedAt) timings.shortcutReceived = this.recorder.requestedAt
      const capture = this.captures.create({
        audioPath: file,
        durationMs: info.durationMs,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        timings
      })
      this.logger.info('capture: saved audio', { id: capture.id, durationMs: Math.round(info.durationMs) })
      this.broadcast({ type: 'captures-changed' })
      this.broadcast({ type: 'capture-result', captureId: capture.id, stage: 'saved', text: 'Transcribing…' })
      this.pipeline.enqueueTranscription(capture.id)
      return { captureId: capture.id }
    } catch (err) {
      if (err instanceof AudioError) {
        this.recorder.lastError = { code: err.code, message: err.message }
        this.windows.hideOverlay(4000)
        throw new UserError(err.code, err.message)
      }
      throw err
    } finally {
      this.recorder.onFinished()
    }
  }

  private onPipelineResult(
    captureId: string,
    stage: 'transcribed' | 'classified' | 'failed',
    text: string
  ): void {
    this.broadcast({ type: 'capture-result', captureId, stage, text })
    if (stage === 'classified' || stage === 'failed') this.windows.hideOverlay(4000)
    if (stage === 'transcribed' && !this.runtime.llama.isReady()) {
      void this.runtime.ensureLlmLoaded()
      this.windows.hideOverlay(4000)
    }
  }

  // -------------------------------------------------------------------------
  // Captures
  // -------------------------------------------------------------------------

  updateCapture(u: CaptureUpdate): Capture {
    const c = this.captures.get(u.id)
    if (!c) throw new UserError('NOT_FOUND', 'That item no longer exists.')
    if (c.status === 'processing' || c.status === 'failed') {
      throw new UserError('NOT_EDITABLE', 'This capture has no transcript yet.')
    }
    const patch: Parameters<CapturesRepo['update']>[1] = {}
    if (u.category !== undefined) patch.category = u.category
    if (u.title !== undefined) patch.title = u.title
    if (u.summary !== undefined) patch.summary = u.summary
    if (u.action !== undefined) patch.action = u.action
    if (u.dueAt !== undefined) {
      patch.dueAt = u.dueAt
      patch.timeDefaulted = false
    }
    const category = u.category !== undefined ? u.category : c.category
    if (u.confirm) {
      if (!category) throw new UserError('CATEGORY_REQUIRED', 'Choose a category first.')
      const due = u.dueAt !== undefined ? u.dueAt : c.dueAt
      if (category === 'reminder' && !due)
        throw new UserError('DATE_REQUIRED', 'Set a date and time for this reminder.')
      patch.status = 'ready'
      patch.clearConfirmation = true
      if (!c.title && !u.title) patch.title = (c.transcript ?? 'Note').slice(0, 60)
    }
    if (u.completed === true) patch.status = 'completed'
    if (u.completed === false && c.status === 'completed') patch.status = 'ready'
    const updated = transaction(this.db, () => {
      const r = this.captures.update(u.id, patch)
      this.reminders.syncForCapture(u.id)
      return r
    })
    this.reminderService.reschedule()
    this.broadcast({ type: 'captures-changed' })
    return updated!
  }

  async deleteCapture(id: string): Promise<void> {
    const r = this.captures.delete(id) // reminders cascade
    if (!r) throw new UserError('NOT_FOUND', 'That item no longer exists.')
    if (r.audioPath) await deleteAudioFile(this.paths.audio, r.audioPath).catch(() => undefined)
    this.reminderService.reschedule()
    this.broadcast({ type: 'captures-changed' })
  }

  /** Deletes pending audio files that no capture references (e.g. after a crash mid-write). */
  private async cleanupOrphanAudio(): Promise<void> {
    try {
      const referenced = new Set(this.captures.allAudioPaths().map((p) => path.resolve(p)))
      for (const f of await fsp.readdir(this.paths.audio).catch(() => [] as string[])) {
        const full = path.resolve(this.paths.audio, f)
        if (!referenced.has(full)) await fsp.rm(full, { force: true })
      }
    } catch (err) {
      this.logger.warn('audio: cleanup failed', { err: err as Error })
    }
  }

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------

  async updateSettings(patch: Partial<Settings>): Promise<Settings> {
    const prev = this.settings
    if (patch.shortcut !== undefined && patch.shortcut !== this.shortcuts.state.accelerator) {
      const r = await this.shortcuts.register(patch.shortcut)
      // On GNOME/Wayland an unregistered shortcut is expected until the desktop shortcut is set up.
      if (
        !r.registered &&
        !(r.method === 'none' && r.desktopShortcutAvailable && r.accelerator === patch.shortcut)
      ) {
        throw new UserError('SHORTCUT_UNAVAILABLE', r.message ?? 'Shortcut could not be registered.')
      }
    }
    if (patch.launchAtLogin !== undefined && patch.launchAtLogin !== prev.launchAtLogin) {
      const r = setLaunchAtLogin(patch.launchAtLogin)
      if (!r.ok)
        throw new UserError('AUTOSTART_UNAVAILABLE', r.message ?? 'Could not change launch at login.')
    }
    for (const key of ['speechModelId', 'llmModelId'] as const) {
      const id = patch[key]
      if (id !== undefined && !this.models.entry(id)) throw new UserError('UNKNOWN_MODEL', 'Unknown model.')
    }
    this.settings = this.settingsRepo.update(patch)

    if (patch.llmIdleUnloadMinutes !== undefined) {
      this.runtime.llama.idleUnloadMinutes = this.settings.llmIdleUnloadMinutes
      this.runtime.llama.touch()
    }
    if (patch.speechModelId && patch.speechModelId !== prev.speechModelId) {
      if (await this.models.verify(patch.speechModelId)) void this.runtime.startSpeech()
    }
    if (patch.llmModelId && patch.llmModelId !== prev.llmModelId) {
      if (await this.models.verify(patch.llmModelId)) void this.runtime.startLlm()
    }
    if (patch.notificationsEnabled !== undefined || patch.defaultReminderHour !== undefined) {
      this.reminderService.reschedule()
    }
    this.pushStatus()
    return this.settings
  }

  async installDesktopShortcut(): Promise<ShortcutStatus> {
    try {
      const r = await this.shortcuts.installDesktopShortcut(this.settings.shortcut)
      this.pushStatus()
      return r
    } catch (err) {
      throw new UserError(
        'DESKTOP_SHORTCUT_FAILED',
        `Could not set up the desktop shortcut: ${(err as Error).message}`
      )
    }
  }

  async removeDesktopShortcut(): Promise<ShortcutStatus> {
    const r = await this.shortcuts.removeDesktopShortcut()
    this.pushStatus()
    return r
  }

  // -------------------------------------------------------------------------
  // Models
  // -------------------------------------------------------------------------

  async downloadModel(id: string): Promise<void> {
    await this.models.download(id)
    if (id === this.settings.speechModelId) await this.runtime.startSpeech()
    if (id === this.settings.llmModelId) await this.runtime.startLlm()
    this.pipeline.resume()
  }

  async retryLoad(kind: 'speech' | 'llm', force: boolean): Promise<void> {
    if (kind === 'speech') {
      await this.runtime.whisper.server?.stop()
      await this.runtime.startSpeech()
    } else {
      await this.runtime.llama.server?.stop()
      await this.runtime.startLlm(force)
    }
    this.pipeline.resume()
  }

  // -------------------------------------------------------------------------
  // Status & events
  // -------------------------------------------------------------------------

  status(): AppStatus {
    const speech = this.runtime.speechStatus()
    const llm = this.runtime.llmStatus()
    const act = this.pipeline.activity()
    if (speech.state === 'ready' && act.transcribing) speech.state = 'busy'
    if (llm.state === 'ready' && act.classifying) llm.state = 'busy'
    return {
      recording: this.recorder.status(),
      speech,
      llm,
      models: this.models.statuses(),
      pipeline: act,
      shortcut: this.shortcuts.state,
      notificationsSupported: Notification.isSupported(),
      topBarIndicator: this.topBarIndicator,
      setupCompleted: this.settings.setupCompleted,
      platform: `${process.platform}-${process.arch}`,
      sessionType: process.env.XDG_SESSION_TYPE ?? 'unknown'
    }
  }

  /** Coalesces status pushes (download progress can be chatty). Recorder changes go out immediately. */
  pushStatus(immediate = false): void {
    if (immediate) {
      if (this.statusTimer) clearTimeout(this.statusTimer)
      this.statusTimer = null
      this.broadcast({ type: 'status', status: this.status() })
      return
    }
    if (this.statusTimer) return
    this.statusTimer = setTimeout(() => {
      this.statusTimer = null
      this.broadcast({ type: 'status', status: this.status() })
    }, 150)
  }

  broadcast(evt: PushEvent): void {
    this.windows?.broadcast(evt)
  }

  private notifier(): Notifier {
    return {
      isSupported: () => Notification.isSupported(),
      show: ({ title, body, captureId }) => {
        const n = new Notification({ title, body, icon: this.paths.icon, urgency: 'normal' })
        this.notifications.add(n)
        const release = (): void => {
          this.notifications.delete(n)
        }
        n.on('click', () => {
          this.windows.showMain('reminder', captureId)
          release()
        })
        n.on('close', release)
        n.on('failed', (_e, error) => this.logger.warn('notification: failed', { error }))
        n.show()
        return true
      }
    }
  }

  testNotification(): boolean {
    if (!Notification.isSupported()) return false
    const n = new Notification({
      title: 'EchoNote',
      body: 'Notifications are working.',
      icon: this.paths.icon
    })
    n.show()
    return true
  }

  // -------------------------------------------------------------------------
  // Diagnostics & data management
  // -------------------------------------------------------------------------

  diagnostics(): Diagnostics {
    let nativeVersions: string | null = null
    try {
      nativeVersions = fs.readFileSync(path.join(this.paths.binDir, 'VERSIONS.txt'), 'utf8')
    } catch {
      /* absent in dev before native build */
    }
    return {
      appVersion: app.getVersion(),
      electron: process.versions.electron,
      node: process.versions.node,
      chrome: process.versions.chrome,
      platform: `${os.type()} ${os.release()} ${process.arch}`,
      sessionType: process.env.XDG_SESSION_TYPE ?? 'unknown',
      cpu: os.cpus()[0]?.model ?? 'unknown',
      cpuCount: os.cpus().length,
      totalMemMB: Math.round(os.totalmem() / 1024 / 1024),
      availableMemMB: availableMemoryMB() ?? Math.round(os.freemem() / 1024 / 1024),
      processMemMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
      paths: {
        userData: this.paths.userData,
        models: this.paths.models,
        logs: this.paths.logs,
        database: this.paths.database
      },
      runtimes: { speech: this.runtime.speechStatus(), llm: this.runtime.llmStatus() },
      counts: this.captures.counts(),
      recentTimings: this.captures.recentTimings(20),
      nativeVersions
    }
  }

  async exportDiagnostics(includeTranscripts: boolean): Promise<string | null> {
    const res = await dialog.showSaveDialog(this.windows.main ?? undefined!, {
      title: 'Export diagnostics',
      defaultPath: path.join(app.getPath('downloads'), `echonote-diagnostics-${Date.now()}.json`),
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (res.canceled || !res.filePath) return null
    let logTail: string[] = []
    try {
      logTail = fs
        .readFileSync(path.join(this.paths.logs, 'echonote.log'), 'utf8')
        .trim()
        .split('\n')
        .slice(-300)
    } catch {
      /* no log yet */
    }
    const data: Record<string, unknown> = {
      exportedAt: new Date().toISOString(),
      diagnostics: this.diagnostics(),
      logTail
    }
    if (includeTranscripts) {
      data.captures = this.captures.list({ view: 'all', includeCompleted: true, limit: 1000 })
    }
    await fsp.writeFile(res.filePath, JSON.stringify(data, null, 2))
    return res.filePath
  }

  async openDataFolder(): Promise<void> {
    const err = await shell.openPath(this.paths.userData)
    if (err) throw new UserError('OPEN_FAILED', err)
  }

  async deleteAllData(includeModels: boolean): Promise<void> {
    this.logger.warn('app: deleting all data', { includeModels })
    this.pipeline.stop()
    this.reminderService.stop()
    await this.runtime.stopAll()
    this.db.close()
    for (const f of [this.paths.database, this.paths.database + '-wal', this.paths.database + '-shm']) {
      await fsp.rm(f, { force: true })
    }
    await fsp.rm(this.paths.audio, { recursive: true, force: true })
    await fsp.rm(this.paths.logs, { recursive: true, force: true })
    if (includeModels) await fsp.rm(this.paths.models, { recursive: true, force: true })
    setLaunchAtLogin(false)
    if (this.shortcuts.state.method === 'desktop')
      await this.shortcuts.removeDesktopShortcut().catch(() => undefined)
    this.quitting = true
    app.relaunch()
    app.exit(0)
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  handleSecondInstance(argv: string[]): void {
    if (argv.includes('--toggle')) this.toggleRecording('cli')
    else this.windows.showMain()
  }

  private onMainClose(e: Electron.Event): void {
    if (this.quitting) return
    e.preventDefault()
    if (!this.settings.closeToBackground) {
      app.quit()
      return
    }
    this.windows.main?.hide()
    if (!this.hiddenNoticeShown && Notification.isSupported()) {
      this.hiddenNoticeShown = true
      new Notification({
        title: 'EchoNote is still running',
        body: 'Reminders and the recording shortcut keep working. Launch EchoNote again to reopen, or quit from the tray / Settings.',
        icon: this.paths.icon,
        silent: true
      }).show()
    }
  }

  /** Called from app 'before-quit'. Returns true if quitting should be deferred. */
  onBeforeQuit(): boolean {
    if (this.quitting) return false
    if (this.recorder.state === 'recording') {
      const choice = dialog.showMessageBoxSync({
        type: 'question',
        buttons: ['Save recording and quit', 'Discard recording and quit', 'Keep recording'],
        defaultId: 0,
        cancelId: 2,
        title: 'Recording in progress',
        message: 'A recording is in progress.'
      })
      if (choice === 2) return true
      if (choice === 0) {
        this.quitAfterRecording = true
        this.recorder.stop('quit')
        return true
      }
      this.windows.sendToRecorder({ type: 'recorder-command', command: 'cancel' })
    }
    this.quitting = true
    return false
  }

  async shutdown(): Promise<void> {
    this.logger.info('app: shutting down')
    this.pipeline?.stop()
    this.reminderService?.stop()
    this.shortcuts?.unregisterAll()
    this.togglePipe?.stop()
    await Promise.race([this.runtime?.stopAll(), new Promise((r) => setTimeout(r, 3000))])
    this.runtime?.killAll()
    try {
      this.db?.close()
    } catch {
      /* already closed */
    }
    this.logger.info('app: stopped')
  }
}
