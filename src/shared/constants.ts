import type { Settings } from './types'

export const APP_NAME = 'EchoNote'

export const LIMITS = {
  /** Hard cap on one recording. 16 kHz mono 16-bit PCM = 32 KB/s -> ~9.6 MB for 5 minutes. */
  maxRecordingMs: 5 * 60 * 1000,
  maxAudioBytes: 12 * 1024 * 1024,
  minRecordingMs: 400,
  maxTranscriptChars: 20_000,
  /** Characters of transcript sent to the LLM. Longer transcripts are truncated for classification only. */
  maxClassifierInputChars: 2_000,
  maxTitleChars: 80,
  maxSummaryChars: 400,
  maxActionChars: 200,
  maxDateExpressionChars: 80,
  maxReasonChars: 200,
  maxLlmOutputTokens: 300,
  transcriptionTimeoutMs: 120_000,
  classificationTimeoutMs: 45_000,
  maxClassifyAttempts: 3,
  maxQueueLength: 500,
  maxSearchChars: 200
} as const

export const DEFAULT_SETTINGS: Settings = {
  shortcut: 'Alt+Shift+Space',
  speechModelId: 'whisper-base.en-q5_1',
  speechLanguage: 'en',
  llmModelId: 'qwen2.5-1.5b-instruct-q4_k_m',
  keepAudio: false,
  defaultReminderHour: 9,
  llmIdleUnloadMinutes: 0,
  launchAtLogin: false,
  closeToBackground: true,
  notificationsEnabled: true,
  setupCompleted: false
}

export const CATEGORY_LABELS = {
  task: 'Task',
  reminder: 'Reminder',
  idea: 'Idea',
  reference: 'Reference'
} as const
