# 14. Review Workflow (Customer Reviews)

Verified against checkout `852e0493` (origin/main, 2026-10-18). Facts marked "(unverified, from memory)" could not be confirmed from code or migrations on this checkout.

Identifiers vs names: route `/customer-reviews`, API `/api/customer-reviews`, module key `customer_review_requests`, tables `customer_review_*`. The UI name is "Review Workflow". The identifiers must never be renamed: every Control Center grant is written against the module key and a rename silently revokes them all.

## 1. Purpose & users

- Employees (candidates) arrange genuine customer reviews of BOE (written or with photos), submit a screenshot proof, and a reviewer approves/rejects. Approved reviews earn BOE Credits (see module BOE Credits, `docs/Module Docs/BOE_CREDITS.md`).
- Roles:
  - Candidate = holder of `customer_review_requests.use`: submits/edits/deletes/reapplies their own custom reviews.
  - Reviewer = holder of `customer_review_requests.verify`: sees all submissions, approves/rejects (never their own), gets notifications, sees Reports, History, pending badge.
  - Admin (`users.role = 'admin'`, active, not deleted): reject-after-approval, admin delete of a custom review, permanent purge of internal test cards, and (via `can_manage_boe_credits()`) may change the awarded amount on approval.
  - Every signed-in employee: reads the current-month leaderboard (`customer_review_leaderboard`), no Review permission needed.

## 2. Status at commit 852e0493

