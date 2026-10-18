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
2. **Give it the schema, in three parts** (this exact sequence made all 206 live tests pass; the dump alone is NOT enough):
   1. **Dump production's schema, read-only, no data** (needs Docker Desktop running for `pg_dump`):
      `supabase db dump --linked --schema public -f prod_public_schema.sql`. Never pass `--data-only`. Keep the file out of the repository.
   2. **Apply it to the test project only** (`supabase link --project-ref <test-ref>` in a separate working
      folder, then `supabase db query --linked --file prod_public_schema.sql`).
   3. **Reset privileges, then re-apply the dump's own grants.** The dump lists only the privileges that differ
      from Supabase's defaults, and a new project hands anon/authenticated full access at table creation, so
      the column-level protections (an employee cannot read `monthly_salary`) silently do not exist and 14
      security tests fail. Build `grants.sql` as three `REVOKE ALL ON ALL TABLES|SEQUENCES|FUNCTIONS IN SCHEMA
      public FROM [PUBLIC,] anon, authenticated, service_role;` statements followed by every line of the dump
      that starts with `GRANT ` or `REVOKE ` (`grep -E '^(GRANT|REVOKE) ' prod_public_schema.sql`), and apply it.
   Then apply the reference data and reference accounts the suites expect: `supabase db query --linked --file
   supabase/tests/live-db-seed.sql`. It is the repository's own seed plus three fake `@example.invalid`
   accounts; no production data. Add rows to it when a suite reports missing reference data.
   The migration history cannot build this database itself
   (see `docs/migrations-are-not-self-contained.md`), and it carries no migration ledger; for newer
   migrations, re-dump and repeat.
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

## Keeping the schema current

The test database is a copy of production's schema as of the migration named in
`supabase/tests/live-db-schema-version.txt`. The nightly workflow prints a warning when the repository has a
newer migration. To refresh: repeat step 2 (dump, apply to a fresh or emptied test project, reset privileges,
seed), then update that file to the newest migration the dump reflects.
