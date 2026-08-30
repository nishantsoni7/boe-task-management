#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════════════════
# The gate's tests — because a guard nobody has watched fail is a comment
# ═════════════════════════════════════════════════════════════════════════════
#
# run_customer_review_outreach_local.sh will only build on a database that has
# been named explicitly, marked disposable, and is empty in public, auth,
# storage and the migration ledger. Those checks exist to stop somebody pointing
# a schema-writing script at a database that matters.
#
# Two kinds of test live here:
#
#   BEHAVIOURAL — the runner is invoked for real against a stack broken in one
#   specific way, and must refuse. Every one also asserts that NOTHING WAS
#   WRITTEN, because a guard that aborts after creating three tables is not a
#   guard, and only the database can say which happened.
#
#   DIRECT — count_or_die() is called on its own with a query that errors and
#   with one that returns something that is not a count. Those failure modes
#   cannot be produced by breaking the database — a count(*) that runs always
#   returns a number — so they are exercised at the function. It is the same
#   code the runner uses: the gate lives in lib/disposable_stack_guard.sh and is
#   sourced by both, so there is no second implementation to drift.
#
# WHAT IT DOES TO YOUR STACK
# --------------------------
# It removes the marker, sets a wrong one, creates a probe table, an auth
# identity and a storage object, and creates a separate throwaway DATABASE that
# has no auth or storage schema. Every one is undone, and the undo also runs
# from a trap, so an interrupted run does not leave the stack altered.
#
# It does NOT rename auth.users or the storage schema, which would be the
# obvious way to test a missing relation: postgres owns neither and cannot
# become supabase_auth_admin, so those statements are refused. An earlier
# version tried anyway through a silent helper, and the case went on to report
# that the runner had accepted a stack with a missing auth table — it had not;
# the injection never happened. Every injection now runs through inject(), which
# aborts the whole script if the setup does not take.
#
# BEFORE IT TOUCHES ANYTHING it runs the full gate itself. If this database is
# not the marked, empty, disposable stack, nothing is created and nothing is
# deleted — the script stops. It will not "clean up" a database to make itself
# runnable.
#
#   BOE_DB_CONTAINER=supabase_db_myproject \
#     supabase/tests/run_customer_review_outreach_guard_tests.sh

set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUNNER="$REPO/supabase/tests/run_customer_review_outreach_local.sh"
MARKER="boe-disposable-customer-review-test"
PROBE_DB="boe_guard_probe_db"

if [ -z "${BOE_DB_CONTAINER:-}" ]; then
  echo "FATAL: BOE_DB_CONTAINER is not set. Name the disposable container." >&2
  exit 1
fi
DB_CONTAINER="$BOE_DB_CONTAINER"
DB="$BOE_DB_CONTAINER"

if ! docker ps --format '{{.Names}}' | grep -qx "$DB"; then
  echo "FATAL: no running container named $DB." >&2
  exit 1
fi

# The same gate the runner uses, not a copy of it.
# shellcheck source=supabase/tests/lib/disposable_stack_guard.sh
. "$REPO/supabase/tests/lib/disposable_stack_guard.sh"

# ── PRECONDITION: this script alters the database, so it checks first ────────
#
# Independently, and before any fault injection: the marker must be exact, and
# public, auth, storage and the ledger must all be empty. A missing schema, a
# failed query or an unexpected result stops the script here, having created and
# deleted nothing.
if ! require_disposable_stack; then
  echo >&2
  echo "REFUSING TO RUN. This script injects faults to test the guards; it will" >&2
  echo "only do that to the marked, empty, disposable stack. Nothing was created" >&2
  echo "and nothing was deleted." >&2
  exit 1
fi
echo "══ precondition: $DB is the marked, empty, disposable stack"
echo

q()  { docker exec -i "$DB" psql -U postgres -d postgres -At -c "$1" 2>/dev/null; }
qq() { docker exec -i "$DB" psql -U postgres -d postgres -q -c "$1" >/dev/null 2>&1; }

