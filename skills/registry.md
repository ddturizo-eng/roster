# Skills registry

Skills that `hr-director` may assign to specialists (see ADR 0005). Only `approved` entries may appear
in an agent's `skills:` field. Approved skills are installed in `.claude/skills/<name>/` and committed.

## How a skill gets approved

1. An agent or the human adds a row with status `proposed`, its source and the reason.
2. The human reads the skill's full content (SKILL.md and any scripts) at the pinned ref.
3. The human installs it in `.claude/skills/<name>/`, commits it, and sets the status to `approved`.
4. Rejected skills stay in the table as `rejected`, with the reason, so they are not proposed again.

## Registry

| Skill | Source | Pinned ref | For profiles | Status | Notes |
| --- | --- | --- | --- | --- | --- |
| better-ui | To verify | — | Frontend, UI polish | proposed | Border radius, optical alignment, shadows, icon states, motion |
| Emil Kowalski design engineering skills | To verify (author: Emil Kowalski) | — | Frontend, animation, interaction design | proposed | Animation and interaction craft |
