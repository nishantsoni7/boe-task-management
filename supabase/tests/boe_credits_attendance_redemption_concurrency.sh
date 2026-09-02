#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════════════════
# CONCURRENCY PROOFS — BOE Credits Phase 1C, two real sessions at a time
# ═════════════════════════════════════════════════════════════════════════════
#
# A single psql script cannot race itself, so these run two `docker exec psql`
# sessions against the schema the runner just built. Session A opens a
# transaction, does its write, sleeps, commits; session B starts one second
# later and must WAIT on the per-employee advisory lock, then be answered by
# the committed state.
#
#   1. DOUBLE-SPEND: balance 2, two 2-credit redemptions of different days at
#      once → one succeeds, the other is refused INSUFFICIENT; balance is 0,
#      never negative.
#   2. SAME DAY: two redemptions of one day at once → one active record, one
#      ledger row; the other refused as a duplicate.
#   3. REVERSAL vs REDEMPTION: A reverses the day's coverage (and sleeps), B
#      redeems the same day → B waits, then succeeds AFTER the reversal; at
#      the end exactly one active coverage exists and history holds both.
#
# It writes fixtures it cannot remove (the ledger is append-only), so run it
# LAST on the disposable container and drop the container afterwards.
#
# USAGE (after run_boe_credits_attendance_redemption_local.sh):
#   BOE_DB_CONTAINER=boe-credits-pg supabase/tests/boe_credits_attendance_redemption_concurrency.sh

set -euo pipefail

DB_CONTAINER="${BOE_DB_CONTAINER:?set BOE_DB_CONTAINER to the throwaway PostgreSQL container}"
DB_NAME="${BOE_DB_NAME:-postgres}"
MARKER="boe-disposable-boe-credits"

q()  { docker exec -i "$DB_CONTAINER" psql -U postgres -d "$DB_NAME" -At -v ON_ERROR_STOP=1 -c "$1"; }
qq() { docker exec -i "$DB_CONTAINER" psql -U postgres -d "$DB_NAME" -At -c "$1" 2>&1 || true; }

found="$(q "select coalesce(shobj_description(oid, 'pg_database'), '') from pg_database where datname = current_database()")"
[ "$found" = "$MARKER" ] || { echo "FATAL: $DB_CONTAINER is not marked '$MARKER'. Nothing was written." >&2; exit 1; }
[ "$(q "select count(*) from public.users")" = 0 ] || { echo "FATAL: public.users is not empty — run this once, on a fresh build." >&2; exit 1; }

ADMIN='c0000000-0000-4000-8000-00000000000c'
EMP='c1000000-0000-4000-8000-0000000000c1'
PERIOD='93000000-0000-4000-8000-000000000093'

q "insert into public.users (id, full_name, email, role, team, is_active, is_deleted, employee_code) values
     ('$ADMIN', 'Race Admin', 'race-admin@example.test', 'admin', 'management', true, false, 'R-ADM'),
     ('$EMP',   'Race Employee', 'race@example.test',    'member', 'sales',     true, false, 'R-001');
   insert into public.payroll_periods (id, payroll_month, payroll_year, status) values ('$PERIOD', 8, 2026, 'generated');
   insert into public.payroll_results (payroll_period_id, employee_id, monthly_salary) values ('$PERIOD', '$EMP', 20000);" >/dev/null

redeem() { # $1 date, $2 kind
  echo "select public.redeem_boe_credits_for_attendance('$EMP', '$PERIOD', date '$1', '$2', '$EMP')"
}
session_a() { # $1 sql — runs in a transaction that sleeps 3 s before commit
  docker exec -i "$DB_CONTAINER" psql -U postgres -d "$DB_NAME" -At -c "begin; $1; select pg_sleep(3); commit;" > "$2" 2>&1
}
fail=0
check() { # $1 label, $2 condition-as-sql-boolean
  if [ "$(q "select ($2)::text")" = "true" ]; then echo "PASS  $1"; else echo "FAIL  $1"; fail=1; fi
}

