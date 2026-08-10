# ADR-0007: One documentation contract, mechanically checked

- **Status:** accepted
- **Date:** 2026-08-11
- **Affects:** Documentation, CI
- **Supersedes / Superseded by:** none

## Context

The repository had three competing entry points — root
`CLAUDE_START_HERE.md.txt`, `docs/Reference/CLAUDE_START_HERE.md`, and
`docs/BOE Master Context/00_README_FIRST.md` — and `CLAUDE.md` pointed at none
of them. The root one referenced **seven** paths, **none of which existed**.

`02_Current_System_State.md` described Attendance and Payroll as "Early Stage"
months after both were in production use, and Employee Records as "Planned"
when it was live at `/admin/members`.

Nothing checked any of this, so drift was invisible until somebody acted on a
false map.

## Decision

**One** canonical entry point (`docs/BOE Master Context/00_README_FIRST.md`),
**one** contributor contract (`AGENTS.md`, which `CLAUDE.md` includes), and a
local validator (`npm run docs:check`) that fails on the mechanical failures: a
missing required document, a broken local link, a module document missing
required sections, a duplicate ADR number, or an index pointing at a missing
file.

## Alternatives considered

| Alternative | Why not |
| --- | --- |
| A documentation site generator | Disproportionate for BOE's size; adds a dependency and a build step |
| Copy the rules into every instruction file | Guarantees they contradict each other — already the observed failure |
| Enforce freshness by comparing timestamps | Produces meaningless edits to satisfy a checker; does not make a sentence true |
| Trust review | Already the process that failed |

## Consequences

- A broken documentation link now fails CI, like a type error.
- **Cost:** the validator checks structure, not truth. A file can pass with a
  false statement in it. Accuracy stays a human responsibility, which
  `AGENTS.md` assigns explicitly.
- **Cost:** adding a module document means filling required sections. That is
  the intent — a stub with headings beats an absent document.

## Migration / rollback

Adopted incrementally: high-risk modules have full documents, the rest have
index entries. Removing the check is one line in `package.json`, but the drift
returns with it.
