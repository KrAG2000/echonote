import * as chrono from 'chrono-node'

/**
 * Turns a spoken date phrase ("tomorrow morning", "next Friday at 5") into a concrete
 * instant in the machine's local timezone. Deterministic: the LLM only extracts the phrase,
 * this module does the arithmetic.
 *
 * Documented interpretations (see docs/ARCHITECTURE.md#dates):
 *  - A day without a time uses the default reminder hour (setting, 09:00 by default) and
 *    is flagged `timeDefaulted`.
 *  - Parts of day: morning 09:00, afternoon 14:00, evening 18:00, tonight/night 20:00.
 *  - "next <weekday>" means the nearest upcoming occurrence. When that day is still in the
 *    current Mon–Sun week (so "next Friday" could also mean the one a week later) the result
 *    needs confirmation.
 *  - "the 15th" without a month resolves to the next 15th and needs confirmation.
 *  - Vague phrases ("next week", "sometime", "this weekend", "next month") produce a
 *    candidate but always need confirmation.
 *  - A time already in the past needs confirmation.
 */

export interface ResolvedDate {
  dueAt: Date | null
  timeDefaulted: boolean
  /** Human-readable explanation when the user should confirm; null when unambiguous. */
  ambiguity: string | null
  /** The phrase actually used for resolution. */
  expression: string | null
}

const PART_OF_DAY: Array<[RegExp, number, string]> = [
  [/\bmorning\b/i, 9, 'morning'],
  [/\bafternoon\b/i, 14, 'afternoon'],
  [/\bevening\b/i, 18, 'evening'],
  [/\b(tonight|night)\b/i, 20, 'night']
]

const VAGUE =
  /\b(some ?time|sometime|later|soon|next week|this week|next month|this month|weekend|in a few|couple of|eventually|one of these days|end of (the )?(week|month))\b/i

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

export function resolveDate(
  expression: string | null | undefined,
  ref: Date,
  opts: { defaultHour: number }
): ResolvedDate {
  const expr = expression?.trim()
  if (!expr) return { dueAt: null, timeDefaulted: false, ambiguity: null, expression: null }

  const ordinal = /\b(?:on\s+)?(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)\b/i.exec(expr)
  const hasMonthName = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b/i.test(expr)

  const parsed = chrono.parse(expr, ref, { forwardDate: true })[0]

  let date: Date
  let ambiguity: string | null = null
  let timeDefaulted = false

  if (ordinal && !hasMonthName && (!parsed || !parsed.start.isCertain('month'))) {
    // "on the 15th": chrono does not handle a bare day-of-month, resolve to the next occurrence.
    const day = Number(ordinal[1])
    if (day < 1 || day > 31) return unresolvable(expr)
    date = nextDayOfMonth(ref, day)
    ambiguity = `You said "${ordinal[0].trim()}" without a month; assumed ${date.toLocaleDateString(undefined, { month: 'long', day: 'numeric' })}.`
    const timeFromParse = parsed && parsed.start.isCertain('hour') ? parsed.start.date() : null
    if (timeFromParse) {
      date.setHours(timeFromParse.getHours(), timeFromParse.getMinutes(), 0, 0)
    } else {
      date.setHours(partOfDayHour(expr) ?? opts.defaultHour, 0, 0, 0)
      timeDefaulted = true
    }
  } else if (parsed) {
    const start = parsed.start
    date = start.date()
    if (!start.isCertain('hour')) {
      const pod = partOfDayHour(expr)
      date.setHours(pod ?? opts.defaultHour, 0, 0, 0)
      timeDefaulted = true
    } else if (!start.isCertain('minute')) {
      date.setMinutes(0, 0, 0)
    } else {
      date.setSeconds(0, 0)
    }

    // A bare time ("at 3pm") that has already passed today rolls to tomorrow.
    if (!start.isCertain('day') && !start.isCertain('weekday') && date.getTime() <= ref.getTime()) {
      date.setDate(date.getDate() + 1)
    }

    const nextWeekday = /\bnext\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i.exec(expr)
    if (nextWeekday) {
      const target = WEEKDAYS.indexOf(nextWeekday[1].toLowerCase())
      const nearest = nextWeekdayDate(ref, target)
      nearest.setHours(date.getHours(), date.getMinutes(), 0, 0)
      date = nearest
      if (sameIsoWeek(ref, nearest)) {
        const later = new Date(nearest)
        later.setDate(later.getDate() + 7)
        ambiguity = `"${nextWeekday[0]}" could mean ${fmtDay(nearest)} or ${fmtDay(later)}; assumed ${fmtDay(nearest)}.`
      }
    }

    if (!ambiguity && VAGUE.test(expr)) {
      ambiguity = `"${expr}" is not a specific time; please pick the exact date.`
    }
  } else {
    return unresolvable(expr)
  }

  if (!ambiguity && date.getTime() < ref.getTime() - 60_000) {
    ambiguity = `"${expr}" resolves to a time in the past.`
  }

  return { dueAt: date, timeDefaulted, ambiguity, expression: expr }
}

/** Finds the first date phrase chrono recognises anywhere in a transcript. */
export function findDateExpression(transcript: string, ref: Date): string | null {
  const results = chrono.parse(transcript, ref, { forwardDate: true })
  if (results.length > 0) return results[0].text
  const ordinal = /\b(?:on\s+)?the\s+\d{1,2}(?:st|nd|rd|th)\b/i.exec(transcript)
  return ordinal ? ordinal[0] : null
}

function unresolvable(expr: string): ResolvedDate {
  return {
    dueAt: null,
    timeDefaulted: false,
    ambiguity: `Could not work out a date from "${expr}".`,
    expression: expr
  }
}

function partOfDayHour(expr: string): number | null {
  for (const [re, hour] of PART_OF_DAY) if (re.test(expr)) return hour
  return null
}

function nextDayOfMonth(ref: Date, day: number): Date {
  for (let add = 0; add < 13; add++) {
    const d = new Date(ref.getFullYear(), ref.getMonth() + add, day)
    if (d.getDate() !== day) continue // e.g. 31st in a 30-day month
    const endOfDay = new Date(d)
    endOfDay.setHours(23, 59, 59, 999)
    if (endOfDay.getTime() >= ref.getTime()) return d
  }
  return new Date(ref.getFullYear(), ref.getMonth() + 1, day)
}

function nextWeekdayDate(ref: Date, weekday: number): Date {
  const d = new Date(ref)
  d.setHours(0, 0, 0, 0)
  let diff = (weekday - d.getDay() + 7) % 7
  if (diff === 0) diff = 7
  d.setDate(d.getDate() + diff)
  return d
}

function sameIsoWeek(a: Date, b: Date): boolean {
  const monday = (d: Date): number => {
    const x = new Date(d)
    x.setHours(0, 0, 0, 0)
    x.setDate(x.getDate() - ((x.getDay() + 6) % 7))
    return x.getTime()
  }
  return monday(a) === monday(b)
}

function fmtDay(d: Date): string {
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
}
