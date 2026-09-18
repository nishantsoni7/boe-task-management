#!/bin/sh
# Prove 20261215000000 (payment_allocation_ledger_for_correction) on a
# DISPOSABLE database:
#
#   1. build the shaped schema and install the DEPLOYED bodies of the helpers
#      the RPC and the policies call, extracted from their own migrations;
#   2. run the assertions BEFORE the migration — they must reproduce the defect
#      (a participant's RLS read returns 1 of 4 allocations) and then stop,
#      because the RPC does not exist yet;
#   3. apply the migration, which runs its own apply-time assertions;
#   4. run the assertions in full.
#
#   supabase/tests/run_payment_allocation_ledger_suite.sh <psql host or socket dir> [port]
#
# Creates and drops a database called boe_allocation_ledger. Touches nothing
# else and never talks to a linked project. POSIX sh, so it also runs inside a
# stock postgres:alpine container.
set -eu
HOST="${1:?usage: run_payment_allocation_ledger_suite.sh <psql host or socket dir> [port]}"
PORT="${2:-5432}"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
DB=boe_allocation_ledger
MIG="$REPO/supabase/migrations"
PSQL="psql -h $HOST -p $PORT -U postgres -v ON_ERROR_STOP=1 -q"

# A function's DEPLOYED body, from `create or replace function public.NAME(`
# (either case) to the `$$;` that ends it.
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
$PSQL -d "$DB" -f "$REPO/supabase/tests/_payment_allocation_ledger_shaped_schema.sql" >/dev/null

echo "== deployed helper bodies"
{
  extract "$MIG/20260905000000_module_view_parent_gates.sql"                     module_entry_open
  extract "$MIG/20260901000000_finance_orders_permission_enforcement.sql"         actor_has_permission
  extract "$MIG/20260901000000_finance_orders_permission_enforcement.sql"         actor_has_module_permission
  extract "$MIG/20261006000000_payment_participant_and_order_total_security.sql"  can_read_payment_as_participant
  cat <<'SQL'
grant execute on function public.module_entry_open(text), public.actor_has_permission(text, text),
  public.actor_has_module_permission(text, text), public.can_read_payment_as_participant(uuid) to authenticated;

-- The policies that call those helpers, verbatim from 20260918000000 / 20260919000000.
create policy finance_payment_requests_participant_select on public.finance_payment_requests
  for select to authenticated using (public.can_read_payment_as_participant(finance_payment_requests.id));
create policy finance_payment_requests_module_entry_gate on public.finance_payment_requests
  as restrictive for all to authenticated
  using (public.module_entry_open('finance') or public.can_read_payment_as_participant(finance_payment_requests.id))
  with check (public.module_entry_open('finance'));
create policy finance_payment_allocations_submission_participant_select on public.finance_payment_allocations
  for select to authenticated using (
    finance_payment_allocations.order_submission_id is not null
    and public.module_entry_open('orders')
    and public.can_view_order_submission(finance_payment_allocations.order_submission_id));
SQL
} > "$TMP/helpers.sql"
for fn in module_entry_open actor_has_permission actor_has_module_permission can_read_payment_as_participant; do
  grep -qi "function public.$fn(" "$TMP/helpers.sql" || { echo "FAIL: could not extract $fn"; exit 1; }
done
$PSQL -d "$DB" -f "$TMP/helpers.sql" >/dev/null

echo "== BEFORE the migration: the defect must reproduce, then the suite must stop"
set +e
BEFORE="$($PSQL -d "$DB" -f "$REPO/supabase/tests/payment_allocation_ledger_assertions.sql" 2>&1)"
set -e
if ! printf '%s' "$BEFORE" | grep -q '0. reproduced'; then
  printf '%s\n' "$BEFORE"; echo "FAIL: the partial-RLS defect did not reproduce"; exit 1
fi
if ! printf '%s' "$BEFORE" | grep -q 'payment_allocation_ledger_for_correction.*does not exist'; then
  printf '%s\n' "$BEFORE"; echo "FAIL: expected the suite to stop on the missing RPC"; exit 1
fi
echo "   reproduced: participant corrector reads 1 of 4 allocations; the RPC does not exist yet"

echo "== applying 20261215000000 (its own apply-time assertions run here)"
$PSQL -d "$DB" -f "$MIG/20261215000000_payment_allocation_ledger_for_correction.sql"

echo "== the assertions"
set +e
OUT="$($PSQL -d "$DB" -f "$REPO/supabase/tests/payment_allocation_ledger_assertions.sql" 2>&1)"
STATUS=$?
set -e
printf '%s\n' "$OUT"
if [ $STATUS -ne 0 ] || ! printf '%s' "$OUT" | grep -q 'ALL ASSERTIONS PASSED'; then
  echo "FAIL: the assertions did not reach the end"; exit 1
fi
echo "== suite complete; database dropped"
