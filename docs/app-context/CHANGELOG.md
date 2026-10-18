# App Context Changelog

Newest first. One entry per merged change that alters behavior, schema, process or backups. Keep entries short; the detail lives in the module dossier and the PR.

Format: `YYYY-MM-DD · PR · what · migrations (version → apply state) · backup taken (UTC stamp)`

## 2026-10-19 — Order Detail + Internal order details: Notion pass (PR open)
- `/orders/[id]`: page centred and capped at 1440px; title in sentence case (28px) with a calmer status pill; the summary is a quiet property panel (grey group captions, muted labels, hairline rows). Documents get a right rail holding Fabric & Finish (stacked) and Notes (Notes moved into `OrderDocumentsRow`). In the lower workspace Payment moved from the left column into the right rail above the Commercial breakdown (the rail is no longer sticky), so the money is one column and the record the other. One card family: white, #ECE7E0 hairline, 12px corners. Visual only — same queries, rules and controls; CSS is one later "ORDER DETAIL — NOTION PASS" block that overrides by cascade order.
- Internal order details (PI Draft, before conversion): every form row fills the 12-column grid — dates 3+3 with Fabric responsibility 6; Salesperson, Middleman commission, Billing % at 4 each; Payment terms 8 + Lead source 4; the commission follow-up on 6/6 and 4/8. Quieter inputs/labels and neutral selected options ("PI FORMS — NOTION PASS" CSS block).
- Tests updated deliberately: `orderDetailArchitecture` (Payment in the money rail), `piFormRedesign.render` (row spans). Migrations: none.
- Also merged: #346 Finance lists redesign, squash 037dec72, production deploy success, backup 20261018T192755Z verified.

## 2026-10-19 — Finance lists: owner's column order, icon actions, allocation popup (same PR as below)
- Both lists: no status tabs and no result count; the cards above each list are the filter (Confirmed: Received / Waiting to allocate / Partially / Fully, with an "over-allocated — Show them" link; Payment Requests: Pending / Needs clarification / Rejected / Archive / All via `FinanceStatusCards`). The view bar holds only search (+ "Paid date" on Confirmed).
- Confirmed Payments columns: Payment ID 100 / Amount 128 (right) / Client (flex, 120 floor) / Received on 100 / Payment mode 104 / Added by 132 (initials + `submitted_by_name`) / Allocation status 156 / Actions 140. "Allocated against" left the row: the Allocation status pill opens `AllocationDetailsPopup` (each Order/PI Draft with amount and links where the reader may open them, allocated total, left to allocate, Allocate button when permitted and money is left). `CONFIRMED_TABLE_MIN_CONTAINER_PX` 970 → 985, so a 1280px laptop now gets cards (agreed with the owner).
- Row actions are icons in fixed slots — View, Edit, Allocate, Delete (`lib/finance/rowActions.ts`: 4 × 28 + 3 × 4 + 16 = 140px); the "More actions" menu is gone from Confirmed rows and cards (Payments to Verify keeps it). Payment Requests: Payment ID, Amount, Client, Paid on, Payment mode, Against, Added by, Status, Actions (View, Edit/Reapply, Delete icons; Delete red).
- Tests rewritten deliberately: `rowActions`/`menuPlacement`, `paymentSurfaces`, `allocatedAgainst.render` (allocation cases now asserted on the popup), `paymentRequestsTable.render`. Migrations: none.

## 2026-10-18 — Finance lists redesign, Concept A (Notion-style)
- Confirmed Payments: four summary cards (Received / Waiting to allocate / Partially / Fully allocated, exact amounts + counts, each a shortcut to its tab) from one paged read of `amount, complete_allocation_status` under the reader's RLS (`lib/finance/confirmedSummary.ts`); re-read on first load and on refresh, not on every keystroke. A view bar inside the list holds quiet tabs (status dot + grey count + dark underline), the search, a "Paid date" chip (native `<details>` holding the two date inputs) and the exact count. Table columns now Payment ID 112 / Client 140 (new) / Amount 128 right-aligned / Received 104 (date with the account underneath) / Allocated against (flex, 150px floor) / Status 156 (soft pill with dot) / Actions 172; `CONFIRMED_TABLE_MIN_CONTAINER_PX` 930 → 970 (computed, not browser-measured). Allocate is a brand-outline button; empty states use `FinanceEmpty`.
- Payment Requests: same view bar (`FinanceTabs` replaces `StatusTabs` here), `.fin-table` grid, right-aligned Amount, Requested by with initials, no coloured left edge, empty state with an action.
- Shared: `finance/components/FinanceListParts.tsx` and the "FINANCE LISTS" block in `globals.css`. `.fin-board` keeps `overflow: visible` so the date panel is never clipped; corners come from the viewbar and last-row cells.
- Tests rewritten where they pinned the old layout: `paymentSurfaces`, `menuPlacement`, `allocatedAgainst.render`, `paymentRequestsTable.render`; new `confirmedSummary.test.ts`. Migrations: none.

