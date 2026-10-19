#!/usr/bin/env bash
# Prove 20270322000000 (finance_payment_edit_reallocates) on a DISPOSABLE database:
#
#   1. build the production-shaped schema through 20261014000000, the body of
#      edit_payment_request this migration restates;
#   2. run the assertions BEFORE the migration — they must reproduce the defect
#      (a payment recorded from a PI is refused with PAYMENT_EDIT_ALLOCATED);
#   3. apply the migration in ONE transaction (-1), as the Supabase runner does,
#      and again onto its own successful state;
#   4. run the assertions in full.
#
#   supabase/tests/run_payment_edit_reallocates_suite.sh <psql host or socket dir>
#
# Creates and drops a database called boe_payment_edit_reallocates. Touches
# nothing else and never talks to a linked project.
set -euo pipefail
HOST="${1:?usage: run_payment_edit_reallocates_suite.sh <psql host or socket dir>}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DB=boe_payment_edit_reallocates
MIG="$REPO/supabase/migrations/20270322000000_finance_payment_edit_reallocates.sql"
Q=(psql -h "$HOST" -U postgres -v ON_ERROR_STOP=1 -q)

"${Q[@]}" -d postgres -c "drop database if exists $DB" >/dev/null 2>&1
"${Q[@]}" -d postgres -c "create database $DB" >/dev/null
trap '"${Q[@]}" -d postgres -c "drop database if exists '"$DB"'" >/dev/null 2>&1 || true' EXIT

echo "== building the production-shaped schema, through 20261014000000"
for f in \
  "$REPO/supabase/tests/_order_finance_reset_shaped_schema.sql" \
  "$REPO/supabase/migrations/20261010000000_order_submission_and_finance_test_data_reset.sql" \
  "$REPO/supabase/tests/_admin_payment_deletion_and_payment_id_extra_schema.sql" \
  "$REPO/supabase/migrations/20261011000000_admin_payment_deletion_and_payment_id.sql" \
  "$REPO/supabase/tests/_allocation_ledger_single_source_extra_schema.sql" \
  "$REPO/supabase/migrations/20261012000000_allocation_ledger_as_single_source.sql" \
  "$REPO/supabase/tests/_payment_entry_destination_model_extra_schema.sql" \
  "$REPO/supabase/migrations/20261013000000_payment_entry_destination_model.sql" \
  "$REPO/supabase/tests/_payment_custody_and_modes_extra_schema.sql" \
  "$REPO/supabase/migrations/20261014000000_payment_destination_display_modes_and_custody.sql"
do
  "${Q[@]}" -d "$DB" -f "$f" >/dev/null 2>&1 || { echo "FAIL building: $f"; "${Q[@]}" -d "$DB" -f "$f" 2>&1 | tail -5; exit 1; }
done

# record_pi_submission_payment (the PI page's Add payment) reads this production
# column; the shaped schema has not got it (same line as _payment_idempotency_extra_schema.sql).
"${Q[@]}" -d "$DB" -c "alter table public.order_submissions add column if not exists assigned_to uuid"

# Production's allocation guards. The shaped schema's allocation table has no
# reversal columns and none of these triggers; without them the suite would prove
# the migration against a table that lets an allocation's amount be edited in
# place, which production forbids. Function bodies are extracted VERBATIM from
# their own migrations (the latest definition of each).
extract() { # <file> <function name>
  awk -v fn="create or replace function public.$2(" '
    index(tolower($0), fn) == 1 { on = 1 }
    on { print }
    on && /^\$\$;/ { exit }
  ' "$1"
}
MIGS="$REPO/supabase/migrations"
TMP="$(mktemp -d)"
trap '"${Q[@]}" -d postgres -c "drop database if exists '"$DB"'" >/dev/null 2>&1 || true; rm -rf "$TMP"' EXIT
{
  cat "$REPO/supabase/tests/_payment_edit_reallocates_extra_schema.sql"
  extract "$MIGS/20260921000000_order_submission_verified_payment_gate.sql" finance_payment_allocations_guard_transition
  extract "$MIGS/20260918000000_finance_payment_allocations.sql"           finance_payment_allocations_derive_reversal
  extract "$MIGS/20260918000000_finance_payment_allocations.sql"           finance_payment_requests_guard_allocated_amount
  cat <<'SQL'
create trigger finance_payment_allocations_check_transition
  before update on public.finance_payment_allocations
  for each row execute function public.finance_payment_allocations_guard_transition();
create trigger finance_payment_allocations_derive_reversal
  before update on public.finance_payment_allocations
  for each row execute function public.finance_payment_allocations_derive_reversal();
create trigger finance_payment_requests_guard_allocated_amount
  before update on public.finance_payment_requests
  for each row execute function public.finance_payment_requests_guard_allocated_amount();
SQL
} > "$TMP/production_shape.sql"
for fn in finance_payment_allocations_guard_transition finance_payment_allocations_derive_reversal finance_payment_requests_guard_allocated_amount; do
  grep -qi "function public.$fn(" "$TMP/production_shape.sql" || { echo "FAIL: could not extract $fn"; exit 1; }
done
"${Q[@]}" -d "$DB" -f "$TMP/production_shape.sql" >/dev/null

echo "== BEFORE the migration: the defect must reproduce"
set +e
BEFORE="$("${Q[@]}" -d "$DB" -f "$REPO/supabase/tests/payment_edit_reallocates_assertions.sql" 2>&1)"
set -e
if ! printf '%s' "$BEFORE" | grep -qE 'PAYMENT_EDIT_ALLOCATED|INTENT_EXCEEDS_PAYMENT|PAYMENT_BELOW_ALLOCATED'; then
  printf '%s\n' "$BEFORE" | tail -15
  echo "FAIL: the allocated-payment defect did not reproduce"
  exit 1
fi
echo "== confirmed: before the migration an allocated payment is refused (a PAYMENT_ refusal)"

echo "== applying 20270322000000 in ONE transaction (its own apply-time assertions run here)"
"${Q[@]}" -1 -d "$DB" -f "$MIG" 2>&1 | grep -vE 'NOTICE:  (trigger|policy|constraint|relation|view|index|function)' || true

echo "== re-applying it onto its own successful state"
"${Q[@]}" -1 -d "$DB" -f "$MIG" 2>&1 | grep -vE 'NOTICE:  (trigger|policy|constraint|relation|view|index|function)' || true

echo "== the assertions"
set +e
OUTPUT="$("${Q[@]}" -d "$DB" -f "$REPO/supabase/tests/payment_edit_reallocates_assertions.sql" 2>&1)"
STATUS=$?
set -e
printf '%s\n' "$OUTPUT" | grep -vE '^NOTICE:  (trigger|constraint|relation)' || true
if [ $STATUS -ne 0 ] || ! printf '%s' "$OUTPUT" | grep -q 'ALL ASSERTIONS PASSED'; then
  echo "FAIL: the assertions did not reach the end"
  exit 1
fi

echo "== suite complete; database dropped"
