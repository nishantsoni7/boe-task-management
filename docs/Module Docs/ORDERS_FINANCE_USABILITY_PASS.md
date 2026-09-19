# Orders & Finance Usability Pass

Status: **UI, navigation and loading only.** No migration. No change to any
business status, financial calculation, allocation rule, permission, grant or
RLS policy. This is not Phase 2 of the payment work: no voids, refunds,
reversals, customer credit, dispatch gates, or fabric or finish workflows.

Base: `origin/main` at `8e809efa` (PRs #165, #166, #168, #169 and #170 merged;
production migrations applied through `20261218000000`).

---

## 1. What the audit found

Each route was audited statically: purpose, actions, entrances and exits,
related-record links, request waves, blocking reads and responsive
behaviour. Each was then measured in a production build. Measurements used
the `next start` build against the production database, signed in as an
admin, read-only. The table covers the problems the pass fixed or chose to
leave.

| Route | Primary decision | Main findings (before) |
| --- | --- | --- |
| `/orders` | What needs me: drafts, the review queue, money | Returned a full-screen spinner until profile, 2 permission reads and 7 counts landed (about 850 ms). Stat cards were clickable `<div>`s that a keyboard could not reach. Running-order rows could not be opened in a new tab. |
| `/orders/drafts` | Which PI to open or review | Full-screen spinner (about 830 ms). The review-queue table was wider than its card at every desktop width: 87 px too wide at 1440, 247 px at 1280, 503 px at 1024, so it scrolled sideways. "Open" was a button, not a link. |
| `/orders/drafts/[id]` | Submit, review, approve, record payments | 4 waves of reads blocked first paint: the draft itself cost a whole round trip before the reads keyed only by its id could start. A quiet refresh that failed replaced the whole record with an error card. Back always went to PI Drafts, even from Finance. "Open Order" carried an external-link icon but navigated in the same tab. |
| `/orders/all` | Find and open a Confirmed Order | Tab, search, assignee, source, date and sort lived only in memory: Back from an Order reset them all, and the page reloaded behind a spinner. No phone layout: 8 columns scrolled sideways. Rows had no real link. Stale "Request deleted" copy mentioned a retired route. |
| `/orders/[id]` | Operate the Order | Back was `router.back()`, which leaves the app from a fresh tab. The "no source PI" block flashed on Orders that do have a PI (`piHandoff` starts as `'none'`). "Finance record" was a button, not a link. |
| `/orders/import` | Is this PI ready to save? | Titled "New Order" although the entry says "Upload PI". There was no exit except the sidebar. Save used `push`, so Back from the new draft landed on an empty upload form. |
| `/orders/notifications`, `/finance/notifications` | Triage | Shell and skeleton were already right. "Delete all" had no confirmation and sat beside "Mark all read". |
| `/finance` | Approve, clarify or reject requests | Full-screen spinner, then the destination read awaited before first draw (3 waves). Tab, search and page were not in the URL. "Against" was plain text even for records the reader can open. Every edit swapped the table for "Loading…", which lost the scroll position. |
| `/finance/received` | Where did the money go; allocate the rest | See §3. Also: title "Received Payments" against the sidebar's "Confirmed Payments"; no URL state; Edit missing from the cards; the deep-link cleanup rebuilt the URL from scratch, which dropped filters and, on Payments to Verify, left the page. |
| Retired routes | A sensible exit | `/orders/requests*` keep their notice with exits (now inside the shell). `/finance/received/unlinked` forwarded as `?view=available`, which titled the page "Payments · Available" above every payment. |
| Shell (both modules) | Where am I? | Sidebar entries were buttons (no new tab, no `aria-current`). An Order record lit no entry; Confirmed Payments sub-routes lit nothing. The module switch read the legacy `app_modules` table, which the Finance guard no longer consults, so the two could disagree. The Finance sidebar issued 4 count queries and drew 1. |

**The largest single defect was the loading state.** On every navigation
inside a module, the page swapped the whole shell (sidebar and header) for a
100vh spinner until its first read landed. Measured, the shell was missing
for 176–1,224 ms per navigation.

## 2. What changed

### Shared foundation
- `src/lib/navigation/moduleNav.ts`: which sidebar entry is lit
  (`activeOrdersNav`, `activeFinanceNav`), and the header title while a route
  loads (`pendingModuleTitle`).
- `src/components/layout/ModuleShellControls.tsx`: the nav link (a real
  `<Link>` with `aria-current`), the Home link and the Refresh button, shared by
  both layouts. The page title is now an `<h1>`, and the entries are a `<nav>`
  landmark.
