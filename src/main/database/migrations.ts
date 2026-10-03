export interface Migration {
  version: number
  name: string
  sql: string
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial schema',
    sql: `
      CREATE TABLE captures (
        id TEXT PRIMARY KEY,
        transcript TEXT,
        category TEXT CHECK (category IS NULL OR category IN ('task','reminder','idea','reference')),
        title TEXT,
        summary TEXT,
        action TEXT,
        original_date_expression TEXT,
        due_at TEXT,
        time_defaulted INTEGER NOT NULL DEFAULT 0,
        timezone TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('processing','failed','inbox','needs_confirmation','ready','completed')),
        confirmation_reason TEXT,
        audio_path TEXT,
        audio_duration_ms INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        transcription_model TEXT,
        classification_model TEXT,
        classify_attempts INTEGER NOT NULL DEFAULT 0,
        transcribe_attempts INTEGER NOT NULL DEFAULT 0,
        error_code TEXT,
        error_message TEXT,
        timings TEXT
      );
      CREATE INDEX idx_captures_status ON captures(status);
      CREATE INDEX idx_captures_category ON captures(category, status);
      CREATE INDEX idx_captures_created ON captures(created_at);

      CREATE TABLE reminders (
        id TEXT PRIMARY KEY,
        capture_id TEXT NOT NULL UNIQUE REFERENCES captures(id) ON DELETE CASCADE,
        due_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending','delivered','failed','cancelled')),
        delivered_at TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_reminders_due ON reminders(status, due_at);

      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `
  }
]
