# 16. Assets & Access

Verified against checkout `852e0493`. "(unverified, from memory)" marks facts not provable from code/migrations on this checkout.

Do not confuse: `20270318000000_custody_handed_by_outside_name.sql` and `20260716/17`, `20261014` "custody" migrations belong to FINANCE payment custody (`finance_payment_custody_events`), not to Assets. Asset custody = the `employee_assets` table (migration `20260722000000_assets_custody_integrity.sql`).

## 1. Purpose & users

- Inventory of company assets (devices etc.) with custody/assignment to employees, acknowledged handover, service/warranty/documents history; plus an Access Register of login/access records per employee.
- Users: every active employee (My Assets / My Access / My Requests: own rows only); inventory managers (holders of `create|assign|edit|delete|manage`); reviewers (`manage`, plus `edit` or `delete` to approve); access-record managers (`manage_access_records`); catalogue managers (`manage_asset_catalogue`); admin (role `admin`; effectively one active admin, Nishant, from memory).

## 2. Status at commit 852e0493

- SHIPPED: V1 reset, permission cut-over, custody integrity, change requests, asset code + location, activity log, master details, transfers/service/documents, lifecycle RPCs, 15+ notification types, own-records boundary, permanent delete, `manage_access_records` permission, handover acknowledgement, asset catalogue + owner overview (PR #240, `70c86aac`, merged 2026-09-29).
- Migrations through `20270220000000` applied in prod: 20260726-31, 20260801000100, 20260802, 20260803, 20260810 (applied by hand via `db query --linked` + `migration repair`, from memory), 20270220000000 applied 2026-09-29 (memory `pr-240-asset-catalogue-state`). `20261028000000` and `20261029000000` (delegation + handover): memory said "UNAPPLIED, local only" on 2026-08-31 but they are on this checkout, which means they were merged; apply state NOT recorded in memory (unverified) - check `migration list --linked`. Note `20261029` was a DATABASE-FIRST rollout design.
- Whether the post-deploy smoke check of the catalogue and the `manage_asset_catalogue` grant were done: unknown (memory says ask before assuming).
- Still outstanding (from memory, 2026-08): `access_records.secret_value` is plaintext (grep for encrypt/pgcrypto in assets migrations/libs found nothing, consistent). This is why the Access Register is restricted. Warranty reminders run via a sweep, not a scheduler.
- The 3 original pre-existing production assets have no `asset_created` event and that is final (do not backfill).

## 3. Pages and API routes

- `/assets-access` (single page; screens chosen by `?view=`), `/assets-access/[id]` (asset detail, 5 tabs, `AssetActionModals.tsx`), `/assets-access/notifications` (own feed on shared `notifications`).
- Views (`src/lib/assets/viewRouting.ts`): `my-assets`, `my-access`, `asset-inventory`, `access-register`, `asset-requests`, `asset-catalogue`. `my-assets` and `my-access` are always allowed because they are the terminal fallback for every refused `?view=`. A refused view falls back to the caller's NORMAL landing view (an inventory manager asking for access-register lands on asset-inventory).
- API: `POST /api/assets/notify` (dispatch asset notifications; duplicate-suppression windows; the warranty type uses a 7-day window), `POST /api/assets/warranty-sweep` (service-role scan for warranties inside 30 days; called opportunistically when the inventory is opened by someone who can act; returns counts only). No cron for it.
- Layout guard `src/app/assets-access/layout.tsx`.

## 4. Database

Tables (current): `assets` (category column is `asset_type`, place is `location`, code `asset_code` `BOE-AST-000001` from sequence `asset_code_seq`, DB-generated, unique, immutable; + `product_id` nullable FK), `employee_assets` (one row per custody period; status pending_acceptance/accepted/returned/lost; + six handover columns from 20261029), `access_records` (login/access records, `secret_value` plaintext), `asset_activity_log` (immutable; `asset_id` nullable ON DELETE SET NULL with code/name snapshots), `asset_transfers` (append-only movement history), `asset_service_records`, `asset_documents` (private bucket `asset-documents`, signed URLs, 10 MB max: `ASSET_DOCUMENT_MAX_BYTES`), `asset_change_requests` (edit/remove requests; `asset_id` nullable SET NULL + `asset_name_snapshot`), `asset_handover_terms` (primary key `version`, v1 seeded, superseded rows kept forever), `asset_categories` (PK = the old `asset_type` key; RESTRICT FK), `asset_products` (unique name within category), `asset_catalogue_activity` (append-only). Dropped: `asset_access_requests`, `asset_maintenance_history`, `employee_assets` V0 / `employee_access_details` / `asset_activity_log` V0 (dropped by 20260640 reset; the current `asset_activity_log` is the 20260727 table).

Key functions: `accept_employee_asset` (ONE impl `accept_employee_asset_impl` + TWO entry points; legacy `accept_employee_asset(uuid)` kept as deprecated wrapper; NEITHER overload may declare a DEFAULT or PostgREST returns PGRST203; asserted `pronargdefaults = 0`), `assign_asset` (7 args, 5 defaults), `approve_asset_change_request` (removal branch admin-only), `permanently_delete_asset(uuid)` (admin only), `add_asset_service_record`, lifecycle RPCs (20260730), `can_access_assets_module()`, `can_view_asset_inventory()`, `can_read_asset_records()`, `can_review_asset_requests()`, `can_manage_access_records()`, `can_manage_asset_catalogue()`, `asset_catalogue_usage()` (counts only), `create_/update_asset_category`, `create_/update_asset_product` (SECURITY DEFINER, call `can_manage_asset_catalogue()` first). Triggers: `prevent_assigned_asset_delete`, `prevent_asset_transfer_mutation`, `prevent_asset_activity_mutation` (BEFORE DELETE guards that also bind service role; each early-returns for one asset when transaction-local GUC `boe.asset_purge_id` names it).

RLS idea: RLS decides who may ask; BEFORE DELETE triggers are the real guarantee; mutations go through definer RPCs; clients get SELECT only on catalogue tables; entry gates (RESTRICTIVE `module_entry_open`) on 3 catalogue tables.

Notification types (enum `notification_type`; migrations `20260731000000`, `20260802000000`): `asset_request_submitted/approved/rejected`, `asset_edit_request_submitted/approved/rejected`, `asset_assigned`, `asset_transferred`, `asset_transfer_acknowledged`, `asset_returned`, `asset_lost`, `asset_recovered`, `asset_repair_sent`, `asset_repair_returned`, `asset_warranty_expiring`, `asset_edited`, `asset_warranty_updated`, `asset_service_added`, `asset_document_uploaded`, `asset_retired`, `asset_disposed`, `asset_restored`, plus `access_*` types.

Asset statuses: `available`, `assigned`, `under_repair`, `lost`, `retired`, `disposed` (+ `assets_status_known` CHECK). `returned` is a CUSTODY event (`employee_assets.status='returned'`), never an asset-master status (20260801000100); `ASSET_STATUS_OPTIONS` and the CHECK are locked by bidirectional tests in `lifecycle.test.ts`. Conditions: new/good/fair/poor/damaged.

Migrations: 20260620000000 create, 20260620000200/20260621000000 admin policies, 20260625000000 access requests (later dropped), 20260640_reset_assets_access_v1, 20260641 admin delete, 20260642 specifications, 20260721000000 permission cutover, 20260722000000 custody integrity, 20260723000000 permission corrections (made `view` a system default for every active employee), 20260724000000 change requests, 20260725000000 `assign` action, 20260726000000 code + location, 20260727000000 activity log, 20260728000000 master details, 20260729000000 transfers/service/documents (+bucket), 20260730000000 lifecycle RPCs, 20260731000000 notification types, 20260801000100 status exclude returned, 20260802000000 access notification types, 20260803000000 permanent delete, 20260810000000 own-records boundary, 20261028000000 `manage_access_records`, 20261029000000 handover acknowledgement, 20270220000000 catalogue. Never edit an applied one. Verification SQL under `docs/Module Docs/` (`asset-activity-verification.sql`, `assets-lifecycle-verification.sql`, `assets-custody-integrity-verification.sql`, `assets-change-requests-verification.sql`, `asset-catalogue-post-release-checks.sql`, `asset-catalogue-rollback.sql`).

## 5. Permissions & access

Module `assets_access`; actions `view`, `create`, `edit`, `delete`, `manage`, `assign` (custom, split from manage by 20260725), `manage_access_records` (custom, PROTECTED, denied by default, granted to nobody by its migration; granted by hand in Control Center), `manage_asset_catalogue` (custom, PROTECTED, denied by default, depends on `view`; grants itself to admin role only).

Rules (UI `deriveAssetsAccessCapabilities` in `src/lib/permissions/assetsAccess.ts` and SQL predicates agree):
- `view` -> enter module + OWN rows only (`can_access_assets_module()`). `view` is a SYSTEM DEFAULT for every active employee (20260723); that default previously leaked org-wide visibility and was fixed by 20260810.
- `create | assign | edit | delete | manage` -> org-wide inventory (`can_view_asset_inventory()`). `create` opens inventory because Create Asset is on that screen.
- `manage` -> review queue and reject (`can_review_asset_requests()`); APPROVE additionally needs `edit` (edit request) or `delete` (removal). Nobody reviews their own request.
- `manage` = custody corrections (return, mark lost). `assign` = give an available asset.
- Permanent delete: `role='admin'` only; the grantable `delete` permission does NOT authorize it (it exists for a never-assigned inventory mistake). Approved removal also admin-only.
- Access Register: `manage_access_records` only; no role, department rule or UUID hard-coded.
- Catalogue: `manage_asset_catalogue` gives nothing else (no inventory sight, no asset writes, no access records).
- Grants are per employee (no role inheritance). Live drift found 2026-08-03: Aditya holds overrides view+create+assign+edit+manage (accepted by user; his `manage` makes him a request reviewer) (from memory).
- View As does NOT lend permissions: `useAssetsAccess` resolves for the signed-in user, so non-admin visibility needs a real non-admin login.

## 6. Business rules

- Custody: one `employee_assets` row per custody period. Assign -> `pending_acceptance`; employee acknowledges via `accept_employee_asset(ack boolean)` -> `accepted` with accepted_at, terms version and EXACT terms text snapshot copied by the database (client cannot supply terms). Return -> asset `available`. Lost -> `lost`.
- Handover facts (condition at issue, accessories issued, existing issue) are recorded by the assigner BEFORE acceptance and live on the assignment row, not the asset. Terms version `ASSET_HANDOVER_TERMS_VERSION = 'v1'`; accepted sheets print the stored snapshot, never today's text.
- Employees cannot UPDATE `employee_assets` directly (acceptance only by RPC). `employee_assets.asset_id` is RESTRICT: an asset with any custody history cannot be hard-deleted except by `permanently_delete_asset` (admin) which erases notifications -> change requests -> documents -> service -> transfers -> assignments -> activity log -> asset in one transaction. Notifications purged by `entity_id = asset AND left(type,6)='asset_'`; an `access_*` notification with the same uuid survives on purpose.
- Warranty: `EXPIRING_SOON_DAYS = 30`; whole days at UTC on both sides; statuses expired / expiring_soon / not_available / active.
- Asset code format `BOE-AST-` + 6-digit zero-padded sequence; burnt sequence values are not reused.
- Catalogue: category key never changes (rename changes `name` only); retire (`is_active=false`) instead of delete; retired category still allows edits to existing assets (shown "(inactive)"); a product named by assets cannot move category; changing an asset's category clears a product belonging to the old one and records it. Backfill: six categories, NO products created, no asset row updated.
- Owner overview (Asset Inventory): counts Active (retired/disposed excluded), Assigned, Available, Needs attention. Needs-attention reasons: status/custody disagreement, lost, handover not accepted (days waiting), under repair, condition poor/damaged, warranty ending within 30 days (only when an expiry is recorded). Available stock never flagged; no overdue-return (no expected-return date); no cost totals (purchase price/date empty on every production asset on 2026-09-27).
- Change requests: non-admin who can see inventory files an `edit` or `remove` request with reason; only an approving reviewer changes the asset; `asset_id` SET NULL on approved removal.
- Access Register has exactly THREE mutations: create, update credentials, toggle status. No access request/approval/transfer workflow exists (`asset_access_requests` dropped).
- Request-submitted notifications resolve recipients as `admins` (`assetNotifications.ts`): a `manage`-only reviewer is NOT notified (left open on purpose). Events to `admins` produce nothing when the only admin is the actor.

## 7. Key components & lib files

- `src/app/assets-access/page.tsx`, `[id]/page.tsx`, `[id]/AssetActionModals.tsx`; `src/components/assets/` (AssetModal, AssetChangeModals, AssetHandover, AssetOverviewParts, AssetCatalogueManager, AssetsAreaTabs).
- `src/lib/assets/` (types, lifecycle, transfers, service, documents, warranty, activity, changeRequests, assetFilters, actionVisibility, catalogue, overview, detail, detailView, handover, errors, assetNotifications, notifyClient, viewRouting). Permissions `src/lib/permissions/assetsAccess.ts`. Hook `useAssetsAccess`.
- Terms text lives in BOTH `src/lib/assets/handover.ts` (`ASSET_HANDOVER_TERMS_BODY`) and the migration `$terms$...$terms$` block; `handover.test.ts` fails if they drift.

## 8. Decisions made & why

- No new action key for the own-records boundary (keep `permissions:check` green); `activity log` stays inventory-only (not widened to current holder - a timeline names past custodians).
- `returned` is an event, not a master status.
- Soft-link `asset_activity_log.asset_id` (SET NULL + snapshots) so approved removals work.
- Permanent delete uses a transaction-local GUC to relax triggers (not RLS or FKs): forging the GUC is not a way in since child tables have no DELETE policy for any role.
- Catalogue: do not guess products from inconsistent brand/model text.
- Handover acceptance snapshots the terms in the DB (not client-supplied).
- Split future asset work into small reviewable pushes (owner feedback after a 49-file, 6-migration change).
- Owner gate (2026-08-01): signed-in browser acceptance pass (`docs/testing/assets-signed-in-acceptance-pass.md`, 12 checks) before more features.

## 9. Known traps, gotchas, unfixed defects

- `notification_type` is a Postgres ENUM: add the value by migration and apply BEFORE the code ships, else the category feed filter returns 500 and the UI shows "No notifications yet" (silent outage).
- `entity_id` is uuid: `''` fails the whole INSERT (22P02) for every recipient; `normalizeNotificationEntityId` in `assetNotifications.ts` is the single chokepoint.
- `.boe-badge-urgent` was once referenced by 4 modules but never defined; now defined beside `.boe-badge-blocked`.
- Print overlay (`boe-handover-print-root`) must be portalled to `document.body`; the print selector `body > *:not(.boe-handover-print-root){display:none}` and the portal are ONE mechanism. Otherwise the printout is blank.
- `db push` on this repo: remote history gap risk (`--include-all` would deploy unrelated migrations); `supabase/config.toml` `[db.migrations] enabled = false` silently no-ops `db push`; 20260810 was applied via wrapped scratchpad copy + `db query --linked -f` + `migration repair --status applied`. `db query --linked` drops RAISE NOTICE and returns only the last result set: end assertion scripts with `select '...PASSED'` and run a negative control that inverts an assertion REACHED on the happy path.
- `pg_get_function_identity_arguments()` returns argument NAMES here; use `pg_catalog.oidvectortypes(p.proargtypes)`.
- Catalogue migration number was renumbered twice (collisions); migration must be applied BEFORE the frontend (new frontend selects `assets.product_id` and gets 400s otherwise). Rollback script refuses once any asset names a product.
- Seven-plus test files hard-code a migration ledger tail; adding any migration breaks them (customerReviews/migration, notifications/groupMutations, notifications/activityLinkMigration, tasks/healthCheckMigrationAudit, tasks/assignmentWriteAuthority, orders/orderFinanceTestReset, finance/participantAndOrderTotalSecurity x2, ...).
- An RLS probe needs `SET LOCAL ROLE authenticated` plus faked `request.jwt.claims`; claims alone do not apply RLS; the boundary suite needs FOUR distinct real user UUIDs.
- Local DB suite: repo migration history cannot build a blank DB (`docs/migrations-are-not-self-contained.md`); use the runner + `bootstrap/001_assets_access_baseline.sql` + 20 real prerequisite migrations + `_assets_access_module_entry_gate.sql`; 20260905000000 cannot run on a scoped DB (asserts 27 gates). Seed QA users via GoTrue admin API, not hand-inserted `auth.users`.
- `node_modules` junction trap: esbuild cannot resolve through a junction into a worktree; run `npm ci`; remove junction via PowerShell `(Get-Item p -Force).Delete()`, never `rm -rf`.
- Lint note from memory (2026-08): two pre-existing `react-hooks/set-state-in-effect` failures outside assets.
- Unfixed: `secret_value` plaintext; request-submitted notifications skip `manage`-only reviewers; no recurring maintenance automation.

## 10. Tests that guard it

Run `npx tsx --test src/lib/assets/*.test.ts src/lib/permissions/assetsAccess.test.ts src/lib/permissions/manageAccessRecords.test.ts src/lib/permissions/manageAssetCatalogue.test.ts`.
- `src/lib/assets/`: actionVisibility, activity, assetFilters, assetNotifications, catalogue, changeRequests, detail, detailView, documents, errors, handover (terms drift vs migration), lifecycle (status vocabulary vs CHECK), overview, service, transfers, viewRouting, warranty. Permissions: assetsAccess, manageAccessRecords, manageAssetCatalogue, levels.
- SQL (disposable DB only): `supabase/tests/assets_access_boundary_assertions.sql`, `asset_permanent_delete_assertions.sql`, `asset_access_delegation_and_handover_assertions.sql` via `run_assets_access_delegation_and_handover_local.sh`, `asset_catalogue_assertions.sql`, `run_asset_catalogue_race_local.sh` (`BOE_RACE_NEGATIVE_CONTROL=1` for negative control; disposable stack `boe-asset-cat` ports 52320-52329 is gone, from memory), `_assets_access_module_entry_gate.sql`.
- Manual: `docs/testing/assets-lifecycle-manual-tests.md`, `assets-signed-in-acceptance-pass.md`.

## 11. Open items / next planned work

- Encrypt `access_records.secret_value` (unblocks manager access to the Access Register).
- Confirm post-release checks and the catalogue permission grant (and who holds `manage_access_records`).
- Signed-in acceptance of notification dispatches fired through real UI (never exercised on production records, from memory).
- Scheduler for warranty reminders (none exists).
- Verify apply state of 20261028/20261029 on prod.

## 12. Recheck before changing this module

- Read: `src/lib/permissions/assetsAccess.ts`, `viewRouting.ts`, `20260810000000_assets_access_own_records_boundary.sql`, `20260722000000_assets_custody_integrity.sql`, `20261029000000_asset_handover_acknowledgement.sql`, `20270220000000_asset_catalogue.sql`, `docs/Module Docs/ASSET_CATALOGUE.md`.
- Query: `supabase migration list --linked`; `asset-catalogue-post-release-checks.sql` baseline; `select pronargdefaults from pg_proc where proname='accept_employee_asset'` must be 0 for both overloads.
- Run: asset lib tests above, `permissions:check` (`npm run permissions:check`), the boundary SQL assertions, and the ledger-pin tests if adding a migration.
- Never: add a DEFAULT to an `accept_employee_asset` overload, edit the terms in only one place, add a notification type without applying the enum migration first, treat `delete` as authorizing purge.
