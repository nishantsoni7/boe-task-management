# Release card: PR #280 — Payment Requests owner soft delete

Status: **NOT RELEASED.** The PR is a draft, unmerged; the migration is unapplied in production. Nothing below runs until the owner authorises the release.

- PR: nishantsoni7/boe-task-management#280, branch `feat/payment-request-salesperson-delete`
- Code and migration last changed in `d84c2d865723…`; this card is the only change on top of it, so the release head is the commit that adds this card (read it from the PR, `gh pr view 280 --json headRefOid`). Branch is 5 commits ahead of `main` = `1664c1f7`, 0 behind. Preflight step 1 compares the live head to the PR; the migration hash below is what must not change.
- The ONE migration: `supabase/migrations/20270226000000_payment_request_owner_soft_delete.sql` (sha256 of the head file with LF endings starts `3d8f8306b341`)

## 1. What ships

| Part | Effect |
|---|---|
| Migration | `deleted_at`/`deleted_by`; `delete_own_payment_request(uuid)`; freeze trigger; RESTRICTIVE select policy hiding deleted rows; refuse-new-allocation/intent triggers; **drops `finance_payment_requests_own_delete`**; `finance.delete` policy now excludes the caller's own requests; `request_deleted` activity event |
| Frontend | Salesperson list (8 columns, Total Before GST, cancelled-link context on rejected rows), Delete dialog, activity label |

## 2. Known gaps (as of the head commit above)

1. **No Admin login check on the latest commit.** A real Admin session was exercised on an earlier commit (review columns intact, deleted row invisible to Admin); on `d84c2d86` the local auth service timed out and the Admin login was skipped. The Admin path is the same code path as the verified Finance reviewer (approval permission): `isSalespersonPaymentView(isAdmin, caps)` returns false for Admins, covered by a unit test. **Do the Admin look in the post-release checks (section 7).**
2. **No authenticated mobile screenshot.** Mobile was checked by (a) a real-session measurement on an earlier commit (no page overflow, Delete reachable, 44px target) and (b) fixture renders of the real list component at 375px on the latest commit. There is no screenshot of a signed-in phone-width session against a database on the head commit.
3. **`supabase db push --dry-run` was not run** for this release (Docker was unstable when preparing it). The equivalent decision input was read instead: `supabase migration list --linked` shows 308 of 309 applied, the only local-only version being `20270226000000`. Run the throwaway-database dry run in section 4 before the push.
4. The local verification stack was slow; Total Before GST sometimes took up to a minute to settle. Production latency is different (see `vercel-iad1-supabase-tokyo-latency`), but the totals load after the rows and after the destination/cancelled-link reads, so expect the column to fill in a second or two later than the rows.

## 3. Current state (read-only, 2026-10-03)

- Merge rules (ruleset "Protect main"): PR required, squash/rebase only, linear history, required status check **`Vercel`** (strict: branch must be up to date with `main`). Head `d84c2d86` has `Vercel` ✓ and `Vercel Preview Comments` ✓; `mergeStateStatus` CLEAN. `main` is still `1664c1f7`, so the strict check is satisfied; if `main` moves, update the branch and let `Vercel` run again.
- Production migrations: 309 local, **308 applied, 1 pending = `20270226000000`**, latest applied `20270225000000`. No unrelated migration is pending, so `db push` would apply exactly this one. (`db push` has no per-file selection — if another migration lands on `main` first, stop and re-check; do not push two.)
- Production data relevant to this migration: `finance_payment_requests` has **2 rows, both `approved_unlinked`**; 0 pending intents; 0 active allocations on unapproved payments; 0 open deletion claims. No row is eligible for deletion today.
- Production policy state matches the migration's assumptions: DELETE policies are `admin_delete_unapproved`, `module_entry_gate` (restrictive, ALL), **`own_delete`**, `permitted_delete_unapproved`; the activity-log CHECK carries the 13 values the migration restates (so restating it drops nothing); `cancel_intents_on_reject` writes the exact reason the list reads.
- `finance.delete` is held only by the Admin account (no role/department/override grants for anyone else).

