#!/usr/bin/env bash
# Prove 20261219000000 (payment idempotency, rupees and paise, unsaved PI
# drafts) on a DISPOSABLE database:
#
#   1. build the Orders/Finance chain run_payment_entry_edit_race.sh builds —
#      the shaped schema plus the REAL 20261010000000 … 20261014000000, so the
#      four payment doors are the deployed bodies — then bring it to
#      production's shape for what this migration touches, installing the
#      deployed create_order_submission and the deployed delete guards;
#   2. REPRODUCE every gap on the deployed bodies (payment_idempotency_before.sql);
#   3. apply the migration in one transaction — it runs its own assertions;
#   4. run payment_idempotency_assertions.sql (one transaction, rolled back);
#   5. RACE: two real sessions with the same key, committed, per door; a lost
#      response; and a no-key control that shows what the key prevents.
#
#   supabase/tests/run_payment_idempotency_suite.sh <psql host or socket dir> [port]
#
# Creates and drops a database called boe_payment_idempotency. Touches nothing
# else and never talks to a linked project.
set -euo pipefail
HOST="${1:?usage: run_payment_idempotency_suite.sh <psql host or socket dir> [port]}"
PORT="${2:-5432}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DB=boe_payment_idempotency
MIG="$REPO/supabase/migrations"
PENDING="$MIG/20261219000000_order_submission_unsaved_drafts_and_payment_idempotency.sql"
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
  "$REPO/supabase/tests/_payment_idempotency_extra_schema.sql"
do
  "${Q[@]}" -d "$DB" -f "$f" >/dev/null 2>"$TMP/err" || { cat "$TMP/err"; fail "building $f"; }
done

echo "== deployed bodies: create_order_submission and the PI delete guards"
{
  # The shaped schema carries a stand-in with other parameter names.
  echo 'drop function if exists public.log_order_submission_activity(uuid, uuid, text, text, text, text, jsonb);'
  extract "$MIG/20260908000000_order_pi_submissions.sql"                 assert_order_submission_actor
  extract "$MIG/20260908000000_order_pi_submissions.sql"                 log_order_submission_activity
  extract "$MIG/20260908000000_order_pi_submissions.sql"                 create_order_submission
  extract "$MIG/20260914000000_order_submission_permanent_deletion.sql"  order_submission_purge_in_progress
  extract "$MIG/20260916000000_order_submission_test_cleanup.sql"        order_submissions_guard_delete
  extract "$MIG/20260916000000_order_submission_test_cleanup.sql"        order_submission_activity_guard_delete
  extract "$MIG/20260716000000_finance_payment_collection_handover.sql"  log_finance_payment_request_activity
  cat <<'SQL'
revoke execute on function public.log_finance_payment_request_activity() from public, anon, authenticated;
drop trigger if exists finance_payment_requests_log_activity on public.finance_payment_requests;
create trigger finance_payment_requests_log_activity
  after insert or update on public.finance_payment_requests
  for each row execute function public.log_finance_payment_request_activity();
revoke execute on function public.create_order_submission(text) from public, anon;
grant  execute on function public.create_order_submission(text) to authenticated;
revoke execute on function public.order_submission_purge_in_progress(uuid) from public, anon, authenticated, service_role;
drop trigger if exists order_submissions_guard_delete on public.order_submissions;
create trigger order_submissions_guard_delete before delete on public.order_submissions
  for each row execute function public.order_submissions_guard_delete();
drop trigger if exists order_submission_activity_guard_delete on public.order_submission_activity;
create trigger order_submission_activity_guard_delete before delete on public.order_submission_activity
  for each row execute function public.order_submission_activity_guard_delete();
SQL
} > "$TMP/deployed.sql"
for fn in assert_order_submission_actor log_order_submission_activity create_order_submission \
          order_submission_purge_in_progress order_submissions_guard_delete order_submission_activity_guard_delete           log_finance_payment_request_activity; do
  grep -qi "function public.$fn(" "$TMP/deployed.sql" || fail "could not extract $fn"
done
"${Q[@]}" -d "$DB" -f "$TMP/deployed.sql" >/dev/null 2>"$TMP/err" || { cat "$TMP/err"; fail "installing deployed bodies"; }

