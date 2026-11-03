# 27. Sales — Lead Master

**Update 2026-11-03:** the Lead Board (module 28, `20270525000000`) changes three things here. `view` no longer reads every lead: a person sees their own, and `view_all`, `assign` and Admin see all. The duplicate warning links to the lead and can record a repeat enquiry, which replaces rule 8. `/sales` opens My day. The rest of this file describes the Lead Master as built.

Written 2026-11-02 from the build, merged as PR #593 (dfe7a3c3). Migration `20270524000000_sales_lead_master.sql` is applied. Sales is module 24's second filled slot (Marketing was the first, module 26).

## 1. Purpose & users

- The owner asked on 2026-11-02 for a **Lead Master**: one place that stores every lead and records to whom each has been allotted, replacing the Google Sheet "Leads Master - 2026" (tabs 2026 / 2025 / 2024, plus Export, Campaign, Retailers, Architects, Worker, Job and a Variables tab of dropdown lists). A later **Lead Management** module will follow leads up; it does not exist, so the link from a duplicate warning to a lead is drawn but dead.
- Admin holds the module. Anybody else is Off until granted per person in Control Center → Access (group Sales): Viewer reads every lead (`view`); Contributor also adds a lead (`create`) and corrects its details (`edit`); `assign` (allot a lead, change who holds it) is a protected action, so it is granted per person and never by a level.
- Staff use phones: every screen was drawn and checked at 390 px.

## 2. Status

- Built and checked: `tsc`, lint, the new tests (logic, API wrappers, migration and parity pins, component renders), the whole suite, and an in-memory Postgres run of the real migration (46 checks, `supabase/tests/sales_lead_master_pglite.mjs`).
- **Not seen signed in, and the migration is not applied.** The screens were approved from a mock-up (rendered in headless Edge); the built screens were not opened in a browser by the builder.
- The register starts **empty**. Importing the 2024–2026 sheet is a separate, later step (section 11).

## 3. Pages and routes

| Route | Screen | Who |
|---|---|---|
| `/sales` | redirects to `/sales/lead-master` | module users |
| `/sales/lead-master` | `LeadMasterScreen`: four period cards, search, source filter, "Allotted to" chips, the table (cards on a phone), the lead panel, the confirmation | `view` (reads); `assign` shows the name dropdowns; `create` shows Add lead |
| `/sales/lead-master/new` | `AddLeadScreen`: number, source, optional details | `create` (anyone else sees why they cannot) |

Shell `src/components/layout/SalesLayout.tsx` (one nav item, Lead Master, lit on Add lead too); guard `src/app/sales/layout.tsx` (`ModuleGuard`, refused goes to `/modules`). List state (period, holder, source, search) lives in the URL (`useListUrlState`).

## 4. Database (`20270524000000_sales_lead_master.sql`)

