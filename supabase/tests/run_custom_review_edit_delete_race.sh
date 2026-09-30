#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════════════════
# TEST-ONLY — two-session races for edit / delete of a custom review
# ═════════════════════════════════════════════════════════════════════════════
#
# Run AFTER run_custom_review_edit_delete_local.sh, on the same disposable
# container (the assertions roll back; the migrations stay). This script COMMITS
# its fixtures, so it refuses a container that is not marked disposable or that
# already holds users.
#
# It proves, with two real connections:
#   R1  delete vs delete  : both run at once; one reverses the credit, the other
#                           answers already_deleted; exactly ONE reversal row.
#   R2  delete vs edit    : an edit that starts while a delete holds the row waits,
#                           then finds the review deleted and is refused; the
#                           credit is reversed once.
#   R3  re-approve vs delete : approving an edited review while the employee deletes
#                           it leaves either "approved, credit kept, then deleted &
#                           reversed" — never a second reward and never a reversal
#                           without a reward.
#
# Ordering is forced with a held transaction (pg_sleep inside the first session)
# and confirmed through pg_stat_activity, not with a blind sleep before the check.
#
# USAGE  BOE_DB_CONTAINER=boe-reviews-v2-pg supabase/tests/run_custom_review_edit_delete_race.sh

set -euo pipefail
C="${BOE_DB_CONTAINER:?set BOE_DB_CONTAINER}"
q()  { docker exec -i "$C" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q -t -A -c "$1"; }
qf() { docker exec -i "$C" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q -t -A; }

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
reversals() { q "select count(*) from public.boe_credit_transactions where employee_id = '$E1' and transaction_type = 'reversal'"; }
rewards()   { q "select count(*) from public.boe_credit_transactions where employee_id = '$E1' and transaction_type = 'review_reward'"; }

wait_blocked() { # a second connection is waiting on a lock
  for _ in $(seq 1 100); do
    [ "$(q "select count(*) from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'")" -ge 1 ] && return 0
    sleep 0.1
  done
  echo "FATAL: the second session never blocked" >&2; return 1
}

# ── R1 delete vs delete ──────────────────────────────────────────────────────
R1=f1100000-0000-4000-8000-000000000001
new_approved "$R1"
docker exec -i "$C" psql -U postgres -d postgres -q -t -A -c "begin; select public.delete_customer_review_custom_submission('$R1', '$E1'); select pg_sleep(2); commit;" > /tmp/r1a.out 2>&1 &
sleep 0.5
docker exec -i "$C" psql -U postgres -d postgres -q -t -A -c "select public.delete_customer_review_custom_submission('$R1', '$E1')" > /tmp/r1b.out 2>&1 &
wait_blocked
wait
[ "$(reversals)" = "1" ] || { echo "FAIL R1: reversals = $(reversals)" >&2; exit 1; }
grep -q '"already_deleted": true' /tmp/r1a.out /tmp/r1b.out || grep -q '"already_deleted":true' /tmp/r1a.out /tmp/r1b.out \
  || { echo "FAIL R1: neither call answered already_deleted" >&2; cat /tmp/r1a.out /tmp/r1b.out >&2; exit 1; }
echo "PASS  R1 two concurrent deletes: one reversal, the other answered already_deleted"

# ── R2 delete vs edit ────────────────────────────────────────────────────────
R2=f1100000-0000-4000-8000-000000000002
new_approved "$R2"
docker exec -i "$C" psql -U postgres -d postgres -q -t -A -c "begin; select public.delete_customer_review_custom_submission('$R2', '$E1'); select pg_sleep(2); commit;" > /tmp/r2a.out 2>&1 &
sleep 0.5
docker exec -i "$C" psql -U postgres -d postgres -q -t -A -c "select public.edit_customer_review_custom_submission('$R2', '$E1', 'text', (now() at time zone 'Asia/Kolkata')::date, 'late edit', 0, null, null, null, null, null)" > /tmp/r2b.out 2>&1 &
wait_blocked
wait
grep -q "CUSTOMER_REVIEW_CUSTOM_NOT_FOUND" /tmp/r2b.out || { echo "FAIL R2: the edit was not refused as not found" >&2; cat /tmp/r2b.out >&2; exit 1; }
[ "$(reversals)" = "2" ] || { echo "FAIL R2: reversals = $(reversals) (expected 2 in total)" >&2; exit 1; }
echo "PASS  R2 an edit racing a delete waits, then is refused; the credit is reversed once"

# ── R3 re-approve vs delete ──────────────────────────────────────────────────
R3=f1100000-0000-4000-8000-000000000003
new_approved "$R3"
q "select public.edit_customer_review_custom_submission('$R3', '$E1', 'text', (now() at time zone 'Asia/Kolkata')::date, 'edited', 0, null, null, null, null, null)" >/dev/null
docker exec -i "$C" psql -U postgres -d postgres -q -t -A -c "begin; select set_config('request.jwt.claims', json_build_object('sub', '$VER', 'role', 'authenticated')::text, true); set local role authenticated; select public.approve_customer_review_custom_submission('$R3', 1); select pg_sleep(2); commit;" > /tmp/r3a.out 2>&1 &
sleep 0.5
docker exec -i "$C" psql -U postgres -d postgres -q -t -A -c "select public.delete_customer_review_custom_submission('$R3', '$E1')" > /tmp/r3b.out 2>&1 &
wait_blocked
wait
[ "$(rewards)" = "3" ] || { echo "FAIL R3: rewards = $(rewards) (expected 3: one per review)" >&2; exit 1; }
[ "$(reversals)" = "3" ] || { echo "FAIL R3: reversals = $(reversals) (expected 3)" >&2; exit 1; }
[ "$(q "select coalesce(sum(credits),0) from public.boe_credit_transactions where employee_id = '$E1'")" = "0.00" ] \
  || { echo "FAIL R3: the balance is not zero" >&2; exit 1; }
echo "PASS  R3 a re-approval racing a delete never pays twice and never reverses without a reward"

echo
echo "OK: races held. This container now holds committed fixtures — drop it: docker rm -f $C"
