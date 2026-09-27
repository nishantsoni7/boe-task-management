#!/bin/sh
# Prove 20270205120000 (Expenses Phase 3: who paid, reimbursement batches,
# bills) on a DISPOSABLE database:
#
#   1. build the shaped base and the storage shape, and apply the four earlier
#      expense migrations;
#   2. insert ONE legacy expense, entered before the payment source existed;
#   3. TRIAL: apply 20270205120000 inside a transaction and ROLL IT BACK, then
#      prove nothing was left behind;
#   4. apply it for real, which runs its own apply-time assertions;
#   5. run the behavioural assertions as a client role under RLS;
#   6. RACE: two sessions reimburse the same expense at the same moment — one
#      batch is written and the other is refused.
#
#   supabase/tests/run_expense_reimbursement_suite.sh <psql host or socket dir> [port]
#
# Creates and drops a database called boe_expense_reimbursement. Touches nothing
# else and NEVER TALKS TO A LINKED PROJECT. POSIX sh.
set -eu
HOST="${1:?usage: run_expense_reimbursement_suite.sh <psql host or socket dir> [port]}"
PORT="${2:-5432}"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
DB=boe_expense_reimbursement
MIG="$REPO/supabase/migrations"
PSQL="psql -h $HOST -p $PORT -U postgres -v ON_ERROR_STOP=1 -q"

$PSQL -d postgres -c "drop database if exists $DB" >/dev/null
$PSQL -d postgres -c "create database $DB" >/dev/null
cleanup() { $PSQL -d postgres -c "drop database if exists $DB" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "== shaped base, storage shape, and the four earlier expense migrations"
$PSQL -d "$DB" -f "$REPO/supabase/tests/_expense_lifecycle_shaped_schema.sql" >/dev/null
$PSQL -d "$DB" -f "$REPO/supabase/tests/_expense_reimbursement_storage_shape.sql" >/dev/null
for m in 20261220000000_finance_expenses 20261221000000_expense_amounts_are_never_rounded \
         20261222000000_expense_lifecycle 20261223000000_finalize_expense_draft_is_not_for_anon; do
  $PSQL -d "$DB" -f "$MIG/$m.sql" >/dev/null
done

echo "== one legacy expense, entered before the payment source existed"
$PSQL -d "$DB" >/dev/null <<'SQL'
insert into public.users (id, full_name, role)
values ('77777777-7777-7777-7777-777777777777', 'Legacy author', 'employee');
insert into public.expense_categories (id, name, created_by)
values ('8a0b094a-ddfd-4f97-a204-ac96c983e5b1', 'Factory Maintenance', '77777777-7777-7777-7777-777777777777');
insert into public.expenses (id, expense_date, amount, payment_mode, paid_to, category_id, created_by)
values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '2026-09-20', 1000.00, 'cash', 'Legacy payee',
        '8a0b094a-ddfd-4f97-a204-ac96c983e5b1', '77777777-7777-7777-7777-777777777777');
SQL

echo "== TRIAL: apply inside a transaction, then ROLL BACK"
{ echo "begin;"; cat "$MIG/20270205120000_expense_reimbursements_and_bills.sql"; echo "rollback;"; } \
  | $PSQL -d "$DB" >/dev/null
$PSQL -d "$DB" >/dev/null <<'SQL'
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'expenses' and column_name = 'paid_from') then
    raise exception 'ROLLBACK LEAK: expenses.paid_from survived';
  end if;
  if to_regclass('public.expense_reimbursements') is not null
     or to_regclass('public.expense_bill_attachments') is not null
     or exists (select 1 from storage.buckets where id = 'expense-bills') then
    raise exception 'ROLLBACK LEAK: a new table or the bucket survived';
  end if;
  if to_regprocedure('public.finalize_expense_draft(uuid, date, numeric, text, text, uuid, text)') is null then
    raise exception 'ROLLBACK LEAK: the original finalize_expense_draft did not come back';
  end if;
  raise notice 'ok: the trial left nothing behind';
end $$;
SQL

echo "== apply 20270205120000 for real"
$PSQL -d "$DB" -f "$MIG/20270205120000_expense_reimbursements_and_bills.sql" >/dev/null

echo "== assertions"
$PSQL -d "$DB" -f "$REPO/supabase/tests/expense_reimbursement_assertions.sql"

echo "== RACE: two sessions reimburse the same expense at once"
# Session A records and HOLDS its transaction open; session B asks for the same
# expense while A still holds the row lock, so B must wait and then be refused.
$PSQL -d "$DB" >/dev/null <<'SQL'
insert into public.expenses (id, expense_date, amount, payment_mode, paid_to, category_id, created_by, paid_from, paid_by)
values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', current_date, 55.00, 'cash', 'Race',
        '8a0b094a-ddfd-4f97-a204-ac96c983e5b1', '11111111-1111-1111-1111-111111111111',
        'personal', '11111111-1111-1111-1111-111111111111');
SQL
AS_FINANCE="set role authenticated; select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);"
OUT_A="$(mktemp)"; OUT_B="$(mktemp)"
( $PSQL -d "$DB" -At -c "$AS_FINANCE" \
    -c "begin; select public.record_expense_reimbursement(array['bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb']::uuid[], current_date, 'RACE-A', 55.00); select pg_sleep(3); commit;" \
    >"$OUT_A" 2>&1 ) &
PID_A=$!
# Wait until A is holding its lock (it is inside pg_sleep), rather than sleeping blind.
i=0
until [ "$($PSQL -d "$DB" -At -c "select count(*) from pg_stat_activity where datname = '$DB' and query like '%pg_sleep(3)%' and pid <> pg_backend_pid()")" = "1" ]; do
  i=$((i+1)); [ $i -gt 100 ] && { echo "session A never started"; exit 1; }
  sleep 0.1
done
set +e
$PSQL -d "$DB" -At -c "$AS_FINANCE" \
  -c "select public.record_expense_reimbursement(array['bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb']::uuid[], current_date, 'RACE-B', 55.00);" \
  >"$OUT_B" 2>&1
B_STATUS=$?
set -e
wait $PID_A
if [ $B_STATUS -eq 0 ] || ! grep -q "already reimbursed" "$OUT_B"; then
  echo "FAILED: the second session was not refused:"; cat "$OUT_B"; exit 1
fi
$PSQL -d "$DB" >/dev/null <<'SQL'
do $$
begin
  if (select count(*) from public.expense_reimbursement_items
      where expense_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb') <> 1
     or (select count(*) from public.expense_reimbursements where reference like 'RACE-%') <> 1
     or (select reference from public.expense_reimbursements where reference like 'RACE-%') <> 'RACE-A' then
    raise exception 'FAILED: the race wrote % batches', (select count(*) from public.expense_reimbursements where reference like 'RACE-%');
  end if;
  raise notice 'ok: one batch (RACE-A) was written; the concurrent RACE-B waited and was refused';
end $$;
SQL
rm -f "$OUT_A" "$OUT_B"

echo "== PASS"
