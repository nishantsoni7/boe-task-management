#!/usr/bin/env bash
# Prove 20270607000000 (a Payment Request can be for an OLD order) on a
# DISPOSABLE database:
#
#   1. build the chain run_payment_idempotency_suite.sh builds — the shaped
#      schema plus the REAL 20261010000000 … 20261014000000, the deployed
#      bodies it needs, and the REAL 20261219000000 (the submit door) and
#      20270322000000 (edit_payment_request) on top;
#   2. add the old-order half of 20270407000000 the migration depends on: its
#      §1 column/constraint DDL and the deployed bodies of
#      normalize_legacy_order_no and allocate_payment_to_legacy_order_internal,
#      extracted verbatim (the rest of 20270407000000 does not touch these doors);
#   3. show the gap: before the migration 'old_order' is refused;
#   4. apply the migration in ONE transaction (its own assertions run there);
#   5. run payment_request_old_order_assertions.sql (one transaction, rolled
#      back): submit, replay, refusals, edit, approval, rejection.
#
#   supabase/tests/run_payment_request_old_order_suite.sh <psql host or socket dir> [port]
#
# Creates and drops a database called boe_payment_request_old_order. Touches
# nothing else and never talks to a linked project.
set -euo pipefail
HOST="${1:?usage: run_payment_request_old_order_suite.sh <psql host or socket dir> [port]}"
PORT="${2:-5432}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DB=boe_payment_request_old_order
MIG="$REPO/supabase/migrations"
PENDING="$MIG/20270607000000_finance_payment_request_old_order.sql"
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

