import { llmClassificationSchema, type LlmClassification } from '../../shared/schemas'
import { LIMITS } from '../../shared/constants'
import type { Category } from '../../shared/types'
import { findDateExpression, resolveDate } from './date-resolver'

export interface ValidatedClassification {
  category: Category
  title: string
  summary: string
  action: string | null
  originalDateExpression: string | null
  dueAt: string | null
  timeDefaulted: boolean
  needsConfirmation: boolean
  confirmationReason: string | null
}

export type ValidationOutcome =
  | { ok: true; value: ValidatedClassification; raw: LlmClassification }
  | { ok: false; code: 'INVALID_JSON' | 'SCHEMA_MISMATCH'; message: string }

/** Below this self-reported confidence the item goes to review. Confidence is a hint, never proof. */
const LOW_CONFIDENCE = 0.5

/**
 * Validates raw model output against the schema and the business rules:
 *  - unknown categories / wrong types are rejected
 *  - over-long strings are clipped to the documented bounds
 *  - a date phrase must actually occur in the transcript (no invented deadlines)
 *  - dates are resolved deterministically in local time
 *  - ideas and reference notes never get a due date
 */
export function validateClassification(
  rawText: string,
  transcript: string,
  ref: Date,
  opts: { defaultHour: number }
): ValidationOutcome {
  let json: unknown
  try {
    json = JSON.parse(extractJsonObject(rawText))
  } catch {
    return { ok: false, code: 'INVALID_JSON', message: 'The model did not return valid JSON.' }
  }
  const parsed = llmClassificationSchema.safeParse(json)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return {
      ok: false,
      code: 'SCHEMA_MISMATCH',
      message: `Model output failed validation at "${issue?.path.join('.') || '(root)'}": ${issue?.message ?? 'invalid'}`
    }
  }
  const raw = parsed.data
  const reasons: string[] = []

  const title = clip(oneLine(raw.title), LIMITS.maxTitleChars)
  const summary = clip(raw.summary.trim(), LIMITS.maxSummaryChars)
  const action = raw.action?.trim() ? clip(oneLine(raw.action), LIMITS.maxActionChars) : null

  // Date handling: only tasks and reminders carry dates.
  let expression: string | null = null
  if (raw.category === 'reminder' || raw.category === 'task') {
    const candidate = raw.date_expression?.trim() || null
    if (candidate && occursIn(candidate, transcript)) {
      expression = clip(candidate, LIMITS.maxDateExpressionChars)
    } else if (raw.category === 'reminder' || candidate) {
      // The model omitted or invented the phrase: look for one in the transcript itself.
      expression = findDateExpression(transcript, ref)
    }
  }

  let dueAt: string | null = null
  let timeDefaulted = false
  if (expression) {
    const resolved = resolveDate(expression, ref, opts)
    if (resolved.dueAt) {
      dueAt = resolved.dueAt.toISOString()
      timeDefaulted = resolved.timeDefaulted
      if (resolved.ambiguity) reasons.push(resolved.ambiguity)
    } else if (raw.category === 'reminder') {
      if (resolved.ambiguity) reasons.push(resolved.ambiguity)
    } else {
      // A task phrase like "on the way home" is not a date: keep the task, drop the phrase.
      expression = null
    }
  }

  if (raw.category === 'reminder' && !dueAt) {
    reasons.push('This sounds like a reminder, but no date or time was mentioned.')
  }
  if (raw.needs_confirmation) {
    reasons.push(
      raw.reason?.trim() ? clip(oneLine(raw.reason), LIMITS.maxReasonChars) : 'The model was unsure.'
    )
  } else if (raw.confidence < LOW_CONFIDENCE) {
    reasons.push('Low confidence in the category.')
  }

  return {
    ok: true,
    raw,
    value: {
      category: raw.category,
      title: title || 'Untitled note',
      summary,
      action,
      originalDateExpression: expression,
      dueAt,
      timeDefaulted,
      needsConfirmation: reasons.length > 0,
      confirmationReason: reasons.length ? reasons.join(' ') : null
    }
  }
}

/** Accepts output wrapped in prose or code fences by taking the outermost {...} span. */
function extractJsonObject(text: string): string {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return text
  return text.slice(start, end + 1)
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}:]+/gu, ' ')
    .trim()
}

function occursIn(phrase: string, transcript: string): boolean {
  const p = normalize(phrase)
  return p.length > 0 && normalize(transcript).includes(p)
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s
}
