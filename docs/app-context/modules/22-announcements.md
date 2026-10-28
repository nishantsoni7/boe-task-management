# 22. Announcements

Verified against checkout `852e0493`. Shipped by #215 (`528d3557`), form fix #216, launcher integration #218 and #262 (`994129e0`, "quieter announcement"). Not a module in the permission registry: announcements live in the BOE OS shell beside Home.

## 1. Purpose & users

- An administrator publishes a short notice (title, one-line summary, full text, optional PDF) to NAMED employees for a window of India dates. While active, each recipient sees it on the Modules page until they press "I have read this", and can reopen it from Announcements for the rest of the window. Nobody else sees it at all.
- Users: administrators (`users.role = 'admin'`, active, not deleted) write; named recipients read and acknowledge. An administrator may also be a recipient (their own banner follows).

## 2. Status at commit 852e0493

- SHIPPED. One migration, `20270110000000_announcements.sql`, idempotent and purely additive (touches no existing table, function, policy, `notifications` or the `notification_type` enum). Production apply state not recorded in memory; the feature is on the Modules launcher in released code (#218/#262), so it is applied in practice (unverified; check `supabase migration list --linked`).
- No memory notes exist for this module; this dossier is derived from code and the migration header.

## 3. Pages and API routes

- `/announcements` (list of the caller's active announcements; `AnnouncementsShell.tsx` shell, available to every signed-in employee), `/announcements/[id]` (full text + PDF).
- `/admin/control-center/announcements` (admin only; `page.tsx` + `AnnouncementForm.tsx`; tabs Current / etc.; Control Center layout admits admins only as the UI half).
- Components: `src/components/announcements/AnnouncementBanner.tsx` (Modules page banner; shows up to `ANNOUNCEMENT_BANNER_MAX_ROWS = 3` unread plus "more" count), `AnnouncementBell.tsx` (header panel). Used by `src/app/modules/page.tsx`.
- No API routes. Everything is Supabase RPC + Storage from the browser.

## 4. Database

Tables (RLS enabled and FORCED on all three; no client holds INSERT/UPDATE/DELETE; all writes via functions):

| Table | Notes |
|---|---|
| `announcements` | `title` 1-120, `summary` 1-280, `body` 1-20000 chars (CHECKs on btrim); `attachment_path/name/size` all-or-none; path must start with the announcement's own id (`announcements_attachment_under_own_id`); `starts_on`, `ends_on` dates (`ends_on >= starts_on`); `ended_at/ended_by` set only by `end_announcement()` (pair CHECK); created_by/at, updated_by/at |
| `announcement_recipients` | who may see each one (named people, never "everyone"); index by user |
| `announcement_reads` | one row per person per announcement, `read_at`; written only by `acknowledge_announcement()`; NOT in `public.notifications` |

Functions: helpers `announcement_india_date(timestamptz default now())`, `announcement_is_live(...)` (pure window rule), `announcement_caller_is_admin()` (SECURITY DEFINER, because `users` RLS hides rows), `announcement_visible_to_caller(uuid)`, `announcement_file_announcement_id(text)` (never raises, so storage policies fail closed); validators `announcement_validate_recipients(uuid[])`, `announcement_check_attachment(...)`; writes `create_announcement`, `update_announcement`, `end_announcement(uuid)` (admin only); `acknowledge_announcement(uuid)` (the only employee write; no user parameter; idempotent, keeps first `read_at`; refused when the announcement is not currently visible, `ANNOUNCEMENT_NOT_VISIBLE`); reader `my_announcements()` (active list for the caller with own `read_at`, newest first). Errors use `ANNOUNCEMENT_<CODE>: message` shown as-is: NO_RECIPIENTS, RECIPIENT_INACTIVE, ATTACHMENT_INCOMPLETE/PATH/MISSING, FORBIDDEN, ID_REQUIRED, DATES, NOT_FOUND, NOT_VISIBLE.

Row security: announcements: admin all, others only those `announcement_visible_to_caller`; recipients and reads: admin all, others own rows.

Storage: bucket `announcement-files` PRIVATE, PDF only, 10 MiB. Policies: SELECT admin OR a current recipient for whom the announcement is live AND whose row names exactly this object (a replaced PDF or an ended announcement cannot be opened by employees); INSERT admin only under `{uuid}/{name}.pdf`; DELETE admin only and only an object no announcement currently names (orphans); no UPDATE. The browser uploads first, then calls create/update, which refuse a path naming a missing object.

Dates: INDIA dates, both ends inclusive (visible from 00:00 IST on `starts_on` to 23:59:59 IST on `ends_on`), computed on every read: no scheduled job. Verification block at the end of the migration raises if any object did not take.

Migration: `20270110000000_announcements.sql`. Local proof: `supabase/tests/run_announcements_local.sh` + `announcements_assertions.sql`.

## 5. Permissions & access

- No module key, no permission rows. Write authority = active non-deleted `users.role = 'admin'` checked INSIDE every write function (`announcement_caller_is_admin()`), plus Control Center layout (UI half).
- Read authority = named recipient + live today in India + active account. No role is consulted for reading.
- Because there is no permission module, `npm run permissions:check` does not cover it and Control Center cannot grant "who may publish"; adding a non-admin publisher would need a new design.
- Recipients removed on edit lose sight immediately; their read row stays as history. Edits keep everybody's acknowledgements (a typo fix is not a new notice).

## 6. Business rules

- Audience must be at least one named, ACTIVE employee; otherwise refused.
- Default window in the form: today (IST) through day 15 inclusive (`ANNOUNCEMENT_DEFAULT_DAYS = 15` => `defaultAnnouncementWindow`). Creating with an end date already passed is refused (`ANNOUNCEMENT_DATES: the end date has already passed`).
- Admin may end one early (`end_announcement`, recorded: `ended_at/by`). Status labels for admin rows (`announcementStatus`): scheduled, active, expired, ended (UI mirror of `announcement_is_live`; the database decides visibility).
- PDF: only PDF, > 0 bytes, under 10 MB (`ANNOUNCEMENT_PDF_MAX_BYTES`); blank type falls back to the `.pdf` extension; object key `{announcementId}/{timestamp}_{random}.pdf`; signed URL TTL 300 s (`ANNOUNCEMENT_PDF_URL_TTL_SECONDS`).
- Limits in `ANNOUNCEMENT_LIMITS`: title 120, summary 280, body 20000.
- One query feeds banner, header panel and list: React Query key `['announcements','mine', userId]`, `staleTime` 60 s; acknowledging updates all three. Page load writes nothing. Admin list key `['announcements','admin']`.
- The left-nav "Announcements" entry is drawn by `BoeOsLayout` only while `my_announcements()` returns at least one row (read or not) and not in View As; admins follow the same rule. The layout loads the list itself (no prop), so every page using it agrees.
- Not a notification: reading/marking/deleting ordinary notifications cannot affect announcement read state.

## 7. Key components & lib files

`src/lib/announcements.ts` (constants, `indiaDate`, `addDays`, `defaultAnnouncementWindow`, `formatAnnouncementDate`, `announcementStatus`, `bannerContent`, `validateAnnouncementPdf`, `buildAnnouncementPdfPath`), `src/hooks/queries/useAnnouncements.ts` (`useMyAnnouncements`, `useAcknowledgeAnnouncement`, `announcementKeys`), `src/app/announcements/*`, `src/app/admin/control-center/announcements/*`, `src/components/announcements/*`, `src/app/modules/page.tsx` (banner integration, "latest announcement" in the compact launcher).

## 8. Decisions made & why

- Named recipients only, never "everyone": prevents accidental broadcast; no recipients = refused.
- Own `announcement_reads` table, not `notifications`: reading/deleting a notification must never clear an acknowledgement, and nothing is written because a page loaded.
- India dates computed on read: expiry needs no scheduler (BOE has no application cron; only the Image Editor cleanup cron exists).
- Writes only through admin-checked functions; RLS only decides SELECT. FORCE RLS to bind even the table owner.
- Private PDF bucket with policies tied to the same visibility rule so the file can never be seen by someone the list hides it from.
- Launcher integration made "quieter" in #262 (one latest announcement, compact).
- 2026-10-29: on the launcher the announcement is no longer a row above the tiles. The newest UNREAD one is the first
  item of the For you panel (`src/app/modules/AttentionPanel.tsx`, `AnnouncementItem`); opening it acknowledges it on
  `/announcements/[id]` and it leaves the panel. Same `useMyAnnouncements` list; the bell is unchanged.

## 9. Known traps, gotchas, unfixed defects

- The `announcements.render.test.tsx` and migration tests pin source text; adding a migration may require ledger-pin updates (see other dossiers) and `announcementsMigration.test.ts` reads the migration file, so edits to it fail the test (never edit an applied migration anyway).
- `announcement_caller_is_admin()` is SECURITY DEFINER for a reason (users RLS); do not inline `users` subqueries into policies for non-admin callers.
- Date maths: `announcement_india_date` takes the instant as a parameter for testing; UI uses `Intl.DateTimeFormat('en-CA', timeZone Asia/Kolkata)`; do not use `new Date().toISOString().slice(0,10)` (UTC) for "today".
- The form grid once overflowed (fix #216: `minmax(0, 1fr)`); keep the pattern in new form columns.
- A removed or replaced PDF cannot be opened by employees even if they have the old signed URL after 300 s.
- The nav entry disappears when the last announcement expires or is ended; a cached list can keep it up to 60 s (staleTime).
- No push/email notification when an announcement is published: recipients only see it by opening the Modules page (design choice, not a bug).
- Stale staleTime 60 s: a new announcement can take up to a minute to show in an open tab.

## 10. Tests that guard it

- `src/lib/announcements.test.ts` (window, status, banner, PDF validation, paths), `src/lib/announcementsMigration.test.ts` (migration contract), `src/components/announcements/announcements.render.test.tsx`. Run `npx tsx --test src/lib/announcements.test.ts src/lib/announcementsMigration.test.ts src/components/announcements/announcements.render.test.tsx`.
- SQL: `supabase/tests/announcements_assertions.sql` via `run_announcements_local.sh` (disposable DB only).

## 11. Open items / next planned work

- None recorded. Ideas implied by the design: a way for non-admin publishers, push notification, audience by department.
- Confirm apply state on production and that at least one end-to-end test announcement was acknowledged by a non-admin (not recorded).

## 12. Recheck before changing this module

- Read: `20270110000000_announcements.sql` (header + sections 4-9), `src/lib/announcements.ts`, `useAnnouncements.ts`, `src/app/modules/page.tsx` banner usage, `src/app/admin/control-center/announcements/page.tsx`.
- Query: `select * from my_announcements()` as a recipient (with `request.jwt.claims` set in a disposable DB), storage policies on `announcement-files`.
- Run: the three test files above and `run_announcements_local.sh`; manually test as admin and as a named non-admin: banner, acknowledge, PDF open, ended early, expired.
