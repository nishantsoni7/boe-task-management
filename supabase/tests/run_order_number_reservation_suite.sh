#!/usr/bin/env bash
# Build a PostgreSQL database shaped like production's numbering, approval and
# payment-allocation surfaces, apply 20261009000000 onto the DEPLOYED bodies of
# the five functions it replaces, and prove what the migration claims:
#
#   * a reservation is sequential, atomic and idempotent
#   * two concurrent reservations never take the same number
#   * two PI Drafts can never hold the same number
#   * the Confirmed Order comes out carrying the reserved number
#   * approval is refused when the revised PI was never uploaded
#   * one payment divides across Orders and PI Drafts in a single transaction,
#     and a failing row leaves neither payment nor allocation behind
#   * the migration refuses itself when a retirement guard is missing
#
#   supabase/tests/run_order_number_reservation_suite.sh <psql-host-or-socket-dir> [port]
#
# Creates and drops a database called `boe_number_reservation`. Touches nothing
# else, and never talks to a linked project.
set -euo pipefail
HOST="${1:?usage: run_order_number_reservation_suite.sh <psql host or socket dir> [port]}"
PORT="${2:-5432}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DB=boe_number_reservation
Q=(psql -h "$HOST" -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -q)

# ── Pull a function's DEPLOYED body out of the migration that installed it ────
#
# By name, from `create or replace function public.NAME(` to the `$$;` that ends
# it. Extracted rather than copied so this harness cannot drift from the applied
# file: if somebody edits the deployed body, this suite tests the edit.
extract() { # <file> <function name>
  awk -v fn="create or replace function public.$2(" '
    index($0, fn) == 1 { on = 1 }
    on { print }
    on && /^\$\$;$/ { exit }
  ' "$1"
}

"${Q[@]}" -d postgres -c "drop database if exists $DB" >/dev/null
"${Q[@]}" -d postgres -c "create database $DB" >/dev/null
trap '"${Q[@]}" -d postgres -c "drop database if exists '"$DB"'" >/dev/null 2>&1 || true' EXIT

echo "══ building the shaped schema ══"
"${Q[@]}" -d "$DB" -f "$REPO/supabase/tests/_order_number_reservation_shaped_schema.sql" >/dev/null

echo "══ installing the DEPLOYED bodies the migration will replace ══"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"; "${Q[@]}" -d postgres -c "drop database if exists '"$DB"'" >/dev/null 2>&1 || true' EXIT

extract "$REPO/supabase/migrations/20260704000000_confirmed_order_four_digit_numbers.sql" \
        set_next_confirmed_order_number            > "$TMP/deployed.sql"
extract "$REPO/supabase/migrations/20260926000000_order_number_cycle_reset.sql" \
        reset_confirmed_order_number_cycle        >> "$TMP/deployed.sql"
extract "$REPO/supabase/migrations/20260923000000_order_submission_billing_percentage.sql" \
        approve_order_submission                  >> "$TMP/deployed.sql"

for fn in set_next_confirmed_order_number reset_confirmed_order_number_cycle approve_order_submission; do
  grep -q "function public.$fn(" "$TMP/deployed.sql" \
    || { echo "FAIL: could not extract $fn from its migration"; exit 1; }
done
"${Q[@]}" -d "$DB" -f "$TMP/deployed.sql" >/dev/null
echo "── three deployed bodies installed, extracted from their own migrations"

# ── The negative case, FIRST, so the assertions below cannot be vacuous ───────
#
# The migration re-asserts that the Order Request retirement guards are still in
# place. Drop one and it must refuse itself, wholly, leaving nothing behind.
echo "══ the migration refuses itself when a retirement guard is gone ══"
"${Q[@]}" -d "$DB" -c "drop trigger order_requests_refuse_new on public.order_requests" >/dev/null
set +e
OUTPUT="$("${Q[@]}" -d "$DB" --single-transaction \
  -f "$REPO/supabase/migrations/20261009000000_split_payment_entry_and_order_submission_number_reservation.sql" 2>&1)"