# The deployed guard really does refuse an ordinary delete — so a discard that
# succeeds later is passing the real guard, not an absent one.
set +e
GUARD="$("${Q[@]}" -d "$DB" -c "insert into public.order_submissions (id, status) values ('dddddddd-0000-4000-8000-000000000000', 'draft'); delete from public.order_submissions where id = 'dddddddd-0000-4000-8000-000000000000';" 2>&1)"
set -e
printf '%s' "$GUARD" | grep -q 'ORDER_SUBMISSION_DELETE_DENIED' || fail "the deployed delete guard is not in force: $GUARD"
echo "   the deployed delete guard refuses an ordinary DELETE"

echo "== committed fixture"
"${Q[@]}" -d "$DB" >/dev/null <<'SEED'
insert into public.users (id, email, role, full_name, is_active, is_deleted) values
  ('11111111-1111-4111-8111-111111111111', 'admin@boe.test',   'admin',       'Admin',   true, false),
  ('22222222-2222-4222-8222-222222222222', 'sales@boe.test',   'salesperson', 'Sales',   true, false),
  ('33333333-3333-4333-8333-333333333333', 'nobody@boe.test',  'viewer',      'Nobody',  true, false),
  ('44444444-4444-4444-8444-444444444444', 'sales2@boe.test',  'salesperson', 'Sales 2', true, false);
insert into public.finance_permission_grants (user_id, action) values
  ('22222222-2222-4222-8222-222222222222', 'finance.create'),
  ('22222222-2222-4222-8222-222222222222', 'finance.allocate'),
  ('22222222-2222-4222-8222-222222222222', 'orders.create'),
  ('22222222-2222-4222-8222-222222222222', 'orders.view_all'),
  ('44444444-4444-4444-8444-444444444444', 'finance.create'),
  ('44444444-4444-4444-8444-444444444444', 'orders.create');
insert into public.orders (id, display_number, status, client_name, created_by) values
  ('a0000000-0000-4000-8000-00000000000a', '0601', 'running', 'Kalyan Interiors', '11111111-1111-4111-8111-111111111111');
insert into public.order_submissions (id, client_name, status, created_by, submitted_by, source_workbook_path) values
  ('d0000000-0000-4000-8000-00000000000d', 'Kalyan Interiors', 'draft',
   '22222222-2222-4222-8222-222222222222', '22222222-2222-4222-8222-222222222222',
   'd0000000-0000-4000-8000-00000000000d/original/pi.xlsx');
SEED

echo "== BEFORE the migration: every gap must reproduce on the deployed bodies"
BEFORE="$("${Q[@]}" -d "$DB" -f "$REPO/supabase/tests/payment_idempotency_before.sql" 2>&1)" \
  || { echo "$BEFORE"; fail "the reproduction file errored"; }
printf '%s\n' "$BEFORE" | grep 'REPRODUCED' | sed 's/^.*NOTICE:  /   /'
[ "$(printf '%s\n' "$BEFORE" | grep -c 'REPRODUCED')" -eq 8 ] || fail "expected 8 reproduced gaps"

echo "== apply $(basename "$PENDING") (one transaction)"
"${Q[@]}" -d "$DB" -1 -f "$PENDING" >"$TMP/apply" 2>&1 || { cat "$TMP/apply"; fail "the migration did not apply"; }
grep -o '20261219000000: .*' "$TMP/apply" | sed 's/^/   /'

echo "== assertions"
AFTER="$("${Q[@]}" -d "$DB" -f "$REPO/supabase/tests/payment_idempotency_assertions.sql" 2>&1)" \
  || { echo "$AFTER"; fail "assertions"; }
printf '%s\n' "$AFTER" | grep 'PASS' | sed 's/^.*NOTICE:  /   /'
[ "$(printf '%s\n' "$AFTER" | grep -c "PASS:")" -eq 14 ] || { echo "$AFTER"; fail "expected 14 PASS lines"; }

# ── The race: two real sessions, committed rows ──────────────────────────────
as_sales="select set_config('request.jwt.claims', json_build_object('sub','22222222-2222-4222-8222-222222222222','role','authenticated')::text, false);"

count() { "${Q[@]}" -d "$DB" -t -A -c "$1"; }

