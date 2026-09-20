#!/bin/sh
# Prove 20261222000000 (Expenses Phase 2: safe removal, and the capture inbox)
# on a DISPOSABLE database:
#
#   1. build the shaped base and apply the two Phase 1 expense migrations;
#   2. copy in the EXACT expense and category the linked project holds, so the
#      migration is trialled against real data rather than invented data;
#   3. TRIAL: apply 20261222000000 inside a transaction and ROLL IT BACK, then
#      prove the database is untouched — no columns, no table, no function;
#   4. apply it for real, which runs its own apply-time assertions;
#   5. run the behavioural assertions in full, as a client role under RLS.
#
#   supabase/tests/run_expense_lifecycle_suite.sh <psql host or socket dir> [port]
#
# Creates and drops a database called boe_expense_lifecycle. Touches nothing
# else and NEVER TALKS TO A LINKED PROJECT. POSIX sh.
set -eu
HOST="${1:?usage: run_expense_lifecycle_suite.sh <psql host or socket dir> [port]}"
PORT="${2:-5432}"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
DB=boe_expense_lifecycle
MIG="$REPO/supabase/migrations"
PSQL="psql -h $HOST -p $PORT -U postgres -v ON_ERROR_STOP=1 -q"

$PSQL -d postgres -c "drop database if exists $DB" >/dev/null
$PSQL -d postgres -c "create database $DB" >/dev/null
cleanup() { $PSQL -d postgres -c "drop database if exists $DB" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "== shaped base"
$PSQL -d "$DB" -f "$REPO/supabase/tests/_expense_lifecycle_shaped_schema.sql" >/dev/null

echo "== Phase 1: 20261220000000 and 20261221000000, applied for real"
$PSQL -d "$DB" -f "$MIG/20261220000000_finance_expenses.sql" >/dev/null
$PSQL -d "$DB" -f "$MIG/20261221000000_expense_amounts_are_never_rounded.sql" >/dev/null

echo "== the linked project's own expense and category, copied in"
$PSQL -d "$DB" >/dev/null <<'SQL'
insert into public.users (id, full_name, role)
values ('6507df9f-cdeb-4ebd-849f-8498c165d596', 'Production author', 'employee')
on conflict (id) do nothing;

insert into public.expense_categories (id, name, is_active, created_by, created_at, updated_at)
values ('8a0b094a-ddfd-4f97-a204-ac96c983e5b1', 'Factory Maintenance', true,
        '6507df9f-cdeb-4ebd-849f-8498c165d596',
        '2026-09-20 08:24:08.21939+00', '2026-09-20 08:24:08.21939+00');

insert into public.expenses
  (id, expense_date, amount, payment_mode, paid_to, category_id, remark,
   created_by, created_at, updated_by, updated_at)
values
  ('5509dffb-df89-47f2-944b-1eeb432319f2', '2026-09-20', 1000.00, 'cash', 'MCD',
   '8a0b094a-ddfd-4f97-a204-ac96c983e5b1', 'Sewage Cleaning',
   '6507df9f-cdeb-4ebd-849f-8498c165d596',
   '2026-09-20 08:24:19.818794+00', NULL, '2026-09-20 08:24:19.818794+00');
SQL

echo "== TRIAL: apply inside a transaction, then ROLL BACK"
# The migration's own apply-time assertions run here too — a failure inside the
# transaction fails this command and the trap drops the database.
{ echo "begin;"; cat "$MIG/20261222000000_expense_lifecycle.sql"; echo "rollback;"; } \
  | $PSQL -d "$DB" >/dev/null
echo "   applied and rolled back cleanly"

echo "== and the rollback left NOTHING behind"
$PSQL -d "$DB" >/dev/null <<'SQL'
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='expenses' and column_name='deleted_at') then
    raise exception 'ROLLBACK LEAK: expenses.deleted_at survived a rolled-back transaction';
  end if;
  if to_regclass('public.expense_drafts') is not null then
    raise exception 'ROLLBACK LEAK: public.expense_drafts survived';
  end if;
  if to_regprocedure('public.finalize_expense_draft(uuid, date, numeric, text, text, uuid, text)') is not null then
    raise exception 'ROLLBACK LEAK: finalize_expense_draft survived';
  end if;
  if (select count(*) from public.expenses) <> 1
     or (select count(*) from public.expense_categories) <> 1 then
    raise exception 'ROLLBACK LEAK: the row counts moved';
  end if;
  raise notice 'ok: the trial left no column, no table, no function and no row behind';
end $$;
SQL

echo "== apply 20261222000000 for real"
$PSQL -d "$DB" -f "$MIG/20261222000000_expense_lifecycle.sql" >/dev/null

echo "== assertions"
$PSQL -d "$DB" -f "$REPO/supabase/tests/expense_lifecycle_assertions.sql"

echo "== PASS"
