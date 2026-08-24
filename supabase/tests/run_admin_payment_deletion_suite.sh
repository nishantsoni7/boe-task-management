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

# == Payment ID concurrency: real separate connections, real overlapping
#    transactions == The assertions above run inside one transaction, which
# cannot exercise genuine concurrency — nextval() contention only shows up
# across independent backends racing the same sequence. This phase fires N
# real psql processes at once (separate connections, separate transactions)
# and proves the database, not a mock of it, hands out N distinct values.
echo "== Payment ID concurrency (60 real concurrent connections)"
"${Q[@]}" -d "$DB" -c \
  "insert into public.users (id, email, role) values ('99999999-9999-4999-8999-999999999999', 'concurrency@boe.test', 'admin')" >/dev/null

for i in $(seq 1 60); do
  "${Q[@]}" -d "$DB" -c \
    "insert into public.finance_payment_requests (request_number, client_name, amount, submitted_by, status) \
     values ('CONC-$i', 'Concurrency Co', 100, '99999999-9999-4999-8999-999999999999', 'pending_approval')" \
    >/dev/null &
done
wait

CONC_RESULT="$("${Q[@]}" -d "$DB" -t -A -c \
  "select count(*) || '|' || count(distinct human_payment_id) \
     from public.finance_payment_requests where request_number like 'CONC-%'")"
CONC_TOTAL="${CONC_RESULT%%|*}"
CONC_DISTINCT="${CONC_RESULT##*|}"
if [ "$CONC_TOTAL" != "60" ] || [ "$CONC_DISTINCT" != "60" ]; then
  echo "FAIL: 60 concurrent inserts produced $CONC_TOTAL rows / $CONC_DISTINCT distinct Payment IDs — expected 60/60"
  exit 1
fi
echo "== 60 concurrent connections -> 60 distinct Payment IDs, no collisions"

# A value drawn by a transaction that then rolls back is never reissued —
# proving "never reused" holds even for an aborted attempt, not only a
# completed deletion's tombstoned number.
ROLLED_BACK_ID="$("${Q[@]}" -d "$DB" -t -A -c "
  begin;
  insert into public.finance_payment_requests (request_number, client_name, amount, submitted_by, status)
  values ('WILL-ROLLBACK', 'Ghost Co', 1, '99999999-9999-4999-8999-999999999999', 'pending_approval')
  returning human_payment_id;
  rollback;
")"
AFTER_ROLLBACK_ID="$("${Q[@]}" -d "$DB" -t -A -c "
  insert into public.finance_payment_requests (request_number, client_name, amount, submitted_by, status)
  values ('AFTER-ROLLBACK', 'Real Co', 1, '99999999-9999-4999-8999-999999999999', 'pending_approval')
  returning human_payment_id;
")"
if [ "$ROLLED_BACK_ID" = "$AFTER_ROLLBACK_ID" ] || [ -z "$ROLLED_BACK_ID" ] || [ -z "$AFTER_ROLLBACK_ID" ]; then
  echo "FAIL: a rolled-back Payment ID ($ROLLED_BACK_ID) must never equal the next real one ($AFTER_ROLLBACK_ID)"
  exit 1
fi
echo "== rolled-back Payment ID ($ROLLED_BACK_ID) permanently skipped; next real insert got $AFTER_ROLLBACK_ID"

echo "== suite complete; database dropped"
