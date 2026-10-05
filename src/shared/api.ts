import type {
  AppStatus,
  Capture,
  CaptureUpdate,
  Diagnostics,
  ListQuery,
  PushEvent,
  ReminderWithCapture,
  Result,
  Settings,
  ShortcutStatus
} from './types'

/** Channel names. Every channel has a payload schema checked in the main process. */
export const IPC = {
  captureList: 'capture:list',
  captureGet: 'capture:get',
  captureUpdate: 'capture:update',
  captureDelete: 'capture:delete',
  captureRetry: 'capture:retry-processing',
  captureToggle: 'capture:toggle',
  captureStart: 'capture:start',
  captureStop: 'capture:stop',
  recorderReady: 'recorder:ready',
  recorderStarted: 'recorder:started',
  recorderFailed: 'recorder:failed',
  recorderSubmit: 'recorder:submit',
  reminderList: 'reminder:list',
  statusGet: 'app:status',
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  modelsDownload: 'models:download',
  modelsCancel: 'models:cancel-download',
  modelsVerify: 'models:verify',
  modelsRetryLoad: 'models:retry-load',
  diagnostics: 'app:diagnostics',
  exportDiagnostics: 'app:export-diagnostics',
  openDataFolder: 'app:open-data-folder',
  deleteAllData: 'app:delete-all-data',
  testNotification: 'app:test-notification',
  hideOverlay: 'app:hide-overlay',
  shortcutInstallDesktop: 'shortcut:install-desktop',
  shortcutRemoveDesktop: 'shortcut:remove-desktop',
  showMain: 'app:show-main',
  quit: 'app:quit'
} as const

export const PUSH_CHANNEL = 'echo:event'

/** The API exposed on `window.echo` by the preload script. */
export interface EchoApi {
  listCaptures(q: ListQuery): Promise<Result<Capture[]>>
  getCapture(id: string): Promise<Result<Capture>>
  updateCapture(u: CaptureUpdate): Promise<Result<Capture>>
  deleteCapture(id: string): Promise<Result<null>>
  retryCapture(id: string): Promise<Result<string>>
  toggleRecording(): Promise<Result<null>>
  startRecording(): Promise<Result<null>>
  stopRecording(): Promise<Result<null>>
  /** The main window's recorder is mounted and listening for commands. */
  recorderReady(): Promise<Result<null>>
  recorderStarted(at: number): Promise<Result<null>>
  recorderFailed(code: string, message: string): Promise<Result<null>>
  submitRecording(p: {
    wav: Uint8Array
    durationMs: number
    peak: number
    rms: number
    startedAt: number
    stoppedAt: number
    voiced?: boolean
  }): Promise<Result<{ captureId: string }>>
  listReminders(): Promise<Result<ReminderWithCapture[]>>
  getStatus(): Promise<Result<AppStatus>>
  getSettings(): Promise<Result<Settings>>
  updateSettings(patch: Partial<Settings>): Promise<Result<Settings>>
  downloadModel(id: string): Promise<Result<null>>
  cancelDownload(id: string): Promise<Result<null>>
  verifyModel(id: string): Promise<Result<boolean>>
  retryLoad(kind: 'speech' | 'llm', force?: boolean): Promise<Result<null>>
  diagnostics(): Promise<Result<Diagnostics>>
  exportDiagnostics(includeTranscripts: boolean): Promise<Result<string | null>>
  openDataFolder(): Promise<Result<null>>
  deleteAllData(includeModels: boolean): Promise<Result<null>>
  testNotification(): Promise<Result<boolean>>
  hideOverlay(): Promise<Result<null>>
  installDesktopShortcut(): Promise<Result<ShortcutStatus>>
  removeDesktopShortcut(): Promise<Result<ShortcutStatus>>
  showMain(view?: string): Promise<Result<null>>
  quit(): Promise<Result<null>>
  onEvent(cb: (e: PushEvent) => void): () => void
}