## 2026-10-18 — Finance lists polish: Payment ID chip, one search focus ring
- Payment Requests and Confirmed Payments: the Payment ID (`human_payment_id`, already unique, immutable, never reused) prints as a copyable chip (`finance/components/PaymentIdChip.tsx`). The search box had a second square focus outline inside its rounded box (the global `:focus-visible !important` rule); now one ring on the box. Payment Requests uses the shared `.boe-list-search` toolbar and searches by Payment ID; date inputs match the search height (36px). CSS and components only. Migrations: none.

## 2026-10-18 — DOM tests for the payment forms
- Added `jsdom` (dev dependency) and `src/lib/testing/domHarness.ts`. The payment forms (Add payment on a PI, Allocate Funds, Edit Received Payment, FormDialog and its parts) are now tested by running them in a DOM; the source-text checks they replace are removed. No product code changed. Migrations: none.

## 2026-10-18 — Big Finance screens split; test-run mechanism for split screens
- `finance/received/ReceivedPaymentsView.tsx` 3,850 → 1,468 lines and `finance/page.tsx` 3,796 → 946 lines: blocks moved into sibling files, each leaving a `// @split:` marker. No behavior change; exports re-exported from the original files.
- Tests: `npm test` and `npm run test:file -- <path>` now preload `scripts/testing/screen-source-preload.mjs`, which puts split blocks back whenever a test file reads a screen as text. `scripts/dev/split-block.mjs` performs a split. Guard: `src/lib/testing/screenSplits.test.ts`. Bare `tsx --test` no longer sees the original layout.
- Also this week (PRs #327–#334): main back to 0 failing tests; required `verify` CI check; nightly live-database suite (`supabase/tests/live-db-seed.sql`, `live-db-schema-version.txt`).
- Migrations: none.

## 2026-10-18 (restore rehearsal)
- First restore rehearsal PASSED: 156 tables / 96,121 rows / 21 auth users from the newest export loaded into a throwaway local Postgres with all counts and numeric sums matching; negative test (tampered manifest) correctly failed. Not covered: the 5 service-role-unreadable tables; schema (not rebuildable from migrations alone - use Supabase platform backups for a real disaster).

## 2026-10-18 (final) — Owner reminder system
- `scripts/backup/owner-reminders.mjs` + `05_OWNER_ROUTINE.md`: nine recurring owner routines with schedules, automatic measurement where possible, a daily Windows pop-up from the 9:30 pm task, and a rule in `AGENTS.md` that every Claude session reports what is due before other work.

## 2026-10-18 (late night) — Private mirror repo live
- `nishantsoni7/boe-task-management-mirror` (private) receives every branch and tag on each push to main (PR #341). Lessons: `actions/checkout` must use `persist-credentials: false` or its own token hides the mirror; a personal token needs the **Workflows** permission to push branches that contain workflow files. Known flake: `backup-all` can report `code:false` if run at the same instant as a git hook's quick backup (mirror lock); re-run it.

## 2026-10-18 (night) — Meetings module-entry fix shipped
- PR #310 merged (`40270642`). Migration `20270319000000_meetings_rpcs_require_module_entry.sql` (renumbered from `20270315000000`, which main already used) applied to production via `db push` after a dry run showing only that file; verified with `migration list --linked`. Backup taken before applying and after merging. Rollback: re-emit the previous guard definitions from `20260814000000_create_meetings_module.sql` in a new forward migration.
- Housekeeping: 7 merged worktrees and 131 fully-merged local branches removed (all preserved in the backup mirror); main checkout moved back to `main`.

## 2026-10-18 (evening) — Backup decisions
- Supabase Pro daily backups confirmed (7 days). PITR declined by the owner (cost). Daily Task Scheduler backup installed (21:30). Passphrase stored in the owner's password manager. Second copy on `D:BOE-Backups`.

## 2026-10-18 (later) — Backups proven, migrations verified
- First successful database + storage export (161 relations, 96,108 rows, 21 auth users). Five relations are denied to the service role and are not covered (see `03_BACKUP_AND_RECOVERY.md`). Second copy to an external drive works. Git-hook bug (stray `refs/local/*` in the real repo) fixed in #337.
- Verified read-only: every migration on main is applied in production; only `20261214000000` (not on main) is absent.

## 2026-10-18 — App-context system and backup system introduced
- Added `docs/app-context/` (this folder): `00_README_FIRST.md`, `01_APP_CONTEXT.md`, `02_MASTER_INSTRUCTION_SHEET.md`, `03_BACKUP_AND_RECOVERY.md`, `04_NEW_MODULE_CHECKLIST.md`, `modules/*.md` dossiers, and the generated `APP_INVENTORY.generated.md` (`scripts/generate-app-inventory.mjs`).
- Added backup tooling `scripts/backup/*` (code mirror + bundle, uncommitted-work snapshot, memory copy, encrypted env copy, database + storage export, freshness verifier), versioned git hooks `.githooks/*`, and the GitHub Action `.github/workflows/backup-on-merge.yml`.
- Migrations: none. Production data: read-only export only.
- Found while building it: the legacy Supabase API keys in the local `.env.local` were disabled on 2026-08-16, so the database export needs the current `sb_secret_…` key in `BOE-Development/backups/.env.backup` (see `03_BACKUP_AND_RECOVERY.md` §6).
- Baseline: main at `852e0493` (#326), 330 migrations (latest `20270318000000_custody_handed_by_outside_name.sql`).
