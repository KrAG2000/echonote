import { describe, expect, it } from 'vitest'
import { validateClassification } from '../../src/main/services/validation-service'

const REF = new Date('2026-10-07T14:05:00+05:30') // Wednesday
const opts = { defaultHour: 9 }

const out = (o: Record<string, unknown>): string =>
  JSON.stringify({
    category: 'task',
    title: 'Do a thing',
    summary: 'Do a thing.',
    action: 'Do a thing',
    date_expression: null,
    needs_confirmation: false,
    reason: null,
    confidence: 0.9,
    ...o
  })

describe('validateClassification', () => {
  it('accepts a clean reminder and resolves its date', () => {
    const t = 'Remind me tomorrow at 7 pm to call the dentist'
    const r = validateClassification(
      out({ category: 'reminder', title: 'Call the dentist', date_expression: 'tomorrow at 7 pm' }),
      t,
      REF,
      opts
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.category).toBe('reminder')
    expect(r.value.dueAt).toBe('2026-10-08T13:30:00.000Z')
    expect(r.value.needsConfirmation).toBe(false)
  })

  it('rejects malformed JSON', () => {
    const r = validateClassification('{"category": "task", ', 'x', REF, opts)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('INVALID_JSON')
  })

  it('rejects unknown categories and wrong types', () => {
    const bad1 = validateClassification(out({ category: 'shopping' }), 'x', REF, opts)
    const bad2 = validateClassification(out({ confidence: 'high' }), 'x', REF, opts)
    const bad3 = validateClassification(out({ needs_confirmation: 'no' }), 'x', REF, opts)
    expect(bad1.ok || bad2.ok || bad3.ok).toBe(false)
  })

  it('rejects a missing title', () => {
    expect(validateClassification(out({ title: '   ' }), 'x', REF, opts).ok).toBe(false)
  })

  it('extracts JSON wrapped in prose or code fences', () => {
    const r = validateClassification('Sure! ```json\n' + out({}) + '\n```', 'Do a thing', REF, opts)
    expect(r.ok).toBe(true)
  })

  it('clips over-long title and summary', () => {
    const r = validateClassification(
      out({ title: 'x'.repeat(300), summary: 'y'.repeat(2000) }),
      't',
      REF,
      opts
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.title.length).toBeLessThanOrEqual(80)
    expect(r.value.summary.length).toBeLessThanOrEqual(400)
  })

  it('never accepts a date phrase that is not in the transcript', () => {
    const r = validateClassification(
      out({ category: 'task', date_expression: 'next Monday' }),
      'Investigate why the worker retries failed jobs',
      REF,
      opts
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.dueAt).toBeNull()
    expect(r.value.originalDateExpression).toBeNull()
  })

  it('a task with a non-date phrase keeps no due date and does not need confirmation', () => {
    const t = 'Buy milk and eggs on the way home.'
    const r = validateClassification(out({ date_expression: 'on the way home' }), t, REF, opts)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.dueAt).toBeNull()
    expect(r.value.originalDateExpression).toBeNull()
    expect(r.value.needsConfirmation).toBe(false)
  })

  it('a reminder with no date anywhere needs confirmation and has no due time', () => {
    const r = validateClassification(
      out({ category: 'reminder' }),
      'Remind me to call the dentist',
      REF,
      opts
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.dueAt).toBeNull()
    expect(r.value.needsConfirmation).toBe(true)
    expect(r.value.confirmationReason).toMatch(/no date/)
  })

  it('recovers the date from the transcript when the model omits it for a reminder', () => {
    const r = validateClassification(
      out({ category: 'reminder' }),
      'Remind me tomorrow at 7 pm to call mom',
      REF,
      opts
    )
    expect(r.ok && r.value.dueAt).toBe('2026-10-08T13:30:00.000Z')
  })

  it('ideas and reference notes never get a due date', () => {
    for (const category of ['idea', 'reference']) {
      const r = validateClassification(
        out({ category, date_expression: 'tomorrow' }),
        'Tomorrow is the deadline for the hackathon',
        REF,
        opts
      )
      expect(r.ok && r.value.dueAt).toBe(null)
    }
  })

  it('ambiguous dates propagate to needs_confirmation', () => {
    const r = validateClassification(
      out({ category: 'reminder', date_expression: 'next Friday' }),
      'remind me next Friday to submit the form',
      REF,
      opts
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.needsConfirmation).toBe(true)
    expect(r.value.dueAt).not.toBeNull()
  })

  it('low self-reported confidence sends the item to review', () => {
    const r = validateClassification(out({ confidence: 0.2 }), 'hmm maybe', REF, opts)
    expect(r.ok && r.value.needsConfirmation).toBe(true)
  })

  it('model-requested confirmation keeps its reason', () => {
    const r = validateClassification(
      out({ needs_confirmation: true, reason: 'Could be an idea' }),
      'x',
      REF,
      opts
    )
    expect(r.ok && r.value.confirmationReason).toMatch(/Could be an idea/)
  })
})
