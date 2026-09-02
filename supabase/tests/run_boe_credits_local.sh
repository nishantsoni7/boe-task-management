#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════════════════
# TEST-ONLY RUNNER — 20261101000000_boe_credits_foundation.sql, on an isolated
# local database
# ═════════════════════════════════════════════════════════════════════════════
#
# WHAT THIS IS FOR
# ----------------
# src/lib/boeCredits/migration.test.ts reads the migration's TEXT and checks
# it says the right things. This executes it, and then runs
# boe_credits_assertions.sql against the result.
#
# WHAT IT PROVES, IN ORDER
# ------------------------
#   1. the migration APPLIES to a database holding its real prerequisite
#      (payroll_periods, applied whole and unmodified from HEAD);
#   2. it is SAFE TO APPLY TWICE — every statement is guarded, so a re-run
#      changes nothing and fails nothing;
#   3. the eight Phase 1A rules hold AT THE DATABASE: ledger math, zero
#      refused, one reward per source, reversal by counter-entry, admin
#      adjustment with a reason by an active admin, employee isolation, no
#      self-award (and no browser write for an admin either), immutability for
#      the service role too, and the seeded settings.
#
# WHAT IT TARGETS, AND WHY
# ------------------------
# A BARE POSTGRESQL CONTAINER — not a local Supabase stack. This chain needs
# no storage, no auth identities and no PostgREST, and a bare container starts
# in seconds with no per-machine config.toml. The trade is stated in
# bootstrap/002_boe_credits_baseline.sql: the three client roles and auth.uid()
# are created by the baseline, and Supabase's default privileges are NOT
# reproduced. A green run therefore proves what the migration DOES, not that
# the platform's defaults could not undo it — which is why the migration
# revokes explicitly and asserts the resulting privileges on itself.
#
# Because the target is bare, the shared gate's composite check
# (require_disposable_stack, which insists on auth.users and storage.objects)
# would refuse it. The primitives it is built from are reused here instead —
# the marker read, count_or_die and _require_empty — so the rule they encode
# ("a question that cannot be answered is not an answer of zero") is the same
# code, not a second copy.
#
# WHAT IT WILL NOT DO
# -------------------
# It will not choose its own target: BOE_DB_CONTAINER must name the container.
# It will not run against a database that has not been marked disposable, or
# whose marker does not match. It will not run if public holds tables or
# functions. It will not run if the prerequisite migration differs from HEAD.
#
# It never resets, never deletes, never repairs, never edits a migration, and
# never contacts anything outside the named local container. Every guard runs
# before the first statement is applied, so a refusal leaves the database
# untouched.
#
# PREREQUISITES
# -------------
#   1. Docker running.
#   2. A throwaway PostgreSQL container, e.g.
#
#        docker run -d --name boe-credits-pg -e POSTGRES_PASSWORD=postgres postgres:16-alpine
#
#   3. NAME THE TARGET, and MARK IT DISPOSABLE. Both are deliberate acts:
#
#        export BOE_DB_CONTAINER=boe-credits-pg
#        docker exec -i "$BOE_DB_CONTAINER" psql -U postgres -d postgres -c \
#          "comment on database postgres is 'boe-disposable-boe-credits'"
#
# USAGE
#   BOE_DB_CONTAINER=boe-credits-pg supabase/tests/run_boe_credits_local.sh
#
# Afterwards: docker rm -f boe-credits-pg

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DB_CONTAINER="${BOE_DB_CONTAINER:?set BOE_DB_CONTAINER to the throwaway PostgreSQL container}"
DB_NAME="${BOE_DB_NAME:-postgres}"
MARKER="boe-disposable-boe-credits"

BASELINE="$REPO/supabase/tests/bootstrap/002_boe_credits_baseline.sql"
PREREQ="20260611_create_payroll_periods.sql"
PENDING="20261101000000_boe_credits_foundation.sql"
ASSERTIONS="$REPO/supabase/tests/boe_credits_assertions.sql"

# The gate lives in its own file so this script trusts the same code its tests
# exercise, rather than a second copy of it.
# shellcheck source=supabase/tests/lib/disposable_stack_guard.sh
. "$REPO/supabase/tests/lib/disposable_stack_guard.sh"

psql_file() {
  docker exec -i "$DB_CONTAINER" psql -U postgres -d "$DB_NAME" -v ON_ERROR_STOP=1 -q < "$1"
}

