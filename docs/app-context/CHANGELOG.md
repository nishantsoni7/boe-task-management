# App Context Changelog

Newest first. One entry per merged change that alters behavior, schema, process or backups. Keep entries short; the detail lives in the module dossier and the PR.

Format: `YYYY-MM-DD · PR · what · migrations (version → apply state) · backup taken (UTC stamp)`

## 2026-10-19 — App code of #358 reverted (b8c15e6e) · migrations 20270321000000/01 kept on main, UNAPPLIED
- #358 merged and deployed before its two migrations were applied; the app then listed notification types the database does not have, which fails the Orders notification feed and badge. The APP CODE is reverted (the feed lists only types the database has again; the PI page / split-modal payment notices and the route change go too). The two migration files STAY on main, unapplied, with their tests — a migration file already on main cannot be removed without tripping the applied-migration guards, and both are purely additive. Next: the owner applies 20270321000000 then 20270321000001 (db push from the main repo), then the app code is re-landed. Nothing in the database changed.

## 2026-10-19 — Orders notifications that were written but shown nowhere (PR open)
- Owner audit: `pi_exception_*`, `pi_revision_*` and `order_document_review_*` rows were inserted (database or `/api/orders/submissions/notify`) but no category listed them, so they reached no feed, badge or "mark all read". They are now in `ORDER_NOTIFICATION_TYPES`; `notificationMeta` files them under Orders (PI exception and revision open the PI; Design Files / Client PO open the Order at #documents). `pi_correction_*` deliberately NOT added: those values are not in the enum yet and an unknown value in a `type.in.(...)` filter fails the whole read — they come with the notifications migration. New test `hiddenOrderTypes.test.ts`. No SQL.

## 2026-10-19 — Orders sidebar order; Download PI Format in a Resources block · #355 (6b3ae524)
- Orders sidebar: Dashboard, Confirmed Orders, PI Drafts, Notifications. Download PI Format left the destinations list for a small, muted "Resources" block above the account (it saves a file; it is not a page). Tests updated deliberately: `piFormatEntryPoints`, `orderRequestRetirement` (nav order). No SQL.

## 2026-10-19 — Correct a wrong pending payment from the two verification screens (PR open) · no migration
- Finance → Payment Requests → review modal ("Payments verification"): an **Edit payment** button beside "Payment Details", drawn only where the table's pencil is (`canManageRequest`: the submitter or an admin, payment not verified). It closes the review and opens the same `EditPaymentModal` (amount, date, account, reference, destination, custody additions) through `edit_payment_request`.
- PI Draft → "Payments awaiting verification" dialog: an **Edit** button beside Approve / Reject on each active payment still with Finance (pending or needs clarification), shown to an active admin (`canAdminAmend`). New `components/orders/PiPaymentEditDialog.tsx` reads the one payment row and opens Finance's `EditPaymentModal`; the payments dialog is hidden meanwhile and reopens after save/close with the payments re-read. `describePiPaymentRow` gained `canEdit`.
- Database unchanged: `edit_payment_request` already lets the submitter or an admin correct an unverified payment and refuses a verified one. A non-admin submitter's own payment is not offered Edit on the PI dialog (the page does not know it is theirs unless they are an approver); they use Finance.

## 2026-10-19 — Sample choice on PI and Order; list without Status · #354 (45f3b1f3) · migration 20270320000000 → APPLIED 2026-10-19 (verified in schema_migrations before merge)
- New `20270320000000_order_submission_sample_type.sql`: `order_submissions.sample_type` and `orders.sample_type / sample_type_set_by / sample_type_set_at` (values `sampling_needed`, `sample_order`); RPCs `set_order_submission_sample_type` (PI draft: `can_edit_order_submission`, row_version) and `set_order_sample_type` (Order: `can_record_order_approval`, never cancelled; logs `sample_type_changed`). Additive; rehearsed against the linked DB inside BEGIN…ROLLBACK (admin sets, bogus value and non-permitted user refused, activity logged, nothing persisted). **Must be applied before the PR merges** — the list and Order page select the new columns.
- PI Draft: a Sample select under the highlight in Supporting details. Order page: a Sample row in Internal order details (editable by the salesperson, admin or manager). Effective value: the Order's own choice once made, else the PI's, else the legacy "Sample order" advance reason (`effectiveSampleType` in `lib/orders/sampleType.ts`).
- Confirmed Orders list: Status column removed (status cards still filter); every column left-aligned; the sample (tooltip "Sampling needed before production" / "Sample order only") and commission symbols at the right edge of the Project code cell; phone cards lose the status pill.
- Tests updated deliberately: `orderListValue.test` (columns, sample precedence), `orderStartupShape` (DETAIL 43 → 44, one RPC on a change).

## 2026-10-19 — Confirmed Orders list: Product Value is the Subtotal; new columns · #353 (e233340c)
- Columns now: Project code (with Sample and commission symbols), Client, Product Value, Status, Factory Status (Aligned for Production / Not Aligned), Sales Person (renamed from Assigned to), Confirmed, Due. Requested by removed. Phone cards show the same facts. The markers come from the same source-PI embed (`advance_exception_reason_code`, nested `order_submission_middleman_commissions`) — still one query.
- `/orders/all` Value (table, phone cards, Value sort) now shows the Subtotal — products minus discount — instead of the Order's Grand Total (`total_value`). Read from the source PI's `subtotal_after_discount` in the same query (embed), used while the PI's grand total still equals the Order's value; otherwise the Order's product value. Order 0524: ₹15,64,090 → ₹12,53,000. No new query, no SQL. New test `orderListValue.test.ts`.

## 2026-10-19 — Order Detail: Edit PI in the header, Main PI beside Product pictures · #352 (fdde269f)
- Edit PI moved from the Main PI row to the page header (same handler, gate and blocked state). Operations reviewer and File rows removed from the Main PI (owner: not required; an unassigned reviewer is still said). Main PI and Product pictures share one row: Main PI left (grows), pictures right (content width), stacked below 760px card width. Tests updated deliberately: `orderDocumentSubmissions.render`. Migrations: none.

## 2026-10-19 — Order Detail Documents card cleanup + warnings off the page (#350 merged as 67523b65 with the first two bullets; the rest in the follow-up PR)
- Files sent with the PI now show in the Design Files and Client PO rows as soon as the Order exists (they were hidden until Operations accepted PI V1, so the rows said "No design files" / "No client PO" beside files that had been sent). `sentWithPiOnFile` in `lib/orders/orderDocumentSubmissions.ts`; an accepted amendment still wins.
- The "Document changes" panel no longer lists the files sent with the PI (they are not a change); it is for amendments and PI revisions only. The Main PI row's line under "Waiting for Operations" now names only the reviewer (the pill and the Approved date already said the rest).
- Main PI row laid out like a Notion record: title + status, a property list (Uploaded, Approved, Operations reviewer, File), then the actions with one primary (Download original Excel became secondary).
- New **Internal order details** block (BOE only) in the Documents card: fabric responsibility, middleman commission (restricted by `can_read_order_submission_commission`, fails closed), billing percentage, billing terms, payment terms. Two reads added to the existing PI load group (no extra wait); `billing_terms`/`payment_terms` added to the PI select.
- Warnings that sit on the page (attention strip, Internal highlight, document changes) are white cards with a 4px amber edge and amber border — even the solid Waiting tint was too close to the page canvas. Payment notice Working `#EAF0F8`, customisation note Blocked `#FBE9EC`. Tests updated deliberately: `orderDocumentSubmissions.render`, `orderDetailPolish.render`, `orderStartupShape` (DETAIL 41 → 43), `operationsHandoffSchema`. Migrations: none.

## 2026-10-19 — Test/lint hygiene: offline test env + restore-rehearsal lint
- `briaProductShot.test.ts` "a missing reference costs nothing at all" failed whenever `NEXT_PUBLIC_SUPABASE_URL` was set (the documented offline env), because `loadStudioReference`'s storage fallback hit the stubbed `fetch`. The test now unsets the Supabase URL/key for its own duration (restored after), so it passes with or without the env and still asserts zero fetches. No product code changed.
- `scripts/backup/restore-rehearsal.mjs`: removed the unused counter `n` (duplicated `report.tables`); `npm run lint` back to 0 warnings. Migrations: none.

## 2026-10-19 — Orders lists on the Finance list design (Confirmed Orders, PI Drafts) · PR #348 (open)
- `/orders/all`: the status tab strip became six status cards that are the filter (`FinanceStatusCards`); the four dropdowns became chips in the view bar (Assignee, Order date, Source, Sort; `FilterChip` gained an `icon`); the "N of M visible" count is gone. Table is `.fin-table` (initials for people, lead source under the client, "Overdue" under the due date, right-aligned Value). Status colours (owner-approved): Running blue, On Hold amber, Ready for Dispatch green (was blue), Dispatched grey (was green), Cancelled red. Phone cards and every URL parameter unchanged.
- `/orders/drafts`: new status cards (All, Draft, Submitted for Review, Needs Changes, Rejected) and a search box (client, PI reference, salesperson, uploader, submitter), both in the URL (`?status=`, `?q=`) and both narrowing the rows already read — no new query. The review queue is a labelled group inside the same board. Open Draft / Review PI / Delete are 28px icons. Phone cards below 1100px unchanged.
- Shared: `FinanceEmpty` gained `file`/`box` icons; CSS "ORDERS LISTS on the Finance list" block (`.fin-group`, `.fin-table-wrap`, `.boe-row-icon--review`). Visual only: same reads, permissions and links. Migrations: none.

## 2026-10-19 — Order Detail + Internal order details: Notion pass (PR open)
- `/orders/[id]`: page centred and capped at 1440px; title in sentence case (28px) with a calmer status pill; the summary is a quiet property panel (grey group captions, muted labels, hairline rows). Documents get a right rail holding Fabric & Finish (stacked) and Notes (Notes moved into `OrderDocumentsRow`). Payment moved into that same rail, below Fabric & Finish and Notes (owner, 2026-10-19: it used the empty space there), wrapped in `.order-docs-pay`; the lower workspace is the record (change requests, activity) beside the Commercial breakdown (no longer sticky). One card family: white, #ECE7E0 hairline, 12px corners. Visual only — same queries, rules and controls; CSS is one later "ORDER DETAIL — NOTION PASS" block that overrides by cascade order.
- Internal order details (PI Draft, before conversion): every form row fills the 12-column grid — dates 3+3 with Fabric responsibility 6; Salesperson, Middleman commission, Billing % at 4 each; Payment terms 8 + Lead source 4; the commission follow-up on 6/6 and 4/8. Quieter inputs/labels and neutral selected options ("PI FORMS — NOTION PASS" CSS block).
- Confirmed Payments fix: the "Paid date" chip stays on the search line (`.fin-tools` no longer wraps on desktop) and its panel opens to the right instead of under the sidebar.
- Tests updated deliberately: `orderDetailArchitecture` (Payment in the Documents rail), `piFormRedesign.render` (row spans), `menuPlacement` (one-line tools, right-opening panel). Migrations: none.
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
