# ADR-0003: Forward-only Supabase migrations

- **Status:** accepted (**Reconstructed** — the practice is provable from the migration history; no original decision record survives)
- **Date:** ~2026-06 (approximate; first repair migrations)
- **Affects:** Database, all modules
- **Supersedes / Superseded by:** none

## Context

Migrations are applied to a production database holding real salaries and audit
history. The repository has 159 migrations. A history-collision incident
(`20260612`/`20260620`/`20260621`) had to be repaired forward rather than by
editing applied files, and two dead migrations were retired by superseding them.

## Decision

Migrations are **forward-only**. A deployed migration is never edited, renamed,
reordered, combined or deleted. A mistake is corrected by adding a new
migration. New files use `YYYYMMDDHHMMSS_snake_case.sql`.

## Alternatives considered

| Alternative | Why not |
| --- | --- |
| Edit the offending migration | Environments that already applied it never see the change; the two drift silently |
| Squash history periodically | Destroys the record of what production actually ran |
| Down-migrations | Rarely correct against real data; a rollback of a data-bearing change is a new forward migration anyway |

## Consequences

- The migration list is an accurate history of what production ran.
- **Cost:** the directory only grows, and carries corrective migrations that
  read as noise without their context.
- **Cost:** two naming conventions coexist (65 eight-digit, 94 fourteen-digit),
  because the older files cannot be renamed. New files are checked; old files
  are grandfathered (R-6).

## Migration / rollback

Not reversible, and that is the point. Rollback of a schema change is a new
corrective-forward migration, planned before the original is applied.
