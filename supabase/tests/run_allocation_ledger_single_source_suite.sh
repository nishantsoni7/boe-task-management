#!/usr/bin/env bash
# Build a production-shaped database, bring it to the state 20261011000000
# leaves behind, supplement it with the pre-112 objects 112 replaces and drops,
# apply 20261012000000, and run the assertions.
#
#   supabase/tests/run_allocation_ledger_single_source_suite.sh <psql-host-or-socket-dir>
#
# Creates and drops a database called `boe_allocation_single_source`. Touches
# nothing else, and never talks to a linked project.
#
# WHY THE FIXTURE BUILDS THE OLD BEHAVIOUR FIRST. The supplement installs
# order_linked_payment_total WITH its direct-link fallback, exactly as
# 20261006000000 leaves it, and the four Link/Unlink RPCs with their real
# signatures and grants. The suite then proves 112 changes those things. A
# fixture that started out already correct would let an empty migration pass.
set -euo pipefail
HOST="${1:?usage: run_allocation_ledger_single_source_suite.sh <psql host or socket dir>}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DB=boe_allocation_single_source
Q=(psql -h "$HOST" -U postgres -v ON_ERROR_STOP=1 -q)

"${Q[@]}" -d postgres -c "drop database if exists $DB" >/dev/null 2>&1
"${Q[@]}" -d postgres -c "create database $DB" >/dev/null
trap '"${Q[@]}" -d postgres -c "drop database if exists '"$DB"'" >/dev/null 2>&1 || true' EXIT

echo "== building the production-shaped schema"
"${Q[@]}" -d "$DB" -f "$REPO/supabase/tests/_order_finance_reset_shaped_schema.sql" >/dev/null

echo "== applying 20261010000000"
"${Q[@]}" -d "$DB" -f "$REPO/supabase/migrations/20261010000000_order_submission_and_finance_test_data_reset.sql" >/dev/null

echo "== supplementing for 20261011000000"
"${Q[@]}" -d "$DB" -f "$REPO/supabase/tests/_admin_payment_deletion_and_payment_id_extra_schema.sql" >/dev/null

echo "== applying 20261011000000 (the view 112 replaces)"
"${Q[@]}" -d "$DB" -f "$REPO/supabase/migrations/20261011000000_admin_payment_deletion_and_payment_id.sql" >/dev/null 2>&1

echo "== supplementing with the PRE-112 objects: order_linked_payment_total WITH its fallback, and the four Link/Unlink RPCs"
"${Q[@]}" -d "$DB" -f "$REPO/supabase/tests/_allocation_ledger_single_source_extra_schema.sql" >/dev/null

# ── The fallback is really there before we start ─────────────────────────────
# Without this the suite could pass against a fixture that never had the defect.
echo "== proving the fixture carries the pre-112 defect"
BEFORE="$("${Q[@]}" -d "$DB" -t -A -f "$REPO/supabase/tests/_allocation_ledger_single_source_before.sql")"
if [ "$BEFORE" != "100000|1" ]; then
  echo "FAIL: the fixture does not reproduce the pre-112 behaviour (got '$BEFORE', expected '100000|1')"
  echo "      Expected: a legacy-linked payment credits its Order 100000, and 4 Link/Unlink RPCs exist."
  exit 1
fi
echo "== confirmed: before 112, a legacy link credits an Order 100000 and 4 Link/Unlink RPCs exist"

echo "== applying 20261012000000 (its own apply-time assertions run here)"
"${Q[@]}" -d "$DB" -f "$REPO/supabase/migrations/20261012000000_allocation_ledger_as_single_source.sql"

echo "== the assertions"
set +e
OUTPUT="$("${Q[@]}" -d "$DB" -f "$REPO/supabase/tests/allocation_ledger_single_source_assertions.sql" 2>&1)"
STATUS=$?
set -e
printf '%s\n' "$OUTPUT" | grep -v '^NOTICE:  trigger\|^NOTICE:  constraint' || true
if [ $STATUS -ne 0 ] || ! printf '%s' "$OUTPUT" | grep -q 'ALL ASSERTIONS PASSED'; then
  echo "FAIL: the assertions did not reach the end"
  exit 1
fi

echo "== suite complete; database dropped"
