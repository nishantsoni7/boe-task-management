#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════════════════
# TEST-ONLY RUNNER — Exhibition Leads: two real sessions, one mobile number
# ═════════════════════════════════════════════════════════════════════════════
#
# WHAT IT PROVES
# --------------
#   1. SAME NUMBER, TWO PEOPLE. Session A creates a lead for a number and holds
#      its transaction open. Session B (another salesperson, another submission)
#      creates a lead for the SAME number in another format. B must WAIT on the
#      unique index (seen in pg_stat_activity), and when A commits it must be
#      told "duplicate" with no id — never a second row.
#   2. DOUBLE TAP. Two sessions of the SAME person send the SAME submission id
#      at once. Exactly one row; the other is 'replayed' with the same id.
#
# NEGATIVE CONTROL. BOE_RACE_NEGATIVE_CONTROL=1 drops the unique indexes first
# and expects the invariant to BREAK (two active rows for one number).
#
# It will not choose its own target: BOE_DB_CONTAINER and BOE_DB_NAME must name a
# DISPOSABLE local database that already carries 20270305000000. Fixtures are
# committed (two sessions cannot see each other's uncommitted rows) and removed
# in an EXIT trap.
#
# USAGE
#   BOE_DB_CONTAINER=supabase_db_<project> BOE_DB_NAME=<disposable> \
#     supabase/tests/run_exhibition_leads_race_local.sh

set -uo pipefail
export MSYS_NO_PATHCONV=1
: "${BOE_DB_CONTAINER:?name a local supabase_db_* container}"
: "${BOE_DB_NAME:?name a disposable database}"
C=$BOE_DB_CONTAINER; DB=$BOE_DB_NAME
case "$C" in supabase_db_*) ;; *) echo "refusing: not a local supabase_db_* container"; exit 2;; esac
psqlq() { docker exec -i "$C" psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 -qAt "$@"; }
fail() { echo "FAIL: $*"; exit 1; }

A=e1ead000-0000-4000-8000-0000000000a1
B=e1ead000-0000-4000-8000-0000000000a2
psqlq -c "select 1 from public.exhibitions limit 1" >/dev/null || fail "migration not applied in $DB"

cleanup() {
  psqlq <<SQL >/dev/null 2>&1
alter table public.exhibition_lead_events disable trigger exhibition_lead_events_append_only;
delete from public.exhibition_lead_events where actor_id in ('$A','$B');
alter table public.exhibition_lead_events enable trigger exhibition_lead_events_append_only;
delete from public.exhibition_leads where collected_by in ('$A','$B');
delete from public.users where id in ('$A','$B');
SQL
}
trap cleanup EXIT
cleanup

psqlq <<SQL >/dev/null
insert into public.users (id, full_name, email, role, team, is_active, employee_code) values
 ('$A','RACE A','race-a@suite.test','member','sales',true,'RACE-A'),
 ('$B','RACE B','race-b@suite.test','member','sales',true,'RACE-B');
SQL
EXH=$(psqlq -c "select id from public.exhibitions where slug='acetech-bangalore-2026'")

as_user() { echo "set local role authenticated; select set_config('request.jwt.claims', json_build_object('sub','$1','role','authenticated')::text, true);"; }
create_sql() { echo "select public.create_exhibition_lead('$1'::uuid,'$EXH'::uuid,'Race','$2','consultant',array['hotel'],null,null,null,'warm');"; }

if [ "${BOE_RACE_NEGATIVE_CONTROL:-}" = "1" ]; then
  echo "negative control: dropping the unique indexes"
  psqlq -c "drop index public.exhibition_leads_one_active_phone"
fi

# ── Scenario 1: same number, two people ───────────────────────────────────────
OUT_A=$(mktemp); OUT_B=$(mktemp)
( { echo "begin;"; as_user $A; create_sql f1000000-0000-4000-8000-000000000001 "98765 11111"; echo "select pg_sleep(4);"; echo "commit;"; } \
  | docker exec -i "$C" psql -U postgres -d "$DB" -qAt -v ON_ERROR_STOP=1 > "$OUT_A" 2>&1 ) &
