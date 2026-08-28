#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════════════════
# TEST-ONLY RUNNER — Customer Review Outreach, isolated local database
# ═════════════════════════════════════════════════════════════════════════════
#
# WHAT THIS IS FOR
# ----------------
# customer_review_request_visibility_assertions.sql proves things no text audit
# can — chiefly that an authorized employee's `INSERT ... RETURNING` is accepted,
# which is the defect that shipped in 51d2f51 past 364 passing unit tests. That
# file needs a database with the module's migration applied. This builds one.
#
# It cannot use the repository's own migration history: the 210 files there
# cannot construct a blank database, because public.users, tasks,
# task_activity_log and notifications predate the chain (see
# docs/migrations-are-not-self-contained.md). So it lays down a test-only
# stand-in for public.users, then applies the five REAL prerequisites and the
# REAL pending migration, whole and unmodified.
#
#   1.   the test-only baseline (bootstrap/000_…_baseline.sql) — NOT a migration
#   2-6. five real prerequisite migrations
#   7.   the real pending migration, whose own assertion block runs inside it
#   8.   the visibility assertions
#
# WHAT IT WILL NOT DO
# -------------------
# It will not choose its own target: BOE_DB_CONTAINER must name the container.
# It will not run against a database that has not been marked disposable, or
# whose marker does not match. It will not run if public holds tables, if
# auth.users holds identities, if storage holds objects or buckets, or if the
# migration ledger has history — any one of those means the database is somebody's,
# and an empty public schema alone never proved otherwise. It will not run if a
# prerequisite migration differs from HEAD, because a run proves nothing if the
# ground under the pending migration has shifted.
#
# It never resets, never deletes, never repairs, never edits a migration, and
# never contacts anything outside the named local container. Every guard runs
# before the first statement is applied, so a refusal leaves the database
# untouched.
#
# PREREQUISITES
# -------------
#   1. Docker running, and a local Supabase stack for this repo:
#
#        supabase init          # if supabase/config.toml does not exist yet
#
#      Then, in supabase/config.toml, turn OFF automatic migrations:
#
#        [db.migrations]
#        enabled = false
#
#      Without that, `supabase start` tries the full history and dies on the
#      first file. (config.toml is deliberately not committed: its ports are
#      per-machine. On Windows the defaults may collide with reserved ranges —
#      check `netsh interface ipv4 show excludedportrange protocol=tcp` and
#      shift them if `supabase start` reports a socket permission error.)
#
#   2. supabase start
#   3. supabase db reset --no-seed
#
#   4. NAME THE TARGET, and MARK IT DISPOSABLE. Both are deliberate acts and
#      neither is guessed:
#
#        export BOE_DB_CONTAINER=supabase_db_<your-project>
#        docker exec -i "$BOE_DB_CONTAINER" psql -U postgres -d postgres -c \
#          "comment on database postgres is 'boe-disposable-customer-review-test'"
#
#      The marker lives in the database rather than in a file, so it travels
#      with the thing being protected. Setting it is a statement that this
#      database holds nothing anybody wants.
#
# WHY BOTH, AND WHY NO AUTODETECT
# -------------------------------
# An earlier version picked the only running `supabase_db_*` container and
# accepted any database whose `public` schema was empty. Both were wrong.
# "The only one running" is not the same as "the one you meant" — on a machine
# with one stack it is the same container every time, right up until the day it
# is not. And an empty `public` schema says nothing about `auth.users` or
# `storage.objects`, which is exactly where a real deployment keeps the things
# that must not be written over.
#
# So: the container is named explicitly, the marker must be present and exact,
# and public/auth/storage must all be empty. Every check runs BEFORE any SQL is
# applied, and a failure aborts rather than repairing anything. This script
# never resets a stack, never deletes, and never contacts a linked or remote
# project.
#
# USAGE
#   BOE_DB_CONTAINER=supabase_db_myproject supabase/tests/run_customer_review_outreach_local.sh
#
# THE GUARDS HAVE THEIR OWN TESTS
#   supabase/tests/run_customer_review_outreach_guard_tests.sh
#   drives this script against a wrong container, a missing marker, a mismatched
#   marker, a populated public schema, an existing auth identity and an existing
#   storage object, and checks that each is refused with nothing written — then
#   that the correct empty stack is accepted.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

BASELINE="supabase/tests/bootstrap/000_customer_review_module_baseline.sql"
ASSERTIONS="supabase/tests/customer_review_request_visibility_assertions.sql"
PENDING="20261017000000_customer_review_outreach.sql"
MIGRATIONS=(
  "20260609_create_attendance_records.sql"
  "20260645_create_control_center_v1.sql"
  "20260660_create_permission_engine.sql"
  "20260661_add_permission_engine_bulk_resolver.sql"
  "20260662_fix_permission_resolver_team_cast.sql"
  "20261017000000_customer_review_outreach.sql"
)

MARKER="boe-disposable-customer-review-test"

# ── The target is named, never guessed ──────────────────────────────────────
if [ -z "${BOE_DB_CONTAINER:-}" ]; then
  echo "FATAL: BOE_DB_CONTAINER is not set." >&2
  echo "       Name the container explicitly; this script will not choose one." >&2
  echo "       Running Supabase database containers:" >&2
  docker ps --format '{{.Names}}' | grep '^supabase_db_' | sed 's/^/         /' >&2 || true
  exit 1