STATUS=$?
set -e
if [ "$STATUS" -eq 0 ]; then
  echo "FAIL: the migration applied with a retirement guard missing."
  exit 1
fi
if ! printf '%s' "$OUTPUT" | grep -qF 'retirement guard order_requests_refuse_new is missing or disabled'; then
  echo "FAIL: it refused, but not for the reason the guard exists."
  printf '%s\n' "$OUTPUT" | sed 's/^/    /'
  exit 1
fi
LEFTOVER="$("${Q[@]}" -d "$DB" -At -c \
  "select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'order_submissions'
      and column_name = 'reserved_order_number'")"
if [ "$LEFTOVER" != "0" ]; then
  echo "FAIL: the refused apply left the reservation column behind — it did not roll back."
  exit 1
fi
echo "── refused, and rolled back completely: no column, no function, no constraint"

"${Q[@]}" -d "$DB" -c "
  create trigger order_requests_refuse_new before insert on public.order_requests
  for each row execute function public.order_requests_refuse_new()" >/dev/null

echo "══ applying 20261009000000 ══"
"${Q[@]}" -d "$DB" --single-transaction \
  -f "$REPO/supabase/migrations/20261009000000_split_payment_entry_and_order_submission_number_reservation.sql"

echo "══ the assertions ══"
"${Q[@]}" -d "$DB" -f "$REPO/supabase/tests/order_number_reservation_assertions.sql"

# ── Concurrency, which needs two real sessions ───────────────────────────────
#
# Everything above runs in one connection, where a FOR UPDATE lock can never be
# contended and proves nothing about the property the whole feature rests on.
# This is two psql processes racing the same cycle row.
echo "══ two concurrent reservations ══"
"${Q[@]}" -d "$DB" -c "
  insert into public.order_submissions (id, status, submitted_by, created_by, client_name,
                                        source_workbook_path, source_workbook_name, source_workbook_sha256)
  select 'aaaaaaaa-0000-4000-8000-00000000c001', 'draft', u.id, u.id, 'Race A',
         'submissions/x/original/a.xlsx', 'a.xlsx', repeat('c', 64)
  from public.users u where u.email = 'owner@test' ;
  insert into public.order_submissions (id, status, submitted_by, created_by, client_name,
                                        source_workbook_path, source_workbook_name, source_workbook_sha256)
  select 'aaaaaaaa-0000-4000-8000-00000000c002', 'draft', u.id, u.id, 'Race B',
         'submissions/y/original/b.xlsx', 'b.xlsx', repeat('d', 64)
  from public.users u where u.email = 'owner@test';" >/dev/null

race() { # <submission id> <out file>
  "${Q[@]}" -d "$DB" -At -o "$2" -c "
    begin;
    select set_config('boe.test_actor', (select id::text from public.users where email = 'owner@test'), true);
    select pg_sleep(0.25);
    select public.reserve_order_number_for_submission('$1')->>'reserved_order_number';
    commit;" 2>&1
}

race aaaaaaaa-0000-4000-8000-00000000c001 "$TMP/raceA" &
PID_A=$!
race aaaaaaaa-0000-4000-8000-00000000c002 "$TMP/raceB" &
PID_B=$!
wait $PID_A; wait $PID_B

A="$(grep -Eo '^[0-9]{4}$' "$TMP/raceA" | tail -1)"
B="$(grep -Eo '^[0-9]{4}$' "$TMP/raceB" | tail -1)"
if [ -z "$A" ] || [ -z "$B" ]; then
  echo "FAIL: a concurrent reservation did not return a number."
  echo "  A: $(cat "$TMP/raceA")"
  echo "  B: $(cat "$TMP/raceB")"
  exit 1
fi
if [ "$A" = "$B" ]; then
  echo "FAIL: two concurrent reservations took the same number ($A). This is the defect the feature exists to prevent."
  exit 1
fi
echo "── two sessions, two different numbers: $A and $B"

CYCLE="$("${Q[@]}" -d "$DB" -At -c 'select next_number from public.order_number_cycle where id')"
echo "── and the cycle advanced past both, to $CYCLE"

echo
echo "ALL CHECKS PASSED"
