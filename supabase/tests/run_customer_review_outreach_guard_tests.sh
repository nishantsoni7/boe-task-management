#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════════════════
# The runner's guards, tested — because a guard nobody has watched fail is a
# comment
# ═════════════════════════════════════════════════════════════════════════════
#
# run_customer_review_outreach_local.sh will only build on a database that has
# been named explicitly, marked disposable, and is empty in public, auth and
# storage. Those checks exist to stop somebody pointing a schema-writing script
# at a database that matters. This drives each one and asserts two things every
# time: that the run was REFUSED, and that NOTHING WAS WRITTEN.
#
# The second half is the part worth having. A guard that aborts after creating
# three tables is not a guard, and only the database can say which happened.
#
# WHAT IT DOES TO YOUR STACK
# --------------------------
# It temporarily removes the marker, sets a wrong one, creates a probe table, an
# auth identity and a storage object — then removes each and restores the marker.
# Every case cleans up in a trap, so an interrupted run does not leave the stack
# altered. It is still only for the disposable stack: it refuses to start
# unless the marker is present, which is the same statement the runner asks for.
#
#   BOE_DB_CONTAINER=supabase_db_myproject \
#     supabase/tests/run_customer_review_outreach_guard_tests.sh

set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUNNER="$REPO/supabase/tests/run_customer_review_outreach_local.sh"
MARKER="boe-disposable-customer-review-test"

if [ -z "${BOE_DB_CONTAINER:-}" ]; then
  echo "FATAL: BOE_DB_CONTAINER is not set. Name the disposable container." >&2
  exit 1
fi
DB="$BOE_DB_CONTAINER"

q() { docker exec -i "$DB" psql -U postgres -d postgres -At -c "$1" 2>/dev/null; }
qq() { docker exec -i "$DB" psql -U postgres -d postgres -q -c "$1" >/dev/null 2>&1; }

# storage.objects and storage.buckets both carry BEFORE DELETE guards
# (storage.protect_objects_delete, storage.protect_buckets_delete) that refuse
# direct deletion, because in a real deployment they would orphan files. This
# harness only ever wrote ROWS — there are no files — so the guard is suspended
# for the length of one transaction to clear up after itself. Nothing else runs
# with it off, and no product code path does this.
qq_storage() {
  docker exec -i "$DB" psql -U postgres -d postgres -q \
    -c "begin; set local session_replication_role = 'replica'; $1; commit;" >/dev/null 2>&1
}

# This script only touches a stack that is already declared throwaway.
START_MARKER="$(q "select coalesce(shobj_description(oid,'pg_database'),'') from pg_database where datname = current_database()")"
if [ "$START_MARKER" != "$MARKER" ]; then
  echo "FATAL: $DB is not marked as the disposable test stack." >&2
  echo "       This script alters the database to test the guards; it will not" >&2
  echo "       do that to anything else." >&2
  exit 1
fi

restore() {
  qq "comment on database postgres is '$MARKER'"
  qq "drop table if exists public._guard_probe"
  qq_storage "delete from storage.objects where name = '_guard_probe.txt'"
  qq_storage "delete from storage.buckets where id = '_guard_probe'"
  qq "delete from auth.users where email = 'guard.probe@example.test'"
}
trap restore EXIT

PASS=0; FAIL=0
# Asserts the runner refused AND wrote nothing.
refused() {
  local label="$1"; shift
  local out rc tables
  out="$("$@" 2>&1)"; rc=$?
  tables="$(q "select count(*) from pg_tables where schemaname='public'")"
  # The probe table this case may have created does not count as "written by the runner".
  local expected="${EXPECT_TABLES:-0}"
  if [ "$rc" -eq 0 ]; then
    echo "FAIL  $label — the runner ACCEPTED it"; FAIL=$((FAIL+1)); return
  fi
  if [ "$tables" != "$expected" ]; then
    echo "FAIL  $label — refused, but public now has $tables table(s), expected $expected"
    FAIL=$((FAIL+1)); return
  fi
  if ! grep -q "Nothing was written\|FATAL" <<<"$out"; then
    echo "FAIL  $label — refused without saying so"; FAIL=$((FAIL+1)); return
  fi
  echo "PASS  $label — refused, $expected table(s) in public"
  PASS=$((PASS+1))
}

echo "══ guard tests against $DB"
echo

# 1. No container named at all.
EXPECT_TABLES=0 refused "no BOE_DB_CONTAINER set" \
  env -u BOE_DB_CONTAINER bash "$RUNNER"

# 2. A container that is not running.
EXPECT_TABLES=0 refused "a container name that does not exist" \
  env BOE_DB_CONTAINER=supabase_db_not_a_real_container bash "$RUNNER"

# 3. Marker absent.
qq "comment on database postgres is NULL"
EXPECT_TABLES=0 refused "no disposable-stack marker" \
  env BOE_DB_CONTAINER="$DB" bash "$RUNNER"
qq "comment on database postgres is '$MARKER'"

# 4. Marker present but wrong.
qq "comment on database postgres is 'someone-elses-database'"
EXPECT_TABLES=0 refused "marker mismatch" \
  env BOE_DB_CONTAINER="$DB" bash "$RUNNER"
qq "comment on database postgres is '$MARKER'"

# 5. public holds a table.
qq "create table public._guard_probe (id int)"
EXPECT_TABLES=1 refused "public schema is not empty" \
  env BOE_DB_CONTAINER="$DB" bash "$RUNNER"
qq "drop table public._guard_probe"

# 6. auth.users holds an identity — the case an empty public schema hides.
qq "insert into auth.users (instance_id, id, aud, role, email)
    values ('00000000-0000-0000-0000-000000000000', gen_random_uuid(),
            'authenticated', 'authenticated', 'guard.probe@example.test')"
EXPECT_TABLES=0 refused "auth.users holds an identity" \
  env BOE_DB_CONTAINER="$DB" bash "$RUNNER"
qq "delete from auth.users where email = 'guard.probe@example.test'"

# 7. storage holds an object — likewise.
qq "insert into storage.buckets (id, name) values ('_guard_probe', '_guard_probe')"
qq "insert into storage.objects (bucket_id, name) values ('_guard_probe', '_guard_probe.txt')"
EXPECT_TABLES=0 refused "storage holds an object" \
  env BOE_DB_CONTAINER="$DB" bash "$RUNNER"
qq_storage "delete from storage.objects where name = '_guard_probe.txt'"
qq_storage "delete from storage.buckets where id = '_guard_probe'"

# 8. ...and the stack the guards are meant to accept.
echo
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
