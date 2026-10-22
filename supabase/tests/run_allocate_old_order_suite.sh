#!/bin/sh
# Prove 20270407000000 (allocate a payment to an OLD order that is not in the
# system) on a DISPOSABLE database:
#
#   1. build the shaped schema and install the DEPLOYED bodies of the capacity
#      trigger, the reversal trigger, reverse_payment_allocation, the transition
#      guard and the activity writer, and attach the deployed triggers;
#   2. apply 20270407000000, which runs its own apply-time assertions;
#   3. run the assertions in full.
#
#   supabase/tests/run_allocate_old_order_suite.sh <psql host or socket dir> [port]
#
# Creates and drops a database called boe_allocate_old_order. Touches nothing
# else and never talks to a linked project. POSIX sh.
set -eu
HOST="${1:?usage: run_allocate_old_order_suite.sh <psql host or socket dir> [port]}"
PORT="${2:-5432}"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
DB=boe_allocate_old_order
MIG="$REPO/supabase/migrations"
PSQL="psql -h $HOST -p $PORT -U postgres -v ON_ERROR_STOP=1 -q"

extract() { # <file> <function name>
  awk -v fn="create or replace function public.$2(" '
    index(tolower($0), fn) == 1 { on = 1 }
    on { print }
    on && /^\$\$;/ { exit }
  ' "$1" | tr -d '\r'
}

$PSQL -d postgres -c "drop database if exists $DB" >/dev/null
$PSQL -d postgres -c "create database $DB" >/dev/null
TMP="$(mktemp -d)"
cleanup() { rm -rf "$TMP"; $PSQL -d postgres -c "drop database if exists $DB" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "== shaped schema"
tr -d '\r' < "$REPO/supabase/tests/_allocate_old_order_shaped_schema.sql" > "$TMP/schema.sql"
$PSQL -d "$DB" -f "$TMP/schema.sql" >/dev/null

echo "== the deployed bodies and triggers this migration builds on"
{
  extract "$MIG/20260918000000_finance_payment_allocations.sql"               finance_payment_allocations_enforce_capacity
  extract "$MIG/20260918000000_finance_payment_allocations.sql"               finance_payment_allocations_derive_reversal
  extract "$MIG/20260918000000_finance_payment_allocations.sql"               reverse_payment_allocation
  extract "$MIG/20260921000000_order_submission_verified_payment_gate.sql"    finance_payment_allocations_guard_transition
  extract "$MIG/20260921000000_order_submission_verified_payment_gate.sql"    log_finance_payment_allocation_activity
  cat <<'SQL'
create trigger finance_payment_allocations_check_transition
  before update on public.finance_payment_allocations
  for each row execute function public.finance_payment_allocations_guard_transition();
create trigger finance_payment_allocations_derive_reversal
  before update on public.finance_payment_allocations
  for each row execute function public.finance_payment_allocations_derive_reversal();
create trigger finance_payment_allocations_enforce_capacity
  before insert or update on public.finance_payment_allocations
  for each row execute function public.finance_payment_allocations_enforce_capacity();
create trigger finance_payment_allocations_log_activity
  after insert or update on public.finance_payment_allocations
  for each row execute function public.log_finance_payment_allocation_activity();
SQL
} > "$TMP/before.sql"
for fn in finance_payment_allocations_enforce_capacity finance_payment_allocations_derive_reversal reverse_payment_allocation finance_payment_allocations_guard_transition log_finance_payment_allocation_activity; do
  grep -qi "function public.$fn(" "$TMP/before.sql" || { echo "FAIL: could not extract $fn"; exit 1; }
done
$PSQL -d "$DB" -f "$TMP/before.sql" >/dev/null

echo "== applying 20270407000000 (its own apply-time assertions run here)"
tr -d '\r' < "$MIG/20270407000000_finance_allocate_to_old_order.sql" > "$TMP/migration.sql"
$PSQL -d "$DB" -f "$TMP/migration.sql"

echo "== the assertions"
tr -d '\r' < "$REPO/supabase/tests/allocate_old_order_assertions.sql" > "$TMP/assertions.sql"
set +e
OUT="$($PSQL -d "$DB" -f "$TMP/assertions.sql" 2>&1)"
STATUS=$?
set -e
printf '%s\n' "$OUT"
if [ $STATUS -ne 0 ] || ! printf '%s' "$OUT" | grep -q 'ALL ASSERTIONS PASSED'; then
  echo "FAIL: the assertions did not reach the end"; exit 1
fi
echo "== suite complete; database dropped"
