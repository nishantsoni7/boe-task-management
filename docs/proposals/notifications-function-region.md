# Proposal: run the Vercel functions in the database's region

**Status: PROPOSED — not applied.** Applying it is a production configuration
change and a deployment decision for the owner.

## The evidence

Measured 15–16 September 2026 on preview deployment `55c76453` with temporary
`Server-Timing` instrumentation (since reverted), signed in as a real user.

* The Supabase project `albnsrohngkljfsrrrhf` is in **`ap-northeast-1` (Tokyo)**
  — Supabase Management API, `projects list`.
* Every response carries `x-vercel-id: bom1::iad1`, so the **functions run in
  `iad1` (US East)** while the browser reaches the edge in Mumbai.
* One `GET /api/notifications` (list) spent **3.08 s** on the server:

  | Stage | What it is | Measured |
  | --- | --- | --- |
  | `auth` | `auth.getUser()` → Supabase Auth | 0.73 s |
  | `viewas` | one `users` row read | 0.65 s |
  | wave | the notification list query | 0.97 s |
  | `enrich` | task/activity/attachment reads, then names | 1.38 s |

* The unread count spent **0.99 s** over three stages.
* The same kind of read straight from the browser (India → Tokyo) measured
  **0.25–0.7 s**, against **0.26–0.97 s** per round trip from the function.

So the server time is dominated by a handful of sequential round trips, each
crossing the Pacific. Fewer trips would help; so would shorter ones.

## The exact change

`vercel.json`, one key:

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "regions": ["hnd1"],
  "crons": [{ "path": "/api/image-editor/cleanup", "schedule": "0 3 * * *" }]
}
```

`hnd1` is Vercel's Tokyo region — the same city as the database.

Next.js's per-route `preferredRegion` is **not** an option here: on Vercel it
applies only to routes with `runtime = 'edge'`, and these are Node routes. The
region is therefore set for the whole deployment.

## What it affects

* **All 132 API route handlers** and every server-rendered route in `src/app`.
* **The nightly cron** `/api/image-editor/cleanup` (schedule unchanged).
* **Static assets and the edge cache are unaffected** — they stay on the CDN
  near the visitor.

Expected to get faster: everything that talks to Supabase from the server,
which is almost every route.

Expected to get slower, and worth weighing:

* **Image Editor** — `/api/image-editor/studio`, `/convert`, `/results`,
  `/results/[id]`, `/cleanup` call fal (`fal.run`, `v3b.fal.media`), which is
  US-hosted. These already run up to 60 s; adding a Pacific crossing to their
  fal calls is the real cost of this change.
* **Anthropic-calling routes** (payroll, attendance, customer-review generation)
  — `api.anthropic.com` is globally distributed, so the effect should be small
  but is unmeasured.

Unchanged: authorization, RLS, service-role usage, the Minop device webhook
(inbound from India — Tokyo is nearer than US East), and every database schema.

## Expected effect, stated as an estimate

If each server-side round trip falls to same-region latency (tens of
milliseconds), the list's 3.08 s of server time would fall well under 1 s and
the unread count under 0.3 s. **This is an inference from the stage timings,
not a measurement.** It should be verified after applying by re-reading the
same stages.

## How to verify after applying

1. Confirm `x-vercel-id` shows `hnd1` on a production response.
2. Re-measure the list and count wall times from a signed-in browser, several
   runs, and compare with the numbers above.
3. Watch an Image Editor job end to end, since that is the route that pays.

## Rollback

* Revert the `vercel.json` commit (or delete the `regions` key) and redeploy —
  the deployment returns to the project's default region.
* No database change, no data migration, no schema or permission change is
  involved in either direction.
* The dashboard's own Function Region setting can also be set back to
  Washington, D.C. (`iad1`) without a deploy.
