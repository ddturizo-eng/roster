// Numbered migrations (plan 002 section 5). Never edit a migration that shipped: add a new one with
// the next version. Version 2 (T07) adds the execution, approval and runtime tables.

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'projects, features, grilling, tasks',
    sql: `
CREATE TABLE projects (
  name                TEXT PRIMARY KEY,
  repo_path           TEXT NOT NULL,
  remote_url          TEXT NOT NULL,
  owner_repo          TEXT NOT NULL,
  registration_commit TEXT NOT NULL,
  synced_at           TEXT NOT NULL
);

CREATE TABLE features (
  id         TEXT PRIMARY KEY,
  project    TEXT NOT NULL REFERENCES projects(name),
  number     TEXT NOT NULL,
  slug       TEXT NOT NULL,
  stage      TEXT NOT NULL,
  step       TEXT NOT NULL,
  idea_text  TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project, number)
);

CREATE TABLE feature_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  feature_id      TEXT NOT NULL REFERENCES features(id),
  from_stage      TEXT,
  to_stage        TEXT NOT NULL,
  step            TEXT NOT NULL,
  at              TEXT NOT NULL,
  pr_url          TEXT,
  merged_at       TEXT,
  evidence_commit TEXT,
  reason          TEXT
);
CREATE INDEX feature_events_feature ON feature_events(feature_id, id);

CREATE TABLE grilling (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  feature_id     TEXT NOT NULL REFERENCES features(id),
  round          INTEGER NOT NULL,
  question_human TEXT NOT NULL,
  question_en    TEXT NOT NULL,
  answer_human   TEXT,
  asked_at       TEXT NOT NULL,
  answered_at    TEXT
);
CREATE INDEX grilling_feature ON grilling(feature_id, id);

CREATE TABLE tasks (
  id            TEXT PRIMARY KEY,
  feature_id    TEXT NOT NULL REFERENCES features(id),
  key           TEXT NOT NULL,
  ord           INTEGER NOT NULL,
  title         TEXT NOT NULL,
  status        TEXT NOT NULL,
  needs_human   TEXT,
  agent_slug    TEXT,
  profile       TEXT,
  body_md       TEXT NOT NULL,
  source_commit TEXT NOT NULL,
  branch        TEXT,
  pr_number     INTEGER,
  pr_url        TEXT,
  merged_at     TEXT,
  stop_reason   TEXT,
  retry_note    TEXT,
  updated_at    TEXT NOT NULL,
  UNIQUE (feature_id, key)
);
CREATE INDEX tasks_feature_ord ON tasks(feature_id, ord);
CREATE INDEX tasks_status ON tasks(status);

CREATE TABLE task_dependencies (
  task_id       TEXT NOT NULL REFERENCES tasks(id),
  depends_on_id TEXT NOT NULL REFERENCES tasks(id),
  PRIMARY KEY (task_id, depends_on_id)
);
CREATE INDEX task_dependencies_depends_on ON task_dependencies(depends_on_id);
`,
  },
  {
    version: 2,
    name: 'executions, steps, events, approvals, runtime state',
    sql: `
CREATE TABLE executions (
  id                      TEXT PRIMARY KEY,
  task_id                 TEXT REFERENCES tasks(id),
  feature_id              TEXT NOT NULL REFERENCES features(id),
  job_kind                TEXT NOT NULL,
  agent_slug              TEXT,
  runtime                 TEXT,
  status                  TEXT NOT NULL,
  started_at              TEXT NOT NULL,
  ended_at                TEXT,
  base_commit             TEXT,
  head_commit             TEXT,
  branch                  TEXT,
  pr_url                  TEXT,
  log_dir                 TEXT,
  container_name          TEXT,
  result_json             TEXT,
  reason                  TEXT,
  stop_requested_at       TEXT,
  pid                     INTEGER,
  rate_limit_status       TEXT,
  rate_limit_type         TEXT,
  five_hour_utilization   REAL,
  five_hour_resets_at     TEXT,
  seven_day_utilization   REAL,
  seven_day_resets_at     TEXT,
  rate_limit_observed_at  TEXT
);
CREATE INDEX executions_feature_started ON executions(feature_id, started_at);
CREATE INDEX executions_task ON executions(task_id);
CREATE INDEX executions_started ON executions(started_at);
CREATE INDEX executions_runtime_observed ON executions(runtime, rate_limit_observed_at);

CREATE TABLE execution_steps (
  execution_id TEXT NOT NULL REFERENCES executions(id),
  step         TEXT NOT NULL,
  status       TEXT NOT NULL,
  started_at   TEXT NOT NULL,
  ended_at     TEXT,
  detail       TEXT,
  PRIMARY KEY (execution_id, step)
);

CREATE TABLE execution_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  execution_id TEXT NOT NULL REFERENCES executions(id),
  at           TEXT NOT NULL,
  type         TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE INDEX execution_events_execution ON execution_events(execution_id, id);

CREATE TABLE approval_requests (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id      TEXT NOT NULL REFERENCES tasks(id),
  kind         TEXT NOT NULL CHECK (kind IN ('dependencies', 'protected_path')),
  detail_json  TEXT NOT NULL,
  content_hash TEXT,
  created_at   TEXT NOT NULL,
  resolved_at  TEXT,
  resolution   TEXT CHECK (resolution IN ('approved', 'consumed'))
);
CREATE INDEX approval_requests_task ON approval_requests(task_id, id);

CREATE TABLE runtime_state (
  runtime            TEXT PRIMARY KEY,
  quota_exhausted_at TEXT,
  cooldown_until     TEXT,
  cooldown_source    TEXT CHECK (cooldown_source IN ('resets_at', 'fallback')),
  cooldown_window    TEXT
);
`,
  },
];
