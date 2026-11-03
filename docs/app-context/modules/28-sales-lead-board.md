# 28. Sales — Lead Board

Written 2026-11-03 from the build, on branch `feat/sales-lead-board` (PR not yet opened). Migration `20270525000000_sales_lead_board.sql` was **NOT APPLIED** when this was written. It sits on the Lead Master (module 27): the same lead record, worked after it has been allotted.

## 1. Purpose & users

- The owner asked on 2026-11-03 for a lead management system to replace the ClickUp boards ("Best of Exports", one folder per salesperson), on the level of Salesforce, Zoho CRM and LeadSquared, but only the proven, practical features, and easy enough to need no training. BOE sells furniture wholesale to hospitality clients in India and abroad.
- ClickUp as found (one salesperson's board, 2026-11-03): most open leads were overdue. Statuses mixed how far a sale had come with what kind of lead it was. The interaction log was a comment with a WhatsApp screenshot.
- Users: salespeople, mostly on phones; managers and the owner reading across people. The design was drawn, rated and approved by the owner as a mock-up first (`~/BOE-Development/temporary/lead-board-mock/`), with the UI/UX Pro Max rules.

## 2. Status

- **This build:** My day, the board, the lead panel, the stage checklist, No answer, WhatsApp quick messages, Undo, repeat enquiries, and who sees what in the database.
- **Not built yet, in the approved design:** the Team page (At risk now, the four answers per person), the screen that names a senior's juniors (`sales_lead_access` exists and is read, nothing fills it), and phone alerts for follow-ups.
- **Owed by the owner:** the ClickUp CSV for the import.
- Checked by `tsc`, lint, the tests in section 10, and the real migration in an in-memory Postgres (41 checks). **Never seen running against a real database or signed in.**

## 3. Pages and routes

| Route | Screen | Who |
|---|---|---|
| `/sales` | redirects to `/sales/my-day` (it used to go to the Lead Master) | module users |
| `/sales/my-day` | `MyDayScreen`: progress, the lists (All, New, Overdue, Today, Hot), one Next lead, the rest in order | `view`; shows the signed-in person's own leads |
| `/sales/board` | `BoardScreen`: four totals, filters, "Leads of" chips, five columns, the Converted and Dead strips. `?lead=<id>` opens a lead | `view` sees own; see section 5 |
| `/sales/lead-master` | module 27, now limited as in section 5 | the Lead Master item shows for `create`, `assign` or `view_all` |

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

## 5. Permissions & access

Module `sales`, actions `view`, `view_all` (new), `create`, `edit`, `assign`.

| Who | Sees | Works (logs, moves) |
|---|---|---|
| `view` | leads they hold | those leads |
| a senior named in `sales_lead_access` | theirs and the named juniors' | only their own |
| `view_all` (a manager) | every lead | nothing: it reads, as it does everywhere in BOE One |
| `assign` | every lead, and the queue | every lead |
| `create` | also the leads they added, until allotted | those it holds |
| Admin | everything | everything |

Enforced in the functions and in RLS. **This reverses module 27's "view reads every lead".** The duplicate check still names a number's holder to anyone adding a lead, with no other detail. On the board, the "Leads of" chips and the avatars show for anyone who can see more than one person's leads, and a card can be moved only by those who may work it.

## 6. Business rules (owner decisions, 2026-11-03)

1. Every lead lands in the Lead Master, typed in or (later) captured automatically. Only an allotted lead reaches a board. Allotment is by hand, and later automatic, using attendance and past lead load.
2. Stage is how far the sale has come. Segment (Bulk, Residential, Reseller), client type and Hot / Warm / Cold are separate facts. Important Bulk, Bulk, Important Residential and Overseas are gone as statuses.
3. Domestic or Export comes from the phone number. Nobody picks it.
4. Every open lead has a next step and a date. Posting needs both.
5. A real reply on a New lead moves it to Under process by itself.
6. No answer is one tap: it logs, keeps the step, and comes back tomorrow. It is a try, not contact. At three in a row the screen asks what next.
7. Moving forward needs: first contact (leaving New); requirement and quantity (Potential client); quotation logged, expected value and timeline (Negotiation). Moving back is never checked. Only leaving New asks for contact, so an imported lead is not held back.
8. Dead asks for a reason from nine; "Other" needs a note. Converted is a record only: **no order number and no link to Orders** (owner's choice). Every detail stays on both.
9. A red card means no update for too long: New 1 day, Under process 7, Potential client 7, Negotiation 3. Follow up later never goes red: Pipedrive users complain that a far-off planned follow-up still "rots".
10. Follow up later needs a date, and the lead returns to My day on it.
11. A repeat enquiry goes on the existing lead: a closed lead reopens as New, an open one comes to the top of its holder's day. This replaces module 27's "blocked until Lead Management".
12. Confirmed by the owner, 2026-11-03: expected value is required from Negotiation (this replaces their earlier "optional"), and the red limits stand as in rule 9. A newly allotted lead gets its first call the same working day; if it does not, the salesperson is told, then manager level. That alert is not built yet.
13. WhatsApp quick messages open `wa.me` with the text filled in; the person presses send. No API, no cost. BOE One cannot see the send, so it logs an attempt, not a reply. WhatsApp screenshots on a log entry: no (owner).

## 7. Key components & lib files

`src/components/salesLeads/`: `MyDayScreen`, `BoardScreen`, `WorkPanel` (the wide lead panel: `Composer`, `StageCard`, `Details`, `History`), `useLeadWork` (every action, and the Move, WhatsApp, three-tries, Dead, park and one-fact dialogs, so all screens behave alike), `LeadBits`, `leadBoard.module.css`. `src/lib/salesLeads/board.ts`: stages, words, `checklistFor`, `dueOf`, `flagOf`, `rankMyDay`, `whyFirst`, `valueLabel`, `parseValue`, `countryOf`, `quickMessages`. `useToast` gained an action (Undo). `DupCallout` gained a live link and `onRepeat`.

## 8. Decisions made & why

- **My day is the home screen, not the board.** The leaders' working screen is a queue of what to do next. One big card with one big button replaced a list with 40 buttons on it (rejected in review).
- **A reason line on the top lead,** so the ranking never feels random.
- **Undo instead of "are you sure?"** Only Dead stops to ask, because it needs a reason.
- **A missing fact is asked for in a small box, never an error,** and moving on happens in the same press.
- **No drag-and-drop library.** Browser dragging on a desktop, and a Move button on every card, which a phone needs and accessibility requires anyway.
- **Automatic lead scoring left out.** It needs months of BOE's own results. Risk to watch: manual Hot may be overused as Important Bulk was.
- Also left out on purpose: automated sequences, forecasting, territories, separate company, contact and deal records, a report builder.

## 9. Known traps

- **View As:** My day and the board read `auth.uid()`, so an administrator previewing somebody sees their own leads, not the employee's. Writes are blocked in the screen.
- A column loads 60 leads; the count and value are the whole stage. Moving a lead by hand between pages is not possible: search or filter finds the rest.
- `sales_lead_stuck` takes a real `sales_leads` row: a CTE row is a plain record and will not resolve, which is why `sales_board` works it out in its first CTE.
- `activities.at` and the move an entry causes share a transaction time; `undo_sales_lead_activity` relies on that with a strict `>`.
- The Hobby plan runs a Vercel cron at most daily, anywhere in its hour. That can carry the same-working-day first-call alert if the day's run comes late enough; anything finer needs pg_cron, not `vercel.json`.
- A new notification type needs its enum value in a migration applied before the code uses it.

## 10. Tests

`src/lib/salesLeads/board.test.ts`; changed on purpose: `migration.test.ts`, `salesLeads.test.tsx`, `comingSoonModules.test.tsx`, `accessCatalog.test.ts`, the two ledgers in `participantAndOrderTotalSecurity.test.ts`. Database: `node supabase/tests/sales_lead_board_pglite.mjs <dir with @electric-sql/pglite>` (expected last line `all 41 checks passed`).

## 11. Open items

- Team page; the senior-access screen; phone alerts (first response, due follow-ups, repeat enquiry).
- ClickUp import: format not seen. Status-to-stage mapping to agree (Important Bulk and Bulk say nothing about stage). A catch-up screen so nobody starts with a wall of red.
- Automatic capture: website form first. WhatsApp and Instagram chats need the WhatsApp Business Platform, a separate decision. Everything lands unallotted in the Lead Master.
- Automatic allotment from attendance and lead load.

## 12. Recheck before changing

Read the LATEST definition of each function (`grep -ln "function public.<name>" supabase/migrations/*`). `supabase migration list --linked` for the apply state. Run `src/lib/salesLeads/*.test.ts`, `src/components/salesLeads/salesLeads.test.tsx`, both PGlite suites and `npm run permissions:check`.