# race <label> <sql returning one id> — A calls and holds its transaction 2 s;
# B makes the identical call 0.7 s later. Both must print the SAME id.
race() {
  local label="$1" call="$2"
  "${Q[@]}" -d "$DB" -t -A >"$TMP/a" 2>&1 <<SQL &
$as_sales
begin;
$call;
select pg_sleep(2);
commit;
SQL
  local pid=$!
  sleep 0.7
  "${Q[@]}" -d "$DB" -t -A >"$TMP/b" 2>&1 <<SQL
$as_sales
$call;
SQL
  wait $pid
  A_ID="$(grep -E '^[0-9a-f-]{36}$' "$TMP/a" | tail -1)"
  B_ID="$(grep -E '^[0-9a-f-]{36}$' "$TMP/b" | tail -1)"
  [ -n "$A_ID" ] && [ "$A_ID" = "$B_ID" ] || { cat "$TMP/a" "$TMP/b"; fail "$label: the two sessions did not converge ($A_ID vs $B_ID)"; }
}

echo "== race 1: submit_payment_request, same key, concurrent"
race submit "select public.submit_payment_request(p_destination => 'confirmed_order', p_target_id => 'a0000000-0000-4000-8000-00000000000a', p_amount => 111111.11, p_payment_date => current_date, p_payment_mode => 'hdfc', p_idempotency_key => 'a1000000-0000-4000-8000-000000000001')->>'payment_request_id'"
[ "$(count "select count(*) from finance_payment_requests where amount = 111111.11")" = 1 ] || fail "race 1 recorded more than one payment"
[ "$(count "select count(*) from finance_payment_allocation_intents where payment_request_id = '$A_ID'")" = 1 ] || fail "race 1: not one intent"
[ "$(count "select count(*) from finance_payment_request_activity_log where payment_request_id = '$A_ID'")" = 1 ] || fail "race 1: not one activity row"
echo "   both sessions returned $A_ID; 1 payment, 1 intent, 1 activity row"

echo "== race 2: record_payment_with_allocations (split + custody), same key, concurrent"
PI_ACT_BEFORE="$(count "select count(*) from order_submission_activity where submission_id = 'd0000000-0000-4000-8000-00000000000d'")"
ALLOC='[{"kind":"order","id":"a0000000-0000-4000-8000-00000000000a","amount":600000},{"kind":"submission","id":"d0000000-0000-4000-8000-00000000000d","amount":400000}]'
CUST='[{"key":"r2","activity_type":"collected","occurred_at":"2026-09-19T10:00:00+05:30","collected_by":"22222222-2222-4222-8222-222222222222"}]'
race split "select public.record_payment_with_allocations(p_amount => 1000000, p_payment_date => current_date, p_payment_mode => 'pnb', p_client_name => null, p_reference => 'RACE-2', p_allocations => '$ALLOC', p_custody_events => '$CUST', p_idempotency_key => 'a2000000-0000-4000-8000-000000000001')->>'payment_request_id'"
[ "$(count "select count(*) from finance_payment_requests where amount = 1000000")" = 1 ] || fail "race 2 recorded more than one payment"
[ "$(count "select count(*) from finance_payment_allocations where payment_request_id = '$A_ID' and status = 'active'")" = 2 ] || fail "race 2: not one allocation set"
[ "$(count "select sum(allocated_amount) from finance_payment_allocations where payment_request_id = '$A_ID'")" = "1000000" ] \
  || [ "$(count "select sum(allocated_amount)::numeric = 1000000 from finance_payment_allocations where payment_request_id = '$A_ID'")" = t ] || fail "race 2: allocated total"
[ "$(count "select count(*) from finance_payment_custody_events where payment_request_id = '$A_ID'")" = 1 ] || fail "race 2: not one custody set"
[ "$(count "select count(*) from finance_payment_request_activity_log where payment_request_id = '$A_ID'")" = 1 ] || fail "race 2: not one Finance activity row"
PI_ACT_DELTA=$(( $(count "select count(*) from order_submission_activity where submission_id = 'd0000000-0000-4000-8000-00000000000d'") - PI_ACT_BEFORE ))
[ "$PI_ACT_DELTA" -le 1 ] || fail "race 2: the PI timeline logged the payment $PI_ACT_DELTA times"
echo "   both sessions returned $A_ID; 1 payment, 2 allocations (₹6,00,000 + ₹4,00,000), 1 custody event, 1 Finance activity row, $PI_ACT_DELTA PI-timeline row"

