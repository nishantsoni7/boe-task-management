#!/usr/bin/env bash
# Prove 20261220000000 (the Finance review modal's clarification door) on a
# DISPOSABLE database:
#
#   1. build the Orders/Finance chain run_payment_idempotency_suite.sh builds —
#      the shaped schema plus the REAL 20261010000000 … 20261014000000, so the
#      reset write guard is the deployed one — then bring it to production's
#      shape for finance_payment_requests (grants, the four UPDATE policies, the
#      deployed activity trigger, production's function privileges) and apply
#      the REAL 20261211000000 (decision guard + rejection RPC);
#   2. REPRODUCE the defect on that stack (payment_request_review_before.sql):
#      the modal's direct UPDATE is refused by the reset guard;
#   3. apply the migration in one transaction — it runs its own assertions;
#   4. run payment_request_review_assertions.sql (one transaction, rolled back);
#   5. RACE: two committed sessions decide the same payment — one sends it back,
#      the other rejects it — and exactly one wins.
#
#   supabase/tests/run_payment_request_review_suite.sh <psql host or socket dir> [port]
#
# Creates and drops a database called boe_payment_request_review. Touches
# nothing else and never talks to a linked project.
set -euo pipefail
HOST="${1:?usage: run_payment_request_review_suite.sh <psql host or socket dir> [port]}"
PORT="${2:-5432}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DB=boe_payment_request_review
MIG="$REPO/supabase/migrations"
PENDING="$MIG/20261220000000_finance_payment_request_clarification_door.sql"
Q=(psql -h "$HOST" -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -q)

extract() { # <file> <function name> — a deployed body, verbatim
  awk -v fn="create or replace function public.$2(" '
    index(tolower($0), fn) == 1 { on = 1 }
    on { print }
    on && /^\$\$;/ { exit }
  ' "$1"
}
fail() { echo "FAIL: $*"; exit 1; }

