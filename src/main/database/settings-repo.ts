import type { Db } from './connection'
import { transaction } from './connection'
import type { Settings } from '../../shared/types'
import { DEFAULT_SETTINGS } from '../../shared/constants'
import { settingsPatchSchema } from '../../shared/schemas'

export class SettingsRepo {
  constructor(private readonly db: Db) {}

  /** Stored values are validated individually; a corrupt value falls back to its default. */
  get(): Settings {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as Array<{
      key: string
      value: string
    }>
    const out: Settings = { ...DEFAULT_SETTINGS }
    for (const { key, value } of rows) {
      if (!(key in DEFAULT_SETTINGS)) continue
      try {
        const parsed = settingsPatchSchema.safeParse({ [key]: JSON.parse(value) })
        if (parsed.success) Object.assign(out, parsed.data)
      } catch {
        /* ignore corrupt value */
      }
    }
    return out
  }

  update(patch: Partial<Settings>): Settings {
    const valid = settingsPatchSchema.parse(patch)
    transaction(this.db, () => {
      const stmt = this.db.prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      )
      for (const [k, v] of Object.entries(valid)) stmt.run(k, JSON.stringify(v))
    })
    return this.get()
  }
}
