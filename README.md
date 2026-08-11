# BOE Task Management

The internal operating system for **Best of Exports** (Jodhpur, India —
hospitality furniture manufacture and export). Task execution, attendance,
payroll, performance, samples, assets, meetings, orders, finance and employee
records in one application.

> ⚠️ **This repository is deployed and in daily production use.** It holds real
> salaries, attendance and audit history. Read
> [`AGENTS.md`](AGENTS.md) before making any change.

---

## Start here

| You are | Read |
| --- | --- |
| A new contributor or AI assistant | [`docs/BOE Master Context/00_README_FIRST.md`](docs/BOE%20Master%20Context/00_README_FIRST.md) — the **only** entry point |
| About to change code | [`AGENTS.md`](AGENTS.md) — the contributor contract |
| Working on one module | [`docs/Module Docs/README.md`](docs/Module%20Docs/README.md) |
| Wondering why something is shaped this way | [`docs/adr/README.md`](docs/adr/README.md) |

## Stack

Next.js 16 (App Router) · React 19 · TypeScript · Supabase (Postgres, Auth, RLS)
· Vercel. A modular monolith — see
[ADR-0002](docs/adr/0002-modular-monolith.md).

## Commands

```bash
npm run dev         # development server
npm run verify      # secrets scan + docs check + typecheck + lint baseline + tests + build
```

Individual steps:

```bash
npm run check:secrets  # credential scan over tracked files
npm run docs:check  # documentation structure and links
npm run typecheck   # tsc --noEmit
npm run lint:baseline  # eslint against the known-error baseline (what verify runs)
npm run lint        # plain eslint — NOT what verify runs
npm test            # full suite (node:test via tsx)
npm run build       # production build
```

`npm run verify` must pass before a commit. CI
(`.github/workflows/verify.yml`) runs the same checks as separate steps, with two
differences: `lint` is non-blocking because of known pre-existing errors, and the
production build is a **separate job gated on `vars.CI_BUILD_ENABLED`** — so a
green CI run does not prove the build passes. Run `verify` locally.

## Layout

```text
src/app/          routes, layouts and API handlers (Next.js App Router)
src/components/   shared UI
src/lib/          domain logic, per module where the pattern exists
src/hooks/        shared hooks
supabase/         forward-only migrations
scripts/          utilities, including the docs validator
docs/             project records — start at "BOE Master Context"
```

## Rules that are easy to get wrong

- **Migrations are forward-only.** Never edit, rename, reorder or delete a
  deployed one ([ADR-0003](docs/adr/0003-forward-only-migrations.md)).
- **Hidden navigation is not authorization.** Name the server-side check
  ([ADR-0006](docs/adr/0006-server-authorization-independent-of-navigation.md)).
- **Documentation is updated in the same commit as the code**
  ([ADR-0007](docs/adr/0007-documentation-contract.md)).
- **Never call branch-only work production**, and never call a migration
  deployed without evidence.