# EVERY FAULT INJECTION GOES THROUGH THIS, and the reason is a bug this harness
# had: it broke the stack with a silent `qq`, and when one of those injections
# turned out to be impossible — postgres does not own auth.users, so the rename
# was refused — the case still ran, found a perfectly healthy database, and
# reported that the runner had ACCEPTED a stack with a missing auth table. The
# guard was fine; the test was lying.
#
# An injection that does not take is not a test. This aborts the whole script.
inject() {
  local label="$1" sql="$2" out
  if ! out="$(docker exec -i "$DB" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q -c "$sql" 2>&1)"; then
    echo "FATAL: could not set up the '$label' case; the test would prove nothing." >&2
    printf '%s\n' "$out" | sed 's/^/         /' >&2
    exit 1
  fi
}

# storage.objects and storage.buckets both carry BEFORE DELETE guards
# (storage.protect_objects_delete, storage.protect_buckets_delete) that refuse
# direct deletion, because in a real deployment they would orphan files. This
# harness only ever wrote ROWS — there are no files — so the guard is suspended
# for one transaction to clear up after itself. Nothing else runs with it off,
# and no product code path does this.
qq_storage() {
  docker exec -i "$DB" psql -U postgres -d postgres -q \
    -c "begin; set local session_replication_role = 'replica'; $1; commit;" >/dev/null 2>&1
}

restore() {
  qq "drop database if exists $PROBE_DB"
  qq "comment on database postgres is '$MARKER'"
  qq "drop table if exists public._guard_probe"
  qq_storage "delete from storage.objects where name = '_guard_probe.txt'"
  qq_storage "delete from storage.buckets where id = '_guard_probe'"
  qq "delete from auth.users where email = 'guard.probe@example.test'"
}
trap restore EXIT

PASS=0; FAIL=0

# The runner must refuse AND have written nothing.
refused() {
  local label="$1"; shift
  local out rc tables expected="${EXPECT_TABLES:-0}"
  out="$("$@" 2>&1)"; rc=$?
  tables="$(q "select count(*) from pg_tables where schemaname='public'")"
  if [ "$rc" -eq 0 ]; then
    echo "FAIL  $label — the runner ACCEPTED it"; FAIL=$((FAIL+1)); return
  fi
  if [ "$tables" != "$expected" ]; then
    echo "FAIL  $label — refused, but public now has $tables table(s), expected $expected"
    FAIL=$((FAIL+1)); return
  fi
  if ! grep -q "Nothing was written" <<<"$out"; then
    echo "FAIL  $label — refused without saying nothing was written"; FAIL=$((FAIL+1)); return
  fi
  echo "PASS  $label — refused before writing, $expected table(s) in public"
  PASS=$((PASS+1))
}

# count_or_die must reject, on its own terms.
rejects() {
  local label="$1" sql="$2" out
  if out="$(count_or_die "probe" "$sql" 2>&1)"; then
    echo "FAIL  $label — count_or_die returned '$out' instead of failing"
    FAIL=$((FAIL+1)); return
  fi
  echo "PASS  $label — count_or_die refused"
  PASS=$((PASS+1))
}

echo "══ behavioural: the runner, against a stack broken one way at a time"
echo

# 1. No container named at all.
EXPECT_TABLES=0 refused "no BOE_DB_CONTAINER set" \
  env -u BOE_DB_CONTAINER bash "$RUNNER"

# 2. A container that is not running.
EXPECT_TABLES=0 refused "a container name that does not exist" \
  env BOE_DB_CONTAINER=supabase_db_not_a_real_container bash "$RUNNER"

# 3. Marker absent.
inject "marker absent" "comment on database postgres is NULL"
EXPECT_TABLES=0 refused "no disposable-stack marker" \
  env BOE_DB_CONTAINER="$DB" bash "$RUNNER"
qq "comment on database postgres is '$MARKER'"

# 4. Marker present but wrong.
inject "marker mismatch" "comment on database postgres is 'someone-elses-database'"
EXPECT_TABLES=0 refused "marker mismatch" \
  env BOE_DB_CONTAINER="$DB" bash "$RUNNER"
qq "comment on database postgres is '$MARKER'"

# 5. Correctly marked, but public already holds an application table.
inject "populated public" "create table public._guard_probe (id int)"
EXPECT_TABLES=1 refused "correctly marked but populated public schema" \
  env BOE_DB_CONTAINER="$DB" bash "$RUNNER"
qq "drop table public._guard_probe"

