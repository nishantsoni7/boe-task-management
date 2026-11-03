# 28. Sales — Lead Board

Written 2026-11-03 from the build, merged as PR #594 (05e299ed) and deployed. Migration `20270525000000_sales_lead_board.sql` is applied. It sits on the Lead Master (module 27): the same lead record, worked after it has been allotted.

## 1. Purpose & users

- The owner asked on 2026-11-03 for a lead management system to replace the ClickUp boards ("Best of Exports", one folder per salesperson), on the level of Salesforce, Zoho CRM and LeadSquared, but only the proven, practical features, and easy enough to need no training. BOE sells furniture wholesale to hospitality clients in India and abroad.
- ClickUp as found (one salesperson's board, 2026-11-03): most open leads were overdue. Statuses mixed how far a sale had come with what kind of lead it was. The interaction log was a comment with a WhatsApp screenshot.
- Users: salespeople, mostly on phones; managers and the owner reading across people. The design was drawn, rated and approved by the owner as a mock-up first (`~/BOE-Development/temporary/lead-board-mock/`), with the UI/UX Pro Max rules.

## 2. Status

- **PR #594:** My day, the board, the lead panel, the stage checklist, No answer, WhatsApp quick messages, Undo, repeat enquiries, and who sees what in the database.
- **PR #595 (972413c3, merged 2026-11-03; `20270526000000` and `20270526000100` APPLIED before the merge):** the ClickUp import, the Team page, Control Center's Sales team tab, the Sales inbox and alerts.
- **Review fixes and ClickUp's full history (migration `20270527000000`, APPLIED 2026-11-03):** a full review of the flow as salesperson, manager and Admin found ten problems; all are fixed (rules 17 to 23). The import can now take every ClickUp comment with its own date and author.
- **Can be given leads (#603, migration `20270529000000`, APPLIED 2026-11-03):** a per-person tick on the Sales team tab (rule 25).
- **The old Google Sheets (#605, migration `20270530000000`, APPLIED 2026-11-03):** Leads Master and Website Leads came into the Lead Master (rule 26), imported in production the same day: 3,874 old leads, 12,868 fills. The ClickUp import ran first: 10,960 leads, 87,316 comments, 44,895 status changes.
- **Website leads arrive by themselves (migrations `20270531000000` and `20270531000100`, NOT APPLIED when written):** Phase 2 of the owner's plan (rule 27). Phases 3 to 5 (automatic allotment, quick add, WhatsApp) are not built.
- **The Pipeline board and the short lead panel (migration `20270601000000`, NOT APPLIED when written):** the owner's design, closed 2026-11-03 after three layouts were shown as an interactive preview (rule 28). The page no longer scrolls, each stage is its own scroller that keeps loading as you reach its end, a card is two lines, and the lead panel is 468px wide with about 14 controls instead of about 30. Not seen signed in.
- **Not built:** automatic capture and automatic allotment (section 11).
- Checked by `tsc`, lint, the tests in section 10, and the real migrations in an in-memory Postgres (the whole journey: 50 checks). The live pages and bundle were checked after the #595 deploy. **Not yet seen signed in.**

## 3. Pages and routes

| Route | Screen | Who |
|---|---|---|
| `/sales` | redirects to `/sales/my-day` (it used to go to the Lead Master) | module users |
| `/sales/my-day` | `MyDayScreen`: progress, the lists (All, New, Overdue, Today, Hot), one Next lead, the rest in order | `view`; shows the signed-in person's own leads |
| `/sales/board` | `BoardScreen`: one toolbar row (search, "Leads of" menu, Filters menu, a totals line that opens the four totals), five columns that each scroll and load on their own, the Converted and Dead strips. `?lead=<id>` opens a lead | `view` sees own; see section 5 |
| `/sales/lead-master` | module 27, now limited as in section 5 | the Lead Master item shows for `create`, `assign` or `view_all` |
| `/sales/team` | `TeamScreen`: At risk now, who has not punched in, filters, four totals, where leads drop off, why they die, who is keeping up | `view_all`, `assign`, Admin |
| `/sales/import` | `ImportScreen`: CSV files and the history file, who gets what, follow-ups a day, what each status becomes, Import | `assign`, Admin |
| `/api/sales/capture/website` (POST) | new website enquiries from the Website Leads sheet script, `Authorization: Bearer SALES_CAPTURE_SECRET` | the script |
| `/api/sales/alerts/morning`, `/api/sales/alerts/evening` | the two daily alerts, called by Vercel Cron with `CRON_SECRET` (the slot is in the path since 20270527: a query string in a cron path is not documented) | the scheduler |
| `/sales/notifications` | the shared `NotificationsView`, `category="sales"` | everyone in Sales |
| Control Center → Access → Sales team | `SalesTeamTab`: each person's job, Can add leads, a senior's juniors | Admin |

`SalesLayout` has three items and, on a phone, a bottom bar (`boe-mobile-bottom-nav`, its own items: `MobileBottomNav` is Task Management's). Board filters live in the URL.

## 4. Database (`20270525000000_sales_lead_board.sql`)

- `sales_leads` gains `stage` (new, under_process, potential, negotiation, follow_up_later, converted, dead), `stage_changed_at`, `temperature`, `segment`, `client_type`, `quantity`, `timeline`, `expected_value_paise`, `next_step`, `next_due_on`, `first_attempt_at` (stops the Waiting clock; No answer counts), `first_contact_at` (a real reply), `last_activity_at`, `last_kind`, `no_answer_streak`, `enquired_again_at`, `dead_reason`, `dead_note`, `closed_at`, and generated `market` (+91 domestic, otherwise export).
- **CHECK `sales_leads_open_has_next_step`:** an allotted open lead always has a next step and a date. **CHECK `sales_leads_dead_has_reason`.**
- `sales_lead_activities`: the log. Append-only except `undone_at`, by trigger. `prior` holds what Undo puts back.
- `sales_lead_access` (viewer, subject): a senior's named juniors. A browser reads only its own rows and writes none.
- `sales_lead_events` gains the kinds `moved` (detail `from>to`) and `enquired_again`.
- Browser functions: `sales_my_day`, `sales_board`, `log_sales_lead_activity`, `sales_lead_no_answer`, `sales_lead_message_sent`, `undo_sales_lead_activity`, `move_sales_lead`, `update_sales_lead_facts`, `record_sales_lead_enquiry`, `sales_lead_visible` (the read policies need it). Internal: `sales_lead_sees_all`, `sales_lead_stuck`, `sales_lead_row`, `sales_lead_for_work`, `sales_lead_record`.
- Re-issued from 20270524: `sales_lead_json` (a lead the person may not see comes back as number, day, source and holder only), `sales_leads_page`, `get_sales_lead`, `allot_sales_lead` (gives the first step), and both read policies.
- `move_sales_lead` answers `{status:'needs', missing:[...]}` instead of raising, so the screen asks for the fact.
- **`20270526000100`:** `sales_leads` gains `imported_at` and `furthest_rank` (1 to 5, kept by trigger, for the funnel: a dead lead's stage no longer says how far it got). `sales_lead_imports` (one row per ClickUp task, with its non-empty fields in `raw`; no browser access). Dead reasons gain `no_requirement` and `not_relevant`. Activity kind and outcome `imported`, event kind `imported`. New functions: `import_sales_leads`, `sales_team_overview`, `sales_lead_remind`, `reassign_due_sales_leads`, `list_sales_team`, `set_sales_lead_juniors`, `sales_lead_send_alerts` (service role only), `sales_lead_notify` (internal). Re-issued: `sales_lead_stuck`, `sales_leads_page`, `get_sales_lead` (adds `clickup`), `sales_board`, `allot_sales_lead`, `record_sales_lead_enquiry`.
- **`20270527000000`:** `sales_lead_import_refs` (one row per ClickUp comment, status and exported latest comment, so a history import never adds anything twice; no browser access). Outcome `not_interested`, event kind `clickup_status`. New: `sales_lead_can_hold` (internal), `list_sales_lead_holders`, `import_sales_lead_history`. Re-issued: `sales_lead_record`, `move_sales_lead`, `update_sales_lead_facts`, `sales_my_day`, `allot_sales_lead`, `reassign_due_sales_leads`, `import_sales_leads`, `sales_team_overview`, `sales_lead_send_alerts`. Rollback in the header.
- **`20270529000000`:** `sales_lead_holding` (user, can_hold; no row = what the job means; no browser access), `set_sales_lead_holding` (Admin only; null removes the choice). Re-issued: `sales_lead_can_hold`, `list_sales_team` (adds `can_hold` and `hold_set`).
- **`20270530000000`:** `sales_leads.is_history` (an old lead from the sheets), sources `bni` and `walk_in`, `import_sales_lead_sheet` (`assign`; refused before any ClickUp import). Re-issued: `sales_lead_row` (adds `is_history`), `sales_leads_page` and `sales_board` (an old lead is not in the Not allotted queue or the waiting count), `record_sales_lead_enquiry` and `allot_sales_lead` (both bring an old lead back).
- **`20270531000000` / `20270531000100`:** notification type `sales_lead_waiting`; `capture_sales_leads` (service role only) and `sales_lead_tell_allotters` (internal). Form rows are remembered as `web:<key>` in `sales_lead_import_refs`.
- **`20270601000000`:** `sales_board_page(stage, offset, limit, holder, market, segment, temperature, source, q)`, read only, `authenticated`: the leads of ONE stage in `sales_board`'s own order (its first 60 are exactly the 60 `sales_board` returns, checked for every role), with `n` (all the stage holds under these filters), `overdue` and `due_today` (a parked, Converted or Dead lead is neither). A page is at most 100. Nothing existing is replaced. Rollback in the header.

## 5. Permissions & access

Module `sales`, actions `view`, `view_all` (new), `create`, `edit`, `assign`.

| Who | Sees | Works (logs, moves) |
|---|---|---|
| `view` | leads they hold | those leads |
| a senior named in `sales_lead_access` | theirs and the named juniors' | only their own |
| `view_all` (a manager) | every lead | only leads they hold themselves |
| `assign` | every lead, and the queue | every lead |
| `create` | also the leads they added, until allotted | those it holds |
| Admin | everything | everything |

Control Center words: **Salesperson** is `view`, with Can add leads for `create`. **Manager** is `view` and `view_all`. **Lead manager** is `view`, `create`, `edit` and `assign`. A senior is a Salesperson with named juniors. The rights go through the existing permission route, so they carry the usual audit trail.

**Who can be given a lead (since 20270529):** active, not an Admin account, a Sales job (Sales `view`), and then the **Can be given leads** tick on the Sales team tab: ticked by default for a Salesperson, unticked by default for a Manager and a Lead manager (owner, 2026-11-03: Nitish, a Manager, and the dummy test account must not show in the allocation lists). From 20270527 to 20270529 it was anybody with a Sales job. `sales_lead_can_hold` decides it for allotting, Give to someone else and the import; `list_sales_lead_holders` feeds every picker. Before, it was the Orders rule (Sales department, or the Orders assignee grant), so somebody given a Sales job outside the Sales department could not be allotted, and somebody in it with No access could.

Enforced in the functions and in RLS. **This reverses module 27's "view reads every lead".** The duplicate check still names a number's holder to anyone adding a lead, with no other detail. On the board, the "Leads of" chips and the avatars show for anyone who can see more than one person's leads, and a card can be moved only by those who may work it.

## 6. Business rules (owner decisions, 2026-11-03)

1. Every lead lands in the Lead Master, typed in or (later) captured automatically. Only an allotted lead reaches a board. Allotment is by hand, and later automatic, using attendance and past lead load.
2. Stage is how far the sale has come. Segment (Bulk, Residential, Reseller), client type and Hot / Warm / Cold are separate facts. Important Bulk, Bulk, Important Residential and Overseas are gone as statuses.
3. Domestic or Export comes from the phone number. Nobody picks it.
4. Every open lead has a next step and a date. Posting needs both.
5. A real reply on a New lead moves it to Under process by itself.
6. No answer is one tap: it logs, keeps the step, and comes back tomorrow. It is a try, not contact. At three in a row the screen asks what next.
7. Moving forward needs: first contact (leaving New); requirement and quantity (Potential client); quotation logged, expected value and timeline (Negotiation). Moving back is never checked. Only leaving New asks for contact, so an imported lead is not held back.
8. Dead asks for a reason from eleven (two added for ClickUp in #595); "Other" needs a note. Converted is a record only: **no order number and no link to Orders** (owner's choice). Every detail stays on both.
9. A red card means no update for too long: New 1 day, Under process 7, Potential client 7, Negotiation 3. Follow up later never goes red: Pipedrive users complain that a far-off planned follow-up still "rots".
10. Follow up later needs a date, and the lead returns to My day on it.
11. A repeat enquiry goes on the existing lead: a closed lead reopens as New, an open one comes to the top of its holder's day. This replaces module 27's "blocked until Lead Management".
12. Confirmed by the owner, 2026-11-03: expected value is required from Negotiation (this replaces their earlier "optional"), and the red limits stand as in rule 9. A newly allotted lead gets its first call the same working day; if it does not, the salesperson is told that evening, then manager level the next morning (`sales_lead_send_alerts`, #595).
13. WhatsApp quick messages open `wa.me` with the text filled in; the person presses send. No API, no cost. BOE One cannot see the send, so it logs an attempt, not a reply. WhatsApp screenshots on a log entry: no (owner).
14. **ClickUp import.** Every folder goes to one person, matched by first name and changeable on the screen. An open lead beats a dead one on the same number, then the one touched last; the other tasks go on it as notes. One number, one lead still holds. Importing notifies nobody.
15. **ClickUp mapping, chosen without asking as the owner instructed.** New leads is New. Under process, Transferred, Overseas, Important Bulk, Bulk and Important Residential are Under process. Important is Warm, plain Bulk is Cold, and URGENT, HIGH or a tag of imp or urgent is Hot. Potential clients and customers are Potential client; Planned visit too, with the step Meeting. Everything in a list with Dead in its name is Dead, whatever its status, including "live again". No reason recorded becomes Other, with that said in the note.
16. **Catch-up.** A follow-up still ahead keeps its date. One overdue or undated gets a new date: nobody called first, then Hot, then furthest along, then latest touched, up to the chosen number a person on each working day (Monday to Saturday). An imported lead does not go red before that date.

From the review of 2026-11-03 (owner: "fix all 10"), migration `20270527000000`:

17. **Converted is checked** like a step past Negotiation: a real contact, the requirement, the quantity and the expected value. A quotation and a timeline are not asked again. The value of a lead in Negotiation or Converted cannot be cleared, only changed.
18. **Only a step past the furthest stage a lead ever reached is checked** (`furthest_rank`). Undo, and coming back out of Follow up later to where the lead was, never ask for facts again; Undo that still needs one asks for it instead of saying "Undone".
19. **Not interested is logged as a call** (outcome `not_interested`), so the first call counts, then the Dead box asks why. It does not move a New lead to Under process on the way.
20. **An imported lead nobody has tried waits for the day the import gave it**, in My day and on the Team page's At risk list, instead of all arriving on day one. A lead added in BOE One still comes at once.
21. **A repeat enquiry since the last log** goes to the top of My day with "Came back with a new enquiry" and the Enquired again chip, however many times the lead was worked before.
22. **The lead on top of My day stays on top** until something is done to it; the once-a-minute refresh no longer swaps it. The Waiting clocks move on with each refresh.
23. **The evening "not called yet" reminder** looks only for its own earlier message that day, so a manager who also holds leads still gets it.
24. **ClickUp's full history.** `scripts/clickup-history.mjs` reads every comment (date, author, replies) and, where ClickUp keeps it, each status's start date, from ClickUp's API with the owner's own token, into `history.jsonl`. The Import page takes it with the CSVs: each comment becomes a ClickUp history entry with its real date; each status a "In ClickUp: …" line; the copy of the latest comment that the export dated by "Date Updated" is hidden; and, until something is done in BOE One, the lead's first-contact, last-contact and stage dates move to ClickUp's real ones. Running it twice adds nothing.
25. **Can be given leads** (owner, 2026-11-03), migration `20270529000000`: a tick per person on the Sales team tab, beside Can add leads. A Salesperson is ticked unless unticked (the dummy test account is); a Manager or a Lead manager is unticked unless ticked (Dhruv, if he also sells). Only a tick that differs from the job is stored, so a later change of job still counts. Every picker follows it; leads already held stay with their holder.
26. **The old Google Sheets** (owner, 2026-11-03), migration `20270530000000`. The Import page takes "Leads Master - 2026" and "Website Leads" as Excel files, after the ClickUp import (the database refuses them before). Leads Master: the year tabs (Date and Month, the year from the tab), the Export tabs (Month only), Campaign and Retailers (2026); Architects, Variables, Worker and Job are not leads. Website Leads: all_leads, Till 2025, Till 2024; rows given to a supplier or staff are not leads; a row with no date takes the date of the nearest dated row around it (the form writes in order; dated = its own date or its number in Leads Master), and says so. A number already in BOE One keeps its ClickUp stage and salesperson; the sheet fills an empty name, email or location, adds its message to the requirement, and leaves a dated line in the history ("Leads Master 2025, given to Ashok"). A number only in the sheets becomes an **old lead** (`is_history`): in the Lead Master register with an "Old lead" tag, known as a repeat, on nobody's board and outside the Not allotted queue; a repeat enquiry or allotting it brings it back. Real sheets on PGlite: 16,790 rows, 3,874 old leads, 12,868 fills, 0 refused, the queue unchanged.
27. **Website leads arrive by themselves** (owner's plan, Phase 2), migrations `20270531000000` and `20270531000100`. A script in the Website Leads sheet (`scripts/google/website-leads-to-boe.gs`, set up once by the owner) sends the rows the form added every five minutes to `/api/sales/capture/website`, which needs `SALES_CAPTURE_SECRET`. A new number becomes a lead, Not allotted, source Website or Google Ads, with the form's name, email, location and message; Admin and everybody with `assign` get "New lead from the website" (To allot). A known number is a repeat enquiry: the message is added, a held lead's holder is told and calls today, a closed or old lead comes back as New, one nobody holds goes back to the queue and the allotters are told. A row sent twice counts once (its key: a hash of number, email, name and message). Rows already in the sheet when the script is set up are not sent.
28. **The Pipeline board and the short lead panel** (owner, 2026-11-03: "close the design A with slim lead panel"), migration `20270601000000`.
    - **Board.** The page does not scroll (`SalesLayout fill`). One toolbar row: search, "Leads of" (only for somebody who sees more than one person's leads), Filters (segment, market, Hot / Warm / Cold, source), and a totals line ("1,377 open · 38 overdue · 306 today") that opens the four totals; its state is remembered on that browser (`boe.sales.board.totals`). Each column has a fixed header (name, count, how many are overdue), its own scroller that asks for 40 more when it reaches the end, and a footer ("40 of 1,070 shown", the expected value). A column can be folded (`boe.sales.board.folded`). On a desktop Converted and Dead are slim strips that open as a column; on a phone the stage chips show one column at a time. A card is two lines: a dot for Hot, Warm or Cold, the name, the next step and when it is due; a third line appears only for an export lead, an expected value, "Enquired again", or a Waiting or Stuck warning. Hover shows Call, WhatsApp, No answer and Move; drag and the Move sheet stay.
    - **Lead panel** (shared by the board, My day and the Team page). A stage pill (the menu moves the lead; a missing fact, Dead and Follow up later ask in the same small boxes as before), a Hot / Warm / Cold pill, Call and WhatsApp, the next step, then "How did it go?": Interested, Still deciding, Call back, No answer (logs at once, with Undo), Not interested, and one optional note. **Nothing is chosen until the person chooses** (the old panel opened with Interested chosen). A small selector beside the question says what kind of contact it was (Call unless changed; Meeting, Email, Quotation, Sample, WhatsApp). The next step and day fill in from the answer and show as "Next: ..., ... Change". "About this lead" shows only what is known, with one line for what is not; History shows three entries and "Show all". Gone from the panel: the five-step path, the stage checklist (the one-fact box asks when a move needs it), the stage guide line (now the tooltip of the stage pill), the Received day.
    - **Not built, offered and not asked for:** saved views, sorting by a column, a choice of card fields, bulk move, a Board / Table switch for managers, the Split view and Table layouts that were previewed.

## 7. Key components & lib files

`src/components/salesLeads/`: `MyDayScreen`, `BoardScreen`, `WorkPanel` (the short lead panel: `StagePill`, `HeatPill`, `Composer`, `About`, `History`), `BoardScreen` (`Column`, `Card`, `ToolMenu`), `src/lib/salesLeads/boardPage.ts` (`COLUMN_PAGE`, `nextOffset`, `uniqueRows`), `SalesLayout` and `SalesFrame` (`fill`), `useLeadWork` (every action, and the Move, WhatsApp, three-tries, Dead, park and one-fact dialogs, so all screens behave alike), `LeadBits`, `leadBoard.module.css`. `src/lib/salesLeads/board.ts`: stages, words, `checklistFor`, `dueOf`, `flagOf`, `rankMyDay`, `whyFirst`, `valueLabel`, `parseValue`, `countryOf`, `quickMessages`. `useToast` gained an action (Undo). `DupCallout` gained a live link and `onRepeat`.

## 8. Decisions made & why

- **My day is the home screen, not the board.** The leaders' working screen is a queue of what to do next. One big card with one big button replaced a list with 40 buttons on it (rejected in review).
- **A reason line on the top lead,** so the ranking never feels random.
- **Undo instead of "are you sure?"** Only Dead stops to ask, because it needs a reason.
- **A missing fact is asked for in a small box, never an error,** and moving on happens in the same press.
- **No drag-and-drop library.** Browser dragging on a desktop, and a Move button on every card, which a phone needs and accessibility requires anyway.
- **Automatic lead scoring left out.** It needs months of BOE's own results. Risk to watch: manual Hot may be overused as Important Bulk was.
- **Three layouts were shown (Pipeline, Split view, Table); the owner chose the Pipeline board with the short panel.** The Split view overlaps My day; the Table could come back as a Board / Table switch for managers.
- Also left out on purpose: automated sequences, forecasting, territories, separate company, contact and deal records, a report builder.

## 9. Known traps

- **View As:** My day and the board read `auth.uid()`, so an administrator previewing somebody sees their own leads, not the employee's. Writes are blocked in the screen.
- A column loads 60 leads; the count and value are the whole stage. Moving a lead by hand between pages is not possible: search or filter finds the rest.
- `sales_lead_stuck` takes a real `sales_leads` row: a CTE row is a plain record and will not resolve, which is why `sales_board` works it out in its first CTE.
- `activities.at` and the move an entry causes share a transaction time; `undo_sales_lead_activity` relies on that with a strict `>`.
- The Hobby plan runs a Vercel cron at most daily, anywhere in its hour. The two Sales crons are 04:00 and 12:00 UTC, so about 9:30 and 17:30 in India, up to an hour later. Anything finer needs pg_cron, not `vercel.json`.
- **A ClickUp export holds only the latest comment, undated.** On the owner's exports: 87,336 comments on 11,314 tasks, 10,497 in the files. The rest come only from ClickUp's API (rule 24): 100 requests a minute, about two hours for the workspace. The token is the owner's, set in their own PowerShell window, never stored.
- Production has no imported lead yet when this was written. If one is imported before the history, the history still finds it by task id; the exported comment is hidden by its `latest:` ref, or by equal text for a lead imported before 20270527.
- ClickUp's columns differ from list to list (45 to 51): `clickup.ts` reads by column name, never by position.
- "Has not punched in" needs 11:00 India time and at least one punch from anybody today, so a stopped machine does not make everyone look absent. Staff with `payroll_active` off are never shown.
- The Team page's first-call and follow-up numbers count only what happened in BOE One: ClickUp recorded neither.
- Never export `NEXT_PUBLIC_SUPABASE_*` for `npm test`: `addPiPayment.dom.test.tsx` then passes but never exits, and the whole run hangs.
- `next build` refuses a `node_modules` junction ("points out of the filesystem root"): a worktree that builds needs a real `npm ci`.
- A new notification type needs its enum value in a migration applied before the code uses it.
- **`sales_board` still returns its first 60 leads per stage; the board ignores them** and reads every column through `sales_board_page`. A refresh re-reads every page a column has loaded, one request each, so a column scrolled down to 400 leads costs ten requests after each action.
- **A lead that moves while a column is being read** can be in two pages or in none; the screen shows it once and the next refresh settles the rest.
- **The order inside a column is the database's** (overdue, today, later; then Hot, Warm, Cold; then the bigger value), not "most days late first".
- **Timing** (PGlite, 11,000 open leads, 6,600 of them in Under process; WebAssembly, so only a guide): `sales_board()` about 640 ms for a manager, one page of 40 about 80 ms, about 45 ms for one salesperson.
- Escape closes an open menu in the panel before it closes the panel.
- **A page that fails to load** stops its column asking again until the person presses Try again (it used to be able to ask about once a second). A scroll never cancels the refresh that follows an action (`cancelRefetch: false`).
- **On a phone** only the stage being looked at is read, and a column folded on a desktop is shown anyway. A page that does not scroll must still end above the fixed bottom bar: `fillBody` has its own phone padding.
- **The panel no longer shows who holds a lead or the day it was received.** A person who may only read a lead is told who holds it in the grey note; the received day is the first line of its history.

## 10. Tests

`src/lib/salesLeads/board.test.ts`; changed on purpose: `migration.test.ts`, `salesLeads.test.tsx`, `comingSoonModules.test.tsx`, `accessCatalog.test.ts`, the two ledgers in `participantAndOrderTotalSecurity.test.ts`. Also `src/lib/salesLeads/clickup.test.ts` and `team.test.ts`, with made-up data only. Database: `node supabase/tests/sales_lead_board_pglite.mjs <dir with @electric-sql/pglite>` (expected last line `all 41 checks passed`), `supabase/tests/sales_go_live_pglite.mjs` (`all 20 checks passed`) and `supabase/tests/sales_full_flow_pglite.mjs`, one lead's whole life as every role with the review fixes and the history import (`all 50 checks passed`). `scripts/clickup-history.test.mjs` covers the history download with a fake ClickUp. New for the Pipeline board: `src/lib/salesLeads/boardPage.test.ts`; `supabase/tests/sales_full_flow_pglite.mjs` is now 75 checks (the first 60 equal the board's for every role, the pages cover a column once and in order, the counts match the board's totals, filters and search, the 30-day rule, refusals).

## 11. Open items

- The owner's review of the mapping in rule 15, above all "live again" as Dead.
- The owner's check of a sample (`--sample 5`) against ClickUp, then the full history download and import.
- To reach 8.5 to 9 on every page (owner's ask, 2026-11-03): the plan in the PR for 20270527 (Lead Master stage column and bulk allot, Team trends and activity counts, notifications in the phone bar, board quick actions on tablets, saved views). Not built.
- Automatic capture: website form first. WhatsApp and Instagram chats need the WhatsApp Business Platform, a separate decision. Everything lands unallotted in the Lead Master.
- Automatic allotment from attendance and lead load.
- The owner's check of the Pipeline board and the short panel signed in, on a desktop and on a phone. Nobody has used them yet.

## 12. Recheck before changing

Read the LATEST definition of each function (`grep -ln "function public.<name>" supabase/migrations/*`). `supabase migration list --linked` for the apply state. Run `src/lib/salesLeads/*.test.ts`, `src/components/salesLeads/salesLeads.test.tsx`, both PGlite suites and `npm run permissions:check`.
