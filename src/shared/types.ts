// Types shared by the main process, preload bridge and renderer.

export const CATEGORIES = ['task', 'reminder', 'idea', 'reference'] as const
export type Category = (typeof CATEGORIES)[number]

/**
 * processing          audio saved, waiting for / undergoing transcription
 * failed              transcription failed; audio kept for retry
 * inbox               transcript saved, not yet classified (queued, LLM unavailable, or invalid output)
 * needs_confirmation  classified, but the user should confirm category or date
 * ready               classified and accepted
 * completed           task/reminder marked done
 */
export const CAPTURE_STATUSES = [
  'processing',
  'failed',
  'inbox',
  'needs_confirmation',
  'ready',
  'completed'
] as const
export type CaptureStatus = (typeof CAPTURE_STATUSES)[number]

export interface Capture {
  id: string
  transcript: string | null
  category: Category | null
  title: string | null
  summary: string | null
  action: string | null
  originalDateExpression: string | null
  /** ISO-8601 UTC instant */
  dueAt: string | null
  /** True when the user gave a day but no time and the default reminder time was applied. */
  timeDefaulted: boolean
  /** IANA timezone in effect when the capture was interpreted. */
  timezone: string
  status: CaptureStatus
  confirmationReason: string | null
  hasAudio: boolean
  audioDurationMs: number | null
  createdAt: string
  updatedAt: string
  completedAt: string | null
  transcriptionModel: string | null
  classificationModel: string | null
  classifyAttempts: number
  errorCode: string | null
  errorMessage: string | null
}

export type ReminderStatus = 'pending' | 'delivered' | 'failed' | 'cancelled'

export interface Reminder {
  id: string
  captureId: string
  dueAt: string
  status: ReminderStatus
  deliveredAt: string | null
  attempts: number
  lastError: string | null
}

export interface ReminderWithCapture extends Reminder {
  capture: Capture
}

export interface Settings {
  shortcut: string
  speechModelId: string
  /** whisper language: 'en', 'hi', or 'auto' */
  speechLanguage: string
  llmModelId: string
  keepAudio: boolean
  defaultReminderHour: number
  llmIdleUnloadMinutes: number
  launchAtLogin: boolean
  closeToBackground: boolean
  notificationsEnabled: boolean
  setupCompleted: boolean
  /** Floating recording popup: 'auto' shows it only when no top-bar indicator can be shown. */
  recordingPopup: 'auto' | 'on' | 'off'
  /** Stop recording automatically after this many seconds without speech (0 = never). */
  silenceStopSeconds: number
}

export type RecorderState = 'idle' | 'starting' | 'recording' | 'stopping'

export interface RecordingStatus {
  state: RecorderState
  startedAt: number | null
  lastError: { code: string; message: string } | null
}

export type RuntimeState =
  | 'missing_model'
  | 'missing_runtime'
  | 'stopped'
  | 'starting'
  | 'ready'
  | 'busy'
  | 'error'
  | 'insufficient_memory'

export interface RuntimeStatus {
  state: RuntimeState
  modelId: string | null
  message: string | null
  loadMs: number | null
}

export interface ModelFileStatus {
  id: string
  name: string
  kind: 'speech' | 'llm'
  sizeBytes: number
  license: string
  description: string
  installed: boolean
  verified: boolean
  downloading: boolean
  verifying: boolean
  downloadedBytes: number
  error: { code: string; message: string } | null
}

export interface PipelineActivity {
  transcribing: string | null
  classifying: string | null
  queuedTranscription: string[]
  queuedClassification: string[]
}

export interface ShortcutStatus {
  accelerator: string
  registered: boolean
  /** global = Electron globalShortcut; desktop = GNOME custom shortcut running `echonote --toggle` */
  method: 'global' | 'desktop' | 'none'
  message: string | null
  desktopShortcutAvailable: boolean
}

export interface AppStatus {
  recording: RecordingStatus
  speech: RuntimeStatus
  llm: RuntimeStatus
  models: ModelFileStatus[]
  pipeline: PipelineActivity
  shortcut: ShortcutStatus
  notificationsSupported: boolean
  /** True when the desktop can show the top-bar recording indicator (StatusNotifierItem host). */
  topBarIndicator: boolean
  setupCompleted: boolean
  platform: string
  sessionType: string
}

export interface ListQuery {
  view: 'all' | 'inbox' | 'task' | 'reminder' | 'idea' | 'reference' | 'recent'
  search?: string
  includeCompleted?: boolean
  limit?: number
}

export interface CaptureUpdate {
  id: string
  category?: Category | null
  title?: string | null
  summary?: string | null
  action?: string | null
  dueAt?: string | null
  /** Marks a needs_confirmation item as confirmed (status -> ready). */
  confirm?: boolean
  completed?: boolean
}

export interface Diagnostics {
  appVersion: string
  electron: string
  node: string
  chrome: string
  platform: string
  sessionType: string
  cpu: string
  cpuCount: number
  totalMemMB: number
  availableMemMB: number
  processMemMB: number
  paths: { userData: string; models: string; logs: string; database: string }
  runtimes: { speech: RuntimeStatus; llm: RuntimeStatus }
  counts: Record<string, number>
  recentTimings: Array<{ captureId: string; timings: Record<string, number> }>
  nativeVersions: string | null
}

export interface ErrorInfo {
  code: string
  message: string
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: ErrorInfo }

/** Events the main process pushes to renderer windows. */
export type PushEvent =
  | { type: 'status'; status: AppStatus }
  | { type: 'captures-changed' }
  | { type: 'recorder-command'; command: 'start' | 'stop' | 'cancel'; silenceStopMs?: number }
  | { type: 'navigate'; view: string; captureId?: string }
  | { type: 'toast'; level: 'info' | 'success' | 'error'; message: string }
  | {
      type: 'capture-result'
      captureId: string
      stage: 'saved' | 'transcribed' | 'classified' | 'failed'
      text: string
    }
