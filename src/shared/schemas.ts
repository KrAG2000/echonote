import { z } from 'zod'
import { CATEGORIES } from './types'
import { LIMITS } from './constants'

const id = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, 'invalid id')
const isoInstant = z.string().refine((s) => !Number.isNaN(Date.parse(s)) && /\d{4}-\d{2}-\d{2}T/.test(s), {
  message: 'invalid timestamp'
})

// ---------------------------------------------------------------------------
// LLM classification output (treated as untrusted input)
// ---------------------------------------------------------------------------

/** What the model is asked to return. Dates are extracted as phrases, never computed by the model. */
export const llmClassificationSchema = z.object({
  category: z.enum(CATEGORIES),
  title: z.string().trim().min(1),
  summary: z.string(),
  action: z.string().nullable(),
  date_expression: z.string().nullable(),
  needs_confirmation: z.boolean(),
  reason: z.string().nullable(),
  confidence: z.number().min(0).max(1)
})
export type LlmClassification = z.infer<typeof llmClassificationSchema>

/** JSON schema handed to llama-server; it compiles this into a grammar that constrains decoding. */
export const LLM_JSON_SCHEMA = {
  type: 'object',
  properties: {
    category: { type: 'string', enum: [...CATEGORIES] },
    title: { type: 'string', minLength: 1, maxLength: LIMITS.maxTitleChars },
    summary: { type: 'string', maxLength: LIMITS.maxSummaryChars },
    action: { type: ['string', 'null'], maxLength: LIMITS.maxActionChars },
    date_expression: { type: ['string', 'null'], maxLength: LIMITS.maxDateExpressionChars },
    needs_confirmation: { type: 'boolean' },
    reason: { type: ['string', 'null'], maxLength: LIMITS.maxReasonChars },
    confidence: { type: 'number', minimum: 0, maximum: 1 }
  },
  required: [
    'category',
    'title',
    'summary',
    'action',
    'date_expression',
    'needs_confirmation',
    'reason',
    'confidence'
  ],
  additionalProperties: false
} as const

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export const settingsPatchSchema = z
  .object({
    shortcut: z.string().min(1).max(60),
    speechModelId: z.string().min(1).max(80),
    speechLanguage: z.enum(['en', 'hi', 'auto']),
    llmModelId: z.string().min(1).max(80),
    keepAudio: z.boolean(),
    defaultReminderHour: z.number().int().min(0).max(23),
    llmIdleUnloadMinutes: z
      .number()
      .int()
      .min(0)
      .max(24 * 60),
    launchAtLogin: z.boolean(),
    closeToBackground: z.boolean(),
    notificationsEnabled: z.boolean(),
    setupCompleted: z.boolean()
  })
  .partial()
  .strict()

// ---------------------------------------------------------------------------
// IPC payloads
// ---------------------------------------------------------------------------

export const listQuerySchema = z
  .object({
    view: z.enum(['all', 'inbox', 'task', 'reminder', 'idea', 'reference', 'recent']),
    search: z.string().max(LIMITS.maxSearchChars).optional(),
    includeCompleted: z.boolean().optional(),
    limit: z.number().int().min(1).max(1000).optional()
  })
  .strict()

export const idPayloadSchema = z.object({ id }).strict()

export const captureUpdateSchema = z
  .object({
    id,
    category: z.enum(CATEGORIES).nullable().optional(),
    title: z.string().trim().max(LIMITS.maxTitleChars).nullable().optional(),
    summary: z.string().max(LIMITS.maxSummaryChars).nullable().optional(),
    action: z.string().max(LIMITS.maxActionChars).nullable().optional(),
    dueAt: isoInstant.nullable().optional(),
    confirm: z.boolean().optional(),
    completed: z.boolean().optional()
  })
  .strict()

export const recorderSubmitSchema = z
  .object({
    wav: z
      .instanceof(Uint8Array)
      .refine((b) => b.byteLength >= 44 && b.byteLength <= LIMITS.maxAudioBytes, 'audio size out of range'),
    durationMs: z
      .number()
      .min(0)
      .max(LIMITS.maxRecordingMs + 5_000),
    peak: z.number().min(0).max(1),
    rms: z.number().min(0).max(1),
    startedAt: z.number(),
    stoppedAt: z.number()
  })
  .strict()

export const recorderFailedSchema = z
  .object({
    code: z.enum([
      'MIC_PERMISSION_DENIED',
      'NO_INPUT_DEVICE',
      'DEVICE_BUSY',
      'RECORDING_FAILED',
      'EMPTY_RECORDING'
    ]),
    message: z.string().max(300)
  })
  .strict()

export const recorderStartedSchema = z.object({ at: z.number() }).strict()

export const modelIdPayloadSchema = z.object({ id: z.string().min(1).max(80) }).strict()

export const retryLoadSchema = z
  .object({ kind: z.enum(['speech', 'llm']), force: z.boolean().optional() })
  .strict()

export const deleteAllSchema = z.object({ confirm: z.literal('DELETE'), includeModels: z.boolean() }).strict()

export const exportDiagnosticsSchema = z.object({ includeTranscripts: z.boolean() }).strict()

// ---------------------------------------------------------------------------
// Model manifest
// ---------------------------------------------------------------------------

export const modelManifestEntrySchema = z
  .object({
    id: z.string().regex(/^[a-z0-9._-]+$/),
    name: z.string(),
    kind: z.enum(['speech', 'llm']),
    version: z.string(),
    fileName: z.string().regex(/^[A-Za-z0-9._-]+$/, 'file name must not contain path separators'),
    url: z
      .string()
      .url()
      .refine((u) => u.startsWith('https://huggingface.co/'), 'downloads must come from huggingface.co'),
    sizeBytes: z.number().int().positive(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    license: z.string(),
    licenseUrl: z.string().url(),
    purpose: z.string(),
    languages: z.array(z.string()).min(1),
    minMemoryMB: z.number().int().positive(),
    runtime: z.object({
      engine: z.enum(['whisper.cpp', 'llama.cpp']),
      contextSize: z.number().int().positive().optional()
    }),
    default: z.boolean().optional()
  })
  .strict()

export const modelManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    models: z.array(modelManifestEntrySchema).min(1)
  })
  .strict()
  .refine((m) => new Set(m.models.map((x) => x.id)).size === m.models.length, 'duplicate model ids')

export type ModelManifest = z.infer<typeof modelManifestSchema>
export type ModelManifestEntry = z.infer<typeof modelManifestEntrySchema>
