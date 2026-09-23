#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════════════════
# THE REVIEWER-REASSIGNMENT RACE, WITH TWO REAL SESSIONS (20261229000000)
# ═════════════════════════════════════════════════════════════════════════════
#
#   BOE_DB_CONTAINER=supabase_db_<project_id> bash supabase/tests/run_order_operations_handoff_race.sh
#
# THE CLAIM UNDER TEST. A PI approval reads "who is the reviewer" while an
# administrator changes it in Control Center. Without serialization the
# approval could read reviewer A, the change could switch to B and readdress
# every handoff it can see — missing the one the approval has not committed
# yet — and the team would end up with a live handoff addressed to A, who is
# no longer the reviewer. The trigger takes a SHARE lock on the one
# order_operations_reviewers row before it reads the reviewer;
# set_order_operations_reviewer() takes the UPDATE lock on that row before it
# reads or writes anything. So the two serialize, in either order, and every
# newly committed unresolved handoff ends up with the reviewer who is current
# after both transactions finish (or visibly unassigned).
#
# WHY THIS IS NOT IN THE ASSERTION FILE. That file runs in one transaction and
# rolls back, which is exactly what a lock-contention test cannot do: a race
# needs two connections, committed rows, and one of them genuinely waiting on
# the other's row lock. So this commits fixtures into the disposable stack and
# runs two psql processes against it. The fixtures it leaves behind are named
# 'ASSERT RACE …' so the runner's disposability check still passes.
#
# LOCK ORDER PROVED HERE, in both directions:
#   approval:   orders (revision path) → reviewers SHARE → handoffs
#   assignment: reviewers UPDATE → handoffs  (never orders)
#   decision:   orders → handoffs            (never reviewers)
# No cycle: orders < reviewers < handoffs everywhere. Direction 2 also proves
# the approval does not deadlock while the assignment holds the row and
# touches handoffs.
#
# PREREQUISITES: the same disposable stack run_order_operations_handoff_local.sh
# needs, with the migration applied, and Docker running.
# ═════════════════════════════════════════════════════════════════════════════
set -euo pipefail

: "${BOE_DB_CONTAINER:?BOE_DB_CONTAINER must name the database container of the disposable stack}"
case "$BOE_DB_CONTAINER" in
  supabase_db_*) ;;
  *) echo "refusing: $BOE_DB_CONTAINER is not a local Supabase database container" >&2; exit 2 ;;
esac

