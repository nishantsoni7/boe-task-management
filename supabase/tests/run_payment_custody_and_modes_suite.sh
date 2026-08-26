#!/usr/bin/env bash
# Build a production-shaped database, bring it to the state 20261013000000
# leaves behind, apply 20261014000000, and run the assertions.
#
#   supabase/tests/run_payment_custody_and_modes_suite.sh <psql-host-or-socket-dir>
#
# THE MIGRATION IS APPLIED IN ONE TRANSACTION (-1), which is how the Supabase
# migration runner applies it. A file that only works statement-by-statement
# would pass a looser harness and fail the real push.
#
# Creates and drops a database called `boe_payment_custody_modes`. Touches
# nothing else, and never talks to a linked project.
set -euo pipefail
HOST="${1:?usage: run_payment_custody_and_modes_suite.sh <psql host or socket dir>}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DB=boe_payment_custody_modes
MIG="$REPO/supabase/migrations/20261014000000_payment_destination_display_modes_and_custody.sql"
Q=(psql -h "$HOST" -U postgres -v ON_ERROR_STOP=1 -q)

"${Q[@]}" -d postgres -c "drop database if exists $DB" >/dev/null 2>&1
"${Q[@]}" -d postgres -c "create database $DB" >/dev/null
trap '"${Q[@]}" -d postgres -c "drop database if exists '"$DB"'" >/dev/null 2>&1 || true' EXIT

echo "== building the production-shaped schema, through 20261013000000"
for f in \
  "$REPO/supabase/tests/_order_finance_reset_shaped_schema.sql" \
  "$REPO/supabase/migrations/20261010000000_order_submission_and_finance_test_data_reset.sql" \
  "$REPO/supabase/tests/_admin_payment_deletion_and_payment_id_extra_schema.sql" \
  "$REPO/supabase/migrations/20261011000000_admin_payment_deletion_and_payment_id.sql" \
  "$REPO/supabase/tests/_allocation_ledger_single_source_extra_schema.sql" \
  "$REPO/supabase/migrations/20261012000000_allocation_ledger_as_single_source.sql" \
  "$REPO/supabase/tests/_payment_entry_destination_model_extra_schema.sql" \
  "$REPO/supabase/migrations/20261013000000_payment_entry_destination_model.sql" \
  "$REPO/supabase/tests/_payment_custody_and_modes_extra_schema.sql"
do
  "${Q[@]}" -d "$DB" -f "$f" >/dev/null 2>&1
done

# ── The fixture really is the pre-114 world ──────────────────────────────────
# Without this the suite could pass against a fixture that never had the
# limitations 114 removes.
echo "== proving the fixture carries the pre-114 defect and domain"
BEFORE="$("${Q[@]}" -d "$DB" -t -A -f "$REPO/supabase/tests/_payment_custody_and_modes_before.sql")"
if [ "$BEFORE" != "FIVE_LEGACY_MODES|NO_CUSTODY_TABLE|NO_DESTINATION_VIEW|APPROVES_UNLINKED" ]; then
  echo "FAIL: the fixture does not reproduce the pre-114 state"
  echo "      got      '$BEFORE'"
  echo "      expected 'FIVE_LEGACY_MODES|NO_CUSTODY_TABLE|NO_DESTINATION_VIEW|APPROVES_UNLINKED'"
  exit 1
fi
echo "== confirmed: the five legacy modes, no custody table, no destination view,"
echo "              and an approved Confirmed-Order request that reads approved_unlinked"

echo "== applying 20261014000000 in ONE transaction (its own apply-time assertions run here)"
"${Q[@]}" -1 -d "$DB" -f "$MIG" 2>&1 \
  | grep -vE 'NOTICE:  (trigger|policy|constraint|relation|view|index|function)' || true

echo "== re-applying 20261014000000 onto its own successful state"
"${Q[@]}" -1 -d "$DB" -f "$MIG" 2>&1 \
  | grep -vE 'NOTICE:  (trigger|policy|constraint|relation|view|index|function)' || true

echo "== the assertions"
set +e
OUTPUT="$("${Q[@]}" -d "$DB" -f "$REPO/supabase/tests/payment_custody_and_modes_assertions.sql" 2>&1)"
STATUS=$?
set -e
printf '%s\n' "$OUTPUT" | grep -vE '^NOTICE:  (trigger|constraint|relation)' || true
if [ $STATUS -ne 0 ] || ! printf '%s' "$OUTPUT" | grep -q 'ALL ASSERTIONS PASSED'; then
  echo "FAIL: the assertions did not reach the end"
  exit 1
fi

echo "== suite complete; database dropped"
