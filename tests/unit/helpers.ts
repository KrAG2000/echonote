import { openDatabase } from '../../src/main/database/connection'
import { CapturesRepo } from '../../src/main/database/captures-repo'
import { RemindersRepo } from '../../src/main/database/reminders-repo'
import { SettingsRepo } from '../../src/main/database/settings-repo'
import { DEFAULT_SETTINGS } from '../../src/shared/constants'
import type { Settings } from '../../src/shared/types'

export function memoryDb(file = ':memory:'): {
  db: ReturnType<typeof openDatabase>
  captures: CapturesRepo
  reminders: RemindersRepo
  settings: SettingsRepo
} {
  const db = openDatabase(file)
  return {
    db,
    captures: new CapturesRepo(db),
    reminders: new RemindersRepo(db),
    settings: new SettingsRepo(db)
  }
}

export const testSettings = (patch: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, ...patch })

export const llmJson = (o: Record<string, unknown> = {}): string =>
  JSON.stringify({
    category: 'reference',
    title: 'Staging server port',
    summary: 'The staging server uses port 8081.',
    action: null,
    date_expression: null,
    needs_confirmation: false,
    reason: null,
    confidence: 0.9,
    ...o
  })

export const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

export async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for condition')
    await new Promise((r) => setTimeout(r, 5))
  }
}
