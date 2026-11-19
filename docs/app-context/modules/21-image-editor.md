# 21. Image Editor (Studio Image prototype)

Verified against checkout `852e0493`. Module key `image_editor`, route `/image-editor`. Long-form design record: `docs/Module Docs/IMAGE_EDITOR_PROTOTYPE.md` (787 lines; accurate against the code sampled here). `assets/image-editor/README.md` explains the reference file.

## 1. Purpose & users

- One page, one job: an employee uploads one to five factory-background furniture photographs and gets back catalogue-style studio images (square 1440x1440 PNG), downloadable as PNG, JPG or WebP.
- Pipeline: Bria Product Shot (studio look from the ORIGINAL photograph + an approved reference image) -> local reframe -> SeedVR2 upscale -> local preservation gate -> normalise to exactly 1440 x 1440.
- Users: holders of `image_editor.view` (open module, see Recent results) and `image_editor.create` (display "Use": press Generate; each press = two paid provider requests). Admin by role default. Results are private to their creator; administrators cannot see others' results.

## 2. Status at commit 852e0493

- SHIPPED as a "prototype", visually accepted for an application trial on a live Irvine chair run (doc). Registered module (`20261020000000`) and result history (`20261022000000`).
- Daily cleanup cron is configured in `vercel.json` (`/api/image-editor/cleanup` at `0 3 * * *`, i.e. 03:00 UTC). Whether `CRON_SECRET` and `FAL_KEY` are set in Vercel production, and whether the reference PNG is uploaded to the private `image-editor` bucket, is not verifiable from the repo (unverified).
- `vercel.json` also pins `regions: ["hnd1"]` (Tokyo, near Supabase).

## 3. Pages and API routes

- Page: `/image-editor` (`page.tsx` + `QueueList.tsx`, `ResultCard.tsx`, `HistoryPanel.tsx`), layout `ModuleGuard` (module entry) and shell `src/components/layout/ImageEditorLayout.tsx`.
- API (`src/app/api/image-editor/`):

| Route | Verb | Purpose |
|---|---|---|
| `studio` | POST | auth, per-user rate limit 6/min (`RATE_LIMIT_MAX = 6`, in-memory), validation, then the two provider calls with reframe and gate between; `runtime nodejs`, `maxDuration 60`; saves the master to history; returns the image and verdict header |
| `convert` | POST | re-encode a finished image for download (sharp); never calls fal, holds no provider key |
| `results` | GET | list own results, newest `HISTORY_PAGE_SIZE = 50`, filter `kept OR expires_at > now()`; one-hour signed URLs after ownership check |
| `results/[id]` | PATCH / DELETE | Keep/Unkeep (`kept` boolean) / owner delete (object first, then row); other person's id answers 404 not 403 |
| `cleanup` | GET | nightly sweep; Vercel Cron sends `Authorization: Bearer $CRON_SECRET`; `runtime nodejs`, `dynamic force-dynamic`, `maxDuration 60` |

`next.config.ts` `outputFileTracingIncludes`: `/api/image-editor/studio` ships `./assets/image-editor/**` (and sharp libvips); `/api/image-editor/convert` ships `@img/sharp-libvips-linux-x64`.

## 4. Database

