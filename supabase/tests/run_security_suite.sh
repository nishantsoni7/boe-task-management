#!/usr/bin/env bash
# Build a production-shaped database, prove both exposures, apply the three
# unapplied migrations in order, and prove both are closed.
#
#   supabase/tests/run_security_suite.sh <psql-host-or-socket-dir>
#
# Creates and drops a database called `boe_sec_dryrun`. Touches nothing else.
set -euo pipefail
HOST="${1:?usage: run_security_suite.sh <psql host or socket dir>}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DB=boe_sec_dryrun
Q=(psql -h "$HOST" -U postgres -v ON_ERROR_STOP=1 -q)

"${Q[@]}" -d postgres -c "drop database if exists $DB" >/dev/null
"${Q[@]}" -d postgres -c "create database $DB" >/dev/null

echo "══ building the production-shaped schema (pre-correction definitions) ══"
"${Q[@]}" -d "$DB" -f "$REPO/supabase/tests/_production_shaped_schema.sql"

echo "══ BEFORE: the exposures, demonstrated ══"
"${Q[@]}" -d "$DB" -f "$REPO/supabase/tests/payment_participant_security.sql"

echo "══ applying the three unapplied migrations, in order ══"
for m in 20261004000000_finance_received_payments_allocation_state \
         20261005000000_order_linked_payment_total_counts_allocations \
         20261006000000_payment_participant_and_order_total_security; do
  echo "── $m"
  "${Q[@]}" -d "$DB" -f "$REPO/supabase/migrations/$m.sql"
done

echo "══ AFTER: the same matrix, now required to hold ══"
"${Q[@]}" -d "$DB" -f "$REPO/supabase/tests/payment_participant_security.sql"

echo "══ the batched-RPC security harness ══"
"${Q[@]}" -d "$DB" -f "$REPO/supabase/tests/payment_active_allocation_totals_security.sql"

"${Q[@]}" -d postgres -c "drop database $DB" >/dev/null
echo "══ suite complete; database dropped ══"
