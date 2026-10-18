# Running the live-database test suites

Eight suites create real auth users and rows to prove RLS and route-level authorization against an actual
database: `src/app/api/payroll/{delete,periods,unlock}/route.test.ts`, `src/app/api/payroll/settlementAuth.test.ts`
and `src/lib/security/{attendancePayrollApiIsolation,attendancePayrollIsolation,objectionIsolation,usersPrivateColumns}.test.ts`.

By default they **skip** (exit 0, reason printed). `REQUIRE_LIVE_DB_TESTS=1` turns a missing or refused database
into a failure. They never run against production: the shared guard (`scripts/lib/uatEnv.mjs`) refuses a hosted
project unless it is named explicitly.

## One-time setup of a disposable project

1. **Create a new Supabase project** used for nothing else (free tier is enough). Note its project ref (the
   `abcdefghijklmnop` in `https://abcdefghijklmnop.supabase.co`).
2. **Give it the schema.** The migration history cannot build an empty database
   (see `docs/migrations-are-not-self-contained.md`: `public.users`, `tasks`, `task_activity_log` and
   `notifications` are created by no migration). So seed it from a **schema-only** copy of the real database,
   never from data:
   - dump the schema of production **read-only**: `supabase db dump --schema public --linked -f schema.sql`
     (do NOT pass `--data-only`, and do not dump data);
   - restore it into the new project (SQL editor or `psql`), then check `supabase migration list` against the
     test project and apply only what is missing.
   Keep `schema.sql` out of the repository.
3. **Add repository secrets** (GitHub → Settings → Secrets and variables → Actions):

   | Secret | Value |
   |---|---|
   | `TEST_SUPABASE_URL` | the test project URL |
   | `TEST_SUPABASE_ANON_KEY` | its anon/publishable key |
   | `TEST_SUPABASE_SERVICE_ROLE_KEY` | its service-role/secret key |
   | `TEST_SUPABASE_OVERRIDE` | `I-KNOW-THIS-IS-NOT-PRODUCTION:<project-ref>` |

4. Run **Actions → Live database tests → Run workflow** once. It also runs nightly.

## Running locally

Put the same four values in a `.env.local` that points at the test project (never at production), then:

```
REQUIRE_LIVE_DB_TESTS=1 UAT_ALLOW_REMOTE_TARGET=I-KNOW-THIS-IS-NOT-PRODUCTION:<project-ref> npx tsx --test --test-concurrency=1 src/lib/security/*.test.ts src/app/api/payroll/*/route.test.ts src/app/api/payroll/settlementAuth.test.ts
```

Run them one at a time: they share fixtures, and two runs at once delete each other's rows.