- SHIPPED and active: the "Custom Reviews only" phase. Candidate submits Custom Review (Text or Image) with proof; reviewer queue; reapply; monthly rules (cap 10, min 3 approved, min 3 image); employee edit/delete; duplicate detection; reports; leaderboard landing; admin reject-after-approval and admin delete.
- SHIPPED but PAUSED (kept intact, not deleted): the generated-review workflow (AI drafts, batches of 6-20, assignment, image groups, booking, WhatsApp/native share, confirm sent, verify). `CANDIDATE_GENERATED_REVIEWS_ENABLED = false` in `src/lib/customerReviews/generatedWorkflow.ts`, and SQL `customer_review_generated_booking_enabled()` returns false (migration `20261206000000`). Re-enabling = flip the constant AND re-create the function in a new migration; `customReviewPhase.test.ts` pins the pair.
- The generated-review FRONTEND is retired for every role (PR #270, `5738e9a5`): pages `/customer-reviews/batches`, `/images`, `/progress`, `/mine`, `/reviews`, `/[id]` are server components that only `redirect('/customer-reviews')`. The screen components (`BatchesScreen.tsx`, `ImagesScreen.tsx`, `ProgressScreen.tsx`, `MyReviewsScreen.tsx`, `TestCardListScreen.tsx`, `[id]/TestCardDetailScreen.tsx`) and API routes remain in the tree.
- Apply state of migrations (production): migrations up to `20261209000000` applied (from memory index: 20261205/06/07 applied 2026-09-13, 20261209 applied before merge of #158). `20270223/24/25000000` APPLIED in prod as of 2026-10-03 (memory `pr-269-reviews-v2-state`, "stale" note in that file overrides the older "unapplied"). `20270304000000` (admin reject/delete, PR #291): apply state NOT recorded in memory (unverified). The module doc `docs/Module Docs/CUSTOMER_REVIEW_OUTREACH.md` still says 20270223/24/25/0304 are "NOT applied": that doc text is STALE for at least the first three. Always run `supabase migration list --linked` (needs non-empty `remote` column).
- Dashboard leader card was added by #269 and REMOVED by #274 (`623191aa`); `ReviewLeaderCard.tsx` file still exists in `src/components/customerReviews/` but the doc §25 line about a dashboard card is stale.
- Internal test-card purge shipped (#158) but production had 0 live cards at the time (all tombstones), so the purge UI was never seen on a real eligible record (from memory).
- Production data history (from memory): module launched 2026-09-01 (#78, empty); legacy 16 cards hard-deleted by `20261025000000`; as of 2026-09-13 all 70 cards were verifier-tombstones. Authenticated UI verification of the generated flow was never performed.

## 3. Pages and API routes

Pages (`src/app/customer-reviews/`):

| Route | What | Who |
|---|---|---|
| `/customer-reviews` | Landing: current-month leaderboard (`leaderboardLanding.ts`), Submit review button, custom-review workspace (`CustomReviewsScreen` -> `CustomReviewSubmissions`) | everyone with module entry |
| `/customer-reviews/custom` | Custom Submissions queue (`CustomSubmissionsScreen`, `CustomSubmissionList`); reads `?submission=<id>` (notification deep link; needs Suspense) | verify; others bounced to root |
| `/customer-reviews/history` | read-only list of retired generated reviews (`HistoryScreen`) | verify |
| `/customer-reviews/reports` | admin dashboard (`ReportsScreen`, `ReviewCharts`) | verify |
| `/customer-reviews/notifications` | shared `NotificationsView` filtered to `customer_review_*` types | verify (sidebar) |
| `/my-credits/leaderboard` | `ReviewLeaderboardScreen` | all signed-in |
| batches, images, progress, mine, reviews, `[id]` | REDIRECT to `/customer-reviews` | n/a |

Module entry guard: `src/app/customer-reviews/layout.tsx` (client). Reads only `users.is_active`, then `hasPermission(use) || hasPermission(verify)`; both catches deny. No admin role short-circuit (an admin with both permissions revoked is shut out). The old "purge page for admin without verify" exception is gone with `/[id]`.

Sidebar (`src/components/layout/CustomerReviewsLayout.tsx` `NAV_ITEMS`): My Reviews (everyone, exact); verifier-only: Custom Submissions (with pending count badge `count: 'custom-pending'`), History, Reports, Notifications.

API routes (`src/app/api/customer-reviews/`):

| Route | Methods | Purpose |
|---|---|---|
| `custom-submissions` | POST, PATCH, PUT, DELETE | register (POST), reapply (PATCH), edit (PUT), employee delete (DELETE). Service-role RPCs, actor = session user |
| `generate`, `revise`, `draft` (PATCH), `images`, `image-groups`, `photos`, `whatsapp` | various | generated-review workflow (paused for candidates; verify or card holder) |
| `test-cards/purge` | POST | admin permanent purge of internal test card (nodejs runtime) |

`uploadRoute.test.ts` pins the number of routes in this folder (was 6 -> 7 -> 8 -> 9 over time; recheck current count before adding a route).

## 4. Database

Tables (all RLS on, no client writes to cards/submissions):

| Table | Notes | Migration |
|---|---|---|
| `customer_review_test_cards` | the generated reviews ("cards"); `review_type` text/image (default `text`), `assigned_to/at/by`, `image_group_id`, soft-delete `deleted_at` (+`deleted_source`), status machine | `20261017000000`, `20261023`, `20261107` |
| `customer_review_test_card_events` | append-only trail | `20261017000000` |
| `customer_review_test_card_screenshots` | submitted screenshot rows | `20261017000000` |
| `customer_review_draft_batches`, `customer_review_draft_batch_revisions`, `customer_review_generation_claims` | AI draft batches / revisions / paid-call claim | `20261023`, `20261026`, `20261027` |
| `customer_review_image_groups`, `customer_review_group_images` | project photo library for image reviews | `20261107000000` |
| `customer_review_custom_submissions` | custom review rows (live phase) | `20261205000000` |
| `customer_review_custom_submission_events` | append-only history, written by trail trigger | `20261206000000` (rows backfilled) |
| `customer_review_custom_duplicate_checks`, `customer_review_custom_duplicate_flags` | duplicate detection | `20270224000000` |
| `boe_credit_settings` (shared) | + `image_review_reward_credits` (20261107), `max_monthly_review_submissions`, `minimum_monthly_image_reviews` (20261206) | |
| `boe_credit_review_rewards`, `boe_credit_review_months` (shared) | month qualification | BOE Credits 1D |

Key functions: `create_/reapply_/edit_/delete_customer_review_custom_submission` (service role only); `approve_customer_review_custom_submission(uuid, numeric)` and `reject_...(uuid, text)` (authenticated, verify permission, never self); `admin_reject_customer_review_custom_submission(uuid,text)` and `admin_delete_...(uuid)` (authenticated, in-function admin-role check, `20270304000000`); `post_boe_credit_custom_review_reward`, `reverse_customer_review_custom_reward`, `check_customer_review_custom_month_rules`, `customer_review_custom_month_usage`, `customer_review_custom_reviewer_ids`; trail trigger `customer_review_custom_submissions_trail()`, guard trigger `customer_review_custom_submissions_guard`; booking pause `customer_review_generated_booking_enabled()` + trigger `customer_review_generated_booking_paused`; purge `begin_/finish_customer_review_test_card_purge`, `can_purge_customer_review_test_cards()`, `customer_review_test_card_purge_authorized()`, `customer_review_test_card_purge_record()`; reporting `customer_review_report()`, `customer_review_report_list()`, `customer_review_leaderboard()`, `customer_review_credits_per_point()` (20270225); generated flow `create_customer_review_draft_batch` (8-arg, 6-20 cards; 5-arg `security invoker` SQL wrapper delegates with 12), `assign_customer_review_batch`, `pick_customer_review_image_groups`, `book_/unbook_customer_review_test_card`, `transition_customer_review_test_card`, `customer_review_assignable_employees()`, `can_view_customer_review_test_card()`, `customer_review_replace_available()`.

Notification types added: `customer_review_submitted`, `customer_review_reapplied` (enum `notification_type`, 20261206). Written by the DB trail trigger to active `verify` holders except the submitter; category `review`; in-app only (`is_push_sent = true`).

Storage buckets (all private): `customer-review-test-screenshots` (path segment 1 = card id), `customer-review-project-images` (image-group images; separate because the screenshots bucket's policy reads segment 1 as a card id), `customer-review-custom-proofs` (segment 1 = submission id).

Migration chain: `20261017000000_customer_review_outreach`, `20261021000000_seed_customer_review_test_cards`, `20261023000000_review_workflow_ai_drafts`, `20261025000000_..._remove_legacy_test_data`, `20261026000000_..._batch_approval`, `20261027000000_..._generation_claims`, `20261030000000_..._deletion_and_replacement`, `20261031000000_..._twelve_drafts_editing_and_images`, `20261102000000_boe_credits_review_reward`, `20261107000000_review_types_assignment_and_image_groups` (~2100 lines, 17 functions), `20261108000000_..._variable_batch_size`, `20261114000000_review_generation_word_range_and_body_length`, `20261123000000_review_native_share_records_the_open`, `20261205000000_..._custom_submissions`, `20261206000000_..._custom_reapply_and_monthly_rules`, `20261207000000_..._reapplied_event_attempt_number`, `20261209000000_..._test_card_admin_purge`, `20270223000000_..._custom_edit_delete`, `20270224000000_..._custom_duplicate_detection`, `20270225000000_..._reporting_and_leaderboard`, `20270304000000_..._admin_reject_and_delete`. Also `20261111000000_permission_module_labels_follow_the_registry` (not review-file-named; fixes `permission_modules` labels for orders and this module).

Immutability: 20261206000000 must never be edited or re-applied; 20261207000000 is its permanent forward repair. Never edit any applied migration.

## 5. Permissions & access

- Module key `customer_review_requests`; actions `use` ("Use Review Workflow") and `verify` ("Verify Reviews & Generate Drafts"). There is no `view` action, so the shared `ModuleGuard` cannot be used; entry is `use` OR `verify` (`src/lib/permissions/customerReviewOutreach.ts`).
- The permission engine is the only authority; no role name is read by submission/reapply/decision/recipient functions. The ONLY role read in the module is the admin check in `customer_review_test_card_purge_authorized()` and `customer_review_custom_is_admin()` (20270304) for admin reject/delete.
- Grants are per employee in Control Center (project rule: grant per employee, no role inheritance).
- Control Center action display names in `permission_actions` rows still read "Use Customer Review Outreach" / "Verify & Close Review Requests" (global per action key, deliberately left).
- Inactive or deleted accounts are refused everywhere.

## 6. Business rules (live Custom Review phase)

- Lifecycle: form (nothing stored) -> `pending_verification` (UI "Pending Approval") -> `approved` (final; exactly one `review_reward`) or `rejected` (reason required) -> reapply by the SAME submitter (PATCH) -> back to `pending_verification` on the SAME row.
- Rates (row inserted by 20261206, admin-managed on `/payroll/credits`, append-only, newest active): 1 credit = Rs 50; Text review = 1 credit (Rs 50); Image review = 1.5 credits (Rs 75); `minimum_monthly_reviews` = 3; `max_monthly_review_submissions` = 10; `minimum_monthly_image_reviews` = 3. CHECK: minimum image <= max. Screens read live settings; no literal numbers in components. Changes apply to future actions only.
- Month = Asia/Kolkata calendar month of the FIRST submission (`submitted_at`, never overwritten). Slot and credit month are the same; reapply takes no new slot.
- Cap: month holds every non-deleted custom review (pending/approved/rejected). 11th refused. Enforced by `check_customer_review_custom_month_rules()` under `pg_advisory_xact_lock(hashtext('customer_review_custom_month'), hashtext(employee))` taken BEFORE the count. The upload route pre-checks.
- Image-mix gate: new TEXT allowed only if `MAX - (submitted+1) >= max(0, MIN_IMAGES - images)`; new IMAGE allowed if `submitted+1 <= MAX`; reapply never checked against MAX, checked against the mix only when turning image -> text. Refusal copy produced by both `customMonthlyRules.ts` and the DB.
- Qualification: while a month has < 3 approved reviews, its review credits are provisional (recorded, not spendable). The approval reaching 3 qualifies the month. No negative penalty; closing a short month runs the existing `review_month_lapse`, removing exactly that month's provisional credits. A lapsed month's review cannot be approved or reapplied (`CUSTOMER_REVIEW_CUSTOM_MONTH_CLOSED`); reject it instead.
- Reapply: submitter only (`CUSTOMER_REVIEW_CUSTOM_NOT_OWNER` otherwise, admins included), only from `rejected`, note <= 500 chars, `reapplication_count` +1, old screenshot kept, rejection who/when/why leave the row but stay in events.
- Approval: verifier confirms configured amount; only `can_manage_boe_credits()` may type another. Nobody decides their own review, administrators included. Already-approved returns without posting.
- Employee edit/delete (20270223): pending edits in place; approved edit -> back to Pending, credit STAYS on ledger with `reward_held`, re-approval posts NOTHING; type locked for approved/held; rejected uses Edit & Reapply; closed-month review cannot be edited. Employee delete = soft delete (frees the slot, reverses an approved/held credit once; lapsed month not reversed twice). One reward and at most one reversal per review for ever; a review whose credit was reversed can never be approved again (`CUSTOMER_REVIEW_CUSTOM_DECIDED`).
- Admin reject-after-approval (20270304): reason <= 300 chars, refuses admin's own review, reverses credit once, recounts the ORIGINAL month via `refresh_boe_credit_review_month`, history keeps the Approved event. Admin delete: soft, any status. Both enforced inside the function (`CUSTOMER_REVIEW_CUSTOM_UNAUTHORIZED`, 42501); guard trigger allows `approved -> rejected` only for a confirmed duplicate or inside that function's own transaction marker.
- Duplicate detection (20270224, `duplicateDetection.ts` `DUPLICATE_THRESHOLDS`): `NAME_MIN_CHARS` 4; `TEXT_MIN_CHARS` 30 / `TEXT_MIN_TOKENS` 6; `TEXT_EXACT_STRONG_CHARS` 60; `TEXT_NEAR_MIN` 0.8; `TEXT_NEAR_STRONG` 0.92; `IMAGE_STRONG_MAX_RATIO` 0.12; `IMAGE_SIMILAR_MAX_RATIO` 0.38; `IMAGE_MIN_MARKED_BITS` 60; 4096-bit difference hash (65x64, lightly blurred); SHA-256 for identical images. Compared against every earlier review of every employee, deleted included. Name-only match = weak. A possible-duplicate never rejects by itself; a CONFIRMED duplicate is binding (rejected/reversed once). Optional form fields: Reviewer name, Review text. Backfill script `scripts/backfill-review-image-hashes.ts` (dry run default, `--apply [--limit=N]`, `--verify`); backfill NOT confirmed as run on prod.
- Reports/leaderboard (20270225): points = credits / 10 (3 decimals; Text = 0.1, Image = 0.15); leaderboard ranked by reward-eligible review count, ties share rank (1,2,2,4); own row always shown; "reward-eligible" = approved, not deleted, posted credit not reversed, not confirmed duplicate. Expired (lapsed month) is NOT rejection. Reports are live, not snapshots. Report/list pages: 25 per page in UI (RPC list limit <= 50); Custom Submissions list pages 100.
- Generated flow numbers (paused): batch size 6-20 (default 12, `MIN_/MAX_/DEFAULT_BATCH_SIZE` in `generationSettings.ts`); original design 8 text + 4 image (`assignReviewTypes` stamps types by position); body DB CHECK `length(test_body) between 20 and 1800` (was 900 until `20261114000000`); app floor `MIN_BODY` 40, `STORAGE_MIN_BODY` 20, `MAX_BODY` 1800, `MIN_WORDS_FLOOR` 10, `MAX_WORDS_CEILING` 200 (memory says 100: STALE, raised in 20261114); `MAX_TITLE` 120. `review_reward_credits` IS the text reward (not renamed); image reward is `image_review_reward_credits`.
- Test-card purge eligibility (20261209): admin only; never-approved `pending_approval` draft; no credit row; no approved/assigned/booked/whatsapp/sent/submitted/verified events; only generated/revised/draft_edited/image_removed/image_group_set events; order = START tombstones (`deleted_source='purge'`), route removes every storage object under `<card>/`, FINISH refuses while objects remain then DELETEs (cascades screenshots/events). No purge log table.

## 7. Key components & lib files

- Libs: `src/lib/customerReviews/` (customSubmissions.ts, customMonthlyRules.ts, generatedWorkflow.ts, duplicateDetection.ts, duplicateCheck.server.ts, imageHash.ts, reviewReport.ts, submissionList.ts, leaderboardLanding.ts, testCardPurge.ts, generationSettings.ts, draftGeneration.ts, reviewTypes.ts, status.ts, sharing.ts, photos.ts, queries.ts, types.ts). Permission helper `src/lib/permissions/customerReviewOutreach.ts`.
- Components: `src/components/customerReviews/` (CustomReviewSubmissions, CustomReviewPerformance, CustomSubmissionPieces, CustomSubmissionList, AdminSubmissionAction, DuplicateReview, ReviewCharts, ReviewLeaderboardScreen, ReviewsLeaderboardPanel, PurgeTestRecord, plus paused generated-flow components GenerateDrafts, PendingBatches, AssignBatch, ImageLibrary, ShareReview, VerifyPanel ...). Hook `src/hooks/queries/useCustomReviewPendingCount.ts` (key `['customer-reviews','custom-submissions','pending-count']`, 30 s stale, verifier only).
- Layout: `src/components/layout/CustomerReviewsLayout.tsx`.

## 8. Decisions made & why

- Keep identifiers `customer_review_requests`/`customer-reviews` despite rename to Review Workflow (grants).
- Pause (not delete) generated workflow; two-part re-enable switch.
- Approved custom review counts under monthly-minimum rule like a verified generated review (owner decision 2026-09-12).
- Soft delete everywhere (`storage.objects` refuses direct DELETE via `storage.protect_objects_delete`; hard-deleting a card would strand its file). No restore: a trigger refuses UPDATE of a tombstoned row.
- Project image groups are authoritative for image reviews (owner decision 2026-09-05); an image review that loads zero files refuses to share.
- Purge eligibility strictly "never approved" (approval is the boundary because Copy message records nothing, so external use is undetectable).
- Approved-then-edited review keeps its credit (ledger allows one reward and one reversal per source; "re-awarding after a reversal is deliberately not possible", 20261101000000).
- Points = credits / 10; no rate invented.
- Sessions with decimal credits: `20261204000000_boe_credits_decimal_credits` converted credit columns to numeric(12,2) (migration belongs to BOE Credits).

## 9. Traps, gotchas, unfixed defects

- A status predicate does not exclude tombstones: any query on `status = 'available'` must add `deleted_at is null` (booking claim needed it).
- Hoisting `deleted_at is null` into `can_view_customer_review_test_card()` once revoked a verifier's access to deleted cards' screenshots; verify-door is deliberately OUTSIDE the deleted guard (`20261030000000`).
- AFTER-trigger off-by-one: NEW already has the increment (`reapplied` attempt recorded as 2); fixed by 20261207. Write behavioural SQL assertions for every derived value a trigger writes.
- Postgres has no `min(uuid)`; use `(array_agg(distinct x))[1]`.
- Two PostgREST overloads differing by a defaulted arg => PGRST203. Old 1-arg approve signatures were DROPPED; 8-arg batch RPC has no defaults.
- Integer PL/pgSQL variables silently round decimals (1.5 -> 2); decimal-credit migration re-created every function affected.
- Guards that pin a live count race against users (20261025 rewrite). Pin sets that cannot drift.
- Employee-side delete leaves `qualifying_review_count` stale until next recount; only the two Admin functions recount (known limitation, doc §28.6).
- Reviews before 20270224 have no reviewer name ("Not recorded").
- Generated flow wording guards: `reviewSharing.test.ts` forbids "sent" in `ShareReview.tsx` except "press send yourself"; `internalTest.test.ts` forbids "internal test" in screen files; `customerReviewOutreach.test.ts` (in permissions) forbids `\breleased\b` on detail screen, even in JSX comments.
- JSX: after `{expr}` a text node starting with an HTML entity loses its leading space on Next 16.2.6; write `{' '}`.
- Navigation target pinned by a literal string passes while the route moves (the `?verified=` incident). Sweep redirects after any route move.
- `supabase db diff --linked` cannot work (history cannot build a blank shadow DB); use `supabase db dump --linked --schema public`.
- `supabase/config.toml` `[db.migrations] enabled = false` silently no-ops `db push --linked`; production migrations are applied by Nishant.
- Windows excludes TCP 57273-57372 and 55945-56044; scratch Supabase on 573xx fails to bind.
- Docs say `Module Docs/CUSTOMER_REVIEW_OUTREACH.md` has duplicate section number 28 and stale "NOT applied" banners.
- `AssignedCounts`, `TypeProgress`, `ReviewTypeSections` in `AssignedReviews.tsx` were unreferenced (dead code) after the UI redesign; the generated-flow components are now all unreachable from navigation.
- Remaining work stated in memory: first real batch needs real BOE project photos (not to be fabricated).

## 10. Tests that guard it

Run: `npx tsx --test src/lib/customerReviews/*.test.ts` (project uses `node:test`; no timeout, so `N cancelled, 0 pass` = a file-level `before()` threw). Never run two suites at once (shared live-DB fixtures). Remove `.env.local` for a baseline-comparable run (live-DB suites change).
- `src/lib/customerReviews/`: customMonthlyRules, customReviewPhase, customSubmissions, customReviewEditDelete, customReviewDuplicates, customReviewAdminActions, duplicateDetection, reviewReport, submissionList, leaderboardLanding, testCardPurge, deletion (95 contract tests), securityContract, migration (pins ledger tail), fixture (pins migration filenames containing `insert into customer_review_test_cards`), uploadRoute (route count), generatedWorkflow pin inside customReviewPhase, batchSize, draftGeneration, reviewTypes, reviewSharing, shareOpened, whatsappRoute, internalTest, adminBypass, preBookingImages, photoRemoval*, variableBatchWorkflow, status, nextStep, etc.
- `src/lib/permissions/customerReviewOutreach.test.ts`; `src/lib/boeCredits/settings.test.ts`, `boeCredits/reviewReward.test.ts`, `boeCredits/migration.test.ts` (pins every migration filename containing "credit").
- SQL suites in `supabase/tests/` (run by shell scripts on a disposable Postgres/local Supabase stack, never against production): `run_custom_review_submissions_local.sh` (+ `custom_review_submissions_assertions.sql`, `custom_review_phase_assertions.sql`), `run_custom_review_edit_delete_local.sh` (+ `custom_review_edit_delete_assertions.sql`, `custom_review_admin_actions_assertions.sql`), `run_custom_review_edit_delete_race.sh`, `run_custom_review_admin_race.sh` (R6-R8), `custom_review_duplicate_assertions.sql`, `custom_review_reporting_assertions.sql`, `run_customer_review_test_card_purge_local.sh`, `run_customer_review_outreach_local.sh` (23 steps incl. 13 legacy-guard shapes), `run_customer_review_draft_batch_race.sh` (5 races), `run_review_workflow_twelve_and_images_local.sh`, `run_boe_credits_review_reward_local.sh`, `customer_review_remote_readiness.sql`. `run_custom_review_submissions_local.sh` breaks under Git Bash with `MSYS_NO_PATHCONV=1` (its `git -C` check).
- Adding ANY migration breaks roughly 10-13 tests that hard-code the migration ledger (see `migration-inventory-suites` memory): reviewReward, participantAndOrderTotalSecurity, activityLinkMigration, groupMutations, orderFinanceTestReset, orderReservedPiGateAndBoeItemCodes, assignmentWriteAuthority, healthCheckMigrationAudit, topTasksApproval, customerReviews/migration; plus `notificationSystemActivity.test.ts` if SQL inserts notifications.

## 11. Open items / next planned work

- Confirm apply state of `20270304000000` (admin reject/delete) and the image-hash backfill (doc: "post-deploy verification ... not done").
- Re-enabling generated reviews would need the two-part switch plus UI reroutes (pages currently redirect); product decision pending (memory said "do not propose more Review Workflow development" for the original rollout).
- Optional: category field for custom reviews (owner decision needed per doc §25.1).
- Candidate remained OPTIONAL at generation (making mandatory is a product decision).
- Authenticated UI check of the purge control on a real eligible record never done.
- Stale doc text to fix: `Module Docs/CUSTOMER_REVIEW_OUTREACH.md` "NOT applied" banners; dashboard leader card statement.

## 12. Recheck before changing this module

- Read: `docs/Module Docs/CUSTOMER_REVIEW_OUTREACH.md` (note staleness), `src/lib/customerReviews/generatedWorkflow.ts`, `customMonthlyRules.ts`, `customSubmissions.ts`, `src/app/customer-reviews/layout.tsx`, `src/components/layout/CustomerReviewsLayout.tsx`, latest of `supabase/migrations/2026120*`, `20270223..20270304*`, `src/app/api/customer-reviews/custom-submissions/route.ts`.
- Query: `supabase migration list --linked` (non-empty `remote` column), then `supabase db dump --linked --schema public` for function bodies; `select * from boe_credit_settings order by created_at desc limit 1`.
- Run: `customReviewPhase.test.ts`, `customMonthlyRules.test.ts`, `migration.test.ts`, `uploadRoute.test.ts`, `boeCredits/*.test.ts`, then the SQL suites above on a disposable stack.
- Do not: edit 20261206/20261207, add a status predicate without `deleted_at is null`, rename the module key, add migrations without updating the ledger-pin tests.
