#!/bin/sh
# Prove 20261218000000 (verified payments are permanent, test data excepted)
# on a DISPOSABLE database:
#
#   1. build the shaped schema and install the deployed helper bodies plus the
#      20261011000000 deletion rule and delete guard (the live bodies);
#   2. REPRODUCE: an admin may open a deletion claim on a real verified payment;
#   3. apply 20261218000000, which runs its own apply-time assertions;
#   4. run the assertions in full.
#
#   supabase/tests/run_verified_payment_permanent_suite.sh <psql host or socket dir> [port]
#
# Creates and drops a database called boe_verified_permanent. Touches nothing
# else and never talks to a linked project. POSIX sh.
set -eu
HOST="${1:?usage: run_verified_payment_permanent_suite.sh <psql host or socket dir> [port]}"
PORT="${2:-5432}"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
DB=boe_verified_permanent
MIG="$REPO/supabase/migrations"
PSQL="psql -h $HOST -p $PORT -U postgres -v ON_ERROR_STOP=1 -q"

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
$PSQL -d "$DB" -f "$REPO/supabase/tests/_verified_payment_permanent_shaped_schema.sql" >/dev/null

echo "== deployed helpers and the 20261011000000 bodies"
{
  extract "$MIG/20260918000000_finance_payment_allocations.sql"                        finance_payment_status_is_verified
  extract "$MIG/20260705000000_protect_finalized_orders_and_payments.sql"              in_test_data_cleanup
  extract "$MIG/20261011000000_admin_payment_deletion_and_payment_id.sql"              in_finance_payment_deletion_finalization
  extract "$MIG/20261011000000_admin_payment_deletion_and_payment_id.sql"              finance_payment_deletable_by
  extract "$MIG/20261011000000_admin_payment_deletion_and_payment_id.sql"              finance_payment_requests_guard_approved_delete
  cat <<'SQL'
create trigger finance_payment_requests_guard_approved_delete
  before delete on public.finance_payment_requests
  for each row execute function public.finance_payment_requests_guard_approved_delete();
SQL
} > "$TMP/before.sql"
for fn in finance_payment_status_is_verified in_test_data_cleanup in_finance_payment_deletion_finalization finance_payment_deletable_by finance_payment_requests_guard_approved_delete; do
  grep -qi "function public.$fn(" "$TMP/before.sql" || { echo "FAIL: could not extract $fn"; exit 1; }
done
$PSQL -d "$DB" -f "$TMP/before.sql" >/dev/null

echo "== BEFORE the migration: an admin may delete a real verified payment"
set +e
BEFORE="$($PSQL -d "$DB" -f "$REPO/supabase/tests/verified_payment_permanent_assertions.sql" 2>&1)"
set -e
if ! printf '%s' "$BEFORE" | grep -q 'an admin must NOT be able to delete a real verified payment'; then
  printf '%s\n' "$BEFORE"; echo "FAIL: the old behaviour did not reproduce"; exit 1
fi
echo "   reproduced: before the migration an admin could open a deletion claim on a real verified payment"

echo "== applying 20261218000000 (its own apply-time assertions run here)"
$PSQL -d "$DB" -f "$MIG/20261218000000_finance_verified_payments_are_permanent.sql"

echo "== the assertions"
set +e
OUT="$($PSQL -d "$DB" -f "$REPO/supabase/tests/verified_payment_permanent_assertions.sql" 2>&1)"
STATUS=$?
set -e
printf '%s\n' "$OUT"
if [ $STATUS -ne 0 ] || ! printf '%s' "$OUT" | grep -q 'ALL ASSERTIONS PASSED'; then
  echo "FAIL: the assertions did not reach the end"; exit 1
fi
echo "== suite complete; database dropped"
