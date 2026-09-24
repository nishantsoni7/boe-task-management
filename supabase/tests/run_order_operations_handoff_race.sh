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
# LOCK ORDER PROVED HERE (the reviewer row is always first):
#   first approval:    submission → new Order → [trigger] reviewers SHARE → handoffs
#   revision approval: reviewers SHARE → Order UPDATE → submission → versions → handoffs
#   assignment:        reviewers UPDATE → handoffs → Order KEY SHARE (the
#                      order_activity_log foreign key, per readdressed handoff)
#   decision / alignment door: reviewers SHARE → Order UPDATE → handoff
# The assignment is the only path that reaches an Order AFTER a handoff, and
# it holds the reviewer row exclusively while it does, so no path that holds
# an Order and waits on a handoff or the reviewer row can be running at the
# same time. Directions 1–3: first approval vs. assignment, both orders, and a
# cleared reviewer. Direction 4: a revised PI (V2) on an Order whose V1 handoff
# is unresolved vs. an assignment for that Order, both orders — the case that
# DEADLOCKED before approve_order_pi_revision took the reviewer row first
# (the assignment's foreign-key check on the Order waited for the approval,
# whose trigger waited for the assignment's reviewer row).
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
SCRATCH=$(mktemp -d)

# RETIRE WHAT THIS RUN COMMITS, pass or fail. The race needs committed rows,
# but a live awaiting handoff left behind would change the counts the
# single-transaction assertion suite makes. Cancelling the fixture Orders
# (through the real cancel door) takes their handoffs out of every "live,
# unresolved" set; the rows stay, as they would in production.
retire() {
  rm -rf "$SCRATCH"
  Q >/dev/null 2>&1 <<'SQL' || true
drop trigger if exists zz_race_pause on public.order_pi_versions;
drop function if exists public.zz_race_pause();
SQL
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

# ── Direction 4: a REVISED PI (V2) on an Order whose V1 handoff is unresolved, while ──
# ── Control Center changes the reviewer for that same Order                         ──
#
# The dangerous interleaving. approve_order_pi_revision() locks the Order FOR
# UPDATE, replaces the parse, then approves V2, and only then does the trigger
# ask for the reviewer row. set_order_operations_reviewer() holds the reviewer
# row, locks the V1 handoff and INSERTS an order_activity_log row for that
# Order — and that row's foreign-key check takes FOR KEY SHARE on the Order,
# which conflicts with FOR UPDATE. If the approval held the Order while the
# change held the reviewer row, each would wait for the other.
#
# To make that window deterministic, not lucky, the runner installs a pause
# (public.zz_race_pause, dropped by retire) that fires on the approval's own
# "V1 → superseded" version write (since 20270101000000: the "V2 → admin_approved"
# staging write) — after the function has taken every lock
# it takes before its trigger, and before the trigger — and sleeps only in a
# session that sets race.pause. Nothing in the function under test is altered
# or pre-empted.
#
# 4a: the approval is mid-flight (Order locked, paused) when the change arrives.
# 4b: the change holds the reviewer row when the approval arrives.
# Both sessions must COMPLETE (no deadlock, no timeout), and V2's live handoff
# must end with B — the reviewer current after both commit — notified once.
Q <<'SQL'
create or replace function public.zz_race_pause() returns trigger
language plpgsql as $f$
begin
  if coalesce(current_setting('race.pause', true), '') not in ('', '0') then
    perform pg_sleep(current_setting('race.pause')::double precision);
  end if;
  return new;
end $f$;
drop trigger if exists zz_race_pause on public.order_pi_versions;
create trigger zz_race_pause before update on public.order_pi_versions
  for each row when (new.status in ('superseded', 'admin_approved', 'rejected')) execute function public.zz_race_pause();
SQL

# A confirmed Order with V1 approved and its handoff awaiting reviewer A, and a
# proposed V2 (file stored, reason given) waiting for the admin's approval.
# Prints "<order id> <V2 workbook path>".
prepare_v2() {
  local PI="$1" CLIENT="$2"
  make_pi "$PI" "$CLIENT" >/dev/null
  assign "'$A'" >/dev/null
  approve_holding_lock "$PI" 0 >/dev/null
  local O; O=$(scalar "select id from public.orders where source_order_submission_id = '$PI'")
  [ "$(scalar "select assigned_to::text || '/' || status from public.order_operations_handoffs where order_id = '$O' and superseded_at is null")" = "$A/awaiting" ] \
    || fail "$CLIENT: V1's handoff must be awaiting A before the race"
  local PATH2; PATH2="submissions/$PI/original/$(scalar "select gen_random_uuid()").xlsx"
  Q >/dev/null <<SQL
insert into storage.objects (bucket_id, name, metadata)
values ('order-files', '$PATH2', jsonb_build_object('mimetype', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'));
begin;
set local role authenticated;
$(as_user "$OWNER")
select public.propose_order_pi_revision('$O', '$PATH2', 'v2.xlsx', 'ASSERT RACE revised quantities');
commit;
SQL
  echo "$O $PATH2"
}

# The revision approval exactly as /api/orders/pi-revisions/approve makes it:
# take the processing lease (its own transaction), then one transaction that
# calls the service-role door with the parsed payload, then release the lease.
# PAUSE seconds of sleep inside the function's own version write hold the
# Order lock open.
approve_revision() {
  local O="$1" PI="$2" PATH2="$3" PAUSE="$4"
  local TOK; TOK=$(scalar "select gen_random_uuid()")
  local V2; V2=$(scalar "select id from public.order_pi_versions where order_id = '$O' and status = 'pending'")
  Q -t -A >/dev/null <<SQL
select public.begin_order_submission_processing('$PI', '$OWNER', '$TOK');
SQL
  Q -t -A <<SQL
begin;
set local statement_timeout = '20s';
set local race.pause = '$PAUSE';
select public.approve_order_pi_revision('$V2', '$OWNER', jsonb_build_object(
  'processing_token', '$TOK',
  'source', jsonb_build_object('workbook_path', '$PATH2', 'workbook_name', 'v2.xlsx', 'workbook_sha256', repeat('b', 64)),
  'header', jsonb_build_object('client_name', 'ASSERT RACE revised'),
  'commercial', jsonb_build_object('gross_product_amount', 1000000, 'grand_total', 1000000),
  'items', jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'source_row', 10, 'item_sequence', '1',
           'product_name', 'ASSERT chair', 'quantity', 2, 'cost_per_piece', 500000, 'total_amount', 1000000)),
  'item_images', '[]'::jsonb,
  'seed_terms', jsonb_build_object('fabric_responsibility', null, 'commercial_terms_note', null, 'client_city', null))) is not null;
commit;
select public.finish_order_submission_processing('$PI', '$TOK');
SQL
}

# The Control Center change, bounded, optionally holding its locks HOLD seconds.
assign_bounded() {
  local WHO="$1" HOLD="${2:-0}"
  Q -t -A <<SQL
begin;
set local statement_timeout = '20s';
set local role authenticated;
$(as_user "$OWNER")
select public.set_order_operations_reviewer($WHO);
select pg_sleep($HOLD);
commit;
SQL
}

live_v2_handoff() {
  scalar "select h.version_number || '/' || coalesce(h.assigned_to::text, 'UNASSIGNED') || '/' || h.status
            from public.order_operations_handoffs h where h.order_id = '$1' and h.superseded_at is null"
}

check_v2_outcome() {
  # 20270101000000: an admin approval STAGES V2. V1 stays in force with its
  # live handoff; V2 is admin_approved, addressed to the CURRENT reviewer (B),
  # who is told exactly once; no V2 handoff exists until B accepts it.
  local LABEL="$1" O="$2"
  [ "$(scalar "select string_agg(version_number || '/' || status, ',' order by version_number) from public.order_pi_versions where order_id = '$O'")" = "1/approved,2/admin_approved" ] \
    || fail "$LABEL: V1 must stay approved and V2 be admin_approved"
  [ "$(scalar "select operations_reviewer from public.order_pi_versions where order_id = '$O' and version_number = 2")" = "$B" ] \
    || fail "$LABEL: V2 must await B"
  [ "$(live_v2_handoff "$O")" = "1/$B/awaiting" ] \
    || fail "$LABEL: V1's handoff must still be the live one, addressed to B, got $(live_v2_handoff "$O")"
  [ "$(scalar "select count(*) from public.order_operations_handoffs where order_id = '$O' and version_number = 2")" = "0" ] \
    || fail "$LABEL: no V2 handoff before operations accepts"
  local NB; NB=$(scalar "select count(*) from public.notifications where entity_id = '$O' and user_id = '$B' and type = 'order_operations_review_requested' and title like '%PI V2 %'")
  [ "$NB" = "1" ] || fail "$LABEL: B must be notified exactly once (for V2), got $NB"
  [ "$(scalar "select count(*) from public.order_activity_log where order_id = '$O' and event_type = 'pi_revision_admin_approved'")" = "1" ] \
    || fail "$LABEL: the admin approval must be on the Order's history once"
  [ "$(scalar "select count(*) from public.order_activity_log where order_id = '$O' and event_type = 'pi_revision_approved'")" = "0" ] \
    || fail "$LABEL: nothing may be applied at admin approval"
}

# One field of the single history event of TYPE for revision version V on Order O.
revision_event() {
  scalar "select string_agg(payload ->> '$4', ',') from public.order_activity_log
           where order_id = '$1' and event_type = '$2' and payload ->> 'version_number' = '$3'"
}

# One field of the single history event of TYPE for handoff version V on Order O.
handoff_event() {
  scalar "select string_agg(payload ->> '$4', ',') from public.order_activity_log
           where order_id = '$1' and event_type = '$2' and payload ->> 'version_number' = '$3'"
}

# Run one side in the background and the other in the foreground; both must finish.
report_pair() {
  local LABEL="$1" RC1="$2" OUT1="$3" RC2="$4" OUT2="$5"
  if grep -qi "deadlock" "$OUT1" "$OUT2"; then
    fail "$LABEL: DEADLOCK — approval: $(tr '\n' ' ' <"$OUT1") | change: $(tr '\n' ' ' <"$OUT2")"
  fi
  [ "$RC1" = "0" ] || fail "$LABEL: the revision approval did not complete: $(tr '\n' ' ' <"$OUT1")"
  [ "$RC2" = "0" ] || fail "$LABEL: the reviewer change did not complete: $(tr '\n' ' ' <"$OUT2")"
}

# Block until another session is PARKED in pg_sleep inside a statement that
# matches PATTERN — i.e. it has really taken the locks it holds — rather than
# guessing with a fixed delay (process start-up alone can take seconds).
wait_until_parked() {
  local PAT="$1" i
  for i in $(seq 1 80); do
    [ "$(scalar "select count(*) from pg_stat_activity where wait_event = 'PgSleep' and query like '%$PAT%' and pid <> pg_backend_pid()")" -ge 1 ] && return 0
    sleep 0.25
  done
  fail "no session reached its pause in '$PAT' within 20s"
}

PI4=$(scalar "select gen_random_uuid()")
read -r O4 PATH4 <<<"$(prepare_v2 "$PI4" "ASSERT RACE 4a $RUN" | tail -1)"
[[ "$O4" =~ ^[0-9a-f-]{36}$ ]] || fail "direction 4a: the V2 fixture could not be prepared: $O4 $PATH4"
echo "== direction 4a: revised PI V2 approval holds the Order (V1 handoff unresolved, reviewer A) … Control Center switches to B meanwhile"
approve_revision "$O4" "$PI4" "$PATH4" 3 >"$SCRATCH/4a-approve.out" 2>&1 &
APPROVE_PID=$!
wait_until_parked "approve_order_pi_revision"
T0=$(date +%s)
ASSIGN_RC=0; assign_bounded "'$B'" >"$SCRATCH/4a-assign.out" 2>&1 || ASSIGN_RC=$?
T1=$(date +%s)
APPROVE_RC=0; wait $APPROVE_PID || APPROVE_RC=$?
report_pair "direction 4a" "$APPROVE_RC" "$SCRATCH/4a-approve.out" "$ASSIGN_RC" "$SCRATCH/4a-assign.out"
[ $((T1 - T0)) -ge 1 ] || fail "direction 4a: the change did not wait for the approval in flight (took $((T1 - T0))s)"
echo "   both sessions completed; the change waited $((T1 - T0))s for the approval, then ran"
check_v2_outcome "direction 4a" "$O4"
# The serialization, read back from history: the approval read A (it held the
# reviewer row), and the change — which waited — then readdressed V2 to B.
[ "$(revision_event "$O4" pi_revision_admin_approved 2 operations_reviewer)" = "$A" ] \
  || fail "direction 4a: the approval must have addressed V2 to A (the reviewer when it locked), got $(revision_event "$O4" pi_revision_admin_approved 2 operations_reviewer)"
[ "$(revision_event "$O4" pi_revision_reviewer_changed 2 previously_assigned_to)" = "$A" ] \
  && [ "$(revision_event "$O4" pi_revision_reviewer_changed 2 assigned_to)" = "$B" ] \
  || fail "direction 4a: the change must have readdressed V2 from A to B"
echo "   OK: V2 staged for A under the approval's lock, then readdressed to B; V1 still in force; B notified once"

PI5=$(scalar "select gen_random_uuid()")
read -r O5 PATH5 <<<"$(prepare_v2 "$PI5" "ASSERT RACE 4b $RUN" | tail -1)"
[[ "$O5" =~ ^[0-9a-f-]{36}$ ]] || fail "direction 4b: the V2 fixture could not be prepared: $O5 $PATH5"
echo "== direction 4b: Control Center switch to B holds the reviewer row (V1 handoff unresolved) … revised PI V2 approval arrives meanwhile"
assign_bounded "'$B'" 3 >"$SCRATCH/4b-assign.out" 2>&1 &
ASSIGN_PID=$!
wait_until_parked "pg_sleep(3)"
T0=$(date +%s)
APPROVE_RC=0; approve_revision "$O5" "$PI5" "$PATH5" 0 >"$SCRATCH/4b-approve.out" 2>&1 || APPROVE_RC=$?
T1=$(date +%s)
ASSIGN_RC=0; wait $ASSIGN_PID || ASSIGN_RC=$?
report_pair "direction 4b" "$APPROVE_RC" "$SCRATCH/4b-approve.out" "$ASSIGN_RC" "$SCRATCH/4b-assign.out"
[ $((T1 - T0)) -ge 1 ] || fail "direction 4b: the approval did not wait for the change (took $((T1 - T0))s)"
echo "   both sessions completed; the approval waited $((T1 - T0))s for the change"
check_v2_outcome "direction 4b" "$O5"
# The change moved V1 to B first; the approval, which waited, then read B.
[ "$(handoff_event "$O5" operations_reviewer_assigned 1 assigned_to)" = "$B" ] \
  || fail "direction 4b: the change must have readdressed V1 to B before the approval"
[ "$(revision_event "$O5" pi_revision_admin_approved 2 operations_reviewer)" = "$B" ] \
  || fail "direction 4b: the approval must have addressed V2 to B directly, got $(revision_event "$O5" pi_revision_admin_approved 2 operations_reviewer)"
echo "   OK: V1 readdressed to B by the change; V2 then staged for B directly; B notified once for V2"


# ── Direction 5 (20270101000000): the OPERATIONS ACCEPTANCE of a staged V2 —
# amendment gate, lease, parse, version switch, handoff decision, codes, in
# ONE transaction — against a Control Center switch. The acceptance takes the
# reviewer row SHARE first, like every decision; the switch takes it FOR
# UPDATE. The pause fires on the acceptance's own "V1 → superseded" write,
# after it holds the Order, the submission and the versions.
accept_revision() {
  local V="$1" WHO="$2" PAUSE="$3"
  Q -t -A <<SQL
begin;
set local statement_timeout = '30s';
set local race.pause = '$PAUSE';
set local role authenticated;
$(as_user "$WHO")
select public.decide_order_pi_revision_operations('$V', 'accepted', 'ASSERT RACE accepted') is not null;
commit;
SQL
}
reconcile_to_v2() {
  Q >/dev/null <<SQL
begin;
set local role authenticated;
$(as_user "$OWNER")
select public.amend_order('$1', 'ASSERT RACE reconcile to PI V2', 'ASSERT RACE revised', 1000000, 1000000);
commit;
SQL
}

V5=$(scalar "select id from public.order_pi_versions where order_id = '$O5' and version_number = 2")
reconcile_to_v2 "$O5"
echo "== direction 5a: B accepts staged V2 (Order held mid-apply) … Control Center switches to A meanwhile"
accept_revision "$V5" "$B" 3 >"$SCRATCH/5a-accept.out" 2>&1 &
ACCEPT_PID=$!
wait_until_parked "decide_order_pi_revision_operations"
T0=$(date +%s)
ASSIGN_RC=0; assign_bounded "'$A'" >"$SCRATCH/5a-assign.out" 2>&1 || ASSIGN_RC=$?
T1=$(date +%s)
ACCEPT_RC=0; wait $ACCEPT_PID || ACCEPT_RC=$?
report_pair "direction 5a" "$ACCEPT_RC" "$SCRATCH/5a-accept.out" "$ASSIGN_RC" "$SCRATCH/5a-assign.out"
[ $((T1 - T0)) -ge 1 ] || fail "direction 5a: the change did not wait for the acceptance in flight (took $((T1 - T0))s)"
[ "$(scalar "select string_agg(version_number || '/' || status, ',' order by version_number) from public.order_pi_versions where order_id = '$O5'")" = "1/superseded,2/approved" ] \
  || fail "direction 5a: V2 must be in force after B's acceptance"
[ "$(live_v2_handoff "$O5")" = "2/$B/accepted" ] \
  || fail "direction 5a: V2's handoff must be accepted by B and not readdressed, got $(live_v2_handoff "$O5")"
[ "$(scalar "select count(*) from public.order_activity_log where order_id = '$O5' and event_type = 'pi_revision_applied'")" = "1" ] \
  || fail "direction 5a: applied exactly once"
echo "   OK: the change waited $((T1 - T0))s; B's acceptance applied V2 once; the accepted handoff stayed with B"

PI6=$(scalar "select gen_random_uuid()")
read -r O6 PATH6 <<<"$(prepare_v2 "$PI6" "ASSERT RACE 5b $RUN" | tail -1)"
[[ "$O6" =~ ^[0-9a-f-]{36}$ ]] || fail "direction 5b: the V2 fixture could not be prepared: $O6 $PATH6"
approve_revision "$O6" "$PI6" "$PATH6" 0 >/dev/null
assign_bounded "'$B'" >/dev/null
reconcile_to_v2 "$O6"
V6=$(scalar "select id from public.order_pi_versions where order_id = '$O6' and version_number = 2")
[ "$(scalar "select status || '/' || operations_reviewer from public.order_pi_versions where id = '$V6'")" = "admin_approved/$B" ] \
  || fail "direction 5b: V2 must be staged for B before the race"
echo "== direction 5b: Control Center switch to A holds the reviewer row … B's acceptance arrives meanwhile"
assign_bounded "'$A'" 3 >"$SCRATCH/5b-assign.out" 2>&1 &
ASSIGN_PID=$!
wait_until_parked "pg_sleep(3)"
T0=$(date +%s)
ACCEPT_RC=0; accept_revision "$V6" "$B" 0 >"$SCRATCH/5b-accept.out" 2>&1 || ACCEPT_RC=$?
T1=$(date +%s)
ASSIGN_RC=0; wait $ASSIGN_PID || ASSIGN_RC=$?
grep -qi deadlock "$SCRATCH/5b-accept.out" "$SCRATCH/5b-assign.out" && fail "direction 5b: DEADLOCK"
[ "$ASSIGN_RC" = "0" ] || fail "direction 5b: the reviewer change did not complete: $(tr '\n' ' ' <"$SCRATCH/5b-assign.out")"
[ $((T1 - T0)) -ge 1 ] || fail "direction 5b: the acceptance did not wait for the change (took $((T1 - T0))s)"
grep -q "Only the assigned operations reviewer" "$SCRATCH/5b-accept.out" \
  || fail "direction 5b: B's late acceptance must be refused, got: $(tr '\n' ' ' <"$SCRATCH/5b-accept.out")"
[ "$(scalar "select status || '/' || operations_reviewer from public.order_pi_versions where id = '$V6'")" = "admin_approved/$A" ] \
  || fail "direction 5b: V2 must still await operations, now addressed to A"
[ "$(scalar "select count(*) from public.order_activity_log where order_id = '$O6' and event_type = 'pi_revision_applied'")" = "0" ] \
  || fail "direction 5b: nothing may be applied"
echo "   OK: B's acceptance waited $((T1 - T0))s for the switch, then was refused; V2 still staged, now for A; nothing applied"


# ── Direction 6 (20270101000000): TWO DECISIONS ON THE SAME V2 AT ONCE ──
# Two admin tabs approving, and one reviewer's two tabs (or a double click)
# deciding. The first session is parked INSIDE its own version write, holding
# every lock it takes; the second must wait for it and then be refused on the
# state the first left — never apply twice, never decide both ways.
decide_revision() {
  local V="$1" WHO="$2" DECISION="$3" PAUSE="$4"
  Q -t -A <<SQL
begin;
set local statement_timeout = '30s';
set local race.pause = '$PAUSE';
set local role authenticated;
$(as_user "$WHO")
select public.decide_order_pi_revision_operations('$V', '$DECISION', 'ASSERT RACE $DECISION') is not null;
commit;
SQL
}
# An Order with V1 in force and V2 staged for reviewer B, reconciled so it can
# be accepted. Prints "<order id> <V2 id>".
staged_for_b() {
  local PI="$1" CLIENT="$2" O P
  read -r O P <<<"$(prepare_v2 "$PI" "$CLIENT" | tail -1)"
  approve_revision "$O" "$PI" "$P" 0 >/dev/null
  assign_bounded "'$B'" >/dev/null
  reconcile_to_v2 "$O"
  echo "$O $(scalar "select id from public.order_pi_versions where order_id = '$O' and version_number = 2")"
}
versions_of() { scalar "select string_agg(version_number || '/' || status, ',' order by version_number) from public.order_pi_versions where order_id = '$1'"; }
applied_count() { scalar "select count(*) from public.order_activity_log where order_id = '$1' and event_type = 'pi_revision_applied'"; }

# 6a. Two admin approvals of one pending V2: exactly one stages it.
PI7=$(scalar "select gen_random_uuid()")
read -r O7 PATH7 <<<"$(prepare_v2 "$PI7" "ASSERT RACE 6a $RUN" | tail -1)"
echo "== direction 6a: two admin approvals of the same pending V2"
approve_revision "$O7" "$PI7" "$PATH7" 3 >"$SCRATCH/6a-first.out" 2>&1 &
FIRST_PID=$!
wait_until_parked "approve_order_pi_revision"
SECOND_RC=0; approve_revision "$O7" "$PI7" "$PATH7" 0 >"$SCRATCH/6a-second.out" 2>&1 || SECOND_RC=$?
FIRST_RC=0; wait $FIRST_PID || FIRST_RC=$?
grep -qi deadlock "$SCRATCH/6a-first.out" "$SCRATCH/6a-second.out" && fail "direction 6a: DEADLOCK"
[ "$FIRST_RC" = "0" ] || fail "direction 6a: the first approval did not complete: $(tr '\n' ' ' <"$SCRATCH/6a-first.out")"
[ "$SECOND_RC" != "0" ] || fail "direction 6a: the second approval must be refused"
grep -qE "ORDER_SUBMISSION_PROCESSING|ORDER_PI_REVISION_NOT_PENDING|already being processed|lease" "$SCRATCH/6a-second.out" \
  || fail "direction 6a: the second approval must be refused by the lease or as no longer pending, got: $(tr '\n' ' ' <"$SCRATCH/6a-second.out")"
[ "$(versions_of "$O7")" = "1/approved,2/admin_approved" ] || fail "direction 6a: V2 staged once, V1 in force; got $(versions_of "$O7")"
[ "$(scalar "select count(*) from public.order_pi_revision_staged_parses s join public.order_pi_versions v on v.id = s.version_id where v.order_id = '$O7'")" = "1" ] \
  || fail "direction 6a: exactly one staged parse"
[ "$(scalar "select count(*) from public.order_activity_log where order_id = '$O7' and event_type = 'pi_revision_admin_approved'")" = "1" ] \
  || fail "direction 6a: one admin approval on the history"
echo "   OK: the second approval was refused ($(grep -oE 'ORDER_[A-Z_]+' "$SCRATCH/6a-second.out" | head -1)); V2 staged once; V1 in force"

# 6b. Accept (parked mid-apply) vs reject from the reviewer's other tab.
PI8=$(scalar "select gen_random_uuid()")
read -r O8 V8 <<<"$(staged_for_b "$PI8" "ASSERT RACE 6b $RUN")"
echo "== direction 6b: B accepts V2 (parked mid-apply) … B's other tab rejects it meanwhile"
decide_revision "$V8" "$B" accepted 3 >"$SCRATCH/6b-accept.out" 2>&1 &
FIRST_PID=$!
wait_until_parked "decide_order_pi_revision_operations"
SECOND_RC=0; decide_revision "$V8" "$B" rejected 0 >"$SCRATCH/6b-reject.out" 2>&1 || SECOND_RC=$?
FIRST_RC=0; wait $FIRST_PID || FIRST_RC=$?
grep -qi deadlock "$SCRATCH/6b-accept.out" "$SCRATCH/6b-reject.out" && fail "direction 6b: DEADLOCK"
[ "$FIRST_RC" = "0" ] || fail "direction 6b: the acceptance did not complete: $(tr '\n' ' ' <"$SCRATCH/6b-accept.out")"
grep -q "ORDER_PI_REVISION_NOT_AWAITING_OPERATIONS" "$SCRATCH/6b-reject.out" \
  || fail "direction 6b: the late rejection must be refused, got: $(tr '\n' ' ' <"$SCRATCH/6b-reject.out")"
[ "$(versions_of "$O8")" = "1/superseded,2/approved" ] && [ "$(applied_count "$O8")" = "1" ] \
  || fail "direction 6b: V2 in force, applied once; got $(versions_of "$O8") / $(applied_count "$O8")"
[ "$(scalar "select count(*) from public.order_activity_log where order_id = '$O8' and event_type = 'pi_revision_operations_rejected'")" = "0" ] \
  || fail "direction 6b: no rejection may be recorded"
echo "   OK: the rejection waited, then was refused; V2 applied once"

# 6c. Reject (parked) vs accept from the other tab: V1 stays in force.
PI9=$(scalar "select gen_random_uuid()")
read -r O9 V9 <<<"$(staged_for_b "$PI9" "ASSERT RACE 6c $RUN")"
LINES9=$(scalar "select string_agg(product_name || 'x' || quantity::int, ',') from public.order_submission_items where submission_id = '$PI9'")
echo "== direction 6c: B rejects V2 (parked) … B's other tab accepts it meanwhile"
decide_revision "$V9" "$B" rejected 3 >"$SCRATCH/6c-reject.out" 2>&1 &
FIRST_PID=$!
wait_until_parked "decide_order_pi_revision_operations"
SECOND_RC=0; decide_revision "$V9" "$B" accepted 0 >"$SCRATCH/6c-accept.out" 2>&1 || SECOND_RC=$?
FIRST_RC=0; wait $FIRST_PID || FIRST_RC=$?
grep -qi deadlock "$SCRATCH/6c-reject.out" "$SCRATCH/6c-accept.out" && fail "direction 6c: DEADLOCK"
[ "$FIRST_RC" = "0" ] || fail "direction 6c: the rejection did not complete: $(tr '\n' ' ' <"$SCRATCH/6c-reject.out")"
grep -q "ORDER_PI_REVISION_NOT_AWAITING_OPERATIONS" "$SCRATCH/6c-accept.out" \
  || fail "direction 6c: the late acceptance must be refused, got: $(tr '\n' ' ' <"$SCRATCH/6c-accept.out")"
[ "$(versions_of "$O9")" = "1/approved,2/rejected" ] && [ "$(applied_count "$O9")" = "0" ] \
  || fail "direction 6c: V1 in force, nothing applied; got $(versions_of "$O9") / $(applied_count "$O9")"
[ "$(scalar "select string_agg(product_name || 'x' || quantity::int, ',') from public.order_submission_items where submission_id = '$PI9'")" = "$LINES9" ] \
  || fail "direction 6c: V1's lines must be untouched"
echo "   OK: the acceptance waited, then was refused; V2 rejected; V1 and its lines untouched"

# 6d. Two acceptances (double click / two tabs): applied exactly once.
PI10=$(scalar "select gen_random_uuid()")
read -r O10 V10 <<<"$(staged_for_b "$PI10" "ASSERT RACE 6d $RUN")"
echo "== direction 6d: B accepts V2 twice at once"
decide_revision "$V10" "$B" accepted 3 >"$SCRATCH/6d-first.out" 2>&1 &
FIRST_PID=$!
wait_until_parked "decide_order_pi_revision_operations"
SECOND_RC=0; decide_revision "$V10" "$B" accepted 0 >"$SCRATCH/6d-second.out" 2>&1 || SECOND_RC=$?
FIRST_RC=0; wait $FIRST_PID || FIRST_RC=$?
grep -qi deadlock "$SCRATCH/6d-first.out" "$SCRATCH/6d-second.out" && fail "direction 6d: DEADLOCK"
[ "$FIRST_RC" = "0" ] || fail "direction 6d: the first acceptance did not complete"
grep -q "ORDER_PI_REVISION_NOT_AWAITING_OPERATIONS" "$SCRATCH/6d-second.out" \
  || fail "direction 6d: the second acceptance must be refused, got: $(tr '\n' ' ' <"$SCRATCH/6d-second.out")"
[ "$(versions_of "$O10")" = "1/superseded,2/approved" ] && [ "$(applied_count "$O10")" = "1" ] \
  || fail "direction 6d: applied exactly once; got $(versions_of "$O10") / $(applied_count "$O10")"
[ "$(scalar "select count(*) from public.order_operations_handoffs where order_id = '$O10' and version_number = 2")" = "1" ] \
  || fail "direction 6d: one V2 handoff"
echo "   OK: the second acceptance waited, then was refused; applied once, one V2 handoff"

echo "ALL RACE ASSERTIONS PASSED"