- Table `public.image_editor_results` (`20261022000000`): `user_id` FK `users(id)` ON DELETE RESTRICT (NOT cascade, see traps), object key `<user_id>/<result_id>.png` (first segment load-bearing: storage policies parse it), source file NAME (photo itself never stored), verification verdict carried unchanged, `kept boolean`, `created_at`, `expires_at` default `now() + interval '7 days'` (set by the DB, never by the app). Indexes `image_editor_results_user_created_idx`, `image_editor_results_due_idx`.
- Policies: `image_editor_results_select_own` (owner AND `kept OR expires_at > now()`), `insert_own`, `update_own`, `delete_own` (owner only, no admin branch), RESTRICTIVE `image_editor_results_module_entry_gate` (`module_entry_open('image_editor')`, first use of that gate for this module). Storage policies on `storage.objects`: `image_editor_results_storage_select/insert/delete` (no UPDATE: a master is written once).
- Bucket `image-editor-results`: private, PNG only, 15 MB limit (`HISTORY_BUCKET`). A second private bucket `image-editor` (name overridable by env `IMAGE_EDITOR_REFERENCE_BUCKET`) holds `studio-reference.png`, created by hand per environment (no migration).
- Registration `20261020000000_register_image_editor_module.sql`: rows in `app_modules` and `permission_modules`, actions `view` and `create`, admin role defaults; the employee-permission route renames `create` to "Use" for this module only (the label map lives in the Control Center employee route; `permission_actions.display_name` is global).
- Migration list: `20261020000000_register_image_editor_module`, `20261022000000_image_editor_result_history`. Apply state: both on main and live (feature in use); exact apply confirmations not recorded in memory (unverified).
- Env vars: `FAL_KEY` (required for generation; server only, never `NEXT_PUBLIC_`), `CRON_SECRET` (required for cleanup; unset => cleanup answers 503 and deletes nothing), optional `IMAGE_EDITOR_REFERENCE_BUCKET`, optional `FAL_BILLING_KEY` (a SEPARATE fal key with the BILLING read-only preset; only the Picture credits page uses it, to show what is left in fal; unset => "Not connected").

## 5. Permissions & access

- `image_editor.view` = module entry, listing, Keep/Unkeep, delete of own results, downloads (re-encode). `image_editor.create` = Generate only. Both denied by system default, true for admin role.
- "Use without View is dormant": `deriveImageEditorCapabilities` (`src/lib/permissions/imageEditor.ts`) reports `canGenerate` only when BOTH are allowed; the studio route checks the same pair server-side.
- Reading/keeping/deleting need only `view`, so a person whose Use was withdrawn can still reach and delete their own work.
- API routes use the SERVICE ROLE; the `.eq('user_id', ...)` on each statement IS the authorization (RLS only protects the table and bucket from other callers).
- Cleanup endpoint is authorized by shared secret (`timingSafeEqual`), not a user.

## 6. Business rules

- Upload limits: JPG/PNG/WebP, `MAX_SOURCE_IMAGE_BYTES = 10 MB`, one to five per queue; provider ceiling 12 MB (`PROVIDER_MAX_IMAGE_BYTES`); image up to 8192 px (`prepareSource`).
- Queue: five max; nothing sent on selection; one request at a time in order; one failure never costs a success; retry is manual; double-press guard is a ref; six rapid presses on a two-image queue = exactly two requests.
- Cost: one Generate = TWO billable requests per photograph, never more; NO retry in the adapter, even on timeout (a request that may have been billed must not be billed silently again); `@fal-ai/client` deliberately NOT a dependency (its `run()` retries up to 3 times on 429/502/503/504); transport is plain `fetch` to `https://fal.run/<model id>` with `Authorization: Key <key>`. Everything refusable is refused before the paying call (missing reference, missing key, over-12MB image); a CONFIRMED stage-one preservation failure stops before the upscale (one request, not two).
- Models: `fal-ai/bria/product-shot` (original photograph as `image_url`, approved reference as `ref_image_url`, no `scene_description`, `placement_type manual_placement`, `manual_placement_selection bottom_center`, `shot_size [1000,1000]`, `num_results 1`, `fast true`, `optimize_description false`) and `fal-ai/seedvr/upscale/image` (`noise_scale 0`, PNG, `upscale_factor 1.44`). Timeouts: provider 45 s (`PROVIDER_TIMEOUT_MS`), hosted-result download 8 s (`RESULT_FETCH_TIMEOUT_MS`); result hosts allowed: fal.media, fal.ai, fal.run; result sanity cap 32 MB.
- Reframe: product placed at ~53% of frame height (band 52-55%); final exactly 1440 x 1440 (`normaliseSquare`: exact 1440 delivered; other square => Lanczos resize; not square => refused).
- Preservation gate (`preservationGate.ts`, local measuring only): aspect ratio tolerance 12%; structure overall floor 55% of original density; under-seat structure band 0.42-0.95 of product height; extremities (touching edge); framing band. Thresholds deliberately loose; when product location is not decidable (cluttered background measure up to 83% area) the verdict is "could not verify", not failure. Outcomes: passed / not verified / confirmed failure (422 `noRetry`).
- History: private to owner, 7 days (`RETENTION_DAYS`) from generation, Keep holds indefinitely, Unkeep restores the ORIGINAL window (so unkeeping a past-window result makes it due at once and the page warns), Delete is real (object + row), expired = unreadable at DB level (both SELECT policies), uploaded photograph never stored.
- Sweep: oldest first, batch `CLEANUP_BATCH_LIMIT = 500`, sequential, object-first then row; failure leaves the row due for tomorrow.
- Member deletion: `POST /api/permanently-delete-user` empties this history FIRST (list rows, delete object then row; then remove any leftovers under the `<user_id>/` prefix) and aborts the whole deletion if it cannot; FK is RESTRICT for that reason.
- Download formats via `downloadFormats.ts`/`imageFormats.ts`: PNG, JPG, WebP (re-encoded by sharp in `convert`).
- Errors shown (no provider text ever reaches browser or logs): not configured (200 `configured:false`), key refused 503, out of credit 503, bad image 422, moderation 422, rate limited 429, timeout 504, empty result 422, not preserved 422, wrong-shape upscale 422, else 502.

