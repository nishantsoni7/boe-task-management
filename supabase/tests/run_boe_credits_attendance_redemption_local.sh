#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════════════════
# TEST-ONLY RUNNER — 20261103000000_boe_credits_attendance_redemption.sql, on
# an isolated local database
# ═════════════════════════════════════════════════════════════════════════════
#
# The Phase 1C sibling of run_boe_credits_local.sh: the same bare PostgreSQL
# target, the same guard, the same baseline, a longer prerequisite chain.
#
# WHAT IT PROVES, IN ORDER
#   1. the migration APPLIES to a database holding its real prerequisites
#      (payroll_periods, payroll_results, the 'generated' status and the
#      BOE Credits foundation — each applied whole and unmodified from HEAD);
#   2. OLD-CODE COMPATIBILITY: the foundation's functions, the ledger's
#      constraints and its indexes are byte-identical before and after —
#      Phase 1B code keeps running against exactly the objects it knew;
#   3. it is SAFE TO APPLY TWICE;
#   4. the Phase 1C rules hold AT THE DATABASE — see the header of
#      boe_credits_attendance_redemption_assertions.sql (which runs inside one
#      rolled-back transaction, so it is repeatable);
#   5. optionally, the CONCURRENCY proofs in
#      boe_credits_attendance_redemption_concurrency.sh, which run afterwards
#      and DO leave fixtures behind — see that file.
#
# PREREQUISITES
#   1. Docker running.
#   2. A throwaway PostgreSQL container, e.g.
#        docker run -d --name boe-credits-pg -e POSTGRES_PASSWORD=postgres postgres:16-alpine
#   3. Name it and mark it disposable:
#        export BOE_DB_CONTAINER=boe-credits-pg
#        docker exec -i "$BOE_DB_CONTAINER" psql -U postgres -d postgres -c \
#          "comment on database postgres is 'boe-disposable-boe-credits'"
#
# USAGE
#   BOE_DB_CONTAINER=boe-credits-pg supabase/tests/run_boe_credits_attendance_redemption_local.sh
#
# Afterwards: docker rm -f boe-credits-pg

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DB_CONTAINER="${BOE_DB_CONTAINER:?set BOE_DB_CONTAINER to the throwaway PostgreSQL container}"
DB_NAME="${BOE_DB_NAME:-postgres}"
MARKER="boe-disposable-boe-credits"

BASELINE="$REPO/supabase/tests/bootstrap/002_boe_credits_baseline.sql"
PREREQS=(
  "20260611_create_payroll_periods.sql"
  "20260612000000_create_payroll_generation_tables.sql"
  "20260616_add_generated_status_to_payroll_periods.sql"
  "20261101000000_boe_credits_foundation.sql"
)
PENDING="20261103000000_boe_credits_attendance_redemption.sql"
ASSERTIONS="$REPO/supabase/tests/boe_credits_attendance_redemption_assertions.sql"

# shellcheck source=supabase/tests/lib/disposable_stack_guard.sh
. "$REPO/supabase/tests/lib/disposable_stack_guard.sh"

psql_file() {
  docker exec -i "$DB_CONTAINER" psql -U postgres -d "$DB_NAME" -v ON_ERROR_STOP=1 -q < "$1"
}

# Everything the foundation defined that Phase 1B code calls or relies on.
FOUNDATION_SHAPE_SQL="
select 'fn:' || p.oid::regprocedure::text || E'\n' || pg_get_functiondef(p.oid)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('post_boe_credit_transaction', 'reverse_boe_credit_transaction', 'can_manage_boe_credits', 'boe_credit_balance', 'boe_credits_append_only')
 order by 1;
select 'con:' || conname || ' ' || pg_get_constraintdef(oid)
  from pg_constraint where conrelid = 'public.boe_credit_transactions'::regclass order by 1;
select 'idx:' || indexdef from pg_indexes where schemaname = 'public' and tablename = 'boe_credit_transactions' order by 1;
select 'col:' || attname || ' ' || format_type(atttypid, atttypmod) || ' ' || attnotnull
  from pg_attribute where attrelid = 'public.boe_credit_transactions'::regclass and attnum > 0 and not attisdropped order by attnum;