echo "== race 3: record_pi_submission_payment, same key, concurrent"
race pi "select public.record_pi_submission_payment(p_submission_id => 'd0000000-0000-4000-8000-00000000000d', p_amount => 33333.33, p_payment_date => current_date, p_payment_mode => 'hdfc', p_idempotency_key => 'a3000000-0000-4000-8000-000000000001')->>'payment_request_id'"
[ "$(count "select count(*) from finance_payment_requests where amount = 33333.33")" = 1 ] || fail "race 3 recorded more than one payment"
[ "$(count "select count(*) from finance_payment_allocations where payment_request_id = '$A_ID'")" = 1 ] || fail "race 3: not one allocation"
[ "$(count "select count(*) from finance_payment_request_activity_log where payment_request_id = '$A_ID'")" = 1 ] || fail "race 3: not one activity row"
echo "   both sessions returned $A_ID; 1 payment, 1 allocation, 1 activity row"

echo "== race 4: create_order_submission, same key, concurrent"
DRAFTS_BEFORE="$(count "select count(*) from order_submissions")"
race draft "select public.create_order_submission(null, 'a4000000-0000-4000-8000-000000000001')->>'id'"
[ "$(count "select count(*) from order_submissions")" = "$((DRAFTS_BEFORE + 1))" ] || fail "race 4 created more than one draft"
[ "$(count "select count(*) from order_submission_activity where submission_id = '$A_ID'")" = 1 ] || fail "race 4: activity"
echo "   both sessions returned $A_ID; 1 draft, 1 activity row"

echo "== lost response: the call commits, its answer never arrives, the client retries"
"${Q[@]}" -d "$DB" -t -A >/dev/null <<SQL
$as_sales
select public.submit_payment_request(p_destination => 'suspense', p_amount => 5555.55, p_payment_date => current_date, p_payment_mode => 'hdfc', p_idempotency_key => 'a5000000-0000-4000-8000-000000000001');
SQL
FIRST="$(count "select id from finance_payment_requests where amount = 5555.55")"
RETRY="$("${Q[@]}" -d "$DB" -t -A <<SQL | grep -E '^[0-9a-f-]{36}$' | tail -1
$as_sales
select public.submit_payment_request(p_destination => 'suspense', p_amount => 5555.55, p_payment_date => current_date, p_payment_mode => 'hdfc', p_idempotency_key => 'a5000000-0000-4000-8000-000000000001')->>'payment_request_id';
SQL
)"
[ "$RETRY" = "$FIRST" ] || fail "the retry after a lost response did not return the committed payment"
[ "$(count "select count(*) from finance_payment_requests where amount = 5555.55")" = 1 ] || fail "lost-response retry duplicated"
echo "   the retry returned the committed payment $FIRST; still 1 payment"

echo "== two genuine payments, different keys, concurrent: both recorded"
"${Q[@]}" -d "$DB" -t -A >/dev/null 2>&1 <<SQL &
$as_sales
begin;
select public.submit_payment_request(p_destination => 'suspense', p_amount => 777.77, p_payment_date => current_date, p_payment_mode => 'hdfc', p_idempotency_key => 'a6000000-0000-4000-8000-000000000001');
select pg_sleep(1);
commit;
SQL
PID=$!
sleep 0.3
"${Q[@]}" -d "$DB" -t -A >/dev/null <<SQL
$as_sales
select public.submit_payment_request(p_destination => 'suspense', p_amount => 777.77, p_payment_date => current_date, p_payment_mode => 'hdfc', p_idempotency_key => 'a6000000-0000-4000-8000-000000000002');
SQL
wait $PID
[ "$(count "select count(*) from finance_payment_requests where amount = 777.77")" = 2 ] || fail "two keys should be two payments"
echo "   2 payments"

echo "== control: the same concurrent retry WITHOUT a key is two payments (what the key prevents)"
"${Q[@]}" -d "$DB" -t -A >/dev/null 2>&1 <<SQL &
$as_sales
begin;
select public.submit_payment_request(p_destination => 'suspense', p_amount => 999.99, p_payment_date => current_date, p_payment_mode => 'hdfc');
select pg_sleep(1);
commit;
SQL
PID=$!
sleep 0.3
"${Q[@]}" -d "$DB" -t -A >/dev/null <<SQL
$as_sales
select public.submit_payment_request(p_destination => 'suspense', p_amount => 999.99, p_payment_date => current_date, p_payment_mode => 'hdfc');
SQL
wait $PID
[ "$(count "select count(*) from finance_payment_requests where amount = 999.99")" = 2 ] || fail "control: expected the unkeyed pair to be two payments"
echo "   2 payments without a key — the deployed frontend's behaviour, unchanged until it sends one"

echo "== suite complete; database dropped"
