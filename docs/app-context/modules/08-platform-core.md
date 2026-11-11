# 08 - Platform core (auth, roles, clients, shell, launcher, View As, rebrand, Vercel)

Verified against checkout `852e0493` (origin/main). Memory notes were checked against code; anything not
verifiable here is labelled "(unverified, from memory)".

## 1. Purpose & users

The shared plumbing every module stands on: sign-in and password reset, the three system roles, the three
Supabase clients, the per-module app shell and sidebar, the Modules launcher (`/modules`), the Task Management
Dashboard (`/dashboard`), Account Settings, View As (admin previews an employee's screen), the BOE One visual
identity, and `vercel.json`.

| Who | What they use |
|---|---|
| Every signed-in person | `/login`, `/forgot-password`, `/reset-password`, `/modules`, `/account`, their module shells |
| Admin | everything above + View As + Control Center (see module 10) |
| Manager (`users.role='manager'`) | no platform privilege of its own; see section 5 |

System roles (`UserRole` in `src/lib/types.ts`): `'admin' | 'manager' | 'member'`. The employee role is stored as
**`member`**, not "employee" - do not search the code for `'employee'`.

## 2. Status at commit 852e0493

- Shipped: everything below. Latest platform-affecting commits: #321 (Vercel `hnd1`), #315 (forgot/reset password),
  #309/#311/#312/#314 (BOE One rebrand), #307 (Control Center hubs), #322 (task navigation warm-up).
- No `middleware.ts` / `proxy.ts` exists anywhere in the repo (searched). **Authentication is not enforced by
  Next middleware.** It is enforced by (a) client layouts/guards (`ModuleGuard`, Control Center layout) and (b) each
  API route re-verifying a bearer token or cookie session. A page that forgets its guard is reachable (data is still
  protected by RLS / API checks).
- `AGENTS.md` warns this is Next.js 16.2.6 with breaking changes: read `node_modules/next/dist/docs/` before writing
  framework code. React 19.2.4.

## 3. Pages and API routes

Pages (this module): `/` (server redirect to `/modules`), `/login`, `/forgot-password`, `/reset-password`, `/modules`,
`/dashboard`, `/account`, `/coming-soon` (shared "not available" landing for denied module entry), `/quick-start-guide`,
`/settings` (+ `/settings/roles`, `/settings/positions`: no longer in any navigation, still routable; see module 10).

API routes: `/api/view-as/subject` (GET only). Sign-in/out and password change use the Supabase browser client
directly (`signInWithPassword`, `resetPasswordForEmail`, `verifyOtp`, `updateUser({password})`) - there is no `/api/login`.
`/api/reset-password` (POST) is the **admin** "set someone's password" route (min 6 chars; the self-service UI minimum
is 8 - `MIN_PASSWORD_LENGTH` in `src/lib/auth/recoveryLink.ts`; the two minimums differ).
`/api/image-editor/cleanup` is the only Vercel cron target (see section 4 Vercel).

Auth flow details:
- `/login` (`src/app/login/page.tsx`): `signInWithPassword`; then `router.push(safeReturnPath(?redirect) ?? '/')`.
  `safeReturnPath` (`src/lib/safeReturnPath.ts`) rejects `//host`, `/\host`, control chars, >2048 chars, cross-origin.
  `/` redirects to `/modules`.
- `/forgot-password`: `resetPasswordForEmail(email, {redirectTo: <origin>/reset-password})`. The confirmation text is
  identical whether or not the address exists (no account enumeration). HTTP 429 -> "Too many reset requests".
- `/reset-password` (`src/lib/auth/recoveryLink.ts`): understands three link shapes: `?token_hash=..&type=recovery`
  (verifyOtp; works on any device), `?code=` (PKCE; only works in the browser that asked), `?error=`/`#error=`
  (`otp_expired` -> fixed expired message). A session counts as "from a reset link" only if the JWT `amr` claim has
  `recovery` or `otp` with a timestamp <= 3600 s old (`RECOVERY_SESSION_MAX_AGE_SECONDS`) - this stops a colleague's
  still-open session on a shared PC from having its password changed.
- `/account`: change own password (`supabase.auth.updateUser`), `?returnTo=` validated by `safeReturnPath`
  (default `/modules`). Reads a named column list from `users` (never `*`).

## 4. Database, clients, storage, Vercel

Tables touched by the platform: `users` (never created by a migration - see below), `app_modules`, `user_module_order`,
`positions`, `departments`. Auth itself is Supabase Auth.

- **`public.users`, `public.tasks`, `public.task_activity_log`, `public.notifications` are NOT created by any migration**
  (`docs/migrations-are-not-self-contained.md`: the history starts after the schema it depends on; an empty database
  cannot be built from `supabase/migrations`). Production-read facts about them live in docs and in this app-context set.
- **Column-level privilege on `users`** (`20260813000000_users_private_column_grants.sql`): table-level SELECT was
  revoked from `anon`/`authenticated`; only named columns are granted. `monthly_salary`, `payroll_notes` and
  `performance_tracking_note` are private (`USER_PRIVATE_COLUMNS` in `src/lib/users/safeColumns.ts`). **`select('*')` on
  `users` from a browser client is an error (42501)**, not a wide read. Adding a column to `users` needs a
  `GRANT SELECT (col) ... TO authenticated` migration AND an entry in `USER_PROFILE_COLUMNS`, or the live
  `usersPrivateColumns.test.ts` fails with 42703. `src/lib/users/noStarSelect.test.ts` guards `select('*')`.
- **Supabase clients** (`src/lib/supabase/`):
  - `client.ts` - browser singleton (`createBrowserClient`, anon key). Module-level `_client` so every page shares one
    GoTrue instance.
  - `server.ts` - cookie-based server client (`createServerClient`), used by routes that read the session cookie
    (e.g. `/api/view-as/subject`, notifications).
  - `admin.ts` - `adminClient()` returns `{ok:true, client}` or `{ok:false, missing:[names]}` (never throws) built from
    `NEXT_PUBLIC_SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` (the single canonical server credential name). BUT most
    routes still build inline `createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!)` (inventory counts 137 raw
    reads of the env name) - the helper is not yet universal. `adminClient.test.ts` fails if any `'use client'` file
    imports it.
  - Typical API route pattern: read `Authorization: Bearer <token>` (116 client call sites send it), `auth.getUser(token)`
    with a service client, load `users.role/is_active/is_deleted`, then act. Many routes authorize on `users.role`
    only; **`is_active=false` / soft-deleted users keep a valid Supabase session** (deactivation does not revoke
    sessions), so newer routes also check `is_active` and `is_deleted`.
- **Vercel** (`vercel.json`): `regions: ["hnd1"]` (Tokyo, next to the Supabase DB in ap-northeast-1; PR #321, measured
  medians e.g. performance-metrics/team 7.41 s -> 1.30 s). One cron: `GET /api/image-editor/cleanup` at `0 3 * * *`
  (03:00 UTC), authorized by `Authorization: Bearer $CRON_SECRET`; with `CRON_SECRET` unset it answers 503 and does
  nothing. The hourly `run_task_health_check` job is a Postgres pg_cron job, not in `vercel.json` (see module 11/12).
  Vercel builds previews for PRs only (a bare branch push builds nothing) and previews talk to the **production**
  database (unverified, from memory).
- `next.config.ts`: `serverExternalPackages: ['pdfkit']`; `outputFileTracingIncludes` ships the sharp native libvips
  `.so` for 6 routes (image-editor studio/convert, orders documents, PI-version PDF, showroom quotation, custom review
  submissions) - without it production died with `ERR_DLOPEN_FAILED libvips-cpp.so.8.18.3`; image `qualities`
  `[THUMB_QUALITY, PREVIEW_QUALITY, 75]`, `minimumCacheTTL` 31 days; a 307 redirect from
  `/attendance/requests?tab=review` to `/attendance/monthly-review?view=decisions`.
- Env var names the code reads: see `docs/app-context/APP_INVENTORY.generated.md` (names only; never record values).
- Migration ledger rule: a migration file is **immutable once applied**; corrections are new, later migrations.
  `src/lib/finance/participantAndOrderTotalSecurity.test.ts` pins SHA-256 of applied files in a `FROZEN` list (do not add
  an unapplied file to it) and keeps an exact pending list; many source/ledger tests hard-code migration filenames, so
  adding a migration touches several tests (PR #327 made the named-successor suites tolerate new files at the end).
  Migration header comments saying "NOT APPLIED" are often stale (e.g. `20261015000000`, `20261016000000` say so but the
  FROZEN list records both APPLIED).

## 5. Permissions & access (platform level)

- `users.role`: `admin` is the authority everywhere; `manager` and `member` carry **no module access by role**. A
  manager opens FEWER modules than some members unless granted (see module 09). Control Center is admin-only by role.
- Module entry is decided by one function family (module 09): `ModuleGuard` -> `canAccessManagementModule` for the 12
  engine-gated modules; `app_modules.visibility_type` still drives Attendance/Payroll self-service cards and Showroom QR's
  department rule.
- `ModuleGuard` (`src/components/layout/ModuleGuard.tsx`): renders `children` ONLY in the `allowed` state (loading screen
  for checking and denied, so protected screens never mount). No session -> `/login`; denied -> `/coming-soon`. It reads
  the **display subject** (View As target), not the actor. UI half only: RLS and route checks refuse the data.
- Admin gate for Control Center (`src/app/admin/control-center/layout.tsx`): no session -> `/login`; not admin ->
  `/dashboard`; admin with View As active -> View As is exited then `/dashboard` (Control Center has no meaning as someone
  else).
- Role-based leftovers still in the platform (not engine-based): `/manager` and `/tasks/all` require role admin|manager
  (page-level redirect to `/dashboard` / `/tasks/my`); `/super-admin` requires admin; `/api/task-detail` is admin|manager.

## 6. Business / behaviour rules

Permission-context caching (`src/hooks/queries/usePermissionContext.ts`):
- ONE resolution per signed-in user: key `['permission-context', userId]`, `PERMISSION_STALE_MS = 30_000`,
  `PERMISSION_GC_MS = 5 min`. Calls `resolve_effective_permissions_for_user` (all modules, one RPC). `useSignedInUserId`
  (key `['signed-in-user-id']`) reads the local session (`getSession`, no network).
- Fail closed, independently: profile read fails -> role null -> everyone (even admins) denied; permission RPC fails ->
  empty map -> non-admins denied, admin passes on role alone. Background refetch rejects rather than overwriting a good
  answer with a fail-closed one. `ready` is not `allowed`: render nothing until `ready`.
- `Providers.tsx` (`AuthIdentityBoundary`): one auth listener. `SIGNED_OUT` -> `queryClient.clear()` +
  `clearPersistedUnreadCounts()`. `SIGNED_IN` for the SAME user (session recovery) is ignored. A different user in the same
  tab -> `queryClient.clear()`. `USER_UPDATED` same user -> invalidate `['permission-context']` and `['signed-in-user-id']`
  by prefix only (the two key literals are duplicated there on purpose so the root bundle stays small). Defaults:
  `staleTime 30s`, `gcTime 5 min`, `retry 1`, `refetchOnWindowFocus false`.

Modules launcher (`src/app/modules/page.tsx`):
- Cards are built from the permission engine first; `canOpenModule(key)` per card. Order = canonical array, then the
  person's saved order (`src/lib/modules/moduleOrder.ts`, `user_module_order` table, migration `20261228000000`): stores
  card KEYS only; the function returns a permutation of the already-gated array, so a stored key can never grant a card.
  Allowed cards the saved order omits are appended in canonical order. `ESSENTIAL_MODULE_KEYS = ['tasks','orders','finance']`.
- Cards present: tasks (`/dashboard`), orders, samples, attendance_payroll (ONE card: admin -> `/payroll`; else
  `/my-attendance` if attendance visible, else `/my-payroll`), showroom (`/showroom-admin`), assets, members (Employee
  Records -> `/admin/control-center/people`), performance (always `/performance`), finance, meetings, customer_reviews
  (Review Workflow), image_editor, exhibition_leads, inventory, plus personal pages (my credits etc.). The newest
  unread announcement (module 22) is the first item of the For you panel, not a row above the tiles (2026-10-29).
- The punch-in strip (`PunchStrip.tsx`, 2026-11-07) is the FIRST child of the page body, above Quick Actions: green or
  amber for 30 minutes after a punch, red from 10:15 until they punch or "Hide for today" (this device only). It is not
  drawn while arranging the cards or while previewing with View As, and a failed read draws nothing. Rules, silent cases
  and the route are in module 04 section 6.
- Unread badge counts via `useUnreadCountState('task'|'finance'|'order')`, only when the person may open that module.
- Phone layout (2026-10-27 redesign), measured on the launcher's own width with container queries in
  `src/app/modules/modules.module.css`: up to 719 px the Essentials are ONE row of equal tiles (icon over name,
  ~100 px, `grid-auto-flow: column` so 1-2 Essentials share the width); up to 479 px "All modules" is ONE rounded
  white surface of 52 px rows (32 px icon chip, 15 px name, chevron) split by hairlines. The chevron
  (`styles.cardChevron`, compact tiles only, not in edit mode) is `display: none` at every other size. Edit order
  uses the same list (dashed hairlines; the held card gets its own ink edge). Layout values live in the CSS
  module because inline `style` beats media queries. Pinned by `moduleCardSurface.test.ts` (PHONE_LIST /
  PHONE_ESSENTIALS) and the dimension list in `src/lib/modules/moduleOrderStorage.test.ts`.
- **A+ refinement (2026-11-02, owner chose it from three mock-ups; desktop and tablet only, the phone above is
  untouched).** From 720 px of launcher width an Essentials tile is 148 px with an ink icon tile (BOE red while the
  tile is pointed at) and, under the name, the count in words: a pale-red chip "3 unread", or a tick and "Nothing new"
  only for a count KNOWN to be zero; a count that has not arrived leaves the row blank, at the same height, so nothing
  moves when it lands. There the badge is hidden (`.cardEssential .badge`); on a phone and on every compact tile the
  badge on the icon is unchanged. The root of a tile carries `aria-label` "Name, N unread" while it is a button.
  Compact tiles are 68 px (were 88; tap floor now 64) with a 38 px icon; "All modules" has a count chip beside its
  heading (hidden on a phone); section titles are 15 px; Edit order draws a darker dashed edge (`#857F76`) and a 36 px
  handle. Finance's icon is the rupee sign and Sales has its own (`ChartNoAxesCombined`); `ModuleIcons.tsx` is shared
  with the Control Center Access screens, so both change. The Edit order controls, the For you panel and `globals.css`
  were not touched. Decisions the owner approved: the chip reverses "the badge is the only count on a tile" for wide
  Essentials only; no pale-pink hover wash (the "no pink" pin stays).
- Quick Actions, phone copy (<= 767 px, `globals.css` `.boe-quick-actions-page`): a visible "Quick Actions" label
  over a grid of equal tiles (`repeat(auto-fit, minmax(140px, 1fr))`, 52 px, icon in a 32 px neutral chip); one
  action spans the row, the featured Add Exhibition Lead always takes its own row. The sidebar copy is unchanged.
  "Attendance request" is offered only when the signed-in member takes part in Attendance & Payroll
  (`users.payroll_active`), so members switched out (owners, non-salaried accounts) do not see it. The launcher reads
  that column itself (`['payroll-participation', userId]`, `select('payroll_active, is_deleted')` on the own row):
  the shared `usePermissionContext` profile does NOT select `payroll_active`, so testing it there always read
  "included" (the #467 defect). Until the read lands the button is held back; if it fails the button is offered.
- "For you" panel (`src/app/modules/AttentionPanel.tsx`; #481, #483, focused 2026-10-29): a 280 px column docked to
  the window's RIGHT EDGE holding ONLY what the owner asked for, each as ONE brief card (`.card`: label · age, bold
  brief, optional muted line) with ONE button (Read / Accept / Review), in this order. No notification previews, no
  Orders group.
  1. The newest UNREAD announcement (`latestAnnouncement` = first row of `useMyAnnouncements`, not while previewing),
     linking to `/announcements/[id]`, which is where it is acknowledged; then it leaves the panel.
  2. The viewer's OWN cash, hand to hand until a company cash custodian (Nitish) accepts it, for EVERYONE (owner
     2026-10-29: "both see it till it changes hands"):
     - "Handed to you" (light red ground): open handovers where `handoverRole === 'recipient' && canAccept`, "₹N from
       X · Not accepted yet", Accept -> `HandoverConfirmDialog` (exported from HandoverCard; "Yes, I received ₹X") ->
       `useHandoverActions().accept` (`accept_cash_handover`). On success, unless `viewerIsCustodian` (from
       `finance_unclosed_funds`; their accepting closes the journey), `HandoverModal` opens at once with the accepted
       payments ticked (`initialPaymentIds`): who did you give it to? The modal's open state lives in the PANEL (the
       card leaves the list once accepted) and is drawn even when the panel itself has nothing left to show.
       Custody only: accepting never approves a payment (20270417000000), Finance still verifies.
     - "Waiting for X" (`WaitingCard`): open handovers where the viewer is the giver, "You handed ₹N to X · X has not
       accepted yet", Remind (`remind_cash_handover`, shown while `canRemind`; the server refuses within 4 hours and
       its sentence is shown).
     - "With you" (light red ground): the viewer's held payments in no open handover (`holderId === viewerId &&
       !openHandover`), one card "You hold ₹N", Hand over -> `HandoverModal` (nothing ticked) when any `canHandOver`.
       A custodian's cash is with the company, so it never appears.
  2b. Records waiting on the viewer (owner 2026-10-31; `src/lib/modules/forYouWork.ts`, `src/hooks/queries/useForYouWork.ts`):
     one short read per item, under the reader's own RLS, running only while that item is on for this person. Five
     cards, then "N more" (reads 20 + an exact count). Each button opens the record's existing page; a failed read says so.
     - New payment request: `finance_payment_requests` `pending_approval`, NEWEST first, for `canApprovePayment` AND
       `canViewAllFinance` (`approve` alone gives no read of other people's payments). Own payments are left out
       unless `verify_own_payment`. Review -> `/finance?tab=pending&request=<id>`, which opens the payment. It leaves
       when decided or sent back; a resubmitted payment returns (`updated_at` is in its Clear all key).
     - Four more, OFF by default, added from Control Center: Payment sent back to you (own `needs_clarification`),
       PI waiting for approval (`orders.approve_order`), Order change request (admins, because the Order page offers
       the review to an acting admin alone), PI waiting for Operations (own `awaiting` handoff, cancelled Orders dropped).
  3. "Cash not with the company", EVERYBODY ELSE's: `useUnclosedFunds()` (`finance_unclosed_funds`: all for admin /
     custodian / view_all, else the viewer's own), minus the viewer's own held payments and payments whose open
     handover is TO the viewer (item 2), grouped by holder (`totalsByHolder`, oldest first): "X holds ₹N" + "N
     payments, not handed over" / "Handed to X, not accepted" + age. Review -> `/finance/handovers?holder=` ONLY when
     `financeAllowed` (Finance route).
  4. Leave and late arrival (admin): `PendingApprovals.tsx`, filtered to `LAUNCHER_REQUEST_TYPES` (late_arrival,
     half_day, full_day_leave); early departure and time out stay in Attendance.
  - Header "For you" + count + "Clear all": hides every card showing for 24 hours, in this browser per user
    (`src/lib/modules/forYouSnooze.ts`, localStorage `boe.forYou.cleared.<userId>`; a key names the thing AND what it
    says, so a new or changed item shows at once; a timer brings everything back at `until`; an event keeps the panel
    and the strip in step). Nothing is deleted, decided or marked read.
  - Which items show (owner 2026-10-31; `src/lib/modules/forYouCatalogue.ts`, the one list of 13 items, each with its
    words, default and who it applies to). Control Center › For you sets each item Off, Optional or Always on through
    `set_for_you_item_mode` (active admin, database-enforced), stored in `for_you_item_settings`; no row = the default
    in the list, so a new item needs no seed. Each person turns Optional items off in Account Settings
    (`ForYouChoicesCard`, `user_for_you_preferences`, own row only); the sliders button in the panel header links there
    because an empty panel is not drawn. Always on ignores the person's choice. "Cash handed to you" defaults to Always
    on (owner). THESE SETTINGS ONLY HIDE: they grant nothing and no guard reads them. Until both are known the panel
    shows nothing, so nothing flashes and no read runs for an item that is off. A failed read = the defaults, so the
    launcher never breaks; the two editing screens refuse to save over something they could not read. Control Center
    can only offer items in the list: a new kind of card needs its own read and access rule in code.
  - NOTHING TO SHOW = NO PANEL (`itemCount === 0` and no read error; only an open "Hand over cash" is still drawn): not drawn at all, no "caught up" line, and
    the reserved width goes with it, so the tiles take the whole width.
  - Layout: from 1132 px of window `.attention` is `position: fixed; top/right/bottom: 0; width: 280px`, own
    scroll, sticky head, 150 px bottom room for the app's floating round buttons; `.boe-main-content:has(.attention)`
    gives the page header and body `padding-right: 280px + 24px` (rules in attentionPanel.module.css). Narrower it
    is `flex: 1 1 100%` in `.launcherShell` (modules.module.css, flex-wrap; `.launcher` still the size container,
    `flex: 999 1 640px`), so it wraps BELOW the tiles, and `AttentionStrip` ("N waiting on you" = handovers to accept
    + held cash to hand over + requests; not the viewer's "Waiting for" cards, `@media (max-width: 1131px)`) at the top jumps to `#for-you`. Not drawn while arranging cards.
  - The panel's CSS is its own `attentionPanel.module.css`, keeping the tiles' stylesheet free of anything its tests
    forbid (moduleCardSurface.test.ts). `useAttentionSummary` is shared by panel and strip; queries dedupe by key.
    The HandoverBanner is not on the launcher (Finance pages keep it). Pinned by `attentionPanel.test.ts`,
    `pendingApprovals.test.ts`, `moduleCardSurface.test.ts`, `handover.test.ts`.
