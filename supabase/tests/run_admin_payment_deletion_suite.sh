#!/usr/bin/env bash
# Build a production-shaped database, apply 20261010000000, supplement it with
# what 20261011000000 additionally needs, apply 20261011000000, and run the
# assertions.
#
#   supabase/tests/run_admin_payment_deletion_suite.sh <psql-host-or-socket-dir>
#
# Creates and drops a database called `boe_admin_payment_deletion`. Touches
# nothing else, and never talks to a linked project.
set -euo pipefail
HOST="${1:?usage: run_admin_payment_deletion_suite.sh <psql host or socket dir>}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DB=boe_admin_payment_deletion
Q=(psql -h "$HOST" -U postgres -v ON_ERROR_STOP=1 -q)

"${Q[@]}" -d postgres -c "drop database if exists $DB" >/dev/null
"${Q[@]}" -d postgres -c "create database $DB" >/dev/null
trap '"${Q[@]}" -d postgres -c "drop database if exists '"$DB"'" >/dev/null 2>&1 || true' EXIT

echo "== building the production-shaped schema"
"${Q[@]}" -d "$DB" -f "$REPO/supabase/tests/_order_finance_reset_shaped_schema.sql"

echo "== applying 20261010000000 (the durable claim protocol this migration extends)"
"${Q[@]}" -d "$DB" -f "$REPO/supabase/migrations/20261010000000_order_submission_and_finance_test_data_reset.sql"

echo "== supplementing with what 20261011000000 additionally reads (allocate_payment_to_target_internal, finance_received_payments)"
"${Q[@]}" -d "$DB" -f "$REPO/supabase/tests/_admin_payment_deletion_and_payment_id_extra_schema.sql"

echo "== applying 20261011000000 (its own apply-time assertions run here)"
"${Q[@]}" -d "$DB" -f "$REPO/supabase/migrations/20261011000000_admin_payment_deletion_and_payment_id.sql"

echo "== the assertions"
set +e
OUTPUT="$("${Q[@]}" -d "$DB" -f "$REPO/supabase/tests/admin_payment_deletion_and_payment_id_assertions.sql" 2>&1)"
STATUS=$?
set -e
printf '%s\n' "$OUTPUT" | grep -v '^NOTICE:  trigger\|^NOTICE:  constraint' || true
if [ $STATUS -ne 0 ] || ! printf '%s' "$OUTPUT" | grep -q 'ALL ASSERTIONS PASSED'; then
  echo "FAIL: the assertions did not reach the end"
  exit 1
fi
echo "== suite complete; database dropped"
