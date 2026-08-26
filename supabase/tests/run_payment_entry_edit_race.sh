#!/usr/bin/env bash
# The edit-versus-approval race, with TWO REAL SESSIONS.
#
#   supabase/tests/run_payment_entry_edit_race.sh <psql-host-or-socket-dir> [--with-114]
#
# TWO SCHEMAS, ONE RACE. Without an argument it builds through 20261013000000 and
# proves the race against the functions THAT migration installed. With --with-114
# it applies 20261014000000 as well and proves the SAME race against the
# functions that actually ship — 114 restates edit_payment_request, and a lock
# ordering that was only ever proved on a superseded body is not proved at all.
#
# WHY THIS IS NOT IN THE ASSERTION FILE. That file runs in one transaction and
# rolls back, which is exactly what a lock-contention test cannot do: a race
# needs two connections, committed rows, and one of them genuinely waiting on
# the other's row lock. So this builds the same database the assertion suite
# builds, commits a fixture into it, and runs two psql processes against it.
#
# THE CLAIM UNDER TEST. edit_payment_request and approve_finance_payment_request
# both take `FOR UPDATE` on the payment row BEFORE they read the status they
# decide on. So they serialize, exactly one wins, and the loser refuses by name
# against the row the winner committed — never against the row it read first.
#
# Creates and drops a database called `boe_payment_edit_race`.
set -euo pipefail
HOST="${1:?usage: run_payment_entry_edit_race.sh <psql host or socket dir> [--with-114]}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DB=boe_payment_edit_race

# ── Which schema, and therefore which payment mode ───────────────────────────
# 20261014000000 retires the five legacy modes for NEW entries, so the fixture
# has to speak the vocabulary of the schema it is running against or every
# submission is refused before the race begins.
EXTRA=()
MODE=upi
if [ "${2:-}" = "--with-114" ]; then
  EXTRA=(
    "$REPO/supabase/tests/_payment_custody_and_modes_extra_schema.sql"
    "$REPO/supabase/migrations/20261014000000_payment_destination_display_modes_and_custody.sql"
  )
  MODE=hdfc
  DB=boe_payment_edit_race_114
fi
Q=(psql -h "$HOST" -U postgres -v ON_ERROR_STOP=1 -q)

"${Q[@]}" -d postgres -c "drop database if exists $DB" >/dev/null 2>&1
"${Q[@]}" -d postgres -c "create database $DB" >/dev/null
trap '"${Q[@]}" -d postgres -c "drop database if exists '"$DB"'" >/dev/null 2>&1 || true' EXIT