# 6. Correctly marked, empty public — and an identity in auth. The case the
#    original public-only check could not see.
inject "auth identity" "insert into auth.users (instance_id, id, aud, role, email)
    values ('00000000-0000-0000-0000-000000000000', gen_random_uuid(),
            'authenticated', 'authenticated', 'guard.probe@example.test')"
EXPECT_TABLES=0 refused "correctly marked, empty public, but auth holds an identity" \
  env BOE_DB_CONTAINER="$DB" bash "$RUNNER"
qq "delete from auth.users where email = 'guard.probe@example.test'"

# 7. ...and an object in storage, likewise.
inject "storage bucket" "insert into storage.buckets (id, name) values ('_guard_probe', '_guard_probe')"
inject "storage object" "insert into storage.objects (bucket_id, name) values ('_guard_probe', '_guard_probe.txt')"
EXPECT_TABLES=0 refused "correctly marked, empty public, but storage holds an object" \
  env BOE_DB_CONTAINER="$DB" bash "$RUNNER"
qq_storage "delete from storage.objects where name = '_guard_probe.txt'"
qq_storage "delete from storage.buckets where id = '_guard_probe'"

# 8. A MARKED, EMPTY DATABASE THAT HAS NO auth SCHEMA AT ALL.
#
#    The obvious injection — rename auth.users out of the way — cannot be done
#    here: postgres does not own it and cannot become supabase_auth_admin. So
#    instead of faking the condition, this makes a database that genuinely has
#    it: a fresh one in the same container, which Postgres creates with nothing
#    but public. It is marked disposable and its public schema is empty, so it
#    passes every earlier guard and reaches the auth probe — which under the old
#    `|| echo 0` reported "no identities, go ahead" and would have let the
#    baseline be written into it.
inject "probe database" "create database $PROBE_DB"
if ! docker exec -i "$DB" psql -U postgres -d "$PROBE_DB" -v ON_ERROR_STOP=1 -q \
       -c "comment on database $PROBE_DB is '$MARKER'" >/dev/null 2>&1; then
  echo "FATAL: could not mark the probe database." >&2; exit 1
fi

EXPECT_TABLES=0 refused "marked and empty, but the auth schema does not exist" \
  env BOE_DB_CONTAINER="$DB" BOE_DB_NAME="$PROBE_DB" bash "$RUNNER"

# 9. ...and the storage probe, on that same database, at the function.
#    The runner refuses at auth before it reaches storage, so the storage case
#    is asked directly — same code, same database, the schema genuinely absent.
if DB_NAME="$PROBE_DB" count_or_die "storage objects" "select count(*) from storage.objects" >/dev/null 2>&1; then
  echo "FAIL  the storage schema does not exist — count_or_die returned a number anyway"
  FAIL=$((FAIL+1))
else
  echo "PASS  the storage schema does not exist — count_or_die refused"
  PASS=$((PASS+1))
fi

inject "drop probe database" "drop database $PROBE_DB"

echo
echo "══ direct: the failure modes a broken database cannot produce"
echo

rejects "a query that errors"        "select count(*) from public.no_such_relation"
rejects "output that is not a count" "select 'not a number'"
rejects "more than one row"          "select generate_series(1, 2)"
rejects "an empty result"            "select 1 where false"

echo
echo "══ and the stack the guards are meant to accept"

LEFTOVER="$(q "select
  (select count(*) from pg_tables where schemaname='public')
+ (select count(*) from auth.users)
+ (select count(*) from storage.objects)
+ (select count(*) from storage.buckets)")"
if [ "$LEFTOVER" != "0" ]; then
  echo "FAIL  the harness did not clean up after itself ($LEFTOVER row(s)/table(s) left);"
  echo "      the accept case cannot be judged."
  FAIL=$((FAIL+1))
elif out="$(env BOE_DB_CONTAINER="$DB" bash "$RUNNER" 2>&1)"; then
  echo "PASS  a correctly marked, empty stack is accepted"
  PASS=$((PASS+1))
else
  echo "FAIL  a correctly marked, empty stack was REFUSED:"
  echo "$out" | tail -20 | sed 's/^/        /'
  FAIL=$((FAIL+1))
fi

echo
echo "══ $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
