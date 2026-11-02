# 26. Marketing — Meta Ads

Written 2026-11-02 from the build of PR A (data and sync). PR B (the screens) is not built. Migrations `20270522000000` and `20270522000100` were **APPLIED to production on 2026-11-02** by the owner, before the merge (checked on the live ledger afterwards; the dry-run listed only these two). PR #580, merged 2026-11-02 as `d29f903f` and deployed.

## 1. Purpose & users

- The owner asked on 2026-11-02 for a Meta Ads section inside Marketing: watch the running and old campaigns, learn from them, say which work and which do not, and later propose new campaigns and make a needs list and a task for the owner. The goal is high volume of good leads at a sensible cost. Phase 1 only reads and shows; nothing in this module can change the Meta account.
- Admin holds the module. Anybody else is Off until granted per person in Control Center → Access (group Sales): Viewer reads (`view`), Contributor also sets the monthly spending cap and the target cost per enquiry (`edit`). `approve` arrives with the phase that proposes campaigns.
- Marketing is separate from SEO (module 25). Sales and Pricing are still registration-only (module 24).

## 2. Status

PR A is live (#580, `d29f903f`, deployed 2026-11-02): the tables, the daily sync, the cron and the registration. In production the route answers 401 to a caller without the secret; it has not yet read Meta. The Marketing page still shows Coming soon until PR B. Checked by `tsc`, lint, new tests (including three deliberate breaks that the tests caught) and an executed rehearsal of both migrations on PGlite with Supabase's default grants copied in: 28 checks, the rollback included. **Not run against Meta**: there is no token yet, so Meta's real answers have not been read.

## 3. The model

Meta is read once a day (GET `/api/integrations/meta/sync`, Vercel Cron, 00:40 UTC = 06:10 India, `Authorization: Bearer $CRON_SECRET`) with a **view-only** token from a system user in the owner's Meta business. The sync writes the six `meta_*` tables with the service role; the screens only read.

- **Account.** One ad account, in rupees. The owner's old ad account holds the history; the business's own new account is empty. The old account stays owned by the owner's personal profile and is shared to the business with the View performance role only (Request access, not Claim: Meta states a claimed account cannot be removed from a business). An account whose currency is not INR is refused.
- **First run** reads from the day the account was created, at most 1100 days back, in windows of 90 days. **Daily runs** read the last 30 days again, because Meta settles late results; every table upserts on a stable key, so rereading never doubles anything.
- **A failed run** writes a `failed` row in `meta_sync_runs` and leaves every earlier row alone, so the screens keep the last good reading. A run that is `running` and younger than 15 minutes stops a second one starting.
- **Results** are stored as Meta sent them (`meta_insights_daily.actions`) and what counts as a "chat" is worked out in `src/lib/meta/results.ts`. Only the `CONVERSATIONS` goal is mapped. Other goals have no result count and get no verdict. Add a goal only after checking its number against Ads Manager.

## 4. Pages and routes

| Route | Screen | Answers |
|---|---|---|
| `/marketing` | Coming soon (PR B replaces it) | |
| `GET /api/integrations/meta/sync` | none | The daily read; 503 with no `CRON_SECRET`, 401 for a wrong one, 200 `not_configured` with no token, 502 when a run fails |

Layout: the approved mock-up (private canvas) has Overview, Campaigns, Settings, an Overview on a phone and three states (no token, first sync running, sync failed). It is drawn in the real BOE shell with the SEO Overview pattern.

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
- No verdicts are drawn here yet. The proposed rules (Too early under 20 chats and ₹3,000; Winning, Watch, Losing against a target the owner has not set) are proposals in the mock-up.
- No figures from the owner's account go in this public repository: not in a migration, a fixture, a test or this file. Tests use made-up numbers.

## 7. Traps

- **The token** (`META_ACCESS_TOKEN`) and the account ids (`META_AD_ACCOUNT_IDS`) are set in Vercel by the owner, never in git, chat or logs, and a deploy is needed after they change. Meta's token can expire or be removed; the run then fails with "Meta did not accept the token" and the old numbers stay.
- **Meta's `paging.next` link has the token written into it.** `graph.ts` asks for the next page with the `after` cursor and puts the token in a header. A test pins both.
- **The client only makes GET requests.** A test pins that no other method appears in `graph.ts` and that nothing else calls `fetch`. Writing to Meta is a later phase with its own token rights.
- **The WhatsApp guard excuses `src/lib/meta/graph.ts`.** `whatsappRoute.test.ts` forbids `graph.facebook.com` anywhere in `src/` because nothing here may send a WhatsApp message. It excuses that marker in this one file, and it fails if the file gains a write method or the word `messages`. Do not move the client or rename the file without updating the guard.
- **Not yet confirmed against real data:** the default listing of campaigns and ad sets may leave out archived ones (compare counts at the first real read); the action name for a "chat" (`onsite_conversion.messaging_conversation_started_7d`) and the 7-day-click, 1-day-view default must match Ads Manager; how far back Meta serves daily results.
- A `running` run that is older than 15 minutes means the function died; PR B shows that as failed.
- The migration rehearsal on the linked database is refused. Use PGlite (`~/BOE-Development/temporary/pglite-env/rehearse-meta.mjs`).

## 8. Recheck before changing

Every new writer goes through the sync or a new function with its own check. A new table needs `module_entry_open('marketing')`. When the screens arrive, read through one shared read, and take Marketing off `ComingSoonModule` (dossier 24, section 8). Writing to Meta needs a new token with write rights, a new action, an approval step, caps in code and an audit log; none of that exists.