SCHEMA_LABEL=20261013000000
[ ${#EXTRA[@]} -gt 0 ] && SCHEMA_LABEL=20261014000000
echo "== building the schema through $SCHEMA_LABEL"
for f in \
  "$REPO/supabase/tests/_order_finance_reset_shaped_schema.sql" \
  "$REPO/supabase/migrations/20261010000000_order_submission_and_finance_test_data_reset.sql" \
  "$REPO/supabase/tests/_admin_payment_deletion_and_payment_id_extra_schema.sql" \
  "$REPO/supabase/migrations/20261011000000_admin_payment_deletion_and_payment_id.sql" \
  "$REPO/supabase/tests/_allocation_ledger_single_source_extra_schema.sql" \
  "$REPO/supabase/migrations/20261012000000_allocation_ledger_as_single_source.sql" \
  "$REPO/supabase/tests/_payment_entry_destination_model_extra_schema.sql" \
  "$REPO/supabase/migrations/20261013000000_payment_entry_destination_model.sql" \
  "${EXTRA[@]+"${EXTRA[@]}"}"
do
  "${Q[@]}" -d "$DB" -f "$f" >/dev/null 2>&1
done

# ── A committed fixture, because a lock has to be taken on a real row ────────
"${Q[@]}" -d "$DB" >/dev/null <<'SEED'
insert into public.users (id, email, role, full_name) values
  ('11111111-1111-4111-8111-111111111111', 'admin@boe.test', 'admin',       'Admin'),
  ('22222222-2222-4222-8222-222222222222', 'sales@boe.test', 'salesperson', 'Sales');
insert into public.finance_permission_grants (user_id, action) values
  ('22222222-2222-4222-8222-222222222222', 'finance.create');
insert into public.orders (id, display_number, status, client_name, created_by) values
  ('a0000000-0000-4000-8000-00000000000a', 'ORD-A', 'running', 'Kalyan Interiors', '11111111-1111-4111-8111-111111111111'),
  ('b0000000-0000-4000-8000-00000000000b', 'ORD-B', 'running', 'Menon Builders',   '11111111-1111-4111-8111-111111111111');
SEED

# One helper per direction, so the two runs cannot share state.
new_request() {
  "${Q[@]}" -d "$DB" -t -A <<MK
select set_config('request.jwt.claims',
  json_build_object('sub', '22222222-2222-4222-8222-222222222222', 'role', 'authenticated')::text, false);
select (public.submit_payment_request(
  p_destination => 'confirmed_order',
  p_target_id   => 'a0000000-0000-4000-8000-00000000000a',
  p_amount      => 40000, p_payment_date => current_date, p_payment_mode => '$MODE'
)->>'payment_request_id');
MK
}

fail() { echo "FAIL: $*"; exit 1; }

# ── Direction 1: APPROVAL wins, the edit arrives second ──────────────────────
PAY="$(new_request | tail -1)"
echo "== direction 1: approval holds the lock, the edit arrives while it is held"

"${Q[@]}" -d "$DB" >/dev/null 2>&1 <<APPROVE &
begin;
select set_config('request.jwt.claims',
  json_build_object('sub', '11111111-1111-4111-8111-111111111111', 'role', 'authenticated')::text, true);
-- Take the row lock the RPC would take, hold it, then do the approval under it.
select 1 from public.finance_payment_requests where id = '$PAY' for update;
select pg_sleep(2);
select public.approve_finance_payment_request('$PAY', null);
commit;
APPROVE
APPROVE_PID=$!

sleep 0.7
set +e
EDIT_OUT="$("${Q[@]}" -d "$DB" -t -A 2>&1 <<EDIT
select set_config('request.jwt.claims',
  json_build_object('sub', '22222222-2222-4222-8222-222222222222', 'role', 'authenticated')::text, false);
select public.edit_payment_request(
  p_payment_request_id => '$PAY',
  p_destination        => 'confirmed_order',
  p_target_id          => 'b0000000-0000-4000-8000-00000000000b',
  p_amount             => 40000, p_payment_date => current_date, p_payment_mode => '$MODE');
EDIT
)"
EDIT_STATUS=$?
set -e
wait $APPROVE_PID

[ $EDIT_STATUS -eq 0 ] && fail "the edit must lose to a committed approval, but it succeeded"
printf '%s' "$EDIT_OUT" | grep -q 'PAYMENT_ALREADY_APPROVED' \
  || fail "the losing edit must say PAYMENT_ALREADY_APPROVED, got: $EDIT_OUT"
echo "   the edit lost, and was told so by name"

"${Q[@]}" -d "$DB" -t -A <<CHECK1 | grep -q '^OK$' || fail "direction 1 left an inconsistent state"
select case when
     (select status from public.finance_payment_requests where id = '$PAY')
       in ('approved_linked', 'approved_unlinked')
 and (select count(*) from public.finance_payment_allocations
       where payment_request_id = '$PAY' and status = 'active') = 1
 and (select count(*) from public.finance_payment_allocations
       where payment_request_id = '$PAY' and status = 'active'
         and order_id = 'a0000000-0000-4000-8000-00000000000a') = 1
 and (select count(*) from public.finance_payment_allocation_intents
       where payment_request_id = '$PAY' and status = 'pending') = 0
 and (select amount from public.finance_payment_requests where id = '$PAY') = 40000
then 'OK' else 'BAD' end;
CHECK1
echo "   approved once, ONE allocation, on the ORIGINAL target, no intent left pending"

# ── Direction 2: THE EDIT wins, the approval arrives second ───────────────────
PAY2="$(new_request | tail -1)"
echo "== direction 2: the edit holds the lock, the approval arrives while it is held"

"${Q[@]}" -d "$DB" >/dev/null 2>&1 <<EDITWIN &
begin;
select set_config('request.jwt.claims',
  json_build_object('sub', '22222222-2222-4222-8222-222222222222', 'role', 'authenticated')::text, true);
select 1 from public.finance_payment_requests where id = '$PAY2' for update;
select pg_sleep(2);
select public.edit_payment_request(
  p_payment_request_id => '$PAY2',
  p_destination        => 'confirmed_order',
  p_target_id          => 'b0000000-0000-4000-8000-00000000000b',
  p_amount             => 40000, p_payment_date => current_date, p_payment_mode => '$MODE');
commit;
EDITWIN
EDIT_PID=$!

sleep 0.7
set +e
"${Q[@]}" -d "$DB" -t -A >/dev/null 2>&1 <<APPROVE2
select set_config('request.jwt.claims',
  json_build_object('sub', '11111111-1111-4111-8111-111111111111', 'role', 'authenticated')::text, false);
select public.approve_finance_payment_request('$PAY2', null);
APPROVE2
APPROVE2_STATUS=$?
set -e
wait $EDIT_PID

# The approval WAITS for the edit's lock and then approves the corrected row, so
# it succeeds — and the money must land on the record the correction chose, not
# on the one the approver read before it blocked.
[ $APPROVE2_STATUS -eq 0 ] || fail "the approval should succeed once the edit commits"

"${Q[@]}" -d "$DB" -t -A <<CHECK2 | grep -q '^OK$' || fail "direction 2 allocated against the wrong target"
select case when
     (select count(*) from public.finance_payment_allocations
       where payment_request_id = '$PAY2' and status = 'active') = 1
 and (select count(*) from public.finance_payment_allocations
       where payment_request_id = '$PAY2' and status = 'active'
         and order_id = 'b0000000-0000-4000-8000-00000000000b') = 1
 and (select count(*) from public.finance_payment_allocation_intents
       where payment_request_id = '$PAY2' and status = 'pending') = 0
 and (select client_name from public.finance_payment_requests where id = '$PAY2') = 'Menon Builders'
then 'OK' else 'BAD' end;
CHECK2
echo "   the approval waited, then allocated against the CORRECTED target, exactly once"

echo "== race suite complete; database dropped"