# ── 1. double-spend ──────────────────────────────────────────────────────────
q "select public.post_boe_credit_transaction('$EMP', 'admin_adjustment', 2, 'manual', null, 'Race fixture: two credits', '$ADMIN')" >/dev/null
session_a "$(redeem 2026-08-03 absent)" /tmp/boe_race_1a.txt &
sleep 1
B="$(qq "$(redeem 2026-08-04 absent)")"
wait
echo "   B: $(printf '%s' "$B" | head -1)"
printf '%s' "$B" | grep -q 'BOE_CREDITS_INSUFFICIENT' && echo "PASS  1. the second 2-credit redemption waited, then was refused INSUFFICIENT" || { echo "FAIL  1. B: $B"; fail=1; }
check "1. balance is exactly 0, never negative" "public.boe_credit_balance('$EMP') = 0"
check "1. exactly one redemption landed" "(select count(*) from public.boe_credit_attendance_redemptions where employee_id = '$EMP') = 1"

# ── 2. same day ──────────────────────────────────────────────────────────────
q "select public.post_boe_credit_transaction('$EMP', 'admin_adjustment', 4, 'manual', null, 'Race fixture: four credits', '$ADMIN')" >/dev/null
session_a "$(redeem 2026-08-05 half_day)" /tmp/boe_race_2a.txt &
sleep 1
B="$(qq "$(redeem 2026-08-05 half_day)")"
wait
echo "   B: $(printf '%s' "$B" | head -1)"
printf '%s' "$B" | grep -qE 'BOE_CREDITS_(ALREADY_COVERED|DUPLICATE_SOURCE)|boe_credit_attendance_redemptions_active_unique' \
  && echo "PASS  2. the second redemption of the same day was refused as a duplicate" || { echo "FAIL  2. B: $B"; fail=1; }
check "2. one active coverage for 05 Aug" "(select count(*) from public.boe_credit_attendance_redemptions where employee_id = '$EMP' and attendance_date = date '2026-08-05' and reversal_transaction_id is null) = 1"
check "2. one ledger row for 05 Aug" "(select count(*) from public.boe_credit_transactions t join public.boe_credit_attendance_redemptions r on r.id = t.source_id where r.attendance_date = date '2026-08-05') = 1"
check "2. balance 3 (4 - 1)" "public.boe_credit_balance('$EMP') = 3"

# ── 3. reversal vs redemption ────────────────────────────────────────────────
R="$(q "select id from public.boe_credit_attendance_redemptions where employee_id = '$EMP' and attendance_date = date '2026-08-05' and reversal_transaction_id is null")"
session_a "select public.reverse_boe_credit_attendance_redemption('$R', '$ADMIN', 'Race: attendance changed')" /tmp/boe_race_3a.txt &
sleep 1
start=$(date +%s)
B="$(qq "$(redeem 2026-08-05 half_day)")"
took=$(( $(date +%s) - start ))
wait
echo "   B took ${took}s: $(printf '%s' "$B" | head -1 | cut -c1-80)"
[ "$took" -ge 2 ] && echo "PASS  3. B waited on the per-employee lock while A reversed" || { echo "FAIL  3. B did not wait (${took}s)"; fail=1; }
printf '%s' "$B" | grep -q 'redemption_id' && echo "PASS  3. B's redemption succeeded AFTER the reversal committed" || { echo "FAIL  3. B: $B"; fail=1; }
check "3. exactly one active coverage for 05 Aug" "(select count(*) from public.boe_credit_attendance_redemptions where employee_id = '$EMP' and attendance_date = date '2026-08-05' and reversal_transaction_id is null) = 1"
check "3. history holds both records for 05 Aug" "(select count(*) from public.boe_credit_attendance_redemptions where employee_id = '$EMP' and attendance_date = date '2026-08-05') = 2"
check "3. the first record is closed by its own reversal" "exists (select 1 from public.boe_credit_attendance_redemptions r join public.boe_credit_transactions v on v.id = r.reversal_transaction_id where r.id = '$R' and v.transaction_type = 'reversal' and v.source_id = r.transaction_id)"
check "3. balance 3 (4 - 1 + 1 - 1)" "public.boe_credit_balance('$EMP') = 3"

echo
if [ $fail = 0 ]; then echo "OK: all concurrency proofs passed on $DB_CONTAINER/$DB_NAME (fixtures left behind — drop the container)."; else echo "FAIL: see above" >&2; exit 1; fi
