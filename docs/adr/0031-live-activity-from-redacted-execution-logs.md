# 0031. Live activity view reads the redacted execution logs; each runtime adapter translates its own log lines

- Status: Accepted (2026-10-30, approved by the human in conversation; merging its PR is the final approval)
- Date: 2026-10-30
- Deciders: architect (feature requested and approved by the human on 2026-10-30; merging this PR
  is the approval)
- Extends: 0022

## Context

On 2026-10-30 the human added `roster watch` to spec 002 (user story 8): a live terminal view of the
running agent, its task and feature, elapsed time, the current job, the latest rate-limit snapshot
(ADR 0030) and one line per step the agent takes (`Read src/x.ts`, `Bash: npm test`,
`denied: Bash (not allowed)`, the final result). Concurrency is 1, so at most one agent runs.
`roster run` usually runs from Windows Task Scheduler (ADR 0015) while the human watches from another
terminal. A later web dashboard will read the same data.

What already exists:

- The sandbox adapter streams each job's output to `%LOCALAPPDATA%\Roster\logs\<execution-id>\` with
  secret redaction (plan 002 section 9, task T15). The store keeps executions, steps, key events and
  the rate-limit snapshot after each runtime job (ADR 0018, 0030), but not every agent step.
- Claude Code with `--output-format stream-json --verbose` writes one JSON object per line: `system`
  `init`, `assistant` lines with `tool_use` items, `user` lines with `tool_result` items,
  `rate_limit_event` and `result` (spike T14, fixtures in `docs/spikes/container-runtime/fixtures/`).
  A tool removed by managed settings shows up only as a `tool_result` error
  (`No such tool available`, spike finding 4).
- `stream-json` is a Claude Code format. Constitution principle 6 and ADR 0022 keep runtime-specific
  formats out of the orchestration core.

Three things must be decided: where live activity comes from, what the log files guarantee so a
second process can follow them, and where runtime-specific translation lives.

## Decision

1. **Source: the per-execution log files, not new store tables.** Live activity is read from the job
   logs that the sandbox adapter already writes. The store keeps what it keeps today (execution,
   steps, events, rate-limit snapshot after each job). No table and no store write per agent step;
   `roster run` does no extra work for the viewer.
2. **Log file guarantees (sandbox adapter).**
   - Each job writes `<log_dir>\<job>.jsonl` (runtime jobs: the runtime's stdout) or `<job>.log`
     (command jobs: setup, verify), where `<job>` is the `execution_steps.step` that ran it, the same
     name as in the container name `roster-<execution-id>-<job>`. Stderr goes to
     `<log_dir>\<job>.stderr.log`. Nothing else is written into a `.jsonl` file.
   - Output is split into complete lines. Each complete line is redacted and appended as soon as it
     is complete; an unterminated last line is redacted and flushed when the job ends. A secret split
     across two read chunks is therefore still redacted.
   - Apart from redaction, a `.jsonl` line is the runtime's line unchanged. Redaction replaces a
     known secret value with `[redacted]`; token values contain only characters that JSON does not
     escape, so a redacted `stream-json` line stays valid JSON.
   - Log files are opened so other processes can read them while they are written (no exclusive
     sharing mode), are only appended to during the execution, and are deleted only by retention.
3. **Translation belongs to the runtime adapter.** `RuntimePort` (ADR 0022) gains one optional
   member, `activity`: a pure reducer `(state, line) => { state, events }` that turns one log line into
   zero or more `ActivityEvent`s. `ActivityEvent` is a core domain type: `start`, `tool` (tool name and
   a short target), `denied` (tool and reason), `tool_error` (tool and first line of the error),
   `rate_limit` (a `RateLimitSnapshot`), `result` (outcome, turns, duration, first line of the final
   text), each with an optional time. The state is plain data owned by the adapter (for example the
   map from `tool_use` id to tool name). The Claude Code adapter implements it from `stream-json` and
   reuses its `rate_limit_event` parsing (ADR 0030). Unknown or malformed lines yield no event and
   never throw. A runtime without `activity` still gets the header and step changes in the view.
4. **What events may carry.** Tool names, short targets taken from tool inputs (file path, first line
   of a shell command, search pattern), the first line of a denial or tool error, the rate-limit
   snapshot and the first line of the final result. Never the content of a successful tool result
   and never the agent's intermediate prose.
5. **Rendering is core and pure.** A core module builds the view from store rows, events and the
   current time, with labels in `human_language`. Every string that comes from a log is untrusted:
   control characters (C0, DEL and C1, including ESC) are replaced, it is printed on one line, and it
   is cut to 120 characters.
6. **The viewer is read-only.** `roster watch` polls the store and follows the current job's log
   (about once per second), re-opening the file on each poll. It takes no lock, writes nothing to the
   store or the logs, reads no secret, never calls Docker and never sends input to any process or
   container.

The web dashboard, when it comes, can reuse decisions 3 to 5 over the same files and store. Its
design is not decided here.

## Considered options

- **Follow the redacted log file, translator in the runtime adapter, view in core (chosen):** no
  schema change and no extra work in the run; one redaction point for logs and viewer; keeps the
  Claude Code format out of core; about 1 s of delay.
- **Translator in core:** one module less to wire; puts a Claude Code format in the core, against
  principle 6 and ADR 0022, and duplicates the adapter's `rate_limit_event` parsing.
- **An `execution_activity` table written by `roster run` for every agent step:** easy to query for a
  dashboard; many writes during the agent job, a second copy of the log, a second place where
  redaction must hold, and a schema change for a viewer.
- **`docker logs -f` or `docker attach` on the job container:** truly live; bypasses Roster's
  redaction, needs Docker access in the viewer, and `attach` can send input to the agent.
- **A pipe or local socket from `roster run` to the viewer:** instant; more moving parts, nothing to
  replay when the viewer starts mid-run, and the run would depend on a viewer being healthy.

## Consequences

- The sandbox adapter (task T15) must write logs line by line with per-line redaction and separate
  stderr files. Per-line redaction also closes the gap of a secret split across two read chunks.
- `interpret` (T16) reads a stdout-only `.jsonl` file, which makes its parsing simpler.
- A change of the `stream-json` format makes `roster watch` show fewer lines, never fail; the CLI
  version is pinned in the image and the translator is tested with the spike fixtures.
- `roster watch` shows attempted tool calls, including denied ones, but no tool output and no file
  contents; it shows nothing that is not already in the redacted log.
- Starting the viewer mid-run re-reads the current job's log from the start to rebuild the
  translator state; job logs are a few megabytes at most, so this is acceptable.
- Reading a file another process appends to on Windows is hypothesis H11 of plan 002, checked by T41
  and T40.