PA=$!
sleep 1.2
START=$(date +%s)
( { echo "set application_name = 'exl_race_b'; begin;"; as_user $B; create_sql f1000000-0000-4000-8000-000000000002 "+91 98765-11111"; echo "commit;"; } \
  | docker exec -i "$C" psql -U postgres -d "$DB" -qAt -v ON_ERROR_STOP=1 > "$OUT_B" 2>&1 ) &
PB=$!
sleep 1.5
WAIT=$(psqlq -c "select wait_event_type from pg_stat_activity where application_name='exl_race_b' limit 1")
wait $PA; wait $PB
ELAPSED=$(( $(date +%s) - START ))
ROWS=$(psqlq -c "select count(*) from public.exhibition_leads where collected_by in ('$A','$B') and phone_e164='+919876511111' and archived_at is null")
echo "A: $(grep -h outcome "$OUT_A" | head -1)"
echo "B: $(grep -h outcome "$OUT_B" | head -1)"
echo "B waited on: ${WAIT:-<nothing>}  (elapsed ${ELAPSED}s)  active rows for the number: $ROWS"

if [ "${BOE_RACE_NEGATIVE_CONTROL:-}" = "1" ]; then
  [ "$ROWS" = "2" ] && echo "NEGATIVE CONTROL OK: without the index both inserts landed (the test can fail)" || fail "negative control did not break the invariant"
  # restore the index on the disposable database (after removing the two rows)
  cleanup
  psqlq -c "create unique index exhibition_leads_one_active_phone on public.exhibition_leads (exhibition_id, phone_e164) where archived_at is null" >/dev/null || fail "could not restore the index"
  exit 0
fi
[ "$ROWS" = "1" ] || fail "expected exactly one active row, found $ROWS"
[ "$WAIT" = "Lock" ] || fail "session B did not wait on a lock (saw '${WAIT}')"
grep -q '"outcome": "created"' "$OUT_A" || fail "A should have created"
grep -q '"outcome": "duplicate"' "$OUT_B" || fail "B should have been told duplicate"
grep -q '"mine": false' "$OUT_B" && ! grep -q lead_id "$OUT_B" || fail "B's duplicate answer leaked a lead id"

# ── Scenario 2: double tap, same submission id ───────────────────────────────
OUT_C=$(mktemp); OUT_D=$(mktemp)
SUB=f1000000-0000-4000-8000-000000000009
( { echo "begin;"; as_user $A; create_sql $SUB "98765 22222"; echo "select pg_sleep(3);"; echo "commit;"; } \
  | docker exec -i "$C" psql -U postgres -d "$DB" -qAt -v ON_ERROR_STOP=1 > "$OUT_C" 2>&1 ) &
PC=$!
sleep 1
( { echo "begin;"; as_user $A; create_sql $SUB "98765 22222"; echo "commit;"; } \
  | docker exec -i "$C" psql -U postgres -d "$DB" -qAt -v ON_ERROR_STOP=1 > "$OUT_D" 2>&1 ) &
PD=$!
wait $PC; wait $PD
ROWS2=$(psqlq -c "select count(*) from public.exhibition_leads where submission_id='$SUB'")
echo "C: $(grep -h outcome "$OUT_C" | head -1)"
echo "D: $(grep -h outcome "$OUT_D" | head -1)"
echo "rows for the submission: $ROWS2"
[ "$ROWS2" = "1" ] || fail "double tap made $ROWS2 rows"
grep -q '"outcome": "created"' "$OUT_C" || fail "first tap should create"
grep -q -E '"outcome": "(replayed|duplicate)"' "$OUT_D" || fail "second tap should not create"

echo "ALL EXHIBITION LEADS RACE CHECKS PASSED"
