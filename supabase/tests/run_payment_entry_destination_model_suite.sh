#!/usr/bin/env bash
# Build a production-shaped database, bring it to the state 20261012000000
# leaves behind, supplement it with the PRE-113 forms of the two RPCs 113
# restates, apply 20261013000000, and run the assertions.
#
#   supabase/tests/run_payment_entry_destination_model_suite.sh <psql-host-or-socket-dir>
#
# Creates and drops a database called `boe_payment_entry_model`. Touches nothing
# else, and never talks to a linked project.
set -euo pipefail
HOST="${1:?usage: run_payment_entry_destination_model_suite.sh <psql host or socket dir>}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DB=boe_payment_entry_model
Q=(psql -h "$HOST" -U postgres -v ON_ERROR_STOP=1 -q)

"${Q[@]}" -d postgres -c "drop database if exists $DB" >/dev/null 2>&1
"${Q[@]}" -d postgres -c "create database $DB" >/dev/null
trap '"${Q[@]}" -d postgres -c "drop database if exists '"$DB"'" >/dev/null 2>&1 || true' EXIT

echo "== building the production-shaped schema, through 20261012000000"
"${Q[@]}" -d "$DB" -f "$REPO/supabase/tests/_order_finance_reset_shaped_schema.sql"                          >/dev/null
"${Q[@]}" -d "$DB" -f "$REPO/supabase/migrations/20261010000000_order_submission_and_finance_test_data_reset.sql" >/dev/null 2>&1
"${Q[@]}" -d "$DB" -f "$REPO/supabase/tests/_admin_payment_deletion_and_payment_id_extra_schema.sql"         >/dev/null
"${Q[@]}" -d "$DB" -f "$REPO/supabase/migrations/20261011000000_admin_payment_deletion_and_payment_id.sql"   >/dev/null 2>&1
"${Q[@]}" -d "$DB" -f "$REPO/supabase/tests/_allocation_ledger_single_source_extra_schema.sql"               >/dev/null
"${Q[@]}" -d "$DB" -f "$REPO/supabase/migrations/20261012000000_allocation_ledger_as_single_source.sql"      >/dev/null 2>&1

echo "== supplementing with the PRE-113 RPCs: a REQUIRED typed customer, and approval that allocates nothing"
"${Q[@]}" -d "$DB" -f "$REPO/supabase/tests/_payment_entry_destination_model_extra_schema.sql"               >/dev/null 2>&1

# ── The fixture really is the pre-113 world ──────────────────────────────────
# Without this the suite could pass against a fixture that never had the
# limitations 113 removes.
echo "== proving the fixture carries the pre-113 limitations"
BEFORE="$("${Q[@]}" -d "$DB" -t -A -f "$REPO/supabase/tests/_payment_entry_destination_model_before.sql")"
if [ "$BEFORE" != "NOT_NULL|CLIENT_REQUIRED|NO_INTENT_TABLE|NO_SUBMIT_RPC" ]; then
  echo "FAIL: the fixture does not reproduce the pre-113 state"
  echo "      got      '$BEFORE'"
  echo "      expected 'NOT_NULL|CLIENT_REQUIRED|NO_INTENT_TABLE|NO_SUBMIT_RPC'"
  exit 1
fi
echo "== confirmed: client_name NOT NULL, a typed customer is REQUIRED, no intent table, no submit RPC"

echo "== applying 20261013000000 (its own apply-time assertions run here)"
"${Q[@]}" -d "$DB" -f "$REPO/supabase/migrations/20261013000000_payment_entry_destination_model.sql" 2>&1 \
  | grep -vE 'NOTICE:  (trigger|policy|constraint|relation)' || true

echo "== the assertions"
set +e
OUTPUT="$("${Q[@]}" -d "$DB" -f "$REPO/supabase/tests/payment_entry_destination_model_assertions.sql" 2>&1)"
STATUS=$?
set -e
printf '%s\n' "$OUTPUT" | grep -vE '^NOTICE:  (trigger|constraint|relation)' || true
if [ $STATUS -ne 0 ] || ! printf '%s' "$OUTPUT" | grep -q 'ALL ASSERTIONS PASSED'; then
  echo "FAIL: the assertions did not reach the end"
  exit 1
fi

echo "== suite complete; database dropped"