Q() { docker exec -i "$BOE_DB_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q "$@"; }
scalar() { docker exec -i "$BOE_DB_CONTAINER" psql -U postgres -d postgres -Atc "$1"; }
fail() { echo "FAIL: $*"; exit 1; }

[ "$(scalar "select to_regclass('public.order_operations_handoffs') is not null")" = "t" ] \
  || fail "order_operations_handoffs is missing — apply 20261229000000 first"
[ "$(scalar "select count(*) from public.orders where client_name not like 'ASSERT%'")" = "0" ] \
  || fail "this database holds Orders that are not test fixtures; it is not disposable"

OWNER=11111111-1111-1111-1111-111111111111
A=aaaaaaaa-0000-4000-8000-00000000000a
B=bbbbbbbb-0000-4000-8000-00000000000b
SALES=55555555-5555-5555-5555-555555555555
RUN=$(date +%s)

# RETIRE WHAT THIS RUN COMMITS, pass or fail. The race needs committed rows,
# but a live awaiting handoff left behind would change the counts the
# single-transaction assertion suite makes. Cancelling the fixture Orders
# (through the real cancel door) takes their handoffs out of every "live,
# unresolved" set; the rows stay, as they would in production.
retire() {
  Q >/dev/null 2>&1 <<SQL || true
begin;
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', '$OWNER', 'role', 'authenticated')::text, true);
select public.cancel_order(id, 'ASSERT race fixture retired')
  from public.orders where client_name like 'ASSERT RACE%' and status <> 'cancelled';
commit;
SQL
  Q >/dev/null 2>&1 <<SQL || true
begin;
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', '$OWNER', 'role', 'authenticated')::text, true);
select public.set_order_operations_reviewer(null);
commit;
SQL
}
trap retire EXIT

echo "== fixtures (committed): two operations reviewers, a salesperson, two submitted PIs"
Q <<SQL
insert into public.users (id, full_name, email, role, team, is_active, employee_code) values
  ('$A',     'ASSERT RACE Reviewer A', 'race-a@example.test', 'member', 'operations', true, 'RACE-A'),
  ('$B',     'ASSERT RACE Reviewer B', 'race-b@example.test', 'member', 'operations', true, 'RACE-B'),
  ('$SALES', 'ASSERT Sales',           'sales@example.test',  'member', 'sales',      true, 'ASSERT-SAL')
on conflict (id) do nothing;
insert into public.employee_permission_overrides (user_id, module_id, action_id, allowed, granted_by)
select u, pm.id, pa.id, true, '$OWNER'
  from unnest(array['$A'::uuid, '$B'::uuid]) as u,
       public.permission_modules pm join public.permission_actions pa on pa.action_key = 'view'
 where pm.module_key = 'orders'
on conflict do nothing;
SQL

make_pi() {
  # A complete, submitted PI with 40% verified, as the assertion suite builds it.
  local PI="$1" CLIENT="$2"
  Q <<SQL
do \$\$
declare
  v_item uuid := gen_random_uuid();
  v_wb   text := 'submissions/$PI/original/' || gen_random_uuid()::text || '.xlsx';
  v_sha  text := repeat('a', 64);
  v_img  text;
  v_pay  uuid := gen_random_uuid();
begin
  perform set_config('request.jwt.claims', '', true);
  insert into public.order_submissions
    (id, status, submitted_by, created_by, client_name, gross_product_amount, discount_amount, grand_total,
     source_workbook_path, source_workbook_sha256, source_workbook_name, parse_warnings, parse_blocking_issues, reservation_required)
  values ('$PI', 'draft', '$SALES', '$SALES', '$CLIENT', 1000000, 0, 1000000, v_wb, v_sha, 'pi.xlsx', '[]', '[]', false);
  insert into storage.objects (bucket_id, name, metadata)
  values ('order-files', v_wb, jsonb_build_object('mimetype', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'));
  insert into public.order_submission_items
    (id, submission_id, source_row, item_sequence, product_name, quantity, cost_per_piece, total_amount, sort_order)
  values (v_item, '$PI', 10, '1', 'ASSERT chair', 1, 1000000, 1000000, 0);
  v_img := 'submissions/$PI/images/' || v_item::text || '/representative/0-' || v_sha || '.png';
  insert into public.order_submission_item_images
    (submission_id, item_id, role, position, storage_path, mime_type, sha256, anchor_row)
  values ('$PI', v_item, 'representative', 0, v_img, 'image/png', v_sha, 10);
  insert into storage.objects (bucket_id, name, metadata)
  values ('order-files', v_img, jsonb_build_object('mimetype', 'image/png'));
  insert into public.finance_payment_requests (id, client_name, amount, payment_date, payment_mode, status, submitted_by, received_in)
  values (v_pay, 'ASSERT', 400000, current_date, 'hdfc', 'approved_unlinked', '$SALES', null);
  insert into public.finance_payment_allocations (payment_request_id, order_submission_id, allocated_amount, origin_target_type, created_by)
  values (v_pay, '$PI', 400000, 'order_submission', '$SALES');
  update public.order_submissions set status = 'submitted', submitted_at = now() where id = '$PI';
end \$\$;
SQL
}

as_user() { printf "select set_config('request.jwt.claims', json_build_object('sub', '%s', 'role', 'authenticated')::text, true);" "$1"; }

# The approval, held open: set role, take the trigger's path, then sleep
# INSIDE the transaction so the SHARE lock on the reviewers row is held.
approve_holding_lock() {
  local PI="$1" HOLD="$2"
  Q <<SQL
begin;
set local role authenticated;
$(as_user "$OWNER")
select public.approve_order_submission('$PI', '$SALES', current_date, current_date + 30, 'reference');
select pg_sleep($HOLD);
commit;
SQL
}

assign() {
  local WHO="$1"
  Q -t -A <<SQL
begin;
set local role authenticated;
$(as_user "$OWNER")
select public.set_order_operations_reviewer($WHO);
commit;
SQL
}

live_reviewer_of_pi() {
  scalar "select coalesce(h.assigned_to::text, 'UNASSIGNED') from public.order_operations_handoffs h
           join public.orders o on o.id = h.order_id
          where o.source_order_submission_id = '$1' and h.superseded_at is null"
}

# ── Direction 1: the approval holds the reviewer lock; the change arrives while it is held ──
PI1=$(scalar "select gen_random_uuid()")
make_pi "$PI1" "ASSERT RACE 1 $RUN"
assign "'$A'" >/dev/null
echo "== direction 1: approval (reads A, holds the SHARE lock) … Control Center switches to B meanwhile"
approve_holding_lock "$PI1" 3 >/dev/null 2>&1 &
APPROVE_PID=$!
sleep 1.0
T0=$(date +%s)
OUT="$(assign "'$B'")"
T1=$(date +%s)
wait $APPROVE_PID
WAITED=$((T1 - T0))
[ "$WAITED" -ge 1 ] || fail "direction 1: the assignment did not wait for the approval (took ${WAITED}s); the row is not serialized"
echo "   the assignment waited ${WAITED}s for the approval's lock, then ran"
printf '%s' "$OUT" | grep -q '"reassigned_handoffs" : 1\|"reassigned_handoffs": 1' \
  || fail "direction 1: the assignment must readdress the handoff the approval had just committed, got: $OUT"
[ "$(live_reviewer_of_pi "$PI1")" = "$B" ] \
  || fail "direction 1: the new handoff must end up with B (the reviewer current after both commits), got $(live_reviewer_of_pi "$PI1")"
[ "$(scalar "select count(*) from public.notifications n join public.orders o on o.id = n.entity_id where o.source_order_submission_id = '$PI1' and n.user_id = '$B'")" = "1" ] \
  || fail "direction 1: B must be notified exactly once for the readdressed handoff"
echo "   OK: approval read A; the change to B waited, then readdressed the committed handoff to B"

# ── Direction 2: the change holds the lock; the approval arrives while it is held ──
PI2=$(scalar "select gen_random_uuid()")
make_pi "$PI2" "ASSERT RACE 2 $RUN"
echo "== direction 2: Control Center switch (to A, holds the UPDATE lock) … approval arrives meanwhile"
Q >/dev/null 2>&1 <<SQL &
begin;
set local role authenticated;
$(as_user "$OWNER")
select public.set_order_operations_reviewer('$A');
select pg_sleep(3);
commit;
SQL
ASSIGN_PID=$!
sleep 1.0
T0=$(date +%s)
approve_holding_lock "$PI2" 0 >/dev/null
T1=$(date +%s)
wait $ASSIGN_PID
WAITED=$((T1 - T0))
[ "$WAITED" -ge 1 ] || fail "direction 2: the approval did not wait for the assignment (took ${WAITED}s)"
echo "   the approval waited ${WAITED}s for the assignment's lock, then ran"
[ "$(live_reviewer_of_pi "$PI2")" = "$A" ] \
  || fail "direction 2: the approval must read the reviewer current after the change committed (A), got $(live_reviewer_of_pi "$PI2")"
[ "$(scalar "select count(*) from public.notifications n join public.orders o on o.id = n.entity_id where o.source_order_submission_id = '$PI2' and n.user_id = '$A'")" = "1" ] \
  || fail "direction 2: A must be notified exactly once"
echo "   OK: the approval waited for the change and addressed the handoff to A"

# ── Direction 3: clearing the reviewer while an approval is in flight → visibly unassigned ──
PI3=$(scalar "select gen_random_uuid()")
make_pi "$PI3" "ASSERT RACE 3 $RUN"
echo "== direction 3: approval holds the lock (reads A) … Control Center CLEARS the reviewer meanwhile"
approve_holding_lock "$PI3" 3 >/dev/null 2>&1 &
APPROVE_PID=$!
sleep 1.0
OUT="$(assign "null")"
wait $APPROVE_PID
[ "$(live_reviewer_of_pi "$PI3")" = "UNASSIGNED" ] \
  || fail "direction 3: the handoff must end up visibly unassigned, got $(live_reviewer_of_pi "$PI3")"
[ "$(scalar "select unassigned_reason from public.order_operations_handoffs h join public.orders o on o.id = h.order_id where o.source_order_submission_id = '$PI3'")" = "no_reviewer" ] \
  || fail "direction 3: the reason must say no reviewer is configured"
echo "   OK: cleared mid-approval → the committed handoff is unassigned with its reason"

echo "ALL RACE ASSERTIONS PASSED"
