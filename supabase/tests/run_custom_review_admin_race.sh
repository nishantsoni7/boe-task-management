#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════════════════
# TEST-ONLY — two-session races for an administrator's reject / delete of a custom review
# ═════════════════════════════════════════════════════════════════════════════
#
# Run AFTER run_custom_review_edit_delete_local.sh (which applies 20270304000000), on the same
# disposable container. It COMMITS its fixtures, so it refuses a container that is not marked
# disposable or that already holds users. It is separate from run_custom_review_edit_delete_race.sh:
# build a fresh container for each of the two.
#
#   R6  admin reject vs admin reject : two administrators click at once; one reversal, the other answers
#                           already_decided, one 'rejected' event, the first reason stands.
#   R7  admin reject vs owner delete : the delete waits for the rejection, then deletes the (already
#                           rejected) review; the credit is reversed once.
#   R8  admin delete vs admin delete : one reversal, the other answers already_deleted, one history row.
#
# Ordering is forced with a held transaction (pg_sleep inside the first session) and the second session
# is confirmed to be WAITING through pg_stat_activity, not assumed.
#
# USAGE  BOE_DB_CONTAINER=boe-custom-review-pg supabase/tests/run_custom_review_admin_race.sh

set -euo pipefail
C="${BOE_DB_CONTAINER:?set BOE_DB_CONTAINER}"
OUT="$(mktemp -d)"
q()   { docker exec -i "$C" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q -t -A -c "$1"; }
qf()  { docker exec -i "$C" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q -t -A; }
run() { docker exec -i "$C" psql -U postgres -d postgres -q -t -A -c "$1"; }

[ "$(q "select coalesce(shobj_description(oid, 'pg_database'), '') from pg_database where datname = current_database()")" = "boe-disposable-boe-credits" ] \
  || { echo "FATAL: $C is not marked disposable" >&2; exit 1; }
[ "$(q "select count(*) from public.users")" = "0" ] || { echo "FATAL: public.users is not empty" >&2; exit 1; }

ADM=a0000000-0000-4000-8000-00000000000a
VER=b0000000-0000-4000-8000-00000000000b
E1=e1000000-0000-4000-8000-0000000000e1

qf >/dev/null <<SQL
insert into public.users (id, full_name, email, role, team, is_active, is_deleted, employee_code) values
  ('$ADM', 'Test Admin', 'admin@example.test', 'admin', 'management', true, false, 'T-ADM'),
  ('$VER', 'Test Verifier', 'ver@example.test', 'member', 'reviews', true, false, 'T-VER'),
  ('$E1', 'Test One', 'e1@example.test', 'member', 'sales', true, false, 'T-001');
insert into public.test_permission_grants (user_id, module_key, action_key) values
  ('$ADM','customer_review_requests','use'),('$ADM','customer_review_requests','verify'),
  ('$VER','customer_review_requests','use'),('$VER','customer_review_requests','verify'),
  ('$E1','customer_review_requests','use');
SQL

new_approved() { # $1 = id
  qf >/dev/null <<SQL
select public.create_customer_review_custom_submission('$1', '$E1', 'text', (now() at time zone 'Asia/Kolkata')::date, null,
  '$1/proof/a.png', 'a.png', 'image/png', 100, md5('$1') || md5('$1x'));
select set_config('request.jwt.claims', json_build_object('sub', '$VER', 'role', 'authenticated')::text, false);
select public.approve_customer_review_custom_submission('$1', 1);
SQL
}
asadm() { echo "select set_config('request.jwt.claims', json_build_object('sub', '$ADM', 'role', 'authenticated')::text, true); set local role authenticated;"; }
rev_of()    { q "select count(*) from public.boe_credit_transactions where transaction_type = 'reversal' and source_id in (select transaction_id from public.boe_credit_review_rewards where card_id = '$1')"; }
events_of() { q "select count(*) from public.customer_review_custom_submission_events where submission_id = '$1' and event_type = '$2'"; }
has()       { grep -q "$1" "$OUT/$2" "$OUT/$3"; }

wait_blocked() {
  for _ in $(seq 1 100); do
    [ "$(q "select count(*) from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'")" -ge 1 ] && return 0
    sleep 0.1
  done
  echo "FATAL: the second session never blocked" >&2; return 1
}

R6=f1100000-0000-4000-8000-000000000061
new_approved "$R6"
run "begin; $(asadm) select public.admin_reject_customer_review_custom_submission('$R6', 'first'); select pg_sleep(4); commit;" > "$OUT/6a" 2>&1 &
sleep 1.5
run "begin; $(asadm) select public.admin_reject_customer_review_custom_submission('$R6', 'second'); commit;" > "$OUT/6b" 2>&1 &
wait_blocked; wait
[ "$(rev_of "$R6")" = "1" ] || { echo "FAIL R6: reversals = $(rev_of "$R6")" >&2; exit 1; }
[ "$(events_of "$R6" rejected)" = "1" ] || { echo "FAIL R6: rejected events = $(events_of "$R6" rejected)" >&2; exit 1; }
has '"already_decided": true' 6a 6b || { echo "FAIL R6: neither call answered already_decided" >&2; cat "$OUT/6a" "$OUT/6b" >&2; exit 1; }
[ "$(q "select rejection_reason from public.customer_review_custom_submissions where id = '$R6'")" = "first" ] || { echo "FAIL R6: the first reason must stand" >&2; exit 1; }
echo "PASS  R6 two administrators rejecting at once: one reversal, one history row, the first reason stands"

R7=f1100000-0000-4000-8000-000000000071
new_approved "$R7"
run "begin; $(asadm) select public.admin_reject_customer_review_custom_submission('$R7', 'removed'); select pg_sleep(4); commit;" > "$OUT/7a" 2>&1 &
sleep 1.5
run "select public.delete_customer_review_custom_submission('$R7', '$E1')" > "$OUT/7b" 2>&1 &
wait_blocked; wait
[ "$(rev_of "$R7")" = "1" ] || { echo "FAIL R7: reversals = $(rev_of "$R7")" >&2; exit 1; }
[ "$(q "select status || '|' || (deleted_at is not null)::text from public.customer_review_custom_submissions where id = '$R7'")" = "rejected|true" ] \
  || { echo "FAIL R7: expected rejected and deleted" >&2; cat "$OUT/7a" "$OUT/7b" >&2; exit 1; }
echo "PASS  R7 an administrator rejection racing the owner delete: rejected, then deleted, credit reversed once"

R8=f1100000-0000-4000-8000-000000000081
new_approved "$R8"
run "begin; $(asadm) select public.admin_delete_customer_review_custom_submission('$R8'); select pg_sleep(4); commit;" > "$OUT/8a" 2>&1 &
sleep 1.5
run "begin; $(asadm) select public.admin_delete_customer_review_custom_submission('$R8'); commit;" > "$OUT/8b" 2>&1 &
wait_blocked; wait
[ "$(rev_of "$R8")" = "1" ] || { echo "FAIL R8: reversals = $(rev_of "$R8")" >&2; exit 1; }
[ "$(events_of "$R8" deleted)" = "1" ] || { echo "FAIL R8: deleted events = $(events_of "$R8" deleted)" >&2; exit 1; }
has '"already_deleted": true' 8a 8b || { echo "FAIL R8: neither call answered already_deleted" >&2; exit 1; }
echo "PASS  R8 two administrators deleting at once: one reversal, one history row"

echo
echo "OK: admin races held. This container now holds committed fixtures - drop it: docker rm -f $C"
