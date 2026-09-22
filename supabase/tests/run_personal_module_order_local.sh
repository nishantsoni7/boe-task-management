#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════════════════
# TEST-ONLY RUNNER — 20261228000000_personal_module_order.sql, on an isolated
# local database
# ═════════════════════════════════════════════════════════════════════════════
#
# WHAT THIS IS FOR
# ----------------
# src/lib/modules/moduleOrderStorage.test.ts reads the migration's TEXT and
# checks it says the right things. This executes it, and then runs
# personal_module_order_assertions.sql against the result.
#
# WHAT IT PROVES, IN ORDER
# ------------------------
#   1. the migration APPLIES to a database holding its one real prerequisite
#      (auth.users, supplied by bootstrap/009);
#   2. it is SAFE TO APPLY TWICE — the table and the function are guarded, so a
#      re-run changes nothing and fails nothing;
#   3. the ten rules hold AT THE DATABASE: two accounts hold two independent
#      orders, neither can read or write the other's row, neither can hand a row
#      over, nobody can delete one, the shape constraint refuses every malformed
#      list, anon holds nothing, and the table is wired into no authorization
#      path at all.
#
# WHAT IT TARGETS, AND WHY
# ------------------------
# A BARE POSTGRESQL CONTAINER — not a local Supabase stack. This migration needs
# no storage, no PostgREST and no real auth identity, and a bare container starts
# in seconds with no per-machine config.toml. The trade is stated in
# bootstrap/009: the three client roles and auth.uid() are created there, and —
# UNLIKE bootstrap/002 — production's default privileges ARE reproduced, because
# the thing most worth proving here is a REVOKE. Without them, "anon cannot read
# a preference row" would pass because the grant was never made rather than
# because the migration removed it.
#
# Because the target is bare, the shared gate's composite check
# (require_disposable_stack, which insists on auth.users and storage.objects)
# would refuse it. The primitives it is built from are reused here instead — the
# marker read, count_or_die and _require_empty — so the rule they encode ("a
# question that cannot be answered is not an answer of zero") is the same code,
# not a second copy.
#
# WHAT IT WILL NOT DO
# -------------------
# It will not choose its own target: BOE_DB_CONTAINER must name the container.
# It will not run against a database that has not been marked disposable, or
# whose marker does not match. It will not run if public holds tables or
# functions.
#
# It never resets, never deletes, never repairs, never edits a migration, and
# never contacts anything outside the named local container. Every guard runs
# before the first statement is applied, so a refusal leaves the database
# untouched. The assertions themselves end in ROLLBACK.
#
# PREREQUISITES
# -------------
#   1. Docker running.
#   2. A throwaway PostgreSQL container, e.g.
#
#        docker run -d --name boe-pmo-pg -e POSTGRES_PASSWORD=postgres postgres:16-alpine
#
#   3. NAME THE TARGET, and MARK IT DISPOSABLE. Both are deliberate acts:
#
#        export BOE_DB_CONTAINER=boe-pmo-pg
#        docker exec -i "$BOE_DB_CONTAINER" psql -U postgres -d postgres -c \
#          "comment on database postgres is 'boe-disposable-personal-module-order'"
#
# USAGE
#   BOE_DB_CONTAINER=boe-pmo-pg supabase/tests/run_personal_module_order_local.sh
#
# Afterwards: docker rm -f boe-pmo-pg

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DB_CONTAINER="${BOE_DB_CONTAINER:?set BOE_DB_CONTAINER to the throwaway PostgreSQL container}"
DB_NAME="${BOE_DB_NAME:-postgres}"
MARKER="boe-disposable-personal-module-order"

BASELINE="$REPO/supabase/tests/bootstrap/009_personal_module_order_baseline.sql"
PENDING="20261228000000_personal_module_order.sql"
ASSERTIONS="$REPO/supabase/tests/personal_module_order_assertions.sql"

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

echo "── 2. the migration under test: $PENDING"
psql_file "$REPO/supabase/migrations/$PENDING"

echo "── 3. the same file again — it must be safe to apply twice"
psql_file "$REPO/supabase/migrations/$PENDING"

# ── Assert ───────────────────────────────────────────────────────────────────
echo "── 4. personal_module_order_assertions.sql"
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