### The migration was amended while unapplied

It changed three times on this branch (`ae6d63cc` → `5c9468da` → `d84c2d86`; `abe861d2` did not touch it). It has **never** been applied to production or recorded in `schema_migrations`, so amending in place was safe and there is no checksum or history drift to reconcile. Rules for the release:

- Push from a checkout whose migration file hashes to the head version (section 4, check 2). Any local or throwaway database that took an earlier version is irrelevant to production.
- Do **not** push from a stale worktree or a cached `supabase/.temp` pointing elsewhere.
- If the file changes again after this card, update the head commit above and re-run the preflight.

## 4. Preflight (read-only; owner runs or approves each)

1. `git fetch && git rev-parse origin/feat/payment-request-salesperson-delete` equals the head commit in this card; PR still draft/unmerged until step 8.
2. In the push worktree: `tr -d '\r' < supabase/migrations/20270226000000_payment_request_owner_soft_delete.sql | sha256sum` starts `3d8f8306b341`.
3. `npx supabase migration list --linked`: exactly one local-only version, `20270226000000`; no remote-only versions. (CLI first initialises a login role on production — accepted for prechecks; see `supabase-verification-path`. A copy of `supabase/.temp` from the main checkout is needed in a fresh worktree.)
4. Read-only SQL via `npx supabase db query --linked -f <file>` (SELECT only) re-confirming section 3: row counts by status, pending intents, active allocations on unapproved payments, open deletion claims, the DELETE policy list, the activity CHECK text, `finance.delete` holders. **Stop if** a new DELETE policy appears (the migration's own DO block would refuse it), the activity CHECK has gained values (restating would drop them), or any request is mid-deletion.
5. Dry run per `release-merge-and-dry-run`: load production's `supabase_migrations.schema_migrations` into a throwaway local database and run the CLI with `--db-url postgresql://postgres:postgres@127.0.0.1:<port>/<db>?sslmode=disable --dry-run`. Expect: one migration listed.
6. Rehearse the migration on a disposable copy of the schema (the SQL suite `supabase/tests/payment_request_owner_soft_delete_assertions.sql` passes there, sections A–H, and fails if the policy changes are removed).
7. Take the owner's recovery point: wait for the fresh Supabase snapshot/backup before pushing (`pr-249` practice), and note its time here.
8. Confirm with the owner that nobody is mid-way through approving or deleting a payment (the migration takes a short ACCESS EXCLUSIVE lock on a 2-row table; this is a courtesy, not a maintenance window). If the owner planned any coordination step, get an explicit yes or waiver before pushing (`release-planned-pause-must-be-confirmed`).

## 5. Release order

**Migration first, then the frontend.** Reasons:

- The new frontend against the *old* schema shows a Delete button that fails with "could not be deleted" — a visible broken control for every salesperson.
- The *old* frontend against the *new* schema is unaffected: it does not use a direct client delete (admin deletion goes through `/api/finance/payments/delete` and SECURITY DEFINER functions, which the dropped `own_delete` policy never fed), it ignores `deleted_at`, and no row can be soft-deleted until something calls the RPC.

Sequence:

1. Preflight (section 4) — all green.
2. Owner authorises. Apply: `npx supabase db push --linked --yes` from the checked worktree (the push is the owner's / needs an explicit in-turn go-ahead; see `prod-deploy-blocked-by-classifier`). The CLI runs the file in a single transaction: either all of it lands and `schema_migrations` gets the row, or none of it does.
3. Immediately run post-migration checks A (section 7). **If they fail, stop — do not merge.**
4. Owner merges #280 on GitHub (Ready for review → **Squash and merge**), `Vercel` green. Merge triggers the production deploy.
5. Verify the merge is real (`git fetch`, `git log origin/main`, `git diff origin/main <branch>` empty — `gh pr view` can lag), then the Production deployment and alias (`vercel inspect boe-task-management.vercel.app`), then post-release checks B.
6. Only then clean up the worktree/branch (offer remote-branch deletion per branch).

## 6. Recovery

### Migration stage fails

- The push is transactional. Nothing partial exists and `schema_migrations` has no `20270226000000` row. Read the error:
  - *"A DELETE policy other than the admin and finance.delete ones exists…"* — the safety DO block found an unexpected policy; inspect `pg_policy` for `finance_payment_requests`, decide with the owner, do not weaken the check silently.
  - lock timeout / connection drop — retry; the migration is re-runnable (`drop … if exists`, `add column if not exists`, `create or replace`).
  - the activity CHECK fails to validate — an unexpected `event_type` exists in the log; list `select distinct event_type`, and update the migration only through a new PR commit.
- Confirm the pending list is still just this version, fix, re-run. Do not merge.

### Frontend stage fails

- Build/deploy fails: the previous production deployment stays live; the applied migration is harmless to it (section 5). Fix forward in the PR or leave the migration in place.
- Deployed UI misbehaves: Vercel **Instant Rollback to the immediately previous production deployment** (Hobby plan: previous only; after a rollback auto-assignment of production domains is off until "Undo Rollback"/`vercel promote`). The migration stays applied. Users keep working with the old UI.
- Open tabs are not reloaded automatically (no skew protection); ask users to Refresh.

### Rolling the migration back (only if the migration itself is the problem)

Decide first: `select count(*) from public.finance_payment_requests where deleted_at is not null;`

**A. No request has been soft-deleted (count = 0) — full reverse**, one transaction, run via `db query --linked -f` after the owner approves:

```sql
begin;
drop trigger if exists finance_payment_allocation_intents_refuse_deleted on public.finance_payment_allocation_intents;
drop trigger if exists finance_payment_allocations_refuse_deleted        on public.finance_payment_allocations;
drop function if exists public.finance_payment_children_refuse_deleted();
drop trigger if exists finance_payment_requests_a_freeze_deleted on public.finance_payment_requests;
drop function if exists public.finance_payment_requests_freeze_deleted();
drop policy  if exists finance_payment_requests_hide_deleted on public.finance_payment_requests;
drop function if exists public.delete_own_payment_request(uuid);

-- the policies as they were in production before this release
drop policy if exists finance_payment_requests_permitted_delete_unapproved on public.finance_payment_requests;
create policy "finance_payment_requests_permitted_delete_unapproved"
  on public.finance_payment_requests for delete to authenticated
  using (status in ('pending_approval', 'needs_clarification', 'rejected')
         and public.actor_has_permission('finance', 'delete'));
create policy "finance_payment_requests_own_delete"
  on public.finance_payment_requests for delete to authenticated
  using (submitted_by = auth.uid() and status in ('pending_approval', 'needs_clarification', 'rejected'));

alter table public.finance_payment_request_activity_log drop constraint finance_payment_request_activity_log_event_type_check;
alter table public.finance_payment_request_activity_log add constraint finance_payment_request_activity_log_event_type_check
  check (event_type in ('request_submitted','order_linked','order_unlinked','order_link_changed','order_request_linked',
    'order_request_unlinked','target_changed','status_changed','collection_details_updated','cash_handover_recorded',
    'allocation_created','allocation_reversed','allocation_moved'));   -- fails if any 'request_deleted' row exists: that means case B

alter table public.finance_payment_requests drop constraint finance_payment_requests_deleted_pair;
alter table public.finance_payment_requests drop column deleted_by, drop column deleted_at;
delete from supabase_migrations.schema_migrations where version = '20270226000000';
commit;
```

Note that this restores the submitter hard-delete bypass the release closed; re-ship a corrected migration promptly. If the frontend was already merged, roll it back too (Delete would fail harmlessly with the "could not be deleted" message).

**B. Requests have been soft-deleted (count > 0) — contain, do not reverse.** Dropping the hide policy or the freeze trigger would put deleted requests back on screen as active, editable, approvable pending requests. Instead:

```sql
revoke execute on function public.delete_own_payment_request(uuid) from authenticated;   -- stops further deletes
```

Keep the columns, the hiding policy and the freeze trigger. Restoring a deleted request is a deliberate, separate act (one owner-approved `update` that clears `deleted_at/deleted_by` after temporarily disabling `finance_payment_requests_a_freeze_deleted`), never part of a rollback.

## 7. Post-release read-only checks

No payment request is created, edited or deleted for testing. Database checks use `db query --linked` with SELECT-only SQL.

**A. Immediately after the migration (before merge)**

1. Version recorded: `select version from supabase_migrations.schema_migrations where version = '20270226000000'` → 1 row; `migration list --linked` → 309/309.
2. Policies (`pg_policy` on `finance_payment_requests`, `polcmd in ('d','*')` plus the restrictive ones): `own_delete` and `own_delete_pending` **absent**; `admin_delete_unapproved`, `permitted_delete_unapproved`, `module_entry_gate` present; `permitted_delete_unapproved` qual contains `submitted_by IS DISTINCT FROM auth.uid()`; `hide_deleted` present, `polpermissive = false`, `polcmd = 'r'`, qual `deleted_at IS NULL`.
3. Objects: columns `deleted_at`, `deleted_by`; triggers `finance_payment_requests_a_freeze_deleted`, `finance_payment_allocations_refuse_deleted`, `finance_payment_allocation_intents_refuse_deleted` enabled; activity CHECK text includes `request_deleted` and still all 13 earlier values.
4. RPC available and callable only by signed-in users: `has_function_privilege('authenticated','public.delete_own_payment_request(uuid)','execute')` = true; same for `anon` = **false**; `prosecdef` true; `proconfig` contains `search_path=public, pg_temp`.
5. RPC reachable without writing: `select public.delete_own_payment_request(gen_random_uuid())` run by `db query` has no signed-in user and must fail with `PAYMENT_UNAUTHENTICATED` (SQLSTATE 28000) **before any statement that writes**. A different error means the function is not the deployed one.
6. Approved-payment protection intact: trigger `finance_payment_requests_guard_approved_delete` still enabled; `pg_get_functiondef` of `delete_own_payment_request` contains `PAYMENT_APPROVED` (status test, approval-stamp test, trail test); `select count(*) … where status like 'approved%' and deleted_at is not null` = **0**; total rows still 2, both `approved_unlinked`, `deleted_at is null`.
7. Row counts unchanged: 2 requests, 0 with `deleted_at`.

**B. After the deploy**

1. Deployment/alias: GitHub Production deployment for the squash commit succeeded; `vercel inspect boe-task-management.vercel.app` points at it; `curl -I /login` → 200 (one light request; no scripted probing, see `vercel-firewall-challenges-probe-traffic`).
2. List loading, in the owner's already-signed-in Chrome, read-only: **Payment Requests** loads without an error banner; tabs and counts render; the Admin account shows the 9 review columns (this closes known gap 1); a salesperson account, or the owner's "view as" equivalent if available, shows the 8 salesperson columns. Do not press Delete on anything. The two production requests are approved, so they do not appear on this page at all — an empty list with correct empty-state text is the expected result today.
3. Approved-payment protection, structurally: repeat A6. The approved rows have no Delete control (they are not on this page) and the RPC refuses them in the database.
4. Browser console/Network: no 4xx/5xx from `finance_payment_requests`, `finance_payment_destinations`, `finance_payment_allocation_intents`, `orders`, `order_submissions` reads on the page.
5. Within the first day: `select count(*) from finance_payment_requests where deleted_at is not null` and the `request_deleted` trail rows only change when a real salesperson deleted a real unapproved request; each should show a matching actor and time.

## 8. Not part of this release

No other migration, no permission change (`finance.delete` stays Admin-only), no production data change, no Admin hard-delete behaviour change.
