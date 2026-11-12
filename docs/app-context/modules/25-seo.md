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

The 6-month review and the discussion brief are live (#575, `4b5d9006`, merged by the owner 2026-11-02). Migration `20270521000000` APPLIED 2026-11-02 by the owner, after the merge, and read as remote. The real documents were sent the same morning. The review was seen signed in; the brief was not. Mock-up: https://claude.ai/artifact/MqaZb24wxgVofxCbLX4XkA (private). The owner asked on 2026-11-02 for a rolling 6-month view that shows what improved and what dropped, feedback for discussions with the SEO person, and an expert guide against wrong action, and pre-approved the build once an expert-style review reached 9 of 10.

Overview, Rankings, Competitors, Vision board, Weekly review and Scheduled tasks were rebuilt to the review's standard (#579, `f828b988`, merged by the owner 2026-11-02). No migration. Each page now answers one question, says what it must not be read as, and names the next step. Seen with real figures from the sender's dry run, at desktop and phone, in a plain page with the real stylesheet. Then read live, signed in as Admin at desktop width, 2026-11-02: all six draw with real figures and nothing overflows. Update and the strategy answers were not clicked, and no lower access level or phone was tried live.

Not built yet: step 3 (Google's free link for Search Console and Analytics), step 4 (Ads, only if ads restart).

The discussion brief can now be drawn as a case for a decision about the role (#661, `c9f1ce32`, merged by the owner 2026-11-11). The owner asked on 2026-11-11 for every fact, a performance chart, quarterly rankings of the searches that bring business, the flow of leads, what was missed, the three claims tested with outside research, answers to likely counters, and how to hold the conversation kindly. Mock-up: https://claude.ai/artifact/UwAz8zrKcHJk63n6rGYL1f (private). No migration. Seen with the real document in the app's own stylesheets at desktop and phone, not signed in.

Every figure in the case brief can now carry its proof (#669, `b2dd6175`, squash-merged by the owner 2026-11-11 19:58 IST; it also carried #664, which was closed as included). The owner asked on 2026-11-11 that every figure show a source link that proves it, biggest points first, comparisons backed by something to show the SEO person, and only what helps the discussion. Plan v3, approved the same day: https://claude.ai/artifact/6NoJVrUMmT4PoXV3EjbCcm (private). Evidence pack with the dated screenshots: https://claude.ai/artifact/Jk2yQPUzZqBfUVuGW3v6QM (private). No migration. Production deploy succeeded 20:02 IST. The new brief (`period_end` 2026-11-11) was sent right after and read signed in as Admin at desktop width: 14 sections, 27 "Check it yourself" lists, 44 links, all https and opening in a new tab, the evidence pack link and the five quarter links present, no sideways scroll. Not yet seen on a phone signed in. The 2026-11-09 brief stays in the table as history.

The brief is rebuilt around two things (pull request `feat/seo-brief-rankings`, not merged yet). The owner asked on 2026-11-12 for the quarterly ranking of the top 5 searches in each business category (24 categories plus banquet: 120 searches) as the main point, then how much of the traffic growth went to blog posts against business searches, then everything else in order with nothing repeated. Plan v4, approved the same day, at the plan link above. Readings: Search Console, India, 12 Nov 2026, saved in the website folder as `data/search-console/2026-11-12_business-searches-by-quarter.json`. No migration. Seen with the real document in the app's own stylesheets at desktop and at phone width, not signed in. Searches a month are Ahrefs figures for 54 of the 120; the rest say "not read" until the shared Toolsurf plan has units (it logged out twice on 12 Nov).

## 3. The model

The Claude scheduled tasks on the owner's PC do the work and save dated files in `repositories\bestofexports-website`, a plain folder outside this repository. Each task ends by running `scripts/push-to-boe-one.mjs` in that folder. BOE One keeps the results and shows them. "Scheduled tasks" here means those Claude tasks, not Task Management, which has no recurring tasks.

The board lives in two places, so it syncs both ways. Each run of the sender first fetches what people changed (`GET /api/integrations/seo/decisions`) into `data/plan/board.json`, then sends. If that fetch fails for any reason but a 404, the board is held back that run and the numbers still go, so an edit can never be overwritten by the folder's older copy. A later change by a session wins over an older edit, because the fetch only applies an `edited_at` it has not seen.

Owner decision 2026-11-01: **no additional paid package.** Ahrefs stays on the Toolsurf shared plan, which has no API, so Ahrefs figures always come through the daily Chrome session. Do not propose official Ahrefs or a paid data service. Google Ads accounts are cancelled, so there is no Ads feed.

## 4. Pages and routes

| Route | Screen | Answers |
|---|---|---|
| `/seo` | `SeoOverview` | This week in one line, what needs the owner in date order, the five numbers against their targets, clicks each day, what moved, whether the figures are fresh |
| `/seo/rankings` | `SeoRankings` | The 20 money keywords in India over 28 days, with demand, position track and next step; where Google shows the wrong page; the 8 cities; the keywords too thin to judge |
| `/seo/competitors` | `SeoCompetitors` | Who to watch and what to copy, who is rising or falling, the directories' share, the other sites, what winners do that we do not |
| `/seo/review` | `SeoSixMonth` | The rolling 6-month review: verdict, likely causes, top 5 good and bad, dated next moves, targets, what to be careful quoting, 18 months of visits, leads and forms, what moved in India, AI readiness, blind spots |
| `/seo/brief` | `SeoBrief` | Admin only. The private discussion brief. A brief with `claims` is drawn as a case (`SeoBriefCase.tsx`), in this order: the message and a link to the evidence pack; rankings by quarter (a summary above, searches under their category heading that adds up clicks, the change since the first quarter, positions from fewer than 20 showings greyed); where the visitors came from (blog posts against business searches); the flow of leads; what else went wrong; the rivals; the claims tested; his own plan point by point; the counters; why the work can be freelance; credit and fairness when the brief has any; and how to hold the conversation. Older parts (the monthly chart, the rivals that rose, the worksheet chart) still draw when a brief has them. Under each part, "Check it yourself" lists the report, page or file behind it. Without `claims` it is the review layout: credit, what to raise, what is not on them, what is scored |
| `/seo/year` | `SeoYear` | 12 months of clicks and leads, page groups, work done. Off the menu since the 6-month review; reached from the review's footnote |
| `/seo/board` | `SeoBoard` | The 30 and 60-day board, open proposals with a recommendation, targets, achieved; Update and Keep or Change for those who hold them |
| `/seo/reviews` | `SeoReviews` | The newest Monday in full: verdict, numbers, the week's work, move and risk, competitors, open and answered strategy changes. Earlier Mondays are one line each |
| `/seo/tasks` | `SeoTasks` | Seven days of runs as squares, how old each figure is, what can stop a task |

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

Metrics in use: `site.month.{clicks,impressions,position,sessions,website_leads}` (first of the month), `keyword.india` (28 days in India, `detail` holds the other figures and the next step), `site.week` (with 14 days of clicks), `site.28d`, `source.age` (no value, `detail.date` is the figure's date), `keyword.position` and `site.money_in_top10` (still sent, no screen reads them), `city.position` (`detail.top` holds the first 5 hosts), `city.demand`, `competitor.snapshot` (`value` is DR), `pages.clicks`, `work.count`, `plan.target`, `plan.progress`.

RLS: one SELECT policy on each table, `module_entry_open('seo')`. No write policy and no write grant, so a browser cannot write to a table, Admin included. The file revokes Supabase's default grants itself and raises if a table is left open.

`20270521000000_seo_six_month_review.sql`: `seo_six_month_reviews` and `seo_discussion_briefs`, one JSON document a period, keyed on `period_end`. The review reads through `module_entry_open('seo')`. The brief reads for `users.role = 'admin'` only, so SEO `view` does not open it. No write grant on either. The shape is `src/lib/seo/sixMonth.ts`, and the door refuses a document that does not match.

`20270519000000_seo_board_edits_and_decisions.sql`: registers `edit` and `approve`, adds `edited_at`, `edited_by` to `seo_plan_items` and `decision`, `decision_note`, `decided_at`, `decided_by` to `seo_log`, and creates the app's only two writes. `seo_update_plan_item(id, status, evidence)` needs `edit`. `seo_decide_proposal(id, decision, note)` needs `approve`. Both are `SECURITY DEFINER` with a fixed `search_path`, read `auth.uid()`, and are closed to anon. The door's upsert does not name the new columns, so it leaves them alone.

## 6. Business rules to remember

- Money keywords are read in India over 28 days. The 7-day worldwide reading missed most of them, because the buyers are in India and many keywords get few views in a week. A keyword missing from the newest reading is left out, never carried forward with an old position.
- A position under 11 is page 1 and under 21 is page 2, because 10.9 shows as 10. Page 1 with real views means 100 or more in the 28 days.
- Numbers are worked out from rows; the expert reading is written. Each Monday the session writes `pages` inside `data/weekly-reviews/YYYY-MM-DD.json`, one block per page, read tolerantly by `pageNotes` in `src/lib/seo/pages.ts`. Stored in `seo_reviews.detail`, so no table changed. With no notes a page draws its figures and a plain sentence.
- A target keeps its `seo_metrics` scope when its wording changes (`detail.label`), because a new scope would add a sixth number beside the old row.
- A need tied to a plan item drops off Overview once that item is done. The Toolsurf login and the count of strategy changes are worked out, not written.
- A proposal's recommendation is in `seo_log.after_value`.
- Directories never count as competitors. They are counted as a share of the top-3 spots.
- A login or CAPTCHA stop outranks "late" on the task state, because it says what to do. A login stop needs the owner; a CAPTCHA stop retries by itself, so it reads No action.
- An Ahrefs day reads Saved when a logged-out attempt came before a finished run on that day, and Login when it ended logged out. The morning check in `data/daily` counts as an attempt.
- Verdict rules and the guard against changing course on one week's moves are in `data/plan/board.json` in the website folder. The Monday review applies them; the app shows the result.
- A board item needs evidence to be marked Done, as the board's own rule says. An answer to a strategy change cannot be overwritten, even by Admin, because the Monday review may already have acted on it. `change` means the owner adopted it; `keep` means declined, and the same change is not proposed again.
- Lead data is counts only. Names and phone numbers never enter this module.
- The 6-month review is a written analysis, not a calculation: the scheduled session writes `data/plan/six-month-review.json` and `data/plan/discussion-brief.json` in the website folder and the sender delivers them. BOE One draws what it is given and works nothing out, so a wrong figure is fixed in the file.
- Positions and views are compared from 13 Sep only. Google stopped counting 100-result pages around 10 to 13 Sep 2025, so an earlier year-ago position reads about 7 places worse than it was. Clicks are not affected.
- Bing's AI Performance has no data from 27 Aug to 19 Oct 2026, so its 3-month view covers 36 days and must not be compared with its 6-month total.
- The employee audit, pay and role cost never enter this module. `docs/change-log.md` in the website folder can name customers, so the Year review reads the hand-written `data/plan/year-work.json`, not that file.

- A brief section may now be left out whole: the spec wraps it as `{ '?': spec }` in `sixMonth.ts`. The September brief still passes, and the four review sections (scored, others, yours, next) are optional.
- The data check ignores fields it does not know, but refuses a document missing a field it requires. So a brief that drops a required section waits until the code that makes it optional is live, or every daily send is refused.
- A proof is `{ label, url?, shows, how }`. The door accepts only https links (no `http:`, `javascript:`, `data:` or relative paths), and every link opens in a new tab with `rel="noopener noreferrer"`. A proof with no `url` names a file, such as his worksheet tab, and draws as plain text. Search Console links open only for someone signed in to the property, so the brief points to the evidence pack for dated screenshots.
- A quarter row may carry `group` (its category) and `shown` (Google's impressions per column). Grouped tables add a category heading with summed clicks and a "Since" column; the change uses only positions from 20 or more showings (`FEW_SHOWINGS` in `SeoBriefCase.tsx`), first column against the last firm one. The worksheet chart (`proof`) is optional in a case, and credit and fairness hide when both are empty.
- Search Console traps when reading many searches: a 120-term exact regex froze the browser tab, so read in groups of 40; JavaScript output that contains "=" is blocked by the browser tool. A query filter makes totals partial (anonymised searches drop out), so the all-clicks proof link carries no filter.

## 7. Traps

- Search Console's own notice: a logging fault overstated impressions, CTR and average position from 13 May 2025 to 27 Apr 2026. Clicks were not affected. Never compare positions or impressions across 27 Apr 2026; the brief's quarterly table carries this warning.
- The repository is public. No SEO figures go in a migration, a fixture or a test. `sixMonthSample.ts` is made up.
- The sender must not post a new key before the code that accepts it is live: the door refuses the whole delivery, and the daily runs fail with it.
- `results.json` holds older URLs without `https://`. Normalise before counting, or brand counts come out too low (the sender's `host()`).
- A finished Ahrefs file can name `not_run_logged_out` in its attempts, so read its top-level `status`, not the text. The sender used to mark 28 Oct logged out this way.
- A city day's Stop is not remembered. The sender works it out from the queue on each send, so once the queue moves on that day reads Ran, as 1 Nov now does.
- Filename order is not run order in `data/ahrefs-daily/`: a day can have `_run2.json` and `_run2_not_run.json`. The sender orders by file time.
- The sender resends everything each run. That is safe only because every table upserts on a stable key, so keep ids stable. A proposal's id is its position in `proposed_changes`: never reorder or delete that list.
- An item removed from `board.json` stays in `seo_plan_items`, because the door only upserts. Delete it by hand.
- The sender needs the `decisions` fetch to come first. Sending before fetching would put the folder's older status over a person's edit.
- The migration rehearsal on the linked database is refused. Use PGlite (`~/BOE-Development/temporary/pglite-env`), and copy Supabase's default privileges into the stub or the revoke proves nothing.

## 8. Recheck before changing

Every new writer goes through the ingest door or a new function with its own check. A new table needs `module_entry_open('seo')`. Screens read through `fetchSeoData`; do not add a second read per screen. The one exception is the brief, `fetchLatestBrief`: it stays out of the shared read so it never reaches anybody else's browser. The read keeps 400 days, so anything shown for longer needs its own query.
