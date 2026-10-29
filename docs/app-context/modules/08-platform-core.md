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
- Unread badge counts via `useUnreadCountState('task'|'finance'|'order')`, only when the person may open that module.
- Phone layout (2026-10-27 redesign), measured on the launcher's own width with container queries in
  `src/app/modules/modules.module.css`: up to 719 px the Essentials are ONE row of equal tiles (icon over name,
  ~100 px, `grid-auto-flow: column` so 1-2 Essentials share the width); up to 479 px "All modules" is ONE rounded
  white surface of 52 px rows (32 px icon chip, 15 px name, chevron) split by hairlines. The chevron
  (`styles.cardChevron`, compact tiles only, not in edit mode) is `display: none` at every other size. Edit order
  uses the same list (dashed hairlines; the held card gets its own ink edge). Desktop/tablet (>= 480 px compact, >= 720 px Essentials) are unchanged. Layout values live in the CSS
  module because inline `style` beats media queries. Pinned by `moduleCardSurface.test.ts` (PHONE_LIST /
  PHONE_ESSENTIALS) and the dimension list in `src/lib/modules/moduleOrderStorage.test.ts`.
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

Dashboard (`/dashboard`, Task Management home): bands "Top 3 Focus", "Needs Your Attention", counters. Primary data is one
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
14. Cross-module `router.prefetch` runs on INTENT only (pointer-enter / focus / touch-start on Module cards and Quick Actions), never in a load effect: a prefetched route brings its CSS, which the browser preloads and then reports as "preloaded but not used". Guard: `src/app/modules/intentPrefetch.test.ts`.

## 10. Tests that guard it

Run one file: `npx tsx --test <file>`; whole suite: `npm test` (`tsx --test "src/**/*.test.ts" "src/**/*.test.tsx" "scripts/**/*.test.mjs"`).
At #327 a clean `main` has 0 failures without a database (live-DB suites SKIP; `REQUIRE_LIVE_DB_TESTS=1` turns the skip
into a failure). Never run two suites at once against the same linked project (shared fixtures).
Relevant: `src/lib/auth/recoveryLink.test.ts`, `src/lib/safeReturnPath.test.ts`, `src/lib/supabase/adminClient.test.ts`,
`src/lib/viewAs.test.ts`, `src/lib/modules/moduleOrder.test.ts`, `moduleOrderStorage.test.ts`,
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