echo "== deployed bodies: what 20261219000000 and the approval/rejection doors run under"
{
  echo 'drop function if exists public.log_order_submission_activity(uuid, uuid, text, text, text, text, jsonb);'
  echo 'drop function if exists public.reject_finance_payment_request(uuid, text);'
  extract "$MIG/20260908000000_order_pi_submissions.sql"                 assert_order_submission_actor
  extract "$MIG/20260908000000_order_pi_submissions.sql"                 log_order_submission_activity
  extract "$MIG/20260908000000_order_pi_submissions.sql"                 create_order_submission
  extract "$MIG/20260914000000_order_submission_permanent_deletion.sql"  order_submission_purge_in_progress
  extract "$MIG/20260916000000_order_submission_test_cleanup.sql"        order_submissions_guard_delete
  extract "$MIG/20260916000000_order_submission_test_cleanup.sql"        order_submission_activity_guard_delete
  extract "$MIG/20260716000000_finance_payment_collection_handover.sql"  log_finance_payment_request_activity
  extract "$MIG/20260920000000_finance_approver_can_verify_payment.sql"   in_finance_payment_verification
  extract "$MIG/20261211000000_finance_payment_decisions_belong_to_verifiers.sql" finance_payment_requests_guard_decision_status
  extract "$MIG/20261211000000_finance_payment_decisions_belong_to_verifiers.sql" reject_finance_payment_request
  cat <<'SQL'
drop trigger if exists finance_payment_requests_guard_decision_status on public.finance_payment_requests;
create trigger finance_payment_requests_guard_decision_status
  before insert or update on public.finance_payment_requests
  for each row execute function public.finance_payment_requests_guard_decision_status();
revoke execute on function public.reject_finance_payment_request(uuid, text) from public, anon;
grant  execute on function public.reject_finance_payment_request(uuid, text) to authenticated;
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
          log_finance_payment_request_activity in_finance_payment_verification \
          finance_payment_requests_guard_decision_status reject_finance_payment_request; do
  grep -qi "function public.$fn(" "$TMP/deployed.sql" || fail "could not extract $fn"
done
"${Q[@]}" -d "$DB" -f "$TMP/deployed.sql" >/dev/null 2>"$TMP/err" || { cat "$TMP/err"; fail "installing deployed bodies"; }

echo "== 20261219000000 (the submit door) and 20270322000000 (edit_payment_request)"
"${Q[@]}" -d "$DB" -1 -f "$MIG/20261219000000_order_submission_unsaved_drafts_and_payment_idempotency.sql" >/dev/null 2>"$TMP/err" \
  || { cat "$TMP/err"; fail "20261219000000 did not apply"; }

{
  cat "$REPO/supabase/tests/_payment_edit_reallocates_extra_schema.sql"
  extract "$MIG/20260921000000_order_submission_verified_payment_gate.sql" finance_payment_allocations_guard_transition
  extract "$MIG/20260918000000_finance_payment_allocations.sql"           finance_payment_allocations_derive_reversal
  extract "$MIG/20260918000000_finance_payment_allocations.sql"           finance_payment_requests_guard_allocated_amount
  cat <<'SQL'
create trigger finance_payment_allocations_check_transition
  before update on public.finance_payment_allocations
  for each row execute function public.finance_payment_allocations_guard_transition();
create trigger finance_payment_allocations_derive_reversal
  before update on public.finance_payment_allocations
  for each row execute function public.finance_payment_allocations_derive_reversal();
create trigger finance_payment_requests_guard_allocated_amount
  before update on public.finance_payment_requests
  for each row execute function public.finance_payment_requests_guard_allocated_amount();
SQL
} > "$TMP/edit_shape.sql"
for fn in finance_payment_allocations_guard_transition finance_payment_allocations_derive_reversal finance_payment_requests_guard_allocated_amount; do
  grep -qi "function public.$fn(" "$TMP/edit_shape.sql" || fail "could not extract $fn"
done
"${Q[@]}" -d "$DB" -f "$TMP/edit_shape.sql" >/dev/null 2>"$TMP/err" || { cat "$TMP/err"; fail "edit production shape"; }
"${Q[@]}" -d "$DB" -1 -f "$MIG/20270322000000_finance_payment_edit_reallocates.sql" >/dev/null 2>"$TMP/err" \
  || { cat "$TMP/err"; fail "20270322000000 did not apply"; }

echo "== the old-order half of 20270407000000 (§1 DDL, normalize_legacy_order_no, the legacy allocator)"
OLD="$MIG/20270407000000_finance_allocate_to_old_order.sql"
{
  sed -n '72,138p' "$OLD"
  extract "$OLD" allocate_payment_to_legacy_order_internal
  echo 'revoke execute on function public.allocate_payment_to_legacy_order_internal(uuid, text, text, numeric) from public, anon, authenticated;'
} > "$TMP/legacy.sql"
grep -qi "function public.normalize_legacy_order_no(" "$TMP/legacy.sql" || fail "could not extract normalize_legacy_order_no"
grep -qi "function public.allocate_payment_to_legacy_order_internal(" "$TMP/legacy.sql" || fail "could not extract the legacy allocator"
"${Q[@]}" -d "$DB" -1 -f "$TMP/legacy.sql" >/dev/null 2>"$TMP/err" || { cat "$TMP/err"; fail "installing the legacy allocator"; }

echo "== committed fixture"
"${Q[@]}" -d "$DB" >/dev/null <<'SEED'
insert into public.users (id, email, role, full_name, is_active, is_deleted) values
  ('11111111-1111-4111-8111-111111111111', 'admin@boe.test',   'admin',       'Admin',   true, false),
  ('22222222-2222-4222-8222-222222222222', 'sales@boe.test',   'salesperson', 'Sales',   true, false),
  ('33333333-3333-4333-8333-333333333333', 'nobody@boe.test',  'viewer',      'Nobody',  true, false),
  ('44444444-4444-4444-8444-444444444444', 'sales2@boe.test',  'salesperson', 'Sales 2', true, false),
  ('55555555-5555-4555-8555-555555555555', 'verify1@boe.test', 'finance',     'Verifier 1', true, false);
insert into public.finance_permission_grants (user_id, action) values
  ('22222222-2222-4222-8222-222222222222', 'finance.create'),
  ('44444444-4444-4444-8444-444444444444', 'finance.create'),
  ('55555555-5555-4555-8555-555555555555', 'finance.approve'),
  ('55555555-5555-4555-8555-555555555555', 'finance.create');
insert into public.orders (id, display_number, status, client_name, created_by) values
  ('a0000000-0000-4000-8000-00000000000a', '0601', 'running', 'Kalyan Interiors', '11111111-1111-4111-8111-111111111111');
SEED

echo "== BEFORE the migration: 'old_order' is refused"
set +e
REFUSED="$("${Q[@]}" -d "$DB" 2>&1 <<'SQL'
select set_config('request.jwt.claims', json_build_object('sub','22222222-2222-4222-8222-222222222222','role','authenticated')::text, false);
select public.submit_payment_request(p_destination => 'old_order', p_amount => 1000, p_payment_date => current_date, p_payment_mode => 'hdfc');
SQL
)"
set -e
printf '%s' "$REFUSED" | grep -q 'PAYMENT_DESTINATION_INVALID' || fail "the gap did not reproduce: $REFUSED"
echo "   refused with PAYMENT_DESTINATION_INVALID"

echo "== apply $(basename "$PENDING") (one transaction)"
"${Q[@]}" -d "$DB" -1 -f "$PENDING" >"$TMP/apply" 2>&1 || { cat "$TMP/apply"; fail "the migration did not apply"; }

echo "== assertions"
set +e
AFTER="$("${Q[@]}" -d "$DB" -f "$REPO/supabase/tests/payment_request_old_order_assertions.sql" 2>&1)"
STATUS=$?
set -e
printf '%s\n' "$AFTER" | grep -E 'PASS|FAIL|ERROR|ASSERT' | sed 's/^.*NOTICE:  /   /'
if [ $STATUS -ne 0 ] || ! printf '%s' "$AFTER" | grep -q 'ALL ASSERTIONS PASSED'; then
  printf '%s\n' "$AFTER" | tail -20
  fail "the assertions did not reach the end"
fi

echo "== suite complete; database dropped"
