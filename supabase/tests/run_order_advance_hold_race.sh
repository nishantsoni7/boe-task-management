#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════════════════
# ALIGNMENT vs. PAYMENT REVERSAL, WITH TWO REAL SESSIONS (20270116000000 §4d)
# ═════════════════════════════════════════════════════════════════════════════
#
#   BOE_DB_CONTAINER=supabase_db_<project_id> bash supabase/tests/run_order_advance_hold_race.sh
#
# THE CLAIM UNDER TEST. Operations aligning an Order and Finance reversing the
# payment that makes it 40% can run at the same moment. The gate reads the
# verified money without locking the allocations, so without serialization
# both could commit: an Order aligned on money that no longer exists. Every
# re-check takes the ORDER row lock before it reads alignment or money, and
# the alignment doors take the same lock before the gate reads money, so the
# two serialize on the Order row in either order:
#
#   1. reversal first:  the reversal's re-check holds the Order; the alignment
#                       WAITS, then its gate sees the reversal and refuses.
#                       Final: not aligned, no hold (it was never aligned).
#   2. alignment first: the alignment holds the Order; the reversal's re-check
#                       WAITS, then sees the committed alignment and holds it.
#                       Final: not aligned, one open hold (payment_changed).
#
# "WAITS" is proved, not assumed: the runner polls pg_stat_activity until the
# second session is blocked on a lock while the first is still open.
#
# WHY NOT IN THE ASSERTION FILE: a race needs two connections and committed
# rows. Fixtures are committed, named 'ASSERT HOLD RACE …', and retired at the
# end (Orders cancelled through the real door, the reviewer assignment put
# back as it was).
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

[ "$(scalar "select to_regprocedure('public.order_advance_hold_recheck(uuid,text,jsonb)') is not null")" = "t" ] \
  || fail "order_advance_hold_recheck is missing — apply 20270116000000 first"

ADMIN=a0d10000-0000-4000-8000-000000000001
SALES=a0d10000-0000-4000-8000-000000000003
OPS=a0d10000-0000-4000-8000-000000000004
FIN=a0d10000-0000-4000-8000-000000000005
SCRATCH=$(mktemp -d)
PREV_REVIEWER=$(scalar "select coalesce(user_id::text, '') from public.order_operations_reviewers where duty = 'pi_handoff'")

retire() {
  rm -rf "$SCRATCH"
  Q >/dev/null 2>&1 <<SQL || true
begin;
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', '$ADMIN', 'role', 'authenticated')::text, true);
select public.cancel_order(id, 'ASSERT hold race fixture retired')
  from public.orders where client_name like 'ASSERT HOLD RACE%' and status <> 'cancelled';
commit;
SQL
  Q >/dev/null 2>&1 <<SQL || true
delete from public.order_operations_reviewers where duty = 'pi_handoff';
insert into public.order_operations_reviewers (duty, user_id, assigned_by)
select 'pi_handoff', nullif('$PREV_REVIEWER', '')::uuid, '$ADMIN' where nullif('$PREV_REVIEWER', '') is not null;
SQL
}
trap retire EXIT

echo "== fixtures (committed): an admin, sales, the operations reviewer, finance"
Q <<SQL
insert into public.users (id, full_name, email, role, team, is_active, employee_code) values
  ('$ADMIN', 'ASSERT HOLD RACE Admin',   'hold-race-admin@suite.test', 'admin',  'management', true, 'HRACE-ADM'),
  ('$SALES', 'ASSERT HOLD RACE Sales',   'hold-race-sales@suite.test', 'member', 'sales',      true, 'HRACE-SAL'),
  ('$OPS',   'ASSERT HOLD RACE Ops',     'hold-race-ops@suite.test',   'member', 'operations', true, 'HRACE-OPS'),
  ('$FIN',   'ASSERT HOLD RACE Finance', 'hold-race-fin@suite.test',   'member', 'management', true, 'HRACE-FIN')
