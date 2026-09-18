#!/bin/sh
# Prove 20261217000000 (update_order_submission_schedule_terms through the
# amendment door) on a DISPOSABLE database:
#
#   1. build the shaped schema and install the DEPLOYED bodies of
#      in_order_amendment(), in_production_alignment() and
#      orders_guard_amendable_columns(), plus the trigger that binds the guard;
#   2. install the 20260929000000 function and REPRODUCE the defect: moving an
#      approved PI's Due Date is refused with ORDER_AMENDMENT_REQUIRED;
#   3. apply 20261217000000, which runs its own apply-time assertions;
#   4. run the assertions in full.
#
#   supabase/tests/run_schedule_terms_amendment_suite.sh <psql host or socket dir> [port]
#
# Creates and drops a database called boe_schedule_terms. Touches nothing else
# and never talks to a linked project. POSIX sh, so it also runs inside a stock
# postgres:alpine container.
set -eu
HOST="${1:?usage: run_schedule_terms_amendment_suite.sh <psql host or socket dir> [port]}"
PORT="${2:-5432}"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
DB=boe_schedule_terms
MIG="$REPO/supabase/migrations"
PSQL="psql -h $HOST -p $PORT -U postgres -v ON_ERROR_STOP=1 -q"

# A function's body as written in a migration, from
# `create or replace function public.NAME(` (either case) to the `$$;` that ends it.
extract() { # <file> <function name>
  awk -v fn="create or replace function public.$2(" '
    index(tolower($0), fn) == 1 { on = 1 }
    on { print }
    on && /^\$\$;/ { exit }
  ' "$1"
}

$PSQL -d postgres -c "drop database if exists $DB" >/dev/null
$PSQL -d postgres -c "create database $DB" >/dev/null
TMP="$(mktemp -d)"
cleanup() { rm -rf "$TMP"; $PSQL -d postgres -c "drop database if exists $DB" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "== shaped schema"
$PSQL -d "$DB" -f "$REPO/supabase/tests/_schedule_terms_amendment_shaped_schema.sql" >/dev/null

echo "== deployed guard and context helpers"
{
  extract "$MIG/20260816000000_order_amendments.sql"                                         in_order_amendment
  extract "$MIG/20261119000000_order_submission_pi_review_gate_versions_and_production.sql"  in_production_alignment
  extract "$MIG/20261119000000_order_submission_pi_review_gate_versions_and_production.sql"  orders_guard_amendable_columns
  cat <<'SQL'
create trigger orders_guard_amendable_columns
  before update on public.orders
  for each row execute function public.orders_guard_amendable_columns();
SQL
  echo "== the 20260929000000 function" >&2
  extract "$MIG/20260929000000_order_submission_schedule_terms_edit.sql" update_order_submission_schedule_terms
  cat <<'SQL'
revoke all    on function public.update_order_submission_schedule_terms(uuid, jsonb, integer, text) from public, anon;
grant  execute on function public.update_order_submission_schedule_terms(uuid, jsonb, integer, text) to authenticated;
SQL
} > "$TMP/before.sql"
for fn in in_order_amendment in_production_alignment orders_guard_amendable_columns update_order_submission_schedule_terms; do
  grep -qi "function public.$fn(" "$TMP/before.sql" || { echo "FAIL: could not extract $fn"; exit 1; }
done
$PSQL -d "$DB" -f "$TMP/before.sql" >/dev/null

echo "== BEFORE the migration: the defect must reproduce"
set +e
BEFORE="$($PSQL -d "$DB" -f "$REPO/supabase/tests/schedule_terms_amendment_assertions.sql" 2>&1)"
set -e
if ! printf '%s' "$BEFORE" | grep -q 'ORDER_AMENDMENT_REQUIRED'; then
  printf '%s\n' "$BEFORE"; echo "FAIL: the defect did not reproduce"; exit 1
fi
echo "   reproduced: moving an approved PI's Due Date is refused with ORDER_AMENDMENT_REQUIRED"

echo "== applying 20261217000000 (its own apply-time assertions run here)"
$PSQL -d "$DB" -f "$MIG/20261217000000_order_submission_schedule_terms_use_the_amendment_context.sql"

echo "== the assertions"
set +e
OUT="$($PSQL -d "$DB" -f "$REPO/supabase/tests/schedule_terms_amendment_assertions.sql" 2>&1)"
STATUS=$?
set -e
printf '%s\n' "$OUT"
if [ $STATUS -ne 0 ] || ! printf '%s' "$OUT" | grep -q 'ALL ASSERTIONS PASSED'; then
  echo "FAIL: the assertions did not reach the end"; exit 1
fi
echo "== suite complete; database dropped"