## 7. Key components & lib files

`src/lib/imageEditor/`: validation.ts, prepareSource.ts (sharp, server only), falRequest.ts (transport + failure classification), briaProductShot.ts, seedvrUpscale.ts, studioReference.ts (local file then private bucket; cached per root), generatedProduct.ts (edge-energy product finding, reframe plan), preservationGate.ts, verification.ts (wire format of verdict, client-safe), studioMaster.ts, queue.ts, downloadFormats.ts, imageFormats.ts, shadowLift.ts, retention.ts, history.ts (+ historyServer.ts `serviceClient`). Permissions `src/lib/permissions/imageEditor.ts`. `scripts/image-editor-smoke.mjs` (one real, CHARGEABLE run from the command line). Reference asset `assets/image-editor/studio-reference.png` (gitignored; README tracked).

## 8. Decisions made & why

- Bria on the ORIGINAL photograph, not a prepared cut-out: the cut-out version turned thin spindles into an opaque mass (six paid experiments in the doc); pixel identity is not available, so a gate substitutes.
- No retry, no SDK: avoid silent double billing.
- Expiry enforced on READ (privacy does not depend on the cron); cron only reclaims bytes.
- Reference image in a private Supabase bucket (a git clone deployment has no gitignored file); no new Vercel env var needed.
- Plain `GET` for cleanup because Vercel Cron only uses GET.
- Object-first-then-row everywhere (a row is the only record of where an object lives).
- Module-scoped label "Use" for the shared `create` action.

## 9. Known traps, gotchas, unfixed defects

- CRON_SECRET must be set in Vercel (not only `.env.local`) or expired files are hidden but never reclaimed.
- The reference PNG must exist in the private `image-editor` bucket in each environment, or every generation fails "reference not installed" (before any billable call).
- Direct-client trap: SELECT policy applies to any statement that reads the row, so unkeeping an expired kept result with a user token is refused; the app does it with service role (and "unkeeping an expired result deletes it").
- Rate limiter is in-memory per instance (6/min), not global.
- A gate result of "inconclusive" is not a failure; do not tighten thresholds without re-running the Irvine acceptance.
- `sharp`/libvips must be traced into the functions (`outputFileTracingIncludes`); changing function names in next.config breaks tracing.
- Pre-existing note from the module doc: a single accepted live run does not prove the mechanism; automated comparison has a blind spot (doc section "The measurement's blind spot").
- Provider text is never logged; do not add logging of data URIs, keys or images.
- Deletion order matters; `ON DELETE CASCADE` on `user_id` would strand bucket objects.
- Edge cost risk: SeedVR upscale timing (45 s provider timeout + 8 s download inside a 60 s function) leaves little slack; raising either needs a longer `maxDuration` plan.