on conflict (id) do update set role = excluded.role, is_active = true;
insert into public.employee_permission_overrides (user_id, module_id, action_id, allowed, granted_by)
select g.uid, mpa.module_id, mpa.action_id, true, '$ADMIN'::uuid
  from (values ('$ADMIN'::uuid, 'orders', 'approve_order'), ('$ADMIN'::uuid, 'orders', 'can_be_order_assignee'),
               ('$SALES'::uuid, 'orders', 'view'), ('$SALES'::uuid, 'orders', 'create'), ('$SALES'::uuid, 'orders', 'can_be_order_assignee'),
               ('$OPS'::uuid, 'orders', 'view'),
               ('$FIN'::uuid, 'finance', 'view'), ('$FIN'::uuid, 'finance', 'allocate_correct')) g(uid, m, a)
  join public.permission_modules pm on pm.module_key = g.m
  join public.permission_actions pa on pa.action_key = g.a
  join public.module_permission_actions mpa on mpa.module_id = pm.id and mpa.action_id = pa.id
on conflict do nothing;
delete from public.order_operations_reviewers where duty = 'pi_handoff';
insert into public.order_operations_reviewers (duty, user_id, assigned_by) values ('pi_handoff', '$OPS', '$ADMIN');
SQL

# A Confirmed Order worth 10,00,000 with exactly 40% verified by ONE allocation,
# its V1 handoff awaiting Operations. Prints "<order id> <allocation id>".
make_order() {
  local CLIENT="$1"
  Q -At <<SQL | tail -1
do \$\$
declare
  v_sub uuid := gen_random_uuid();
  v_wb  text := 'submissions/' || v_sub || '/original/' || gen_random_uuid() || '.xlsx';
  v_pay uuid := gen_random_uuid();
  v_res jsonb;
begin
  insert into public.order_submissions (id, status, submitted_by, created_by, parse_warnings, parse_blocking_issues)
  values (v_sub, 'draft', '$SALES', '$SALES', '[]', '[]');
  update public.order_submissions
     set client_name = '$CLIENT', gross_product_amount = 1000000, discount_amount = 0, grand_total = 1000000,
         source_workbook_path = v_wb, source_workbook_sha256 = repeat('b', 64)
   where id = v_sub;
  insert into storage.objects (bucket_id, name, metadata) values ('order-files', v_wb, '{"mimetype":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}');
  insert into public.order_submission_items (submission_id, source_row, item_sequence, product_name, quantity, cost_per_piece, total_amount, sort_order)
  values (v_sub, 32, 'B001', '$CLIENT chair', 10, 100000, 1000000, 0);
  insert into public.order_submission_item_images (submission_id, item_id, role, position, storage_path, mime_type, sha256, anchor_row)
  select v_sub, i.id, 'representative', 0,
         'submissions/' || v_sub || '/images/' || i.id || '/representative/0-' || repeat('c', 64) || '.png', 'image/png', repeat('c', 64), 32
    from public.order_submission_items i where i.submission_id = v_sub;
  insert into storage.objects (bucket_id, name, metadata)
  select 'order-files', storage_path, '{"mimetype":"image/png"}' from public.order_submission_item_images where submission_id = v_sub;
  insert into public.finance_payment_requests (id, client_name, amount, payment_date, payment_mode, status, submitted_by, received_in)
  values (v_pay, '$CLIENT', 400000, current_date, 'hdfc', 'approved_unlinked', '$SALES', null);
  insert into public.finance_payment_allocations (payment_request_id, order_submission_id, allocated_amount, origin_target_type, created_by)
  values (v_pay, v_sub, 400000, 'order_submission', '$SALES');
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub', '$SALES', 'role', 'authenticated')::text, true);
  perform public.submit_pi_for_review(v_sub, null, null, null, null);
  perform set_config('request.jwt.claims', json_build_object('sub', '$ADMIN', 'role', 'authenticated')::text, true);
  if (select pi_approved_at from public.order_submissions where id = v_sub) is null then
    perform public.approve_pi_review(v_sub);
  end if;
  v_res := public.approve_order_submission(v_sub, '$SALES', current_date, current_date + 30, 'reference');
  execute 'reset role';
  perform set_config('test.out', (v_res ->> 'order_id') || ' ' ||
    (select a.id::text from public.finance_payment_allocations a where a.order_id = (v_res ->> 'order_id')::uuid), false);
end \$\$;
select current_setting('test.out');
SQL
}

as_user() { # $1 user, then SQL on stdin; one transaction, prints the error text if any
  local U="$1"
  { echo "begin;"; echo "set local role authenticated;";
    echo "select set_config('request.jwt.claims', json_build_object('sub', '$U', 'role', 'authenticated')::text, true);";
    cat; echo "commit;"; } | docker exec -i "$BOE_DB_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q -At 2>&1
}