select 'pol:' || policyname || ' ' || cmd || ' ' || coalesce(qual, '')
  from pg_policies where schemaname = 'public' and tablename in ('boe_credit_transactions', 'boe_credit_settings') order by 1;
select 'view:' || pg_get_viewdef('public.boe_credit_balances'::regclass);
"
foundation_shape() {
  docker exec -i "$DB_CONTAINER" psql -U postgres -d "$DB_NAME" -At -v ON_ERROR_STOP=1 -c "$FOUNDATION_SHAPE_SQL"
}

# ── The gate, for a bare container (verbatim from run_boe_credits_local.sh) ──
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

# ── The prerequisites must be what HEAD says they are ────────────────────────
for m in "${PREREQS[@]}"; do
  if [ ! -f "$REPO/supabase/migrations/$m" ]; then
    echo "FATAL: prerequisite supabase/migrations/$m is missing. Refusing to run." >&2
    exit 1
  elif ! git -C "$REPO" diff --quiet HEAD -- "supabase/migrations/$m"; then
    echo "FATAL: prerequisite supabase/migrations/$m differs from HEAD. Refusing to run." >&2
    exit 1
  fi
done
if [ ! -f "$REPO/supabase/migrations/$PENDING" ]; then
  echo "FATAL: supabase/migrations/$PENDING is missing." >&2
  exit 1
fi
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

n=2
for m in "${PREREQS[@]}"; do
  echo "── $n. real prerequisite: $m"
  psql_file "$REPO/supabase/migrations/$m"
  n=$((n + 1))
done

echo "── $n. record the foundation's shape (what Phase 1B code runs against)"
BEFORE="$(foundation_shape)"
n=$((n + 1))

echo "── $n. the migration under test: $PENDING"
psql_file "$REPO/supabase/migrations/$PENDING"
n=$((n + 1))

echo "── $n. the same file again — it must be safe to apply twice"
psql_file "$REPO/supabase/migrations/$PENDING"
n=$((n + 1))

echo "── $n. OLD-CODE COMPATIBILITY: the foundation's functions, constraints, indexes, columns, policies and view are unchanged"
AFTER="$(foundation_shape)"
if [ "$BEFORE" != "$AFTER" ]; then
  echo "FAIL: the foundation's shape changed:" >&2
  diff <(printf '%s\n' "$BEFORE") <(printf '%s\n' "$AFTER") >&2 || true
  exit 1
fi
echo "   identical ($(printf '%s\n' "$AFTER" | grep -c '^fn:') functions, $(printf '%s\n' "$AFTER" | grep -c '^con:') constraints, $(printf '%s\n' "$AFTER" | grep -c '^idx:') indexes compared)"
n=$((n + 1))

# ── Assert (repeatable: one transaction, rolled back) ────────────────────────
for pass in 1 2; do
  echo "── $n. boe_credits_attendance_redemption_assertions.sql (pass $pass of 2 — it must leave nothing behind)"
  set +e
  OUTPUT="$(docker exec -i "$DB_CONTAINER" psql -U postgres -d "$DB_NAME" -v ON_ERROR_STOP=1 < "$ASSERTIONS" 2>&1)"
  STATUS=$?
  set -e
  if [ "$pass" = 1 ]; then
    printf '%s\n' "$OUTPUT" | grep -E 'NOTICE|ERROR|FATAL|ASSERT' | sed 's/^psql:[^ ]* *//; s/^NOTICE:  //'
  fi
  if [ $STATUS -ne 0 ] || ! printf '%s' "$OUTPUT" | grep -q 'ALL ASSERTIONS PASSED'; then
    printf '%s\n' "$OUTPUT" | grep -E 'ERROR|FATAL|ASSERT' >&2 || true
    echo "FAIL: the assertions did not reach the end on pass $pass (psql exit $STATUS)" >&2
    exit 1
  fi
  n=$((n + 1))
done

echo
echo "OK: $PENDING applied twice, the foundation unchanged, and every assertion passed twice on $DB_CONTAINER/$DB_NAME."
echo "    Next (optional, leaves fixtures behind): BOE_DB_CONTAINER=$DB_CONTAINER supabase/tests/boe_credits_attendance_redemption_concurrency.sh"
echo "    The database still holds the schema; drop the container when done."