- `ModuleSwitchButton`: asks each target's own guard question. Finance uses
  `canAccessManagementModule` on the display subject (ModuleGuard's rule).
  Orders uses admin role or `orders.view` for the signed-in user (OrdersGuard's
  rule). Both answers come from the session's cached permission context, so
  the legacy `app_modules` read is gone. It is a link. On a phone it shows the
  module name alone.
- `ModulePageSkeleton` and `ModuleRouteFallback`: the shell with a
  skeleton body, used by every page's loading state and by the new
  `src/app/orders/loading.tsx` and `src/app/finance/loading.tsx`. Both sit
  inside the guards, read nothing and draw no action.
- `RecordBackLink` with `src/lib/navigation/recordReturn.ts`: Back on a
  record is a named link ("Back to Confirmed Payments"). It goes to the
  validated `returnTo` the opening list passed (`safeReturnPath`, the Task
  module's convention), or to the record's own list.
- `useMirrorToUrl` with `urlMirror.ts`: mirrors a Finance list's own state
  to the URL with `replace`, touching only its own keys.
- `destinationRecordHref` in `crossModuleLinks.ts`: the Payment Requests
  "Against" link rule.

### Lists and records
- **Confirmed Orders**:
  - Every control is in the URL (the shared `listState` codecs).
  - Scroll is restored on Back, and rows carry `returnTo`.
  - The order number is a real link.
  - There is a card list below 768 px (switched by CSS, so nothing flashes).
  - Rows stay on screen while a refresh runs.
- **Orders dashboard**: cards and running-order numbers are links.
- **PI Drafts**:
  - "Open" is a link, prefetched on hover and on focus.
  - The review queue shows submitter and date in one stacked cell, and names may wrap.
  - Cards appear below 1100 px.
- **PI record**:
  - The Back link returns to the list that opened it.
  - A quiet refresh that fails keeps the record and shows a notice.
  - "Open Order" is a link, without the misleading icon.
- **Upload PI**: renamed "Upload PI" and gains an exit to PI Drafts. Saving uses `replace`.
- **Order record**:
  - The Back link returns to the list that opened it.
  - "Finance record" is a link.
  - The "no source PI" block waits for the hand-off to answer.
- **Payment Requests**:
  - Tab, search and page are in the URL.
  - Scroll is restored on Back.
  - "Against" links to the one Order or PI only when the reader may open it.
  - Rows stay on screen during a re-read.
- **Notifications**: "Delete all" asks first.

### Loading and performance
- The shell stays up on every page load inside a module.
- `loading.tsx` boundaries give an instant shell on route change, including the two dynamic record routes.
- The Finance sidebar asks for the one count it draws (1 query, not 4).
- The legacy `app_modules` read in the module switch is gone.
- Payment Requests draws its rows before the destination read, which no longer blocks first paint.
- The PI record starts its id-only reads together with the record itself: 3 waves become 2.

## 3. Confirmed Payments

- **Header:** Record Payment is the page's primary action, in the page header where every Orders and Finance page puts its own. It is still drawn only for `finance.allocate`.
- **Toolbar:** one wrapping row of narrowing only — search, then "Paid from" and "to" as labelled bounds, then Clear filters. At 320 px each bound takes its own line.
- **Tab bar:** the allocation-status tabs head the list card, and the exact count of the whole narrowed set sits at its right. This is the same arrangement as Confirmed Orders.
- **Columns:** `table-layout: fixed` with measured compact widths. Allocated Against takes the rest (200 px floor), so it grows with the screen and the compact columns no longer crowd together on the left.

  | Column | Width | Widest measured value |
  | --- | --- | --- |
  | Payment ID | 80 | "P-ZZ-99999" |
  | Amount | 128 | "₹12,34,56,789.00" |
  | Received Date | 100 | its header |
  | Mode | 92 | "Bank Transfer" |
  | Allocation Status | 156 | "Over-allocated — review" |
  | Actions | 172 | computed |

  The switch threshold is derived: 728 px fixed + 200 px floor → 930 px (was 920). A 1280 px window still gets the table; 1024 px still gets cards. The container-measured switch and its overflow safety net are unchanged.
- **Actions:** "View" and "Allocate" are labelled buttons in fixed slots, so every control sits at the same x on every row. Edit and Delete are behind "More actions"; Delete is last, red, set off by a rule, and still confirmed by its own dialog. The cards use the same component, so they gained Edit.
- **Unchanged:** the complete active-allocation read, combined duplicate targets, the unallocated line, exclusion of reversed allocations, safe PI Draft labels, and the status badge's source.

## 4. Measurements

Environment and method:
- Local production build (`next start`), with the Browser pane on the same machine.
- Production Supabase in Tokyo, read-only.
- Each route loaded in a same-origin iframe at 1280×800.
- Median of 3 runs; one re-check used 5.
- The same harness code before and after (kept with the PR notes).
- "Shell" is the first frame with the sidebar; "content" is the first frame with the page title and no skeleton, spinner or "Loading" text.
- Script KB counts script resources the document touched, including code prefetched for visible links.

Production data is nearly empty (1 PI Draft, 0 Orders, 1 payment), so list
render cost is not exercised.

**Cold document load (median ms):**

| Route | Shell | Content | LCP | CLS | Requests |
| --- | --- | --- | --- | --- | --- |
| `/orders` | 853 → **362** | 853 → 891 | 888 → **404** | .002 → .001 | 15 → 15 |
| `/orders/drafts` | 827 → **349** | 827 → 916 | 872 → **388** | .002 → .001 | 9 → 9 |
| PI record | 1614 → **333** | 1614 → 1651 | 1640 → 1676 | .002 → .001 | 30 → 30 |
| `/orders/all` | 551 → **327** | 551 → 664 | 588 → **372** | .002 → .001 | 8 → 8 |
| `/orders/import` | 875 → **349** | 875 → 865 | 908 → **376** | .001 → .001 | 7 → 7 |
| Order (not found) | 486 → **383** | 800 → 716 | 516 → **424** | .003 → .003 | 11 → 11 |
| `/finance` | 811 → **391** | 811 → 788 | 844 → **404** | .003 → .001 | 12 → 12 |
| `/finance/received` | 1985 → **404** | 1985 → **998** | 2024 → **424** | .002 → .001 | 16 → **13** |
| `/finance/payments-to-verify` | 976 → **389** | 976 → 1068 | 992 → **404** | .002 → .001 | 12 → **9** |
| `/finance/notifications` | 507 → **356** | 1217 → **847** | 540 → **396** | .004 → .001 | 8 → **5** |
| `/orders/notifications` | 427 → 437 | 1097 → 1456 | 444 → 472 | .003 → .003 | 7 → 7 |

Two routes need caveats:
- `/finance/received`: before, the three runs were 6.4 s, 0.9 s and 2.0 s; after, 4.4 s, 0.8 s and 1.0 s. The network was noisy in both sets. The request drop (16 → 13) is structural: three unused sidebar counts are gone.
- `/orders/notifications`: its content wait is the `/api/notifications` route and is unchanged by this pass.

**Warm client-side navigation (median ms to content):**

| From → to | Before | After | Shell lost during navigation |
| --- | --- | --- | --- |
| PI Drafts → PI record | 1482 | **963** | 1224 ms → **0** |
| PI record → PI Drafts | 558 | 533 | 448 ms → **0** |
| Dashboard → PI Drafts | 561 | 594 | 280 ms → **0** |
| Dashboard → Confirmed Orders | 279 | 310 | 184 ms → **0** |
| Confirmed Orders → Dashboard | 353 | 385 | 192 ms → **0** |
| Payment Requests → Confirmed Payments | 575 | 566 (5-run re-check) | 328 ms → **0** |
| Confirmed Payments → Payment Requests | 382 | 431 | 248 ms → **0** |
| Orders → Finance (module switch) | 357 | 415 | 176 ms → **0** |
| Finance → Orders (module switch) | 1041 | 827 | 560 ms → 168 ms (the Orders guard re-checks access, by design) |

### What these numbers do and do not show (corrected 2026-09-19)

**Shown:**
- **Continuity.** The shell (sidebar, header, page title) is never lost inside
  a module, and it appears at about 330–400 ms on a cold load instead of only
  when all the data has landed. This is a real improvement in perceived
  navigation, and the largest effect of the pass.
- **Structural reductions:**
  - One network wave less on every PI open. This is the one clear content-time
    gain: warm 1,482 → 963 ms.
  - Three fewer count queries on every Finance page.
  - One fewer permission read per shell mount.

**Not shown:**
- **Faster business data.** The LCP drop comes from the skeleton-and-header
  shell becoming the largest early paint. It does not show that the data a
  reader needs arrives sooner.
- **Faster content on most routes.** "Content" (the page's data on screen) was
  statistically unchanged on most routes, and slower in several of these
  3-run medians:
  - `/orders/drafts` 827 → 916
  - `/orders/all` 551 → 664
  - `/finance/payments-to-verify` 976 → 1,068
  - `/orders/notifications` 1,097 → 1,456
  - Dashboard → PI Drafts 561 → 594
  - Confirmed Payments → Payment Requests 382 → 431
  - Orders → Finance 357 → 415

  With three runs on a network that varied by ±60 ms and more, most of these
  are within noise. A plausible real cost is that production `<Link>`s
  prefetch visible destinations while the first page is still loading. The
  script bytes counted per route rose for that reason. This has not been
  isolated.

**Limits of the evidence:**
- **Nearly empty data.** Production held 1 PI Draft, 0 Orders and 1 payment,
  so list rendering, paging and large-table behaviour were not exercised.
- **No throttled-mobile timings.** The Browser pane has no network or CPU
  throttling, and reproducing the signed-in session in another browser would
  have meant copying session tokens. Phone widths were checked for layout
  only.
- **No large-list timings.** Representative Confirmed Orders, Payment Requests
  and Confirmed Payments volumes were not measured.

**Follow-up performance work (not done here):**
- A representative-data profile of all lists on a disposable database.
- A throttled-mobile profile.
- Measuring whether viewport prefetch should be reduced to hover or focus on
  data-heavy pages.
- Server-side paging for Confirmed Orders.
- Lazy PI thumbnails.

These are open performance questions, not a verified performance result.

## 5. Security review

- No SQL, RLS, grant, RPC or migration changed.
- No capability is derived differently.
- Every page still resolves its own capabilities from the database before any action is drawn. The Orders startup-shape tests, which forbid cross-load caching in screens, still pass.
- The shell and skeleton read nothing and offer no action. The guards are unchanged.
- The module switch now uses the same cached permission context as `ModuleGuard` and `/modules`. It fails closed until that context is ready, and the target guard stays authoritative.
- Related-record links are drawn only where the reader has Orders module entry and the record came back under the reader's own RLS. For Payment Requests, a non-null `reference` from the `security_invoker` destinations projection is that evidence. The destination page re-reads its record under the same session.
- `returnTo` accepts only a same-origin path (`safeReturnPath`: no scheme, no `//`, no backslash, no control characters).
- URL state carries filters and page numbers only. No record data or personal data goes into the URL.
- No service-role key in the browser, and no protected query moved.

## 6. Deferred, deliberately

- **Confirmed Orders still loads its list whole** and filters in the browser, as before. With 0 Orders today that is fine. Server-side paging needs server-side search across joined names and per-tab counts, which is its own change. It should be done before the table reaches a few hundred rows.
- **The PI record still signs every thumbnail before first paint.** Deferring images below the fold would take another round trip off; it touches the pinned `piPreview.tsx`.
- **The Order record's status menu** still lets Dispatched be chosen without a confirmation. That is a business-process decision.
- **Payments to Verify** keeps its own viewport rule and table, as before.
- **A throttled-mobile timing profile and a representative-data profile**, as noted in §4.

## 7. Correction pass (2026-09-19)

Three defects found in review were fixed on the same PR:

1. **Confirmed Payments empty state.**
   - **The defect.** An empty allocation-status tab (Zero, Partial, Full or
     Over) said "No payments received yet" while payments existed in other
     tabs.
   - **The fix.** `confirmedListEmptyKind` now separates four cases: loading;
     read failure (which takes precedence over every empty statement); no
     payments at all (only when nothing constrains the list); and no match
     for the search, dates or status tab.
   - **The recovery action.** A filtered empty list offers one action,
     "Show all payments". It clears search, dates and status and returns to
     page 1; the URL mirror then drops those parameters.
   - **Unchanged.** The toolbar's "Clear filters" still covers search and
     dates only. The database filter, paging, counts and the
     complete-allocation source are unchanged.
2. **Confirmed Orders search.** A pending search term is flushed on blur, as
   on the Task lists. An Order opened straight after typing gets its
   `returnTo` from the term as typed (trimmed), because the blur flush only
   schedules the URL change before the click reads it. The 250 ms debounce
   and replace-history behaviour are unchanged.
3. **Notifications sidebar entry.** It is a real `<Link>`, like every other
   destination. The active styling, `aria-current`, unread badge and label,
   `onNavigate` and per-module `href` are kept. The manual `router.push` and
   `router.prefetch` are gone.
