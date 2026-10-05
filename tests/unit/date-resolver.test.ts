import { describe, expect, it } from 'vitest'
import { findDateExpression, resolveDate } from '../../src/main/services/date-resolver'

// Tests run with TZ=Asia/Kolkata (see vitest.config.ts).
// Wednesday 7 October 2026, 14:05 local.
const REF = new Date('2026-10-07T14:05:00+05:30')
const opts = { defaultHour: 9 }
const local = (d: Date | null): string =>
  d ? d.toLocaleString('sv-SE', { timeZone: 'Asia/Kolkata' }).slice(0, 16) : 'null'

describe('resolveDate', () => {
  it('returns nothing for a missing expression', () => {
    expect(resolveDate(null, REF, opts)).toEqual({
      dueAt: null,
      timeDefaulted: false,
      ambiguity: null,
      expression: null
    })
    expect(resolveDate('  ', REF, opts).dueAt).toBeNull()
  })

  it('"tomorrow" uses the default hour and flags it', () => {
    const r = resolveDate('tomorrow', REF, opts)
    expect(local(r.dueAt)).toBe('2026-10-08 09:00')
    expect(r.timeDefaulted).toBe(true)
    expect(r.ambiguity).toBeNull()
  })

  it('respects a configured default hour', () => {
    expect(local(resolveDate('tomorrow', REF, { defaultHour: 7 }).dueAt)).toBe('2026-10-08 07:00')
  })

  it('"tomorrow morning" maps to 09:00, evening to 18:00', () => {
    expect(local(resolveDate('tomorrow morning', REF, opts).dueAt)).toBe('2026-10-08 09:00')
    expect(local(resolveDate('tomorrow evening', REF, opts).dueAt)).toBe('2026-10-08 18:00')
  })

  it('explicit times are certain', () => {
    const r = resolveDate('tomorrow at 7:30 pm', REF, opts)
    expect(local(r.dueAt)).toBe('2026-10-08 19:30')
    expect(r.timeDefaulted).toBe(false)
    expect(r.ambiguity).toBeNull()
  })

  it('a bare time that already passed today rolls to tomorrow', () => {
    expect(local(resolveDate('at 10am', REF, opts).dueAt)).toBe('2026-10-08 10:00')
    expect(local(resolveDate('at 5pm', REF, opts).dueAt)).toBe('2026-10-07 17:00')
  })

  it('relative durations', () => {
    expect(local(resolveDate('in 10 minutes', REF, opts).dueAt)).toBe('2026-10-07 14:15')
    // Exact to the second, never rounded down (which would fire early).
    const ref = new Date('2026-10-07T14:05:47+05:30')
    expect(resolveDate('in two minutes', ref, opts).dueAt!.getTime() - ref.getTime()).toBe(120_000)
    expect(local(resolveDate('in two hours', REF, opts).dueAt)).toBe('2026-10-07 16:05')
  })

  it('"next Friday" mid-week is ambiguous and resolves to the nearest Friday', () => {
    const r = resolveDate('next Friday', REF, opts)
    expect(local(r.dueAt)).toBe('2026-10-09 09:00')
    expect(r.ambiguity).toMatch(/could mean/)
  })

  it('"next Friday" said on a Saturday is not ambiguous', () => {
    const sat = new Date('2026-10-10T10:00:00+05:30')
    const r = resolveDate('next Friday', sat, opts)
    expect(local(r.dueAt)).toBe('2026-10-16 09:00')
    expect(r.ambiguity).toBeNull()
  })

  it('"on the 15th" without a month asks for confirmation', () => {
    const r = resolveDate('on the 15th', REF, opts)
    expect(local(r.dueAt)).toBe('2026-10-15 09:00')
    expect(r.ambiguity).toMatch(/without a month/)
  })

  it('a bare ordinal ("15th") is treated like "the 15th"', () => {
    const r = resolveDate('15th', REF, opts)
    expect(local(r.dueAt)).toBe('2026-10-15 09:00')
    expect(r.ambiguity).toMatch(/without a month/)
  })

  it('"the 3rd" after the 3rd rolls into next month', () => {
    expect(local(resolveDate('the 3rd', REF, opts).dueAt)).toBe('2026-11-03 09:00')
  })

  it('a full date is unambiguous', () => {
    const r = resolveDate('October 15 at noon', REF, opts)
    expect(local(r.dueAt)).toBe('2026-10-15 12:00')
    expect(r.ambiguity).toBeNull()
  })

  it('vague phrases produce a candidate but require confirmation', () => {
    for (const phrase of ['sometime next week', 'next week', 'this weekend', 'next month']) {
      const r = resolveDate(phrase, REF, opts)
      expect(r.ambiguity, phrase).not.toBeNull()
    }
  })

  it('unparseable expressions are reported, never invented', () => {
    const r = resolveDate('whenever the moon is blue', REF, opts)
    expect(r.dueAt).toBeNull()
    expect(r.ambiguity).toMatch(/Could not work out/)
  })

  it('stores instants in UTC', () => {
    const r = resolveDate('tomorrow at 9am', REF, opts)
    expect(r.dueAt!.toISOString()).toBe('2026-10-08T03:30:00.000Z')
  })
})

describe('findDateExpression', () => {
  it('finds a date phrase in a transcript', () => {
    expect(findDateExpression('Remind me tomorrow at 9 to call mom', REF)).toMatch(/tomorrow at 9/)
    expect(findDateExpression('pay rent on the 1st', REF)).toMatch(/the 1st/)
  })
  it('returns null when there is none', () => {
    expect(findDateExpression('The staging server uses port 8081', REF)).toBeNull()
  })
})
