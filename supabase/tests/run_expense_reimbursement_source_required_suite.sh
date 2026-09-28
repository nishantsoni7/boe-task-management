#!/bin/sh
# Prove 20270211120000 (a NEW expense must say how it was paid) on a DISPOSABLE
# database:
#
#   1. build the shaped base and storage shape, apply the four earlier expense
#      migrations and 20270205120000;
#   2. insert ONE legacy expense whose source was never recorded;
#   3. TRIAL: apply 20270211120000 inside a transaction and ROLL IT BACK, then
#      prove nothing was left behind;
#   4. apply it for real (its own apply-time assertions run);
#   5. run the behavioural assertions as client roles and as the owner.
#
#   supabase/tests/run_expense_reimbursement_source_required_suite.sh <psql host or socket dir> [port]
#
# Creates and drops a database called boe_expense_source_required. Touches
# nothing else and NEVER TALKS TO A LINKED PROJECT. POSIX sh.
set -eu
HOST="${1:?usage: run_expense_reimbursement_source_required_suite.sh <psql host or socket dir> [port]}"
PORT="${2:-5432}"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
DB=boe_expense_source_required
MIG="$REPO/supabase/migrations"
PSQL="psql -h $HOST -p $PORT -U postgres -v ON_ERROR_STOP=1 -q"

$PSQL -d postgres -c "drop database if exists $DB" >/dev/null
$PSQL -d postgres -c "create database $DB" >/dev/null
cleanup() { $PSQL -d postgres -c "drop database if exists $DB" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "== shaped base, storage shape, the expense migrations through 20270205120000"
$PSQL -d "$DB" -f "$REPO/supabase/tests/_expense_lifecycle_shaped_schema.sql" >/dev/null
$PSQL -d "$DB" -f "$REPO/supabase/tests/_expense_reimbursement_storage_shape.sql" >/dev/null
for m in 20261220000000_finance_expenses 20261221000000_expense_amounts_are_never_rounded \
         20261222000000_expense_lifecycle 20261223000000_finalize_expense_draft_is_not_for_anon \
         20270205120000_expense_reimbursements_and_bills; do
  $PSQL -d "$DB" -f "$MIG/$m.sql" >/dev/null
done

echo "== one legacy expense, its source never recorded"
$PSQL -d "$DB" >/dev/null <<'SQL'
insert into public.users (id, full_name, role)
values ('77777777-7777-7777-7777-777777777777', 'Legacy author', 'employee');
insert into public.expense_categories (id, name, created_by)
values ('8a0b094a-ddfd-4f97-a204-ac96c983e5b1', 'Factory Maintenance', '77777777-7777-7777-7777-777777777777');
insert into public.expenses (id, expense_date, amount, payment_mode, paid_to, category_id, created_by)
values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '2026-09-20', 1000.00, 'cash', 'Legacy payee',
        '8a0b094a-ddfd-4f97-a204-ac96c983e5b1', '77777777-7777-7777-7777-777777777777'),
       ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '2026-09-21', 250.00, 'upi', 'Legacy two',
        '8a0b094a-ddfd-4f97-a204-ac96c983e5b1', '77777777-7777-7777-7777-777777777777'),
       ('cccccccc-cccc-cccc-cccc-cccccccccccc', '2026-09-22', 75.00, 'cash', 'Legacy three',
        '8a0b094a-ddfd-4f97-a204-ac96c983e5b1', '77777777-7777-7777-7777-777777777777');
SQL

echo "== TRIAL: apply inside a transaction, then ROLL BACK"
{ echo "begin;"; cat "$MIG/20270211120000_expense_payment_source_required.sql"; echo "rollback;"; } \
  | $PSQL -d "$DB" >/dev/null
$PSQL -d "$DB" >/dev/null <<'SQL'
do $$
begin
  if exists (select 1 from pg_trigger where tgname = 'expenses_require_payment_source')
     or to_regprocedure('public.expenses_require_payment_source()') is not null then
    raise exception 'ROLLBACK LEAK: the trigger or its function survived';
  end if;
  raise notice 'ok: the trial left nothing behind';
end $$;
SQL

echo "== apply 20270211120000 for real"
$PSQL -d "$DB" -f "$MIG/20270211120000_expense_payment_source_required.sql" >/dev/null

echo "== assertions"
$PSQL -d "$DB" -f "$REPO/supabase/tests/expense_reimbursement_source_required_assertions.sql"

echo "== PASS"
