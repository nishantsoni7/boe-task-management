#!/bin/sh
# Prove 20270331000000 (an admin may delete a Confirmed Payment entered by
# mistake; a bank-linked payment is refused) on a DISPOSABLE database:
#
#   1. build the shaped schema and install the DEPLOYED bodies: the helpers, the
#      20261011000000 begin/finalize and the 20261218000000 deletable_by + guard;
#   2. REPRODUCE: an admin cannot open a claim on a real verified payment;
#   3. apply 20270331000000, which runs its own apply-time assertions;
#   4. run the assertions in full.
#
#   supabase/tests/run_admin_delete_confirmed_payment_suite.sh <psql host or socket dir> [port]
#
# Creates and drops a database called boe_admin_delete_confirmed. Touches nothing
# else and never talks to a linked project. POSIX sh.
set -eu
HOST="${1:?usage: run_admin_delete_confirmed_payment_suite.sh <psql host or socket dir> [port]}"
PORT="${2:-5432}"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
DB=boe_admin_delete_confirmed
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
tr -d '\r' < "$REPO/supabase/tests/_admin_delete_confirmed_payment_shaped_schema.sql" > "$TMP/schema.sql"
$PSQL -d "$DB" -f "$TMP/schema.sql" >/dev/null

echo "== deployed helpers and the live bodies this migration replaces"
{
  extract "$MIG/20260918000000_finance_payment_allocations.sql"                        finance_payment_status_is_verified
  extract "$MIG/20260705000000_protect_finalized_orders_and_payments.sql"              in_test_data_cleanup
  extract "$MIG/20261011000000_admin_payment_deletion_and_payment_id.sql"              in_finance_payment_deletion_finalization
  extract "$MIG/20261218000000_finance_verified_payments_are_permanent.sql"            finance_payment_deletable_by
  extract "$MIG/20261218000000_finance_verified_payments_are_permanent.sql"            finance_payment_requests_guard_approved_delete
  extract "$MIG/20261011000000_admin_payment_deletion_and_payment_id.sql"              begin_finance_payment_deletion
  extract "$MIG/20261011000000_admin_payment_deletion_and_payment_id.sql"              finalize_finance_payment_deletion
  cat <<'SQL'
create trigger finance_payment_requests_guard_approved_delete
  before delete on public.finance_payment_requests
  for each row execute function public.finance_payment_requests_guard_approved_delete();
SQL
} > "$TMP/before.sql"
for fn in finance_payment_status_is_verified in_test_data_cleanup in_finance_payment_deletion_finalization finance_payment_deletable_by finance_payment_requests_guard_approved_delete begin_finance_payment_deletion finalize_finance_payment_deletion; do
  grep -qi "function public.$fn(" "$TMP/before.sql" || { echo "FAIL: could not extract $fn"; exit 1; }
done
$PSQL -d "$DB" -f "$TMP/before.sql" >/dev/null

echo "== BEFORE the migration: an admin cannot delete a real verified payment"
tr -d '\r' < "$REPO/supabase/tests/admin_delete_confirmed_payment_assertions.sql" > "$TMP/assertions.sql"
set +e
BEFORE="$($PSQL -d "$DB" -f "$TMP/assertions.sql" 2>&1)"
set -e
if ! printf '%s' "$BEFORE" | grep -q 'an admin MUST be able to open a claim on a real verified payment'; then
  printf '%s\n' "$BEFORE"; echo "FAIL: the old behaviour did not reproduce"; exit 1
fi
echo "   reproduced: before the migration the claim on a real verified payment is refused"

echo "== applying 20270331000000 (its own apply-time assertions run here)"
tr -d '\r' < "$MIG/20270331000000_finance_admin_may_delete_confirmed_payment.sql" > "$TMP/migration.sql"
$PSQL -d "$DB" -f "$TMP/migration.sql"

echo "== the assertions"
set +e
OUT="$($PSQL -d "$DB" -f "$TMP/assertions.sql" 2>&1)"
STATUS=$?
set -e
printf '%s\n' "$OUT"
if [ $STATUS -ne 0 ] || ! printf '%s' "$OUT" | grep -q 'ALL ASSERTIONS PASSED'; then
  echo "FAIL: the assertions did not reach the end"; exit 1
fi
echo "== suite complete; database dropped"
