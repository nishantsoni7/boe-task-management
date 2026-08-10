# Architecture Decision Records

Last verified: **2026-08-11**

An ADR records a decision that would otherwise be re-argued every few months —
why the repository is shaped the way it is, what was rejected, and what it costs.

## When to write one

Write an ADR for a decision that is **hard to reverse** or **easy to
accidentally undo**:

- A technology or platform choice
- A structural boundary (what a module owns, what is shared)
- A security or privacy posture
- A data-ownership or migration rule
- A rule about how documentation or verification works

Do **not** write one for a bug fix, a copy change, or a decision that a code
comment already carries adequately.

## How

1. Copy [_TEMPLATE.md](_TEMPLATE.md).
2. Number it sequentially: `NNNN-short-kebab-title.md`. Numbers are **never
   reused**, including for rejected records.
3. Add a row to the index below.
4. `npm run docs:check` fails on a duplicate number, an ADR missing from the
   index, or an index row pointing at a missing file.

## Status values

| Status | Meaning |
| --- | --- |
| `proposed` | Written, not yet agreed |
| `accepted` | In force |
| `superseded` | Replaced — must name the ADR that replaced it |
| `rejected` | Considered and declined. Kept, because the reasoning is the value |

## Reconstructed records

ADRs 0001–0004 are marked **Reconstructed**. The decisions are provable from
code, migrations and project records, but no original written decision or exact
date survives. The reasoning is inferred from the repository, not invented, and
the reconstruction is stated in each file. Do not cite a reconstructed date as
fact.

## Index

| ADR | Title | Status | Date | Affects |
| --- | --- | --- | --- | --- |
| [0001](0001-nextjs-supabase-vercel.md) | Next.js App Router + Supabase + Vercel | accepted (reconstructed) | ~2026-05 | All |
| [0002](0002-modular-monolith.md) | Modular monolith, not services | accepted (reconstructed) | ~2026-05 | All |
| [0003](0003-forward-only-migrations.md) | Forward-only Supabase migrations | accepted (reconstructed) | ~2026-06 | Database |
| [0004](0004-attendance-payroll-ui-consolidation.md) | Attendance & Payroll combined at the UI level, separate internally | accepted | 2026-08-10 | Attendance, Payroll |
| [0005](0005-guide-content-derives-from-engine-constants.md) | Employee-facing rule content derives from engine constants | accepted | 2026-08-11 | Payroll, Docs |
| [0006](0006-server-authorization-independent-of-navigation.md) | Server authorization is independent of navigation visibility | accepted | 2026-08-11 | All |
| [0007](0007-documentation-contract.md) | One documentation contract, mechanically checked | accepted | 2026-08-11 | Docs, CI |
