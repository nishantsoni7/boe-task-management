# 26. Marketing — Meta Ads

Written 2026-11-02 from the build of PR A (data and sync) and updated the same day for PR B (the screens, no SQL; pull request pending when written). Migrations `20270522000000` and `20270522000100` were **APPLIED to production on 2026-11-02** by the owner, before the merge (checked on the live ledger afterwards; the dry-run listed only these two). PR #580, merged 2026-11-02 as `d29f903f` and deployed.

## 1. Purpose & users

- The owner asked on 2026-11-02 for a Meta Ads section inside Marketing: watch the running and old campaigns, learn from them, say which work and which do not, and later propose new campaigns and make a needs list and a task for the owner. The goal is high volume of good leads at a sensible cost. Phase 1 only reads and shows; nothing in this module can change the Meta account.
- Admin holds the module. Anybody else is Off until granted per person in Control Center → Access (group Sales): Viewer reads (`view`), Contributor also sets the monthly spending cap and the target cost per enquiry (`edit`). `approve` arrives with the phase that proposes campaigns.
- Marketing is separate from SEO (module 25). Sales and Pricing are still registration-only (module 24).

## 2. Status

PR A is live (#580, `d29f903f`, deployed 2026-11-02): the tables, the daily sync, the cron and the registration. **The first real read happened on 2026-11-02**, after the owner made a system user and a view-only token and set the two Vercel names: it finished `ok` in 43 seconds, and its campaign and ad set counts, and the spend and chats of the running campaign (and of its ad sets), matched Ads Manager exactly. So the "chat" action and the attribution default are right, and Meta's default listing leaves nothing out.

PR B draws the screens (Overview, Campaigns, Settings, and the states for nothing read yet, first read running, last read failed). No SQL. Checked by `tsc`, lint, 39 new tests (the rules, the figures drawn from made-up rows, and a guard that the browser code can only read) and the screens rendered with the real stylesheet in headless Edge at desktop and phone width. **Not seen signed in with real data by the builder**; the owner checks on the Vercel preview before the merge.

## 3. The model

Meta is read once a day (GET `/api/integrations/meta/sync`, Vercel Cron, 00:40 UTC = 06:10 India, `Authorization: Bearer $CRON_SECRET`) with a **view-only** token from a system user in the owner's Meta business. The sync writes the six `meta_*` tables with the service role; the screens only read.

- **Account.** One ad account, in rupees. The owner's old ad account holds the history; the business's own new account is empty. The old account stays owned by the owner's personal profile and is shared to the business with the View performance role only (Request access, not Claim: Meta states a claimed account cannot be removed from a business). An account whose currency is not INR is refused.
- **First run** reads from the day the account was created, at most 1100 days back, in windows of 90 days. **Daily runs** read the last 30 days again, because Meta settles late results; every table upserts on a stable key, so rereading never doubles anything.
- **A failed run** writes a `failed` row in `meta_sync_runs` and leaves every earlier row alone, so the screens keep the last good reading. A run that is `running` and younger than 15 minutes stops a second one starting.
- **Results** are stored as Meta sent them (`meta_insights_daily.actions`) and what counts as a "chat" is worked out in `src/lib/meta/results.ts`. Only the `CONVERSATIONS` goal is mapped. Other goals have no result count and get no verdict. Add a goal only after checking its number against Ads Manager.

## 4. Pages and routes

| Route | Screen | Answers |
|---|---|---|
| `/marketing` | Overview: a verdict for what is running now, five figures, cost per chat by ad set, your two numbers, the connection, how an ad set is judged | Admin, or `view` |
| `/marketing/campaigns` | Every campaign, running first then by spend, filters All / Running / Off, search, 25 at a time; open one for its ad sets | Admin, or `view` |
| `/marketing/settings` | The monthly spending cap and the target cost per chat; the connection | `view` reads, `edit` (or Admin) saves |
| `GET /api/integrations/meta/sync` | none | The daily read; 503 with no `CRON_SECRET`, 401 for a wrong one, 200 `not_configured` with no token, 502 when a run fails |

Code: `src/components/layout/MarketingLayout.tsx` (the shell), `src/components/meta/` (`MetaScreen` holds the shared reads, the period and the states; `MetaOverview`, `MetaCampaigns`, `MetaSettings`, `metaParts`, `meta.module.css`), `src/lib/meta/report.ts` (every figure and the sync state, pure), `verdict.ts` (the rules), `api.ts` (the only file that talks to the database), `src/hooks/useMetaAccess.ts`. One shared read (`['meta', 'structure']`) and one per period (`['meta', 'insights', from, to]`), so moving between pages costs nothing.

Period: last 7, 30, 90 days or 12 months, ending **yesterday** (today is partial, and Ads Manager leaves it out of "last 30 days" too). The state is per page and resets to 30 days when you move.

Layout: the approved mock-up (private canvas), drawn in the real BOE shell with the SEO Overview pattern. Left out of it on purpose: **Sync now** (a button that runs the read from the browser needs its own authenticated route; the daily read is enough for now), and the written paragraph about which ad set is costlier (it was hand-written in the mock-up; the weekly Claude review of phase 2 is where such sentences belong). The "Other ad sets, now off" row of the mock-up is gone: the real ad sets are listed by name, and spend on an ad set Meta no longer lists is its own line ("Ad sets Meta no longer lists") so a campaign's total always equals the sum of its lines.

## 5. Database

`20270522000000_marketing_meta_edit_action.sql`: registers `edit` (off by default, Admin role on) and sets the module description to "Marketing, starting with Meta Ads." Mirrored by `registerModule` in `src/lib/permissions/modules.ts`, `accessCatalog.ts` (viewer, contributor) and `enforcement.ts`.

`20270522000100_meta_ads_tables.sql`:

| Table | Holds | Key |
|---|---|---|
| `meta_ad_accounts` | the account, currency, last sync | `account_id` |
| `meta_campaigns`, `meta_ad_sets` | the structure, budgets in paise, the goal | `campaign_id`, `ad_set_id` |
| `meta_insights_daily` | ad set × day: spend (paise), impressions, clicks, raw `actions` | `ad_set_id, day`; no foreign key on purpose |
| `meta_sync_runs` | one row per sync: kind, status, message, counts | `id` |
| `meta_settings` | one row: monthly cap and target cost per enquiry, both empty until set | `id = true` |

RLS: one SELECT policy each, `module_entry_open('marketing')`. No write policy and no write grant, so a browser cannot write, Admin included. `meta_set_targets(cap, target)` is the one write: `SECURITY DEFINER`, fixed `search_path`, Admin or `edit`, closed to anon, values in paise, 0 or negative or over ₹1 crore refused. The file raises if a table is left open. Rollback is in the file's header.

## 6. Business rules to remember

- Money is whole paise everywhere. Meta sends spend in rupees as text and budgets in the smallest unit; `src/lib/meta/parse.ts` converts both.
- A row Meta sends without a usable id makes the run fail loudly. That is how a change in Meta's shape is noticed.
- Lead data is counts only. Names and phone numbers never enter this module. The chats happen in WhatsApp and Instagram, which BOE One cannot see; whether a chat became a real enquiry is a later phase and needs a human tag.
- **Verdicts** (`verdict.ts`, one place to change them). The numbers are the owner's proposed defaults and the screen says "Proposed, you confirm the numbers": **Too early** under 20 chats AND under ₹3,000 spent; **No data** with nothing spent; **Other goal** when the ad set's goal has no result count; with no target set everything else is **Watch**; with a target, cost per chat at or under it is **Winning**, up to half as much again over is **Watch**, more than that is **Losing**, and ₹3,000 spent with no chat at all is Losing. A Losing verdict only suggests a look; nothing here can pause anything. A campaign is judged on its totals, and a campaign that mixes goals on the part that chases chats. The Overview's headline word judges every running chat ad set together.
- **The target is a cost per chat, on purpose.** The mock-up called it "target cost per real enquiry", but BOE One cannot see which chats became enquiries, and judging a cost per chat against a cost per enquiry would call expensive chats Winning. The screens say "Target cost per chat". The column and function keep the name `target_cost_per_enquiry_paise`; when the lead-quality tag of phase 4 arrives, that is the moment to give a real per-enquiry number its own place.
- **Spend is counted whole, chats only where the goal counts them.** The account's Spent is every campaign; Chats started and Cost per chat use only ad sets whose goal is `CONVERSATIONS` (and spend on ad sets Meta no longer lists counts by the goal of that campaign's other ad sets). A campaign aimed at something else shows its spend, "Another goal", no results and no verdict.
- **Monthly cap.** The Overview shows spend since the 1st against it. It is a figure to look at, not a limit: nothing enforces a cap until phase 3 can start or stop anything.
- No figures from the owner's account go in this public repository: not in a migration, a fixture, a test or this file. Tests use made-up numbers.

