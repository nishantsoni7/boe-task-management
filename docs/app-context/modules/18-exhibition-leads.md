# 18. Exhibition Leads

Verified against checkout `852e0493`. Small, isolated module built 2026-10-09..13 (PRs #296-#304 area). It touches nothing in tasks, orders, payments, attendance or performance scoring.

## 1. Purpose & users

- Capture visitors at a trade fair, follow them up afterwards, and rank who collected most leads. First (seeded) exhibition: Acetech Bangalore 2026 (9-11 October 2026, Bengaluru).
- Users: salespeople (Sales department has `view` by a department rule): add leads, work leads they currently OWN; Admin (`users.role='admin'`): sees/manages everything, ranking, exhibitions, CSV export, reassign, archive/restore; "View All Leads" holders (`view_all`): read-only sight of everyone's leads (managers outside Sales), excluded from the ranking.

## 2. Status at commit 852e0493

- SHIPPED, all 8 migrations on main: `20270305000000`..`20270312000000`. Apply state: memory only records `20270307000000` as unapplied on 2026-10-09 (stale); the later commits (#300-#304, 2026-10-10..13) were deployed against them, so they are applied in production in practice, but a per-migration confirmation is not recorded (unverify via `supabase migration list --linked`).
- Recent changes in order: #296 redesigned Add Lead (scoreboard tiles Today/Total/Rank, leaderboard, instant-save outbox, warm start); #300 one scanner that reads everything + View All Leads permission; #301 stop forcing `tool_choice` so scanning works again; #302 Residential requirement + featured "Add Exhibition Lead" action; #303 duplicate names the holder; Residential-only coverage; #304 Admin closes an exhibition and the quick link follows.
- The acetech fair dates (9-11 Oct 2026) are in the past at this commit; whether it has been closed in prod is unknown.

## 3. Pages and API routes

Pages (`src/app/exhibition-leads/`; nav in `src/components/layout/ExhibitionLeadsLayout.tsx`):

| Route | Screen | Who |
|---|---|---|
| `/exhibition-leads` | landing / redirect to add | module users |
| `/exhibition-leads/add` | `AddLeadScreen` (scoreboard, `StandingsPanel`, `ScanPanel`, `EntryFeed`, outbox) | anyone with module access; link hidden when every exhibition is closed (`addAllowed`) |
| `/exhibition-leads/my` | `LeadsListScreen` - leads I currently own | module users |
| `/exhibition-leads/all` | all leads, filters (collector/owner/archived) | Admin or `view_all` |
| `/exhibition-leads/ranking` | `RankingScreen` (per-day matrix) | Admin only |
| `/exhibition-leads/exhibitions` | `ExhibitionsScreen` (create/edit/close/reopen) | Admin only |

Layout guard `src/app/exhibition-leads/layout.tsx`: signed-in check with `/login?redirect=<path>` (value followed only after `safeReturnPath()`), then module guard, plus `warmStart` prefetch.

API: `POST /api/exhibition-leads/scan` (`runtime nodejs`, `maxDuration 30`). All other operations are Supabase RPCs from the browser.

Scan route details: authenticates the caller's bearer token; module access checked by a user-scoped `select` on `exhibitions` (RESTRICTIVE `module_entry_open('exhibition_leads')` policy, no service credential). Calls `https://api.anthropic.com/v1/messages` (`anthropic-version 2023-06-01`, `max_tokens 1500`) with env `ANTHROPIC_API_KEY`; models tried in order: `EXHIBITION_SCAN_MODEL` (optional env), `claude-sonnet-5-5`, `claude-opus-5-5`, `claude-haiku-5-5` (a 404 falls through to the next). Provider timeout 25 s. In-memory per-user rate guard 20 requests / 60 s (spend guard, not security). Photo accepted types jpeg/png/webp (heic/heif accepted client-side then converted), max 3 MB (`MAX_SCAN_BYTES`), long side 1800 px (`SCAN_LONG_SIDE`). Photograph is read into memory, sent, dropped: not stored or logged. If `ANTHROPIC_API_KEY` is missing the route answers `not_configured` and the screen falls back to typing: scanning is an aid, never a gate. Whatever is printed is data, never instructions; `parseScanResult` discards anything outside the fixed schema (name, up to 6 phones, email, company, designation, city, website, address, client type, requirements, requirement_text, other_text; kind `visiting_card` or `visitor_form`). Unmapped fields (designation, website, address, spare numbers) go into the lead's note ("Scanned from visiting card/visitor form").

## 4. Database

Tables (RLS read-only to browser; `*` policies gated by `module_entry_open('exhibition_leads')`; every write via SECURITY DEFINER functions deriving actor from `auth.uid()` - no function takes an actor id):

| Table | Notes |
|---|---|
| `exhibitions` | slug `^[a-z0-9][a-z0-9-]{1,62}$` unique; name 1-120 (unique case-insensitive via `exhibitions_name_unique`); city; `starts_on`/`ends_on` (CHECK ordered; max span 31 days via `exhibitions_span_max`); `is_active`; `created_by`; `closed_at`/`closed_by` (stamped by trigger `exhibitions_stamp_closed`) |
| `exhibition_leads` | `contact_name` 1-120; `phone_e164` `^\+[1-9][0-9]{7,14}$`; `email` (lower-cased, 20270308); `card_photo_path` (unique index `exhibition_leads_card_photo_path_unique`); `client_type` (+ `client_type_other` iff other); `requirements text[]` (restaurant_cafe, hotel, residential; up to 3); `company_name` <= 160; `project_city` <= 80; `buying_timeline`; `lead_type` (hot/warm/long_term/mismatched_retail) mandatory, no default; `status` default `new`; `initial_note` <= 2000; `owner_id`, immutable `collected_by`, `exhibition_id`, `created_at`, `submission_id` (UNIQUE idempotency key); `next_follow_up_on`; archive fields (`archived_at/by`, `archive_reason` 3-500, all-or-none) |
| `exhibition_lead_events` | append-only trail (trigger `exhibition_lead_events_append_only`) |

Unique index `exhibition_leads_one_active_phone`: ONE active lead per normalised mobile per exhibition (archived leads do not hold the number; restore re-checks). Trigger `exhibition_leads_guard_immutable` keeps `collected_by`, `exhibition_id`, `created_at`, `submission_id` fixed even for a privileged writer; `owner_id` changes only through reassign.

Functions: `normalize_lead_phone(text)` (also a dependency of Inventory), `exhibition_leads_user_eligible`, `exhibition_leads_actor`, `exhibition_leads_viewer`, `exhibition_leads_my_access`, `exhibition_leads_filtered`, `exhibition_leads_page`, `get_exhibition_lead`, `exhibition_lead_json` (internal), `exhibition_lead_people`, `exhibition_lead_ranking` (Admin), `exhibition_lead_standings(uuid)` (any module user: names + today/total counts only, `is_me` flag, no ids), `export_exhibition_leads` (Admin CSV), `create_exhibition_lead` (idempotent; replays original for the same `submission_id`), `update_exhibition_lead`, `set_exhibition_lead_contact` (email + card photo, called right after create so the create path stays byte-identical), `reassign_exhibition_lead`, `archive_exhibition_lead`, `restore_exhibition_lead`, `create_exhibition`, `update_exhibition`, `set_exhibition_open(uuid, boolean)`, `list_exhibitions_admin()`, `exhibition_lead_card_can_upload`, `exhibition_lead_card_readable`.

Storage: private bucket `exhibition-lead-cards`, path `{uploader uuid}/{uuid}.jpg` (`newCardPath`), never a URL (short-lived signed URL). Visible to exactly who sees the lead (owner and Admin; `view_all` holders via 20270309); before attachment only its uploader. One photograph belongs to one lead.

Module registration is inside 20270305 (`app_modules`, `permission_modules`, `module_permission_actions`, `role_permissions` for admin, `department_permissions` for the Sales department `view`); `view_all` registered in 20270309 (default off, granted to nobody; the global action key `view_all` is shared with Orders/Finance). Rollback notes are in each migration header. Migrations: `20270305000000_exhibition_leads`, `20270306000000_exhibition_management`, `20270307000000_exhibition_lead_standings`, `20270308000000_exhibition_lead_email_and_card`, `20270309000000_exhibition_leads_view_all` (re-creates six functions), `20270310000000_exhibition_lead_requirement_residential` (CHECK + both create/update widened), `20270311000000_exhibition_lead_duplicate_owner_name`, `20270312000000_exhibition_close_reopen`. Later migrations re-issue earlier functions verbatim apart from the stated change, so the LATEST migration defining a function is the truth.

## 5. Permissions & access

- Module key `exhibition_leads`; actions `view` (open, add leads, work owned leads) and `view_all` (display "View All Records"; read-only sight of every lead, sheet and card photo; the people list for filters; NOT CSV export, NOT Ranking, NOT Exhibitions management). No create/edit grant exists.
- Admin (role) bypasses the engine. Sales has `view` through a department rule (removable in Control Center; an employee override can win).
- A salesperson sees/edits only leads they currently OWN. Writes require Admin or being the lead's current owner. Archive/restore: Admin only (no other role has a delete path).
- `view_all` holders are removed from the fair ranking and from the leaderboard on Add Lead / My Leads even if they collected leads (their leads stay in their owner list). Admin is never "a holder".
- Scan route needs only module access (via RLS probe).

## 6. Business rules

- Day boundary = Asia/Kolkata; `created_at` server time.
- Ranking: credit to the IMMUTABLE `collected_by`; counts only ACTIVE (non-archived) leads inside the exhibition's own dates; per-day columns (hence the 31-day span limit). Standings (Add Lead leaderboard) count exactly the same way so screens cannot disagree; equal totals share a position (1,2,2,4); a person with no leads has null position; all-zero board has no leader. "Today/Total" come from collector credit while My Leads lists current OWNER (differ only after reassignment).
- Duplicates: same normalised mobile active in the same exhibition -> create returns status duplicate (`duplicate_mine` / `duplicate_other`); for another person's lead the answer carries only the status and the holder's NAME (`owner_name`, 20270311), no id, no contact, no notes.
- Status vocabulary: new, contacted, quotation_sent, follow_up, converted, not_proceeding. CHECKs: `follow_up` requires `next_follow_up_on`; terminal statuses (converted, not_proceeding) must have no follow-up date. Follow-up filters: due today, overdue, not scheduled.
- Lead Type labels/hints: Hot ("Immediate RFQs / Active Site Plan"), Warm ("Sourcing for Pipeline Projects"), Long Term ("General Networking & Future Roster"), Mismatched / Retail Inquiries ("Low Priority"). Client types: Architect / Interior Designer, Property Owner, Consultant, Other (+text). Buying timelines: within 1 month, 1-3, 3-6 months, later, not sure.
- Phone: default country code 91; Indian mobile 10 digits starting 6-9 stored as `+91...`; other countries keep the full `+...`.
- Closing an exhibition (`is_active=false`, Admin): refuses NEW leads only; leads, ranking, export stay readable; owners may still edit leads (follow-ups continue); the app hides the "Add Exhibition Lead" quick link and Add Lead navigation when every exhibition is closed (no deploy needed). Closed exhibitions stay visible to every module user (policy changed in 20270306).
- Instant save: the Add Lead screen saves into a localStorage outbox (per user), clears the form at once, and retries with the SAME `submission_id` until confirmed; states saving/retry/auth/saved/duplicate_mine/duplicate_other/failed; refused entries stay visible for edit or discard.
- Limits: `MAX_NAME` 120, `MAX_COMPANY` 160, `MAX_CITY` 80, `MAX_NOTE` 2000, `MAX_OTHER` 200, `MAX_EMAIL` 120; email pattern `^[^@\s]+@[^@\s]+\.[^@\s]+$`.

## 7. Key components & lib files

`src/components/exhibitionLeads/`: AddLeadScreen, ScanPanel, StandingsPanel, EntryFeed, OutboxProvider, ChoiceGroup, LeadBits, LeadDetailSheet, LeadsListScreen, RankingScreen, ExhibitionsScreen. `src/lib/exhibitionLeads/`: api.ts, cardPhotos.ts, constants.ts, csv.ts, draft.ts, errors.ts, exhibitions.ts, filters.ts, format.ts, intake.ts, outbox.ts, phone.ts, queries.ts, ranking.ts, scan.ts, scanClient.ts, scanPrompt.ts (prompt + tool schema), standings.ts, validation.ts. Layout `src/components/layout/ExhibitionLeadsLayout.tsx`; quick action in `QuickActions.tsx`.

## 8. Decisions made & why

- Scan is an aid, not a gate: key missing -> typing still works; photo never stored (privacy); model fallback list because a model name the account lacks must not fail the scan.
- Collector credit immutable so reassignment cannot move ranking credit.
- Leaderboard shows names and counts to everyone ("a board you cannot read does not motivate anyone") but never any lead detail.
- Separate `view_all` instead of making managers Admin; view_all holders leave the ranking.
- Closed = soft state; nothing deleted; reopening supported.
- Idempotent create (submission_id) and email/photo attached by a separate function to keep the create path unchanged.
- `tool_choice` no longer forced (#301): forcing it broke scanning.

## 9. Known traps, gotchas, unfixed defects

- Migration inventory pins: adding `20270307` broke 14 pins + the `expenseSurfaces` allowlist; the supabase/tests file name must contain `exhibition_leads` or the expenseSurfaces rule rejects it (`exhibition_lead_*` files named `exhibition_leads_*_assertions.sql`).
- The standings function degrades gracefully if missing (screen shows own numbers only), so code can ship before that migration.
- The rate limiter is per server instance memory: not a real limit across Vercel instances.
- Scan model names are hard-coded in the route; check they still exist on the Anthropic account (`claude-sonnet-5-5` etc.); `EXHIBITION_SCAN_MODEL` overrides. Do not force `tool_choice`.
- HEIC conversion happens client-side; server accepts only jpeg/png/webp.
- Browser verification without a stack: mock-Supabase harness in `temporary/` (cleared 2026-10-14 per memory, so gone).
- Windows port exclusions (57273-57372) affect local stacks.
- Later functions replace earlier ones; do not edit an old migration to fix behavior.

## 10. Tests that guard it

- `src/lib/exhibitionLeads/`: `exhibitionLeads.test.ts`, `migration.test.ts`, `scan.test.ts`, `cardPhoto.test.ts`, `closeExhibition.test.ts`, `exhibitions.test.ts`, `outbox.test.ts`, `standings.test.ts`, `viewAll.test.ts`. Run `npx tsx --test src/lib/exhibitionLeads/*.test.ts`.
- SQL (disposable DB): `supabase/tests/exhibition_leads_assertions.sql`, `exhibition_leads_card_assertions.sql`, `exhibition_leads_standings_assertions.sql`, `exhibition_leads_view_all_assertions.sql`, `run_exhibition_leads_race_local.sh` (concurrent duplicate submissions).
- `npm run permissions:check`; migration-ledger pin tests.

## 11. Open items / next planned work

- Confirm the fair is closed in prod and the Admin ranking exported.
- Per-migration apply confirmation (see section 2).
- Possible: real rate limiting; storing scan results; no planned work recorded in memory.

## 12. Recheck before changing this module

- Read the LATEST definition of each function (`grep -ln "function public.<name>" supabase/migrations/*` then take the last), `src/app/api/exhibition-leads/scan/route.ts`, `src/lib/exhibitionLeads/scan.ts`, `outbox.ts`, `constants.ts`, `src/lib/permissions/modules.ts` (exhibition_leads block).
- Query: `supabase migration list --linked`; `select slug,is_active,closed_at from exhibitions`; permission grants for `view`/`view_all`.
- Run: all `src/lib/exhibitionLeads/*.test.ts`, the four SQL assertion files, `permissions:check`, ledger pin tests.
