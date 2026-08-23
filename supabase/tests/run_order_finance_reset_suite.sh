#!/usr/bin/env bash
# Build a production-shaped database for the Order & Finance module reset, apply
# 20261010000000 to it, and run the assertions.
#
#   supabase/tests/run_order_finance_reset_suite.sh <psql-host-or-socket-dir>
#
# Creates and drops a database called `boe_order_finance_reset`. Touches nothing
# else, and never talks to a linked project.
set -euo pipefail
HOST="${1:?usage: run_order_finance_reset_suite.sh <psql host or socket dir>}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DB=boe_order_finance_reset
Q=(psql -h "$HOST" -U postgres -v ON_ERROR_STOP=1 -q)

"${Q[@]}" -d postgres -c "drop database if exists $DB" >/dev/null
"${Q[@]}" -d postgres -c "create database $DB" >/dev/null
trap '"${Q[@]}" -d postgres -c "drop database if exists '"$DB"'" >/dev/null 2>&1 || true' EXIT

echo "== building the production-shaped schema"
"${Q[@]}" -d "$DB" -f "$REPO/supabase/tests/_order_finance_reset_shaped_schema.sql"

echo "== applying 20261010000000 (its own apply-time assertions run here)"
"${Q[@]}" -d "$DB" -f "$REPO/supabase/migrations/20261010000000_order_submission_and_finance_test_data_reset.sql"

echo "== the assertions"
set +e
OUTPUT="$("${Q[@]}" -d "$DB" -f "$REPO/supabase/tests/order_finance_reset_assertions.sql" 2>&1)"
set -e
printf '%s\n' "$OUTPUT" | grep -v '^NOTICE:  trigger\|^NOTICE:  constraint' || true
if ! printf '%s' "$OUTPUT" | grep -q 'ALL ASSERTIONS PASSED'; then
  echo "FAIL: the assertions did not reach the end"
  exit 1
fi
echo "== suite complete; database dropped"