"${Q[@]}" -d postgres -c "drop database if exists $DB" >/dev/null 2>&1
"${Q[@]}" -d postgres -c "create database $DB" >/dev/null
TMP="$(mktemp -d)"
cleanup() { rm -rf "$TMP"; "${Q[@]}" -d postgres -c "drop database if exists $DB" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "== chain: shaped schema + 20261010000000 … 20261014000000"
for f in \
  "$REPO/supabase/tests/_order_finance_reset_shaped_schema.sql" \
  "$MIG/20261010000000_order_submission_and_finance_test_data_reset.sql" \
  "$REPO/supabase/tests/_admin_payment_deletion_and_payment_id_extra_schema.sql" \
  "$MIG/20261011000000_admin_payment_deletion_and_payment_id.sql" \
  "$REPO/supabase/tests/_allocation_ledger_single_source_extra_schema.sql" \
  "$MIG/20261012000000_allocation_ledger_as_single_source.sql" \
  "$REPO/supabase/tests/_payment_entry_destination_model_extra_schema.sql" \
  "$MIG/20261013000000_payment_entry_destination_model.sql" \
  "$REPO/supabase/tests/_payment_custody_and_modes_extra_schema.sql" \
  "$MIG/20261014000000_payment_destination_display_modes_and_custody.sql" \
  "$REPO/supabase/tests/_payment_request_review_extra_schema.sql"
do
  "${Q[@]}" -d "$DB" -f "$f" >/dev/null 2>"$TMP/err" || { cat "$TMP/err"; fail "building $f"; }
done

echo "== deployed bodies: the approval marker and the Finance activity trigger"
{
  extract "$MIG/20260920000000_finance_approver_can_verify_payment.sql"  in_finance_payment_verification
  extract "$MIG/20260716000000_finance_payment_collection_handover.sql"  log_finance_payment_request_activity
  cat <<'SQL'
revoke execute on function public.in_finance_payment_verification(uuid) from public, anon, authenticated;
revoke execute on function public.log_finance_payment_request_activity() from public, anon, authenticated;
drop trigger if exists finance_payment_requests_log_activity on public.finance_payment_requests;
create trigger finance_payment_requests_log_activity
  after insert or update on public.finance_payment_requests
  for each row execute function public.log_finance_payment_request_activity();
SQL
} > "$TMP/deployed.sql"
for fn in in_finance_payment_verification log_finance_payment_request_activity; do
  grep -qi "function public.$fn(" "$TMP/deployed.sql" || fail "could not extract $fn"
done
"${Q[@]}" -d "$DB" -f "$TMP/deployed.sql" >/dev/null 2>"$TMP/err" || { cat "$TMP/err"; fail "installing deployed bodies"; }

echo "== apply 20261211000000 (the deployed decision guard and rejection RPC)"
"${Q[@]}" -d "$DB" -1 -f "$MIG/20261211000000_finance_payment_decisions_belong_to_verifiers.sql" >"$TMP/apply" 2>&1 \
  || { cat "$TMP/apply"; fail "20261211000000 did not apply"; }
grep -o '20261211000000 applied: .*' "$TMP/apply" | sed 's/^/   /'

echo "== committed fixture"
"${Q[@]}" -d "$DB" >/dev/null <<'SEED'
insert into public.users (id, email, role, full_name, is_active, is_deleted) values
  ('d0000000-0000-4000-8000-00000000000a', 'admin@boe.test',     'admin',  'Admin',              true, false),
  ('d0000000-0000-4000-8000-000000000001', 'submitter@boe.test', 'member', 'Submitter',          true, false),
  ('d0000000-0000-4000-8000-000000000003', 'verifier@boe.test',  'member', 'Verifier',           true, false),
  ('d0000000-0000-4000-8000-000000000005', 'viewer@boe.test',    'member', 'Viewer',             true, false),
  ('d0000000-0000-4000-8000-000000000007', 'both@boe.test',      'member', 'Submitter+Verifier', true, false);
insert into public.finance_permission_grants (user_id, action) values
  ('d0000000-0000-4000-8000-000000000001', 'finance.view'),
  ('d0000000-0000-4000-8000-000000000001', 'finance.create'),
  ('d0000000-0000-4000-8000-000000000003', 'finance.view'),
  ('d0000000-0000-4000-8000-000000000003', 'finance.view_all'),
  ('d0000000-0000-4000-8000-000000000003', 'finance.approve'),
  ('d0000000-0000-4000-8000-000000000005', 'finance.view'),
  ('d0000000-0000-4000-8000-000000000005', 'finance.view_all'),
  ('d0000000-0000-4000-8000-000000000007', 'finance.view'),
  ('d0000000-0000-4000-8000-000000000007', 'finance.view_all'),
  ('d0000000-0000-4000-8000-000000000007', 'finance.approve'),
  ('d0000000-0000-4000-8000-000000000007', 'finance.create');
insert into public.orders (id, display_number, status, client_name) values
  ('a0000000-0000-4000-8000-00000000000a', '0701', 'confirmed', 'Kalyan Interiors');
insert into public.finance_payment_requests (id, request_number, client_name, amount, payment_mode, status, submitted_by) values
  ('e0000000-0000-4000-8000-000000000001', 'PR-0001', 'Kalyan Interiors', 1000, 'hdfc', 'pending_approval', 'd0000000-0000-4000-8000-000000000001'),
  ('e0000000-0000-4000-8000-000000000002', 'PR-0002', 'Kalyan Interiors', 2000, 'hdfc', 'pending_approval', 'd0000000-0000-4000-8000-000000000001'),
  ('e0000000-0000-4000-8000-000000000003', 'PR-0003', 'Kalyan Interiors', 3000, 'hdfc', 'pending_approval', 'd0000000-0000-4000-8000-000000000001'),
  ('e0000000-0000-4000-8000-000000000004', 'PR-0004', 'Kalyan Interiors', 4000, 'hdfc', 'pending_approval', 'd0000000-0000-4000-8000-000000000001'),
  ('e0000000-0000-4000-8000-000000000005', 'PR-0005', 'Kalyan Interiors', 5000, 'hdfc', 'pending_approval', 'd0000000-0000-4000-8000-000000000001'),
  ('e0000000-0000-4000-8000-000000000006', 'PR-0006', 'Kalyan Interiors', 6000, 'hdfc', 'pending_approval', 'd0000000-0000-4000-8000-000000000001'),
  ('e0000000-0000-4000-8000-000000000007', 'PR-0007', 'Kalyan Interiors', 7000, 'hdfc', 'pending_approval', 'd0000000-0000-4000-8000-000000000007'),
  ('e0000000-0000-4000-8000-00000000000a', 'PR-000A', 'Kalyan Interiors', 9000, 'hdfc', 'pending_approval', 'd0000000-0000-4000-8000-00000000000a');
SEED

echo "== BEFORE the migration: the defect must reproduce on the deployed guard"
BEFORE="$("${Q[@]}" -d "$DB" -f "$REPO/supabase/tests/payment_request_review_before.sql" 2>&1)" \
  || { echo "$BEFORE"; fail "the reproduction file errored"; }
printf '%s\n' "$BEFORE" | grep 'REPRODUCED' | sed 's/^.*NOTICE:  /   /'
[ "$(printf '%s\n' "$BEFORE" | grep -c 'REPRODUCED')" -eq 6 ] || fail "expected 6 REPRODUCED lines"

echo "== apply $(basename "$PENDING") (one transaction)"
"${Q[@]}" -d "$DB" -1 -f "$PENDING" >"$TMP/apply" 2>&1 || { cat "$TMP/apply"; fail "the migration did not apply"; }
grep -o '20261220000000 applied: .*' "$TMP/apply" | sed 's/^/   /'

echo "== re-apply (idempotent: create or replace, same grants)"
"${Q[@]}" -d "$DB" -1 -f "$PENDING" >"$TMP/apply" 2>&1 || { cat "$TMP/apply"; fail "the migration did not re-apply"; }
echo "   ok"

echo "== assertions"
AFTER="$("${Q[@]}" -d "$DB" -f "$REPO/supabase/tests/payment_request_review_assertions.sql" 2>&1)" \
  || { echo "$AFTER"; fail "assertions"; }
printf '%s\n' "$AFTER" | grep 'PASS' | sed 's/^.*NOTICE:  /   /'
[ "$(printf '%s\n' "$AFTER" | grep -c "PASS:")" -eq 14 ] || { echo "$AFTER"; fail "expected 14 PASS lines"; }

# ── The race: two real sessions, committed ───────────────────────────────────
as_verifier="set role authenticated; select set_config('request.jwt.claims', json_build_object('sub','d0000000-0000-4000-8000-000000000003','role','authenticated')::text, false);"
count() { "${Q[@]}" -d "$DB" -t -A -c "$1"; }

echo "== race: one verifier sends PR-0006 back while another rejects it"
"${Q[@]}" -d "$DB" -t -A >"$TMP/a" 2>&1 <<SQL &
$as_verifier
begin;
select public.request_finance_payment_clarification('e0000000-0000-4000-8000-000000000006', 'Which account?')->>'status';
select pg_sleep(2);
commit;
SQL
PID=$!
sleep 0.7
set +e
"${Q[@]}" -d "$DB" -t -A >"$TMP/b" 2>&1 <<SQL
$as_verifier
select public.reject_finance_payment_request('e0000000-0000-4000-8000-000000000006', 'Duplicate')->>'status';
SQL
set -e
wait $PID
grep -q '^needs_clarification$' "$TMP/a" || { cat "$TMP/a"; fail "race: the first session did not send the payment back"; }
grep -q 'Only a pending payment request can be rejected (PR-0006 is needs_clarification)' "$TMP/b" \
  || { cat "$TMP/b"; fail "race: the second session was not refused after waiting on the lock"; }
[ "$(count "select status || '|' || admin_note from finance_payment_requests where id = 'e0000000-0000-4000-8000-000000000006'")" = "needs_clarification|Which account?" ] \
  || fail "race: the row does not carry the winning decision"
[ "$(count "select count(*) from finance_payment_request_activity_log where payment_request_id = 'e0000000-0000-4000-8000-000000000006' and event_type = 'status_changed'")" = 1 ] \
  || fail "race: not exactly one decision in the activity trail"
echo "   the second decision waited on the row lock and was refused; one decision, one activity row"

echo "== suite complete; database dropped"