# ── The gate, for a bare container ───────────────────────────────────────────
require_disposable_bare_postgres() {
  local found_marker

  if ! found_marker="$(_psql_raw "select coalesce(shobj_description(oid, 'pg_database'), '') from pg_database where datname = current_database()")"; then
    {
      echo "FATAL: could not read the disposable marker from $DB_CONTAINER."
      printf '%s\n' "$found_marker" | sed 's/^/         /'
      echo "       Nothing was written."
    } >&2
    return 1
  fi
  if [ -z "$found_marker" ]; then
    {
      echo "FATAL: $DB_CONTAINER carries no disposable marker."
      echo "       This script only builds on a database somebody has declared throwaway:"
      echo "         docker exec -i $DB_CONTAINER psql -U postgres -d $DB_NAME -c \\"
      echo "           \"comment on database $DB_NAME is '$MARKER'\""
      echo "       Nothing was written."
    } >&2
    return 1
  fi
  if [ "$found_marker" != "$MARKER" ]; then
    {
      echo "FATAL: marker mismatch on $DB_CONTAINER."
      echo "       found    '$found_marker'"
      echo "       expected '$MARKER'"
      echo "       Nothing was written."
    } >&2
    return 1
  fi

  _require_empty 'public tables' \
    "select count(*) from pg_tables where schemaname = 'public'" \
    'table(s) in public' || return 1

  _require_empty 'public functions' \
    "select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'" \
    'function(s) in public' || return 1

  # A migration ledger means a Supabase stack with history, which is not the
  # blank target this script wants. Asked in two parts, both failing closed.
  local ledger
  if ! ledger="$(_psql_raw "select coalesce(to_regclass('supabase_migrations.schema_migrations')::text, '')")"; then
    {
      echo "FATAL: could not determine whether $DB_CONTAINER has a migration ledger."
      printf '%s\n' "$ledger" | sed 's/^/         /'
      echo "       Nothing was written."
    } >&2
    return 1
  fi
  if [ -n "$ledger" ]; then
    _require_empty 'migration ledger' \
      "select count(*) from supabase_migrations.schema_migrations" \
      'row(s) in the migration ledger' || return 1
  fi
}

echo "── target: container $DB_CONTAINER, database $DB_NAME"
require_disposable_bare_postgres || exit 1
echo "   disposable marker present, public empty"

# ── The prerequisite must be what HEAD says it is ────────────────────────────
if [ ! -f "$REPO/supabase/migrations/$PREREQ" ]; then
  echo "FATAL: prerequisite supabase/migrations/$PREREQ is missing. Refusing to run." >&2
  exit 1
elif ! git -C "$REPO" diff --quiet HEAD -- "supabase/migrations/$PREREQ"; then
  echo "FATAL: prerequisite supabase/migrations/$PREREQ differs from HEAD. Refusing to run." >&2
  exit 1
fi
if [ ! -f "$REPO/supabase/migrations/$PENDING" ]; then
  echo "FATAL: supabase/migrations/$PENDING is missing." >&2
  exit 1
fi
# The pending file is under test and may be uncommitted; it is applied as it
# stands and its working-tree state is recorded in the output.
if git -C "$REPO" ls-files --error-unmatch "supabase/migrations/$PENDING" >/dev/null 2>&1; then
  if git -C "$REPO" diff --quiet HEAD -- "supabase/migrations/$PENDING"; then
    echo "   $PENDING: tracked, identical to HEAD"
  else
    echo "   $PENDING: tracked, MODIFIED in the working tree"
  fi
else
  echo "   $PENDING: untracked (not yet committed)"
fi

# ── Build ────────────────────────────────────────────────────────────────────
echo "── 1. test-only baseline (NOT a migration)"
psql_file "$BASELINE"

echo "── 2. real prerequisite: $PREREQ"
psql_file "$REPO/supabase/migrations/$PREREQ"

echo "── 3. the migration under test: $PENDING"
psql_file "$REPO/supabase/migrations/$PENDING"

echo "── 4. the same file again — it must be safe to apply twice"
psql_file "$REPO/supabase/migrations/$PENDING"

# ── Assert ───────────────────────────────────────────────────────────────────
echo "── 5. boe_credits_assertions.sql"
set +e
OUTPUT="$(docker exec -i "$DB_CONTAINER" psql -U postgres -d "$DB_NAME" -v ON_ERROR_STOP=1 < "$ASSERTIONS" 2>&1)"
STATUS=$?
set -e
printf '%s\n' "$OUTPUT" | grep -E 'NOTICE|ERROR|FATAL|ASSERT' | sed 's/^psql:[^ ]* *//; s/^NOTICE:  //'

if [ $STATUS -ne 0 ] || ! printf '%s' "$OUTPUT" | grep -q 'ALL ASSERTIONS PASSED'; then
  echo "FAIL: the assertions did not reach the end (psql exit $STATUS)" >&2
  exit 1
fi

echo
echo "OK: $PENDING applied twice and every assertion passed on $DB_CONTAINER/$DB_NAME."
echo "    The database still holds the schema; drop the container when done."
