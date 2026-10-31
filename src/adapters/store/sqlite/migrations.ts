// Numbered migrations (plan 002 section 5). Never edit a migration that shipped: add a new one with
// the next version. T07 adds the execution, approval and runtime tables as version 2.

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
];
