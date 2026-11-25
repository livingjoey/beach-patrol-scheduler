// Database schema. SQLite for local/dev use; every table maps 1:1 to PostgreSQL
// (INTEGER PRIMARY KEY -> SERIAL/IDENTITY, TEXT dates -> DATE, 0/1 -> BOOLEAN).
// Dates are stored as ISO strings 'YYYY-MM-DD'. Weekdays are 0..6 with 0 = Saturday,
// matching the patrol week (Saturday through Friday).

export const SCHEMA_SQL = `
-- Scheduler accounts: administrators only (at most 10). Lifeguards do not sign in.
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  identifier    TEXT NOT NULL UNIQUE COLLATE NOCASE,  -- e.g. ADM01; used to sign in
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  can_override  INTEGER NOT NULL DEFAULT 0,          -- may approve supervisor overrides
  active        INTEGER NOT NULL DEFAULT 1,
  last_login_at TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS certifications (
  code       TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- "Holding holder_code also satisfies satisfies_code". Nothing is implied unless a row exists AND is enabled.
CREATE TABLE IF NOT EXISTS cert_equivalencies (
  id             INTEGER PRIMARY KEY,
  holder_code    TEXT NOT NULL REFERENCES certifications(code) ON DELETE CASCADE,
  satisfies_code TEXT NOT NULL REFERENCES certifications(code) ON DELETE CASCADE,
  enabled        INTEGER NOT NULL DEFAULT 0,
  UNIQUE (holder_code, satisfies_code),
  CHECK (holder_code <> satisfies_code)
);

CREATE TABLE IF NOT EXISTS personnel (
  id          INTEGER PRIMARY KEY,
  lg_number   TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name        TEXT NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1,
  label_color TEXT NOT NULL DEFAULT 'white'
              CHECK (label_color IN ('red','light_blue','green','dark_blue','white')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS personnel_certs (
  personnel_id INTEGER NOT NULL REFERENCES personnel(id) ON DELETE CASCADE,
  cert_code    TEXT NOT NULL REFERENCES certifications(code) ON DELETE CASCADE,
  PRIMARY KEY (personnel_id, cert_code)
);

-- Regular weekly days off; repeat every week.
CREATE TABLE IF NOT EXISTS personnel_days_off (
  personnel_id INTEGER NOT NULL REFERENCES personnel(id) ON DELETE CASCADE,
  weekday      INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  PRIMARY KEY (personnel_id, weekday)
);

-- Date-specific overrides. They never change the regular pattern.
-- 'extra_workday' makes someone available on one of their regular days off.
CREATE TABLE IF NOT EXISTS time_off (
  id           INTEGER PRIMARY KEY,
  personnel_id INTEGER NOT NULL REFERENCES personnel(id) ON DELETE CASCADE,
  start_date   TEXT NOT NULL,
  end_date     TEXT NOT NULL,
  type         TEXT NOT NULL CHECK (type IN ('vacation','leave','training','other','extra_workday')),
  note         TEXT NOT NULL DEFAULT '',
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (end_date >= start_date)
);
CREATE INDEX IF NOT EXISTS time_off_person_dates ON time_off (personnel_id, start_date, end_date);

CREATE TABLE IF NOT EXISTS criteria_presets (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  rule_json   TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS assignments (
  id                INTEGER PRIMARY KEY,
  code              TEXT NOT NULL UNIQUE COLLATE NOCASE,
  kind              TEXT NOT NULL CHECK (kind IN ('stand','medical','pwc','boat','extra')),
  display_name      TEXT NOT NULL,
  active            INTEGER NOT NULL DEFAULT 1,
  sort_order        INTEGER NOT NULL DEFAULT 0,
  default_preset_id INTEGER REFERENCES criteria_presets(id) ON DELETE SET NULL,
  open_by_default   INTEGER NOT NULL DEFAULT 1,
  start_time        TEXT,  -- optional 'HH:MM'; used for overlap checks
  end_time          TEXT
);

CREATE TABLE IF NOT EXISTS slots (
  id               INTEGER PRIMARY KEY,
  assignment_id    INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  position         INTEGER NOT NULL,
  name             TEXT NOT NULL,
  criteria_mode    TEXT NOT NULL DEFAULT 'default' CHECK (criteria_mode IN ('default','preset','custom')),
  preset_id        INTEGER REFERENCES criteria_presets(id) ON DELETE SET NULL,
  custom_rule_json TEXT
);
CREATE INDEX IF NOT EXISTS slots_assignment ON slots (assignment_id, position);

-- Per-day open/closed override for an assignment. No row = use open_by_default.
CREATE TABLE IF NOT EXISTS assignment_day_status (
  assignment_id INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  date          TEXT NOT NULL,
  open          INTEGER NOT NULL,
  PRIMARY KEY (assignment_id, date)
);

CREATE TABLE IF NOT EXISTS schedule_entries (
  id              INTEGER PRIMARY KEY,
  date            TEXT NOT NULL,
  slot_id         INTEGER NOT NULL REFERENCES slots(id) ON DELETE CASCADE,
  personnel_id    INTEGER NOT NULL REFERENCES personnel(id) ON DELETE CASCADE,
  locked          INTEGER NOT NULL DEFAULT 0,
  source          TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','autofill','copy')),
  override_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  override_reason TEXT,
  override_issues TEXT,
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (date, slot_id)
);
CREATE INDEX IF NOT EXISTS schedule_entries_person_date ON schedule_entries (personnel_id, date);
CREATE INDEX IF NOT EXISTS schedule_entries_date ON schedule_entries (date);

CREATE TABLE IF NOT EXISTS weeks (
  week_start   TEXT PRIMARY KEY,
  status       TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  published_at TEXT,
  published_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY,
  at          TEXT NOT NULL DEFAULT (datetime('now')),
  user_id     INTEGER,
  action      TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}'
);
`;