fi
DB_CONTAINER="$BOE_DB_CONTAINER"

if ! docker ps --format '{{.Names}}' | grep -qx "$DB_CONTAINER"; then
  echo "FATAL: no running container named $DB_CONTAINER." >&2
  exit 1
fi

psql_q() { docker exec -i "$DB_CONTAINER" psql -U postgres -d postgres -At -c "$1"; }
psql_file() {
  # ON_ERROR_STOP=1 makes the first error abort the file rather than leaving a
  # half-applied migration behind.
  docker exec -i "$DB_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q < "$1"
}

# ── SAY WHAT IS ABOUT TO BE WRITTEN TO, BEFORE WRITING ──────────────────────
echo "══ target"
echo "──   container : $DB_CONTAINER"
echo "──   database  : $(psql_q 'select current_database()')"
echo "──   server    : $(psql_q 'select inet_server_addr()::text' 2>/dev/null || echo 'local socket')"
echo "──   marker    : $(psql_q "select coalesce(shobj_description(oid, 'pg_database'), '(none)') from pg_database where datname = current_database()")"
echo

# ── Every guard runs before a single statement is applied ───────────────────
fail() { echo "FATAL: $1" >&2; echo "       Nothing was written." >&2; exit 1; }

FOUND_MARKER="$(psql_q "select coalesce(shobj_description(oid, 'pg_database'), '') from pg_database where datname = current_database()")"
if [ -z "$FOUND_MARKER" ]; then
  echo "FATAL: $DB_CONTAINER carries no disposable-stack marker." >&2
  echo "       This script only builds on a database somebody has declared throwaway:" >&2
  echo "         docker exec -i $DB_CONTAINER psql -U postgres -d postgres -c \\" >&2
  echo "           \"comment on database postgres is '$MARKER'\"" >&2
  echo "       Nothing was written." >&2
  exit 1
fi
[ "$FOUND_MARKER" = "$MARKER" ] || \
  fail "marker mismatch on $DB_CONTAINER: found '$FOUND_MARKER', expected '$MARKER'."

# public — application tables
PUBLIC_TABLES="$(psql_q "select count(*) from pg_tables where schemaname = 'public'")"
[ "$PUBLIC_TABLES" = "0" ] || \
  fail "the public schema of $DB_CONTAINER holds $PUBLIC_TABLES table(s)."

# auth — identities. An empty public schema says nothing about these.
AUTH_USERS="$(psql_q "select count(*) from auth.users" 2>/dev/null || echo 0)"
[ "$AUTH_USERS" = "0" ] || \
  fail "auth.users in $DB_CONTAINER holds $AUTH_USERS identit(ies)."

# storage — buckets and the objects in them
STORAGE_OBJECTS="$(psql_q "select count(*) from storage.objects" 2>/dev/null || echo 0)"
[ "$STORAGE_OBJECTS" = "0" ] || \
  fail "storage.objects in $DB_CONTAINER holds $STORAGE_OBJECTS object(s)."

STORAGE_BUCKETS="$(psql_q "select count(*) from storage.buckets" 2>/dev/null || echo 0)"
[ "$STORAGE_BUCKETS" = "0" ] || \
  fail "storage.buckets in $DB_CONTAINER holds $STORAGE_BUCKETS bucket(s)."

# Any other schema carrying application data. supabase_migrations is the ledger
# a real deployment keeps; its presence means this database has a history.
MIGRATION_ROWS="$(psql_q "select count(*) from supabase_migrations.schema_migrations" 2>/dev/null || echo 0)"
[ "$MIGRATION_ROWS" = "0" ] || \
  fail "$DB_CONTAINER has $MIGRATION_ROWS applied migration(s) in its ledger; this is not a blank stack."

echo "══ marker present, public/auth/storage all empty — safe to build"
echo

echo "══ 1/8  baseline (TEST-ONLY, not a migration)"
echo "──      $BASELINE"
psql_file "$REPO/$BASELINE"
echo "        ✓ applied"

step=2
for m in "${MIGRATIONS[@]}"; do
  echo
  echo "══ $step/8  $m"
  if [ "$m" = "$PENDING" ]; then
    # The file under review. It is allowed to differ from HEAD — but the
    # difference is printed rather than assumed, so a run can never quietly
    # test something other than what is on disk.
    if git -C "$REPO" diff --quiet HEAD -- "supabase/migrations/$m"; then
      echo "        (unchanged from HEAD)"
    else
      echo "        MODIFIED vs HEAD — this run tests the working-tree version:"
      git -C "$REPO" diff --stat HEAD -- "supabase/migrations/$m" | sed 's/^/          /'
    fi
  elif ! git -C "$REPO" diff --quiet HEAD -- "supabase/migrations/$m"; then
    echo "FATAL: prerequisite supabase/migrations/$m differs from HEAD. Refusing to run." >&2
    exit 1
  fi
  psql_file "$REPO/supabase/migrations/$m"
  echo "        ✓ applied"
  step=$((step + 1))
done

echo
echo "══ 8/8  $ASSERTIONS"
psql_file "$REPO/$ASSERTIONS"

echo
echo "══ all eight steps passed"
echo "══ step 7 ran the migration's own do \$\$ … \$\$ assertion block, and step 8"
echo "══ ran the visibility assertions; either would have aborted this script."