wait_blocked() { # $1 application_name; waits until that backend is waiting on a lock
  for _ in $(seq 1 100); do
    [ "$(scalar "select count(*) from pg_stat_activity where application_name = '$1' and wait_event_type = 'Lock'")" = "1" ] && return 0
    sleep 0.1
  done
  return 1
}

accept_sql() { echo "set application_name = '$2'; select public.decide_order_operations_handoff((select id from public.order_operations_handoffs where order_id = '$1' and superseded_at is null), 'accepted', null); $3"; }
reverse_sql() { echo "set application_name = '$2'; select public.reverse_payment_allocation('$1', 'ASSERT hold race reversal'); $3"; }

echo "== 1. reversal first: the alignment waits, then is refused"
read -r O1 A1 <<< "$(make_order 'ASSERT HOLD RACE 1')"
[ -n "$O1" ] && [ -n "$A1" ] || fail "fixture 1 not created"
( reverse_sql "$A1" hold_race_rev1 "select pg_sleep(3);" | as_user "$FIN" > "$SCRATCH/r1-rev.out" ) &
P1=$!
for _ in $(seq 1 100); do
  [ "$(scalar "select count(*) from pg_stat_activity where application_name = 'hold_race_rev1' and query like '%pg_sleep%'")" = "1" ] && break; sleep 0.1
done
( accept_sql "$O1" hold_race_acc1 "" | as_user "$OPS" > "$SCRATCH/r1-acc.out" ) &
P2=$!
wait_blocked hold_race_acc1 || fail "1: the alignment did not wait on the reversal's Order lock"
echo "   the alignment is blocked on a lock while the reversal is open: OK"
wait $P1 || true; wait $P2 || true
grep -q "ORDER_ADVANCE_BELOW_THRESHOLD" "$SCRATCH/r1-acc.out" || { cat "$SCRATCH/r1-acc.out"; fail "1: the alignment was not refused after the reversal"; }
[ "$(scalar "select production_alignment from public.orders where id = '$O1'")" = "not_aligned" ] || fail "1: the Order ended aligned"
[ "$(scalar "select count(*) from public.order_advance_holds where order_id = '$O1'")" = "0" ] || fail "1: a never-aligned Order was held"
echo "   final: not aligned, refused with ORDER_ADVANCE_BELOW_THRESHOLD, no hold: OK"

echo "== 2. alignment first: the reversal waits, then holds the aligned Order"
read -r O2 A2 <<< "$(make_order 'ASSERT HOLD RACE 2')"
[ -n "$O2" ] && [ -n "$A2" ] || fail "fixture 2 not created"
( accept_sql "$O2" hold_race_acc2 "select pg_sleep(3);" | as_user "$OPS" > "$SCRATCH/r2-acc.out" ) &
P1=$!
for _ in $(seq 1 100); do
  [ "$(scalar "select count(*) from pg_stat_activity where application_name = 'hold_race_acc2' and query like '%pg_sleep%'")" = "1" ] && break; sleep 0.1
done
( reverse_sql "$A2" hold_race_rev2 "" | as_user "$FIN" > "$SCRATCH/r2-rev.out" ) &
P2=$!
wait_blocked hold_race_rev2 || fail "2: the reversal's re-check did not wait on the alignment's Order lock"
echo "   the reversal is blocked on a lock while the alignment is open: OK"
wait $P1 || true; wait $P2 || true
grep -q "ERROR" "$SCRATCH/r2-acc.out" && { cat "$SCRATCH/r2-acc.out"; fail "2: the alignment failed"; }
grep -q "ERROR" "$SCRATCH/r2-rev.out" && { cat "$SCRATCH/r2-rev.out"; fail "2: the reversal failed"; }
[ "$(scalar "select production_alignment from public.orders where id = '$O2'")" = "not_aligned" ] || fail "2: the Order stayed aligned on reversed money"
[ "$(scalar "select count(*) from public.order_advance_holds where order_id = '$O2' and resolved_at is null and cause = 'payment_changed'")" = "1" ] \
  || fail "2: no open payment hold"
[ "$(scalar "select count(*) from public.order_activity_log where order_id = '$O2' and event_type = 'operations_handoff_accepted'")" = "1" ] \
  || fail "2: the acceptance is not on the history"
echo "   final: acceptance recorded, then held and not aligned: OK"

echo "ALL ADVANCE-HOLD RACE ASSERTIONS PASSED"
