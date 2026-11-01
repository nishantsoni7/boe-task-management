# 25. SEO

Written 2026-11-01 from the build, updated 2026-11-02. Plan: https://claude.ai/artifact/QwAtfMUUDGcDDNJXU4HYqk (private). This dossier covers steps 1 and 2 of that plan.

## 1. Purpose & users

- One question, answered every Monday in under a minute: is Google bringing us more hotel and restaurant project enquiries, and what do we change this week?
- The owner asked for it on 2026-11-01 as its own module, joined to the owner's scheduled tasks. It is not part of Marketing, which stays Coming soon.
- Admin holds it. Anybody else is Off until granted a level, per person, in Control Center → Access (group Sales): Viewer reads (`view`), Contributor also updates board items (`edit`), Manager also answers strategy changes (`approve`). The plan said one `manage` action; the existing levels fit better, because the SEO employee can then update the board without deciding strategy.

## 2. Status

Step 1 is live (#570, `b1bc5ab6`, merged by the owner 2026-11-01): five screens, six tables and the door the sessions send results through. Migrations `20270518000000` and `20270518000100` APPLIED 2026-11-01. The saved history was sent the same day.

Step 2 is live (#571, `af8476b4`, merged by the owner 2026-11-02): the Weekly review and Scheduled tasks screens, a board that can be updated, Keep or Change on strategy changes, and the way back to the website folder. Migration `20270519000000` APPLIED 2026-11-02. A real sender run after the deploy fetched from `decisions` and sent. The four scheduled tasks end by running the sender, from 2 Nov 2026.

Neither step has been seen in a browser or signed in. `permissions:check` is refused as a production read, so it was not run.

Not built yet: step 3 (Google's free link for Search Console and Analytics), step 4 (Ads, only if ads restart).

## 3. The model

The Claude scheduled tasks on the owner's PC do the work and save dated files in `repositories\bestofexports-website`, a plain folder outside this repository. Each task ends by running `scripts/push-to-boe-one.mjs` in that folder. BOE One keeps the results and shows them. "Scheduled tasks" here means those Claude tasks, not Task Management, which has no recurring tasks.

The board lives in two places, so it syncs both ways. Each run of the sender first fetches what people changed (`GET /api/integrations/seo/decisions`) into `data/plan/board.json`, then sends. If that fetch fails for any reason but a 404, the board is held back that run and the numbers still go, so an edit can never be overwritten by the folder's older copy. A later change by a session wins over an older edit, because the fetch only applies an `edited_at` it has not seen.

Owner decision 2026-11-01: **no additional paid package.** Ahrefs stays on the Toolsurf shared plan, which has no API, so Ahrefs figures always come through the daily Chrome session. Do not propose official Ahrefs or a paid data service. Google Ads accounts are cancelled, so there is no Ads feed.

## 4. Pages and routes

| Route | Screen | Answers |
|---|---|---|
| `/seo` | `SeoOverview` | Verdict, five numbers, what needs the owner, the state of each task |
| `/seo/rankings` | `SeoRankings` | The 20 money keywords, the 8 cities |
| `/seo/competitors` | `SeoCompetitors` | Who wins, how strong, read on which date |
| `/seo/year` | `SeoYear` | 12 months of clicks and leads, page groups, work done |
| `/seo/board` | `SeoBoard` | The 30 and 60-day board, targets, achieved, open proposals; Update and Keep or Change for those who hold them |
| `/seo/reviews` | `SeoReviews` | Open strategy changes, every Monday page, the answers given |
| `/seo/tasks` | `SeoTasks` | Each task's time, state, what to do, and its last 7 runs |

`src/app/seo/layout.tsx` is `ModuleGuard` with `deniedRoute="/modules"`. Shell: `src/components/layout/SeoLayout.tsx`. `SeoScreen` holds the shell, the one shared read (`fetchSeoData`, query key `['seo', 'data']`) and the loading, error and empty states. Every rule the screens show is in `src/lib/seo/report.ts`, which is pure. `useSeoAccess` decides which controls to draw, and draws none while an administrator is previewing somebody else; the database functions decide what is allowed.

`POST /api/integrations/seo/ingest` is how the sessions write: `Authorization: Bearer $SEO_INGEST_SECRET`, 2 MB cap, the whole delivery is checked by `parseSeoIngest` before anything is written, and rows are upserted on keys the sender chooses. `GET /api/integrations/seo/decisions` uses the same secret and returns only edited items and answered proposals. Unset secret answers 503. The local copy of the secret is `backups\.keys\seo-ingest-secret.txt`.

## 5. Database

`20270518000000_register_seo_module.sql`: registration only, the same four tables as Vendors. `app_modules` sort 150. Mirrored by `registerModule` in `src/lib/permissions/modules.ts`, `ENGINE_GATED_MODULE_KEYS` (17 now), `MODULE_ENFORCEMENT`, `MODULE_WORDS` in `accessCatalog.ts` and `ModuleIcon`.

`20270518000100_seo_tables.sql`:

| Table | Holds | Key |
|---|---|---|
| `seo_metrics` | Every number | `metric_date, metric, scope` |
| `seo_watchlist` | Money keywords and competitors | `kind, entry_key` |
| `seo_plan_items` | The board | `id` (from `board.json`) |
| `seo_reviews` | One row per Monday | `review_date` |
| `seo_log` | Work, findings, decisions, proposals | `id` |
| `seo_feed_runs` | One row per task per day | `feed, run_date` |

Metrics in use: `site.month.{clicks,impressions,position,sessions,website_leads}` (first of the month), `keyword.position`, `site.money_in_top10`, `city.position` (`detail.top` holds the first 5 hosts), `city.demand`, `competitor.snapshot` (`value` is DR), `pages.clicks`, `work.count`, `plan.target`, `plan.progress`.

RLS: one SELECT policy on each table, `module_entry_open('seo')`. No write policy and no write grant, so a browser cannot write to a table, Admin included. The file revokes Supabase's default grants itself and raises if a table is left open.

`20270519000000_seo_board_edits_and_decisions.sql`: registers `edit` and `approve`, adds `edited_at`, `edited_by` to `seo_plan_items` and `decision`, `decision_note`, `decided_at`, `decided_by` to `seo_log`, and creates the app's only two writes. `seo_update_plan_item(id, status, evidence)` needs `edit`. `seo_decide_proposal(id, decision, note)` needs `approve`. Both are `SECURITY DEFINER` with a fixed `search_path`, read `auth.uid()`, and are closed to anon. The door's upsert does not name the new columns, so it leaves them alone.

## 6. Business rules to remember

- A keyword missing from the newest reading has no impressions that week. It is silent, never carried forward with an old position.
- Position under 11 counts as top 10, because 10.9 shows as position 10.
- Directories never count as competitors. They are counted as a share of the top-3 spots.
- A login or CAPTCHA stop outranks "late" on the task state, because it says what to do.
- Verdict rules and the guard against changing course on one week's moves are in `data/plan/board.json` in the website folder. The Monday review applies them; the app shows the result.
- A board item needs evidence to be marked Done, as the board's own rule says. An answer to a strategy change cannot be overwritten, even by Admin, because the Monday review may already have acted on it. `change` means the owner adopted it; `keep` means declined, and the same change is not proposed again.
- Lead data is counts only. Names and phone numbers never enter this module.
- The employee audit, pay and role cost never enter this module. `docs/change-log.md` in the website folder can name customers, so the Year review reads the hand-written `data/plan/year-work.json`, not that file.

## 7. Traps

- The repository is public. No SEO figures go in a migration, a fixture or a test.
- `results.json` holds older URLs without `https://`. Normalise before counting, or brand counts come out too low (the sender's `host()`).
- Filename order is not run order in `data/ahrefs-daily/`: a day can have `_run2.json` and `_run2_not_run.json`. The sender orders by file time.
- The sender resends everything each run. That is safe only because every table upserts on a stable key, so keep ids stable. A proposal's id is its position in `proposed_changes`: never reorder or delete that list.
- An item removed from `board.json` stays in `seo_plan_items`, because the door only upserts. Delete it by hand.
- The sender needs the `decisions` fetch to come first. Sending before fetching would put the folder's older status over a person's edit.
- The migration rehearsal on the linked database is refused. Use PGlite (`~/BOE-Development/temporary/pglite-env`), and copy Supabase's default privileges into the stub or the revoke proves nothing.

## 8. Recheck before changing

Every new writer goes through the ingest door or a new function with its own check. A new table needs `module_entry_open('seo')`. Screens read through `fetchSeoData`; do not add a second read per screen. The read keeps 400 days, so anything shown for longer needs its own query.