## 7. Traps

- **The token** (`META_ACCESS_TOKEN`) and the account ids (`META_AD_ACCOUNT_IDS`) are set in Vercel by the owner, never in git, chat or logs, and a deploy is needed after they change. Meta's token can expire or be removed; the run then fails with "Meta did not accept the token" and the old numbers stay.
- **Meta's `paging.next` link has the token written into it.** `graph.ts` asks for the next page with the `after` cursor and puts the token in a header. A test pins both.
- **The client only makes GET requests.** A test pins that no other method appears in `graph.ts` and that nothing else calls `fetch`. Writing to Meta is a later phase with its own token rights.
- **The WhatsApp guard excuses `src/lib/meta/graph.ts`.** `whatsappRoute.test.ts` forbids `graph.facebook.com` anywhere in `src/` because nothing here may send a WhatsApp message. It excuses that marker in this one file, and it fails if the file gains a write method or the word `messages`. Do not move the client or rename the file without updating the guard.
- **Confirmed against real data on 2026-11-02:** Meta's default listing leaves nothing out (the counts match Ads Manager), the chat action name and the attribution default match Ads Manager to the rupee and the chat, and a campaign's total equals the sum of its ad sets. Still open: how far back Meta serves daily results beyond what the first read returned, and the goals other than `CONVERSATIONS` (a profile-visit goal has no mapping, so such a campaign shows no result).
- A `running` run that is older than 15 minutes means the function died; the screens show it as failed (`STALE_RUN_MINUTES` in `report.ts`, a test pins it to the sync's number).
- **Reading the result of a run.** Vercel's Runtime Logs stay empty on success because the route logs nothing, and its Request Logs cannot tell `ok` from `not_configured` (both 200). The record is `meta_sync_runs`, which the Overview's badge and connection panel read.
- **The sync is not a button.** Until a Sync now route exists, a run is only the daily cron or "Run" on Vercel's Cron Jobs page.
- **A token needs more than a system user.** Meta needs an app in the business first; the system user needs a role on that app (Business settings → System users → Assign assets → Apps) before Generate token lists any permission; `ads_read` is on the app by default ("Ready for testing") and the Marketing API access tier stays "Limited access", which was enough for the old, person-owned ad account shared to the business. The app is never published and never goes through app review.
- The migration rehearsal on the linked database is refused. Use PGlite (`~/BOE-Development/temporary/pglite-env/rehearse-meta.mjs`).

## 8. Recheck before changing

Every new writer goes through the sync or a new function with its own check. A new table needs `module_entry_open('marketing')`. New screens read through the shared `MetaScreen` reads, and `metaScreens.test.tsx` pins that only `api.ts` queries the database and that its one write is `meta_set_targets`; keep it that way. Marketing is off `ComingSoonModule` (dossier 24, section 8). Writing to Meta needs a new token with write rights, a new action, an approval step, caps in code and an audit log; none of that exists.