- `sales_leads`: `lead_no` (identity, never reused or edited), `received_on` (India date, a column default, immutable by trigger), `phone_e164` (CHECK `^\+[1-9][0-9]{7,14}$`, **unique index `sales_leads_phone_key`**), `source` (CHECK of ten keys), optional `name` / `email` / `location` / `requirement` (limits 120 / 120 / 120 / 4000), `assigned_to` (null = **not allotted**; `on delete set null`), `assigned_at`, `assigned_by`, `created_by`, timestamps.
- `sales_lead_events`: append-only (trigger), kinds `added` / `allotted` / `reassigned` / `edited`; the people columns are **plain ids with no foreign key** (a foreign key's `on delete set null` is an UPDATE the append-only trigger would refuse, so removing a person would be blocked by their own history). `edited` records which fields changed, never their values.
- Both tables: RLS on, `select` only to `authenticated` through a policy `module_entry_open('sales')`, no write grant, all writes through functions. Nothing is seeded.
- Functions (all `SECURITY DEFINER`, `search_path = public, pg_temp`): browser-callable `sales_lead_phone_check`, `sales_leads_page`, `get_sales_lead`, `create_sales_lead`, `update_sales_lead`, `allot_sales_lead`; internal (closed to browsers) `sales_leads_require(action)` (module gate, then the right: Admin or `resolve_permission`) and `sales_lead_json`. Errors are `SALES_FORBIDDEN` (42501), `SALES_NOT_FOUND`, `SALES_INVALID: …`, `SALES_CHANGED: …`.
- Reused, not rebuilt: `normalize_lead_phone()` (20270305000000, the Exhibition Leads rule) and `is_eligible_order_assignee()` / `list_eligible_order_assignees()` (20260697000000: active AND (team = 'sales' OR the `can_be_order_assignee` grant)).
- The migration registers `create`, `edit`, `assign` on `sales` (Admin role rows, none default-on), changes the description in `app_modules` and `permission_modules`, and self-checks (four Admin rows, nothing default-on, RLS on, no browser write grant, `anon` cannot execute anything, the internal gate is closed).

## 5. Permissions & access

- Module key `sales`; actions `view`, `create`, `edit`, `assign`. Mirrors `registerModule('sales')` in `src/lib/permissions/modules.ts`; levels Viewer / Contributor in `accessCatalog.ts`; `assign` is in `PROTECTED_ACTIONS`; `enforcement.ts` says `enforced`.
- The screens read the signed-in person's rights through `useSalesAccess()` (permission context; nothing is offered while an administrator previews somebody else). The database decides every write.
- Without `assign` the holder is shown as text, never a dropdown.

## 6. Business rules (owner decisions, 2026-11-02)

1. The contact number is stored in **one format** (`+<country><digits>`; display `+91 98765 43210`) and is **unique** across the whole register, all years. A duplicate saves nothing and shows the existing lead: its number, the day it was received, its source, and who holds it (or "Not allotted yet"). The "Open lead" link is drawn and does not work until Lead Management exists.
2. The **received date** is today in India, filled in by the database, shown locked, never edited.
3. **Adding a lead does not allot it.** A new lead is "Not allotted". Allotting happens afterwards from the list.
4. **Allotting**: a dropdown of sales candidates on each row (and in the lead panel). Picking a name for a lead nobody holds saves **at once**. **Changing** a name asks "Change who holds this lead?" (From → To, "Keep as it is" focused). The owner decided the first allotment does not ask. The database refuses a change whose "who I saw holding it" is stale (`SALES_CHANGED`), so a screen that was out of date can never reassign a lead silently.
5. Only a person who is active and counts as a sales candidate can be chosen. Allotting and changing both need `assign`. **Since 20270527000000 the candidates are everybody with a Sales job in Control Center** (`sales_lead_can_hold`, `list_sales_lead_holders`, module 28 section 5), no longer the Orders rule below.
6. Only the number and the source are required; name, email, location and requirement are optional (many leads arrive with only a number).
7. Ten sources: Website, WhatsApp, Instagram, Insta Promo, Facebook Promo, Google Ads, Campaign, Reference, Repeat Customer, Others. "Campaign" is in use in the sheet but missing from its Variables list.
8. A repeat enquiry from a known number cannot be recorded yet: it is blocked with the holder shown, until Lead Management can hold follow-ups.
9. Out of the register by decision: the sheet's **Worker** and **Job** tabs (suppliers and job seekers, not leads) and the **Architects** tab (an outbound call list with its own assignee).
10. A **search looks through every day** (the period cards step aside while it is used), so a number that came in last week is found.
11. An **edit started from an older version of a lead is refused** (`SALES_CHANGED`): editing a detail or allotting the lead both count as a change. The person is shown the latest version and edits again.

## 7. Key components & lib files

`src/components/salesLeads/`: `LeadMasterScreen`, `LeadTable`, `LeadPanel` (drawer, history, edit), `AllotParts` (`AllotPicker`, `ConfirmChange`, `Holder`), `AddLeadScreen`, `LeadFields` (live number check, `DupCallout`, source chips, detail fields), `SalesFrame`, `useToast`, `useDialogFocus` (one keyboard layer for the panel and the confirmation: Escape, Tab trap, focus back), `salesLeads.module.css`. `src/lib/salesLeads/`: `constants.ts`, `api.ts` (typed wrappers, error kinds), `validation.ts`, `format.ts`, `allot.ts` (the dropdown rule). Hook `src/hooks/useSalesAccess.ts`. The number rules are imported from `src/lib/exhibitionLeads/phone.ts`, not copied.

## 8. Decisions made & why

- Allocation left Add lead because the person who receives a lead is not always the person who decides who handles it; a lead can wait unallotted, and the "Not allotted" chip is the queue.
- Only a *change* asks, because the owner wants speed for the daily first allotment and protection against a name changed by mistake.
- Reads go through one page function so the period counts, the chip counts and the page agree.
- No notification, no export, no delete, no archive in this build: nothing asked for them.

## 9. Known traps

- **Migration number.** `20270523000000` is the Meta Ads weekly review (PR #592, merged), so this migration is `20270524000000` and is applied after it. Check `supabase migration list --linked` shows 523 applied first.
- A browser `<select>` on Chrome / Edge changes (and fires `change`) on an arrow key or a typed letter while closed. `AllotPicker` ignores a change that arrives within 100 ms of such a key (`isSelectNavigationKey`, `changeCameFromKey` in `allot.ts`); a person opens the list (click, Space, Enter, Alt+Down) and picks. It is judged by time, not by waiting for a key-up: on a Mac an arrow key opens the list and its key-up never reaches the select. Do not "simplify" this away. **Unchecked on a real iPhone:** its wheel picker applies the scrolled value when it is dismissed; for an unallotted lead that saves at once.
- The picker uses `aria-busy`, never `disabled`: a disabled control drops keyboard focus to `<body>` after every allotment.
- Edits and numbers: the shared phone rule accepts `+9710501234567` (a 0 left after +971) as a different number from `+971501234567`; the form refuses it (`numberError`) but the database does not, because the rule is shared and applied. The same for "Other" without a +.
- `text[] || 'literal'` in PL/pgSQL fails ("malformed array literal"); `update_sales_lead` uses `array_append`.
- Anything with an append-only trigger must not carry a foreign key with a referential action (see the events table).
- `received_on` and `lead_no` cannot be updated (trigger; identity). An import must `insert` with `overriding system value` for numbers and an explicit `received_on`.
- Landlines starting 2–5 are refused as "not a valid mobile number" (the shared phone rule).
- The registry's display name for `assign` is per module ("Assign Leads" here, "Assign Assets" in Assets); the drift check compares action keys only.

## 10. Tests

`src/lib/salesLeads/logic.test.ts`, `api.test.ts`, `migration.test.ts`; `src/components/salesLeads/salesLeads.test.tsx`; changed on purpose: `comingSoonModules.test.tsx`, `accessCatalog.test.ts`, the two migration ledgers in `participantAndOrderTotalSecurity.test.ts`. Database: `node supabase/tests/sales_lead_master_pglite.mjs <dir with @electric-sql/pglite>` (expected last line `all 46 checks passed`).

## 11. Open items

- Apply the migration (owner), then grant per person in Control Center: `view` + `create` to whoever enters leads; `assign` to whoever allots; Dhruv, Mohit and the others only `view` if they just read.
- **Import the 2024–2026 sheet** so the duplicate check knows the old numbers: a one-time script from an export the owner supplies, with a dry-run report of invalid numbers and repeated numbers (keep the earliest as the lead); then freeze the sheet on a cutover day.
- **Owner decision wanted:** the "Not allotted" chip and queue count only the selected period (Today by default), as the approved mock-up showed. A lead entered yesterday and never allotted shows in no default view. Option: make "Not allotted" always mean the whole register (and open All time). Not changed without the owner's yes.
- Lead Management (follow-ups, status, repeat enquiries) and the live link from the duplicate warning.
- Possible: a way for Admin to add a lead source without a migration; a CSV export; archiving a wrong lead.

## 12. Recheck before changing

Read the LATEST definition of each function (`grep -ln "function public.<name>" supabase/migrations/*`); `src/lib/permissions/modules.ts` (sales block); `supabase migration list --linked` for the apply state; run `src/lib/salesLeads/*.test.ts`, `src/components/salesLeads/salesLeads.test.tsx`, the in-memory Postgres suite, and `npm run permissions:check`.