- Leave and late-arrival requests (`PendingApprovals.tsx`, helpers `src/lib/attendance/pendingApprovals.ts`): ADMIN
  only (`profile.role === 'admin'`, not while previewing). `usePendingApprovalQueue` reads
  `/api/attendance-requests?scope=queue&status=pending` (key `['attendance-requests','home-pending',userId]`, not even
  asked unless that gate passed), drops the admin's own requests, keeps the launcher types, shows the oldest 5
  (type · "Xh ago" from `submitted_at`, name, `requestSummary`, Review) then "N more requests ->"
  `/attendance/requests`. Decides through `/api/attendance-requests/[id]/decision`; no rule moved.

Dashboard (`/dashboard`, Task Management home): bands "Top 3 Focus", "Needs Your Attention", and an "At a glance" bar (counters +
Tasks Created) docked to the right edge from a 1132 px window, like the Modules "For you" panel (2026-10-29). Primary data is one
React Query entry `['tasks','assigned-to',<effective uid>,'dashboard-active']`. Refresh uses `manualRefreshKey` only
(tab visibility must never refetch it). It warms My Tasks (`warmMyTasksCaches`) and prefetches `/tasks/my`,
`/notifications` (never under View As). Details in module 11.

View As (`src/lib/viewAs.ts`, `src/contexts/ViewAsContext.tsx`, `src/hooks/queries/useDisplaySubject.ts`):
- State in `localStorage['adminViewAs']`. READ identity = display subject (viewed employee); WRITE authority = the real
  actor. The subject's profile + permissions come from `GET /api/view-as/subject?userId=` which decides from the session:
  caller must be an active, non-deleted admin; subject must be active and non-deleted (else 404 "Employee not available for
  preview"); returns profile (`USER_PROFILE_COLUMNS`) + `permissionsByModule` from the same bulk resolver a real login uses.
  `useDisplaySubject` fails closed (null role, empty map) until the server answers.
- "No writes while previewing" is a UI rule per screen plus a server refusal ONLY on the four `/api/notifications` write
  paths (header `x-boe-view-as`, `PREVIEW_WRITE_REFUSED` 403). Other routes act on the admin's own session. The header can
  only remove authority.
- Performance app-open recording while previewing records the admin, not the employee (verified in memory; route comment says so).
- LOGIN AS MEMBER (2026-10-23, separate from the read-only preview above): floating admin-only icon
  (`src/components/layout/LoginAsMemberWidget.tsx`, rules in `src/lib/impersonation.ts`) performs a REAL session swap via
  `/api/impersonation/{members,start,end}` and audits to `admin_impersonation_sessions`. The sidebar Switch User dropdown
  is gone. See CHANGELOG 2026-10-23 for traps (no signOut during swap; stash before verifyOtp; single-use refresh tokens).
  ON A PHONE (owner, 2026-11-04, PR #610 squash-merged as d3c61d98, deployed): below 768px the round button is a slim tab (24px) flush with the right edge,
  because it covered search boxes and rows (Confirmed Orders). Position and trigger shape are CSS (`.boe-viewas`,
  `.boe-viewas-trigger` in globals.css), not inline styles, so the phone rule can win. While acting as a member the
  "Acting as" pill and the return button keep their full size on purpose (`.is-acting`). Pinned in `impersonation.test.ts`.
- View As never lends permissions to a screen that resolves the actor (e.g. `useAssetsAccess`), so it cannot test
  non-admin visibility there; that needs a real non-admin login.

Shell & navigation standards (`docs/BOE Master Context/BOE_GLOBAL_NAVIGATION_STANDARD.md`, `BOE_MODULE_LAYOUT_STANDARD.md`):
every module has its own two-column layout: sidebar (module icon+name+Home -> `/modules`; module-only nav; bottom: user
profile, Account Settings, View As switcher for admins, Sign Out last) + content. No cross-module links; desktop and mobile
nav come from one source. Shell components live in `src/components/layout/` (`DashboardLayout` for Task Management,
`BoeOsLayout`, `OrdersLayout`, `FinanceLayout`, `AttendancePayrollLayout`, `ControlCenterLayout`, `MobileBottomNav`,
`NotificationsNavItem`, ...). Known deviation from the standard: `ModuleSwitchButton` (Finance <-> Orders) is a deliberate
cross-module link, shown only if the person can enter the other module (`canAccessManagementModule`).
Task Management's sidebar holds task work only (Dashboard, New Quotation Request when `canCreateQuotations`, My Tasks,
Assigned By Me, Quotation Requests when `canViewQuotations`, Notifications); Performance, Settings and Super Admin were
removed from it.

Hover rail (2026-10-28): on a desktop with a mouse (>= 768 px, `hover: hover`, `pointer: fine`) every module sidebar rests as a 64 px icon rail
and opens to 260 px OVER the page on hover (100 ms intent delay), on keyboard focus, while its account menu (`[aria-haspopup][aria-expanded="true"]`) is open, or when pinned (`localStorage['boe.sidebar.pinned']`).
Motion (2026-10-29): nothing inside changes height between the two states (whole rail `white-space: nowrap`, fixed 38 px rows; captions `boe-rail-ghost` keep their height and fade; sub-lists `boe-rail-tree` show as a guide line with an active tick while closed; search boxes `boe-rail-search` keep box and icon; the notification card `boe-rail-hide` appears only when pinned; no scrollbar on the unpinned rail); only the panel width animates, on `cubic-bezier(0.32, 0.72, 0, 1)` (0.44 s open, 0.32 s close); count badges keep one size and move by transform only (icon corner -> row end).
Checked by measuring every sidebar element closed vs open on all 16 module shells: 0 move. A new sidebar element must keep its height in both states (pick one of the classes above), never `display: none` it on hover.
A shell opts in with `railShellClass` and `useSidebarPinned` from `src/components/layout/RailControls.tsx`; labels carry `boe-rail-label` / `boe-rail-hide` / `boe-rail-ghost` / `boe-nav-count`
(CSS: "HOVER RAIL SIDEBAR" in `globals.css`). Touch, tablets and the phone drawer are unchanged. A new module layout must opt in or keeps the full sidebar.

BOE One identity (`docs/BOE_VISUAL_IDENTITY.md`; values in `:root` of `src/app/globals.css`, mirrored in `src/lib/tokens.ts`):
terracotta `#B9472E` = actions/selection only; charcoal `#303536` text; canvas `#F7F5F1`; input border `#8C8379`
(corrected from `#B9B2A9` for WCAG 1.4.11); error `#B42332`; status pairs (pending/working/waiting/blocked/completed) never
recoloured to brand. Fonts Manrope (headings) + Inter (body), self-hosted woff2 via `next/font/local` in `src/app/fonts`
(no Google fetch; Syne was removed after a build-time fetch failure); latin-ext files carry the rupee sign and load by
`unicode-range`. Geometry: controls 8 px, panels 12 px, badges 6 px; focus ring 2 px terracotta `!important`. Visible app
name is "BOE One" (`metadata.title`); every module sidebar header reads "BOE One" and the signed-out frame (`AuthShell`) shows a text wordmark "BOE One" in brand colours instead of the logo image; logo files in `public/branding/` (`boe-one-logo-full.png`, `boe-one-logo-horizontal.png`,
`boe-icon.png`, `favicon.png`). No dark mode. PDFs/print layouts/Excel exports deliberately keep their own colours
(PR #314 matched only the PDF accent red). `.boe-badge-urgent` was once referenced but undefined - now defined next to
`.boe-badge-blocked`.

## 7. Key components & lib files

- Auth: `src/app/login|forgot-password|reset-password/page.tsx`, `src/components/auth/AuthShell.tsx`,
  `src/lib/auth/recoveryLink.ts`, `src/lib/safeReturnPath.ts`.
- Clients: `src/lib/supabase/{client,server,admin}.ts`, `src/lib/users/safeColumns.ts`.
- Shell: `src/components/layout/{ModuleGuard,DashboardLayout,BoeOsLayout,Providers,ModuleSwitchButton,MobileBottomNav,
  NotificationsNavItem,AdminViewModeControls,BoeBrandIcon,PageShell,ModuleRouteFallback}.tsx`, `src/contexts/{ViewAsContext,RefreshContext}.tsx`.
- Permission context: `src/hooks/queries/{usePermissionContext,useDisplaySubject,useProfile}.ts`.
- Launcher: `src/app/modules/page.tsx`, `modules.module.css`, `src/lib/modules/moduleOrder.ts`, `src/hooks/queries/useModuleOrder.ts`.
- View As: `src/lib/viewAs.ts`, `src/app/api/view-as/subject/route.ts`, `src/app/super-admin/view-user/[userId]/page.tsx`.
- Navigation helpers: `src/lib/navigation/{appHistory,moduleNav,recordReturn,urlMirror}.ts`, `src/lib/listState.ts`, `src/hooks/useListUrlState.ts`.
- Error boundaries: `src/app/error.tsx`, `src/app/global-error.tsx` (PR #234: Try again / Reload / Go to Modules).

## 8. Decisions made & why

- Roles carry no module access; access is per-person (module 09). A manager is not special.
- Fail closed everywhere a permission answer is unresolved (guard shows loading, never content).
- The permission resolution lives in a hook, not the root provider: hoisting it was measured and reverted (+4 KB on every
  route, requests on pages that do not need them).
- Cards from the engine first, personal order second; a preference table grants nothing.
- Region moved to hnd1 to sit beside the database; functions are not edge.
- Rebrand left generated documents (PI/quotation PDFs, QR export, approval slip) untouched on purpose.
- No dark mode.

## 9. Known traps / gotchas / unfixed defects

1. `src/lib/permissions/moduleParentGate.test.ts` is a SOURCE-CONTRACT test: it pins `ModuleGuard.tsx` and
   `modules/page.tsx` wiring (three-hop path `ModuleGuard / launcher -> usePermissionContext -> getEffectivePermissionsForUser`)
   and `employee_records -> src/app/admin/members/layout.tsx`. Any edit there breaks it by design - that is why
   `/admin/members` still has a layout with a ModuleGuard though the page only redirects.
2. About 9 test files literal-string-pin `src/app/modules/page.tsx`; change it and read them first.
3. `router.prefetch(` matches the naive `/fetch\(/g`; use `/(?<!pre)fetch\(/g` in source-count tests.
4. supabase-js returns `{data:null, error}` and does not throw: always `if (error) throw error` inside a `queryFn`, or an
   empty result is cached for the whole stale window.
5. An inline `style` beats any media query; mobile overrides need CSS-module classes.
6. No middleware: do not assume an unauthenticated request is bounced before a page renders.
7. Deactivating or soft-deleting a user does NOT end their Supabase session (see section 4).
8. `/api/reset-password` min 6 chars vs UI 8; `/api/update-employee` and `/api/create-employee` have different role
   allow-lists (`update-employee` = admin only at this commit; `create-employee` = admin or manager).
9. `/api/performance` (module 13) and some role-based leftovers (`/manager`, `/tasks/all`, `/api/task-detail`) predate the
   permission engine.
10. A route added under `src/app` leaves a stale `.next/dev/types/validator.ts`; delete `.next/dev/types` before `tsc`/`next build`.
    Folders starting with `_` are not routes. Any page that calls `useSearchParams` needs a `<Suspense>` boundary or `next build` fails.
11. JSX whitespace in Next 16.2.6: write `{' '}` after an inline element before an entity. A heredoc eats backslashes in
    generated regex source (memory); the rebrand also had ES2017 regex-flag issues that only fail `next build`.
12. The local `supabase/config.toml` is gitignored and may ship `[db.migrations] enabled=false`, which makes
    `supabase db push --linked` silently report "up to date" (unverified, from memory).
13. `vercel link` pulls `.env.local` (production credentials). Never give test suites `.env.local`: the only configured
    project is production and live-DB suites write fixtures.
14. Cross-module `router.prefetch` runs on INTENT only, never in a load effect: a prefetched route brings its CSS, which the browser preloads and then reports as "preloaded but not used". On Module cards intent is the pointer RESTING for 250 ms (`INTENT_DWELL_MS`; leaving or unmounting cancels), keyboard focus, or touch-start. Raw pointer-enter was not enough (2026-11-11: hovering four cards on the way to Sales left four unused preloads). Quick Actions still warm on pointer-enter. Guard: `src/app/modules/intentPrefetch.test.ts`.

## 10. Tests that guard it

- **Styles, every screen (2026-10-31):** `src/app/stylesDefined.test.ts` fails when a className names a class with no rule, or a `styles.x` its module does not define; `NO_RULE_NEEDED` holds the reasoned exceptions and fails when one goes stale. `ui` and `cc` hand stylesheets on under other names: a new one like them goes in `HANDED_ON`. It cannot see a run-time name, or a rule gone while the name survives in another rule, as `.od-pair` did (pinned in `orderDashboardSummary.test.ts`). `.boe-spin` in `globals.css` is the busy icon.

Run one file: `npx tsx --test <file>`; whole suite: `npm test` (`tsx --test "src/**/*.test.ts" "src/**/*.test.tsx" "scripts/**/*.test.mjs"`).
At #327 a clean `main` has 0 failures without a database (live-DB suites SKIP; `REQUIRE_LIVE_DB_TESTS=1` turns the skip
into a failure). Never run two suites at once against the same linked project (shared fixtures).
Relevant: `src/lib/auth/recoveryLink.test.ts`, `src/lib/safeReturnPath.test.ts`, `src/lib/supabase/adminClient.test.ts`,
`src/lib/viewAs.test.ts`, `src/lib/modules/moduleOrder.test.ts`, `moduleOrderStorage.test.ts`,
`src/lib/modules/forYouCatalogue.test.ts`, `forYouWork.test.ts`, `src/app/modules/forYouSettings.test.ts`,
`src/lib/permissions/moduleParentGate.test.ts`, `moduleVisibility.test.ts`, `uiEnforcement.test.ts`,
`src/lib/users/noStarSelect.test.ts`, `src/lib/security/usersPrivateColumns.test.ts` (live DB),
`src/lib/navigation/*.test.ts*`, `src/components/layout/controlCenterNav.test.ts`, `boeOsDrawerInert.test.ts`,
`attendancePayrollNav.test.tsx`, `src/hooks/useScrollLock.test.ts`, `src/lib/testDiscovery.test.ts`.

## 11. Open items / next planned work

- Repo contains stray root files (`dashboardlayout-diff.txt`, `hboardlayout-diff.txt`, `diag_xls.js`, `read_xls.js`,
  a PNG, `CLAUDE_START_HERE.md.txt`) - cleanup candidates.
- Dead local task-creation modals (module 11) and the orphan `/api/performance` route.
- Universal use of `adminClient()` is not done.
- Notification-region proposal `docs/proposals/notifications-function-region.md` is superseded by #321 (hnd1 applied).
- Migration-from-empty-database blocker (`docs/migrations-are-not-self-contained.md`) is open.

## 12. Recheck before changing this module

Read first: `src/components/layout/ModuleGuard.tsx`, `src/hooks/queries/usePermissionContext.ts`, `useDisplaySubject.ts`,
`src/components/layout/Providers.tsx`, `src/lib/permissions/moduleVisibility.ts`, `src/lib/viewAs.ts`, `vercel.json`,
`docs/BOE_VISUAL_IDENTITY.md`, `docs/BOE Master Context/BOE_GLOBAL_NAVIGATION_STANDARD.md`.
Run: `npx tsx --test src/lib/permissions/moduleParentGate.test.ts src/lib/viewAs.test.ts src/lib/modules/moduleOrder.test.ts`,
then `npm run lint`, `npx tsc --noEmit`, `npm run build` (build catches Suspense/regex-flag issues tests miss).
Query (read-only, linked project): `select module_key, visibility_type, allowed_user_ids from app_modules;` and
`npx supabase migration list --linked` (needs a non-empty `remote` column to prove a migration is applied).

## Phones: content first, Phase 1 (2026-11-05, owner; plan approved "yes to all"; no SQL; PR pending)
- **Why.** An audit of all 182 pages at 390px (six reviewers, code-read estimates) scored most pages 4 to 6.5 of 10 on a phone: a 125 to 220px sticky header, number-card grids of 200 to 650px, filter rows of 2 or 3 lines, ~15 tables scrolling sideways, and many controls under 44px. The owner asked for 8.5 to 9 on every page, phones only, using the UI/UX Pro Max skill (now in `.claude/skills/ui-ux-pro-max`, MIT, from nextlevelbuilder/ui-ux-pro-max-skill).
- **Phase 1 (shared, this PR).** (1) Header: one row on every layout (`globals.css` "PHONES: CONTENT FIRST"); title and subtitle one line each. `PhoneHeaderMenu` (`components/layout/PhoneHeaderMenu.tsx`) holds layout-owned actions on a phone: Finance's Hand over cash and the Orders/Finance switch, Orders' switch, Task Management's Self/Delegate Task as one "+". `useModuleSwitch(target)` in `ModuleSwitchButton.tsx` is the one visibility rule for both the button and the menu item. Meetings' help button is an icon. Control Center's group label is hidden. Attendance & Payroll's actions no longer take a row of their own. Samples gained the ☰ button (its tabs and Notifications were unreachable on a phone). (2) `.fin-stats` is a sideways chip row. (3) `FilterChip` panels open as bottom sheets; the search is 44px. (4) `PhoneTableCards` (`components/ui/PhoneTableCards.tsx`) labels cells from the `<thead>` and shows rows as cards below 768px; `CcTable` uses it. (5) NotificationsView tools are 44px icons and its pills 40px; `StatusTabs` are 44px.
- **Traps.** The new sheet classes are `boe-psheet*`: `.boe-sheet`, `.boe-sheet-head` and `.boe-sheet-close` already belong to `PayrollModal`. `.boe-desktop-only` / `.boe-phone-only` use `!important`. `PhoneTableCards` sets `data-label` after every render (an effect), so the first paint on a phone has unlabelled cells for one frame. Checked at 390px with a static copy of the markup and the real `globals.css` (Playwright); not seen signed in.
- **Phase 2 (same PR).** The pages that were broken on a phone: Showroom inquiry detail (inline `1fr 340px` grid left the main column almost no room; `.sra-inq-*` stack it), Quotation Requests (six columns needed ~700px and Notes/View were cut off; `.qtn-row` is a three-line card), Sales Notifications (SalesLayout had no `actions`, so Mark all read / Delete all never rendered), Manager (Live and Assign Task are desktop-only; the header's "+" covers Assign) and All Tasks (the back link is an arrow on a phone).
- **Phase 1-2 merged** as #612 (cf3591be), deployed 2026-11-05.
- **Phase 3 (2026-11-05, PR pending, no SQL).** Per-module phone redesigns, built in five parallel worktrees and merged here. Each module's phone CSS is one block at the end of `globals.css` headed `PHONE PHASE 3 — <MODULE>` (Finance, Orders, Sales/Leads/Showroom/Reviews/SEO/Marketing, Tasks/Meetings/Admin) or in the module's CSS modules (Attendance & Payroll). Estimated phone scores after (static 390px harness renders, not signed in): Finance 8-9 (Payment Requests and Bank as 3-line cards, Reimbursements search + Filter sheet, the notices strip one expandable line); Orders 8-8.5 (dashboard tiles 2×3, Drafts and BDPI 3-line cards, payment plan cards, Confirmed Order header 24px number); Attendance & Payroll 8-8.5 (My Attendance requests as one line, My Payroll month cards, ObjectionQueue cards, credits balances first; `HeaderActions` and `PhoneSheet` in `components/attendancePayroll/`, dossiers 03 and 05); Tasks/Meetings/Admin 8-8.5 (`components/tasks/PhoneListTools.tsx` chips + search + Filter sheet, meeting actions in ⋯, Control Center tabs/controls 44px, Permissions list folds to the chosen person, Team Performance and Assets filters in sheets, `/super-admin` added to the task-create hidden routes); Sales/Leads/Vendors/Showroom/Reviews/SEO/Marketing 8-8.5 (`components/phoneFilters/PhoneFilterSheet.tsx` and `useIsPhone.ts`, Exhibition Leads one Filters button, Product Master cards with a ⋯ menu, SEO `VerdictPanel`, campaign cards, charts drawn narrower on phones). Shared fixes found on the way: the compact header could wrap, Orders chips 40px, sheet Close/Clear 44px, Attendance title basis 140px.
- **Phase 3 traps.** Three near-identical filter-sheet components were left (`orders/all/PhoneListControls`, `tasks/PhoneListTools`, `phoneFilters/PhoneFilterSheet`, plus `attendancePayroll/PhoneSheet`) because the first hard-codes "Show N orders"; folded into one set on 2026-11-05 (see "Phones: one filter set" below). Charts that switch size with `useIsPhone` draw the desktop size for the first frame. The phone-block tests (`phoneOrders`, `phoneFinance`) slice `globals.css` from their heading to the next `PHONE PHASE 3 —` heading, so keep those headings. Not seen signed in or on a device.
- **Phase 3 merged** as #613 (b5dc116f), deployed 2026-11-05.
- **Phase 4 (2026-11-05, PR #614 squash-merged as 5a66c28, no SQL).** A second read-only scoring pass over every page (four reviewers, code-read estimates) listed every page still below 8.5; four worktrees fixed them, merged here. (1) **Sticky works on phones now:** `.boe-main-content` is `overflow-x: clip` below 768px (was `hidden`, which made it the scroll container, so the page header and every sticky save bar scrolled away; checked with Playwright: header top 0 after a 1200px scroll, -1200 before). (2) Attendance & Payroll: employee detail and list, upload (sticky Confirm), correction log (ObjectionQueue folds to one line on a phone), requests, Minop, today, monthly review, payroll runs, settings (save bar only when dirty), results, two 11px labels. (3) Tasks, core, admin: Quick Start Guide, `NotificationRow` on phones (auto right column, 44px trash/checkbox, row tap), task/self-task/quotation forms stacked with 44px controls (`type="tel"` phone), Quotation Requests search + Filter sheet, Account, Meetings guide, Control Center For you / data management / test-data cleanup / order notifications / announcements, Settings roles, My Credits, All Tasks pager, login/forgot/reset (44px links, `autoComplete`), Coming soon. (4) Sales, Showroom, Samples: Samples cards stack with a status chip row and 44px actions, Samples notifications icons, Showroom categories and QR, vendor forms 44px, Sales board phone breakpoint 700→767 with Call + ⋯ per card, import, public Showroom join/scan/product (16px inputs, sticky Add), Lead Master new, Exhibition Leads ranking (its "How is this counted?" was hidden by Phase 3's `.scopeLine` rule; fixed) and exhibitions, Inventory detail. (5) Orders & Finance: Edit PI (sticky save bar), Founders (month grid as cards, sheet filters), Expenses and Received header icons, Orders import chips, dispatch heading and sticky save, Operations view sizes, PI draft header icons, payment plan sticky bar, customize-learning, the Confirmed Orders filter sheet 40px options.
- **Phase 4 traps.** The Add lead Save bar, the attendance upload Confirm bar and the Payroll Rules save bar (only while unsaved) are `position: fixed` on a phone (built before the clip change; they still work). On a phone ObjectionQueue folds to one line on the correction log, payroll results and monthly preview. The phone test files slice `globals.css` from their own `PHONE PHASE 3/4 — …` heading to the next one; keep those headings. `finalApprovalScope.test.ts` holds the Orders import screen's cards byte-for-byte against commit 700a30c7, so their 20px side padding stays on a phone; in a shallow clone that commit is missing and the test skips silently, so fetch it (`git fetch --depth=1 origin 700a30c7a978ee0f6bcc92c5616bd9d6b39978f8`) before trusting a local run. For you and data management keep the desktop legend/lists and add a folded phone copy hidden by CSS. Product new/edit `.field-helper` needs `!important` to beat the page's own `<style>`. Not seen signed in or on a device.
- **Next.** The owner scores the preview; anything still below 8.5 gets a follow-up.
- **Tests.** `components/layout/phoneShell.render.test.tsx`.

## Phones: one filter set (2026-11-05, owner; plan agreed "yes, go ahead"; no SQL; PR #616 squash-merged as f6d855a2)
- **Why.** Phases 3 and 4 left four near-identical phone filter sheets. They had the same markup but different names ("Show N orders" was hard-coded), so every fix had to be made four times.
- **What.** One set in `src/components/ui/PhoneFilters.tsx`: `PhoneChips` (sideways chip row; `label` is the group's aria label, `rowClassName` defaults to `boe-p3-chips`, Orders passes `orders-phone-chips`), `PhoneSearchBox`, `PhoneSearchFilter` (the `boe-p3-tools` row: search + one Filter button + extras; "Show N <noun>"), `PhoneFilterSheet` (the button + bottom sheet: `label`, `title`, `ariaLabel` (defaults to `title`), `icon` (sliders by default, `null` for none), `activeCount` badge, option `groups` and/or `children`, optional `onClearAll`, `applyLabel` + `onApply`, `triggerClassName` / `sheetClassName`), `PhoneOptionGroup`, `PhoneMultiGroup`, `PhoneSheetField`, `showResultsLabel(n, [one, many])`. `useIsPhone` moved to `src/components/ui/useIsPhone.ts`. Deleted: `app/orders/all/PhoneListControls.tsx`, `components/tasks/PhoneListTools.tsx`, `components/phoneFilters/` and `components/attendancePayroll/PhoneSheet.tsx`.
- **Callers.** Orders (`/orders/all`), every Tasks list, Quotation Requests, Meetings and Follow-ups, Control Center members, Team Performance, Assets, the cancelled archives, Lead Master, Sales Team, Vendors, Customer Reviews reports and custom submissions, Attendance records, employee detail and Minop incoming, and the two charts that use `useIsPhone` (Reviews, SEO).
- **Phone markup unchanged.** Each caller passes the classes it had before: Tasks get `boe-p3-filter` (from `PhoneSearchFilter`); Sales/Vendors/Reviews get `boe-phone-only p3-filter` + `p3-sheet`; Attendance gets its module's `phoneOnly sheetTrigger` + `sheet` and `ariaLabel="Filter"`, and the employee page `icon={null}`. Desktop draws nothing new; no CSS rule changed (comments only).
- **Traps.** The sheet's group headings are `p3-sheet-<id>` everywhere now (Orders' were `orders-sheet-<id>`; only `aria-labelledby` used them). The class order on some buttons moved (`orders-phone-filter` first). A new phone list should use this set; `phoneFilters.render.test.tsx` fails if another file draws `orders-sheet-head` itself.
- **Tests.** `components/ui/phoneFilters.render.test.tsx` (new). Retargeted on purpose: `app/orders/all/phoneListControls.render.test.tsx`, `app/tasks/phoneTasksAdmin.render.test.tsx`, `components/phoneSalesShowroom.render.test.tsx`, `components/attendancePayroll/phoneAttendancePayroll.render.test.tsx` (each also checks its pages pass their classes).