## 10. Tests that guard it

- `src/lib/imageEditor/*.test.ts`: briaProductShot, falRequest, generatedProduct, history, imageFormats, prepareSource, preservationGate, queue, retention, seedvrUpscale, shadowLift, studioMaster, studioReference, validation, verification (one test asserts a single call site per stage and neither inside a loop). `src/lib/permissions/imageEditor.test.ts`.
- SQL: `supabase/tests/run_image_editor_result_history_suite.sh <psql-host> [port]` builds a disposable `boe_image_editor_history` DB from `_image_editor_result_history_shaped_schema.sql`, applies the migration verbatim and probes policies (owner/other/expired/kept/module-entry/RESTRICT); never talks to a linked project. `image_editor_result_history_assertions.sql`.
- Run: `npx tsx --test src/lib/imageEditor/*.test.ts`. Do not run `scripts/image-editor-smoke.mjs` unless you intend to be charged.

## 11. Open items / next planned work

- Confirm production env (FAL_KEY, CRON_SECRET, reference bucket) and that the cron actually runs (Vercel Cron logs).
- Possible wide-rollout questions: granting `create` per employee. Cost monitoring is now the Picture credits wallet (section 13).
- Picture credits, later (owner, 18 Nov 2026): an alert at 80% of the team pool; Star Seller credits automatic from the Scoreboard (`scoreboard_star_seller`; the Scoreboard is paused for the team); reuse of an already-cleaned picture for the same product; a one-tap "ask a founder for credits".

## 12. Recheck before changing this module

- Read: `docs/Module Docs/IMAGE_EDITOR_PROTOTYPE.md` (Authorization, Recent results, Configuration), `src/app/api/image-editor/studio/route.ts`, `cleanup/route.ts`, `20261022000000_image_editor_result_history.sql`, `vercel.json`, `next.config.ts` tracing block, `src/lib/imageEditor/falRequest.ts`.
- Query: `select count(*) filter (where kept), count(*) filter (where expires_at < now() and not kept) from image_editor_results` (should be ~0 overdue-unkept after the nightly run); bucket objects vs rows reconciliation.
- Run: imageEditor tests, the history SQL suite on a disposable DB; Vercel Cron manual invoke with the secret only on a preview.

- **One read of your own row (2026-11-12, #711 merged as `72c57977`, no SQL).** `/image-editor` reads the profile through `profileQueryOptions`. The cached copy is the one the module shell already loaded through `usePermissionContext`. Before this, each screen read the signed-in person's `users` row again, mostly with `USER_PROFILE_COLUMNS`. No screen used a field outside the 8 shared columns.

## 13. Picture credits: the wallet and the tracking page (PR #932 merged as `c7f03dcd` 18 Nov 2026, migration `20270808000000` APPLIED 18 Nov 2026; limits OFF)

**What it is.** Every paid picture press takes credits from a wallet BEFORE the paid fal call: Studio Image (1 credit), Edit PI Customize image, the quotation image studio's Clean up and Change it (2 credits each). 1 credit is about Rs 4 (costs in `src/lib/imageCredits/costs.ts`). It also records every press for the founders' tracking page.

**Measure first.** The migration ships with `enforce = false`: every press is recorded and NOBODY is refused except by the pause switch, so nobody loses access on the day it ships. The owner turns limits on after reading real numbers. With limits on, a press is refused (`PAUSED`, `NO_ALLOWANCE`, `USER_MONTH`, `USER_DAY`, `POOL`) when the person has no allowance, has used their monthly credits or the daily cap, or the team pool for the month is used up. Month and day are India time. Unused credits do not carry over.

**Tables** (RLS on, no policies, browser roles revoked; service role only): `image_credit_settings` (one row: `enabled`, `enforce`, `monthly_pool` 1500, `daily_cap` 60, `inr_per_usd` 88), `image_credit_allowances` (`user_id`, `monthly_credits`), `image_credit_ledger` (`user_id` nullable `on delete set null`, `tool`, `credits`, `usd_estimate`, `status` charged/refunded). **Functions** (SECURITY DEFINER, `search_path = public, pg_temp`, service role only): `image_credit_spend` (locks the settings row so two presses cannot both pass a limit), `image_credit_refund`, `image_credit_status`, `image_credit_report`.

**Code.** `src/lib/imageCredits/` (`costs`, `spend` with `NOT_BILLED`, `falBalance`, `report`, `note`, `caller`), `src/components/imageCredits/CreditNote.tsx` (the line beside the buttons; shows nothing while limits are off; credits only, never rupees or model names), routes `GET /api/image-credits/me` (any signed-in person), `GET /api/image-credits/report`, `POST /api/image-credits/settings`, `POST /api/image-credits/allowance` (administrators only, `creditCaller(req, true)`), page `/image-editor/usage` ("Picture credits", administrators only, in the module's own nav; its per-person table shows credits a month, used this month and left this month, `creditsLeft` in `report.ts`). The three paid routes call `spendCredits` once, after every free refusal and immediately before the paying call, and `spend.refundIfNotBilled(reason)` on failure.

**Rules.** The check fails CLOSED: if the wallet cannot be read, the press is refused (`UNAVAILABLE`). Credits are returned only for `NOT_BILLED` reasons (fal refused before running: not configured, bad key, no fal credit, unsupported image, moderation, busy); a timeout, a 5xx or an empty answer stays charged, the same "may already have been billed" rule as the no-retry rule. shortcut: assumes fal does not bill those refusals; trim the list if fal's own usage disagrees. `usd_estimate` is the price in `costs.ts` when the press was made; update it when the model changes, or the page drifts from fal's bill. "Pictures" on the page are charged presses; a retry or "Change this result" is another press. The fal balance is read from `GET https://api.fal.ai/v1/account/billing?expand=credits` (`credits.current_balance`, USD) with `FAL_BILLING_KEY`.

**Doors not covered.** The Anthropic "Understand" step in Customize image (billed by Anthropic, not fal) and `scripts/image-editor-smoke.mjs`. The per-minute limiter in each route stays: it is a burst guard, in memory per instance, not a spend cap.

**Rollout.** (1) Owner applied the migration with `supabase db query --linked --file` then `supabase migration repair --status applied 20270808000000 --linked`, NOT `db push` (nine older local-only migrations would have needed `--include-all`). The first version, `20270807000000`, collided with `quotation_payment_and_desk` already applied on the live database, so `migration list` showed it as applied while the tables did not exist: pick a version after reading the REMOTE history, and prove "applied" with a `to_regclass` probe. Nothing uses it until step 2. (2) Merge and deploy. (3) Create a fal BILLING-preset key and set `FAL_BILLING_KEY` in Vercel if the balance is wanted. (4) Watch the page for about two weeks. (5) Set allowances for the people who get credits (founders; the Star Seller; optionally a small baseline for everyone), then tick "Limits" (the page says whether they are ON or OFF; the box stays locked until someone has credits, since limits with an empty list would block everyone). Rollback: revert the PR; the tables are then unused (drop them in a later migration if wanted).

**Traps.** Turning limits on with no allowances blocks everyone: add allowances first. Sales staff without an allowance see "not switched on for your account". The day and month follow India time (the SQL uses `Asia/Kolkata`). Deleting a user keeps their ledger rows (shown as "Former member").

**Tests.** `supabase/tests/picture_wallet_pglite.mjs` (13 checks on the real migration: measure mode, pause, no allowance, monthly, daily, pool, refund, India month boundary, status, report, closed tables, bad cost, rerun), `src/lib/imageCredits/imageCredits.test.ts` (16: costs, the wallet's answers, refusal list, balance reader, the note, every paid route takes credits first), `src/app/api/image-editor/studio/routeBehaviour.test.ts` (the wallet in the real Studio route), the migration lists in `participantAndOrderTotalSecurity.test.ts`. Run the SQL suite: `node supabase/tests/picture_wallet_pglite.mjs <dir with @electric-sql/pglite installed>`.
