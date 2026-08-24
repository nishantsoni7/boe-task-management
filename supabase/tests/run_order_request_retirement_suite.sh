#!/usr/bin/env bash
# Build a production-shaped database carrying the Order Request policy history,
# reproduce the apply-time failure 20261007000000 hit on the linked database,
# prove it rolled back cleanly, apply the corrected migration, and prove the
# retirement holds — including that 20261008000000 still applies on top of it.
#
#   supabase/tests/run_order_request_retirement_suite.sh <psql-host-or-socket-dir>
#
# Creates and drops a database called `boe_or_retirement`. Touches nothing else,
# and never talks to a linked project.
set -euo pipefail
HOST="${1:?usage: run_order_request_retirement_suite.sh <psql host or socket dir>}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DB=boe_or_retirement
Q=(psql -h "$HOST" -U postgres -v ON_ERROR_STOP=1 -q)

# AS THE MIGRATION ROLE, not as a superuser. The CLI connects as a login role and
# then assumes the role that owns the schema, so session_user and current_user are
# two different roles for the whole run — which is the configuration that made
# `RESET ROLE` inside the migration a demotion instead of a restore. Applying as
# postgres would pass every privilege check and prove nothing.
APPLY=(psql -h "$HOST" -U postgres -v ON_ERROR_STOP=1 -q
       -c "set session authorization boe_cli" -c "set role boe_migrator")

# The failure, verbatim, as the linked apply reported it.
EXPECTED_FAILURE='order_requests still has 1 INSERT-capable polic(ies); the retired workflow would remain creatable'
EXPECTED_READ_FAILURE='public.orders.source_order_request_id is in the catalog but could not be read (permission denied for table orders): the historical record must stay reachable'

"${Q[@]}" -d postgres -c "drop database if exists $DB" >/dev/null
"${Q[@]}" -d postgres -c "create database $DB" >/dev/null
trap '"${Q[@]}" -d postgres -c "drop database if exists $DB" >/dev/null 2>&1 || true' EXIT

policy_signature() {
  "${Q[@]}" -d "$DB" -At -c \
    "select string_agg(policyname || '/' || permissive || '/' || cmd, ',' order by policyname)
       from pg_policies where schemaname = 'public' and tablename = 'order_requests'"
}

echo "══ building the production-shaped schema, policy history replayed in order ══"
"${Q[@]}" -d "$DB" -f "$REPO/supabase/tests/_order_requests_shaped_schema.sql"

echo "══ BEFORE: the pre-retirement state, and which policy really grants INSERT ══"
"${Q[@]}" -d "$DB" -f "$REPO/supabase/tests/order_request_retirement_pre_107.sql"

echo "══ reproducing the linked apply-time failure ══"
BEFORE="$(policy_signature)"
set +e
OUTPUT="$("${Q[@]}" -d "$DB" --single-transaction \
  -f "$REPO/supabase/tests/_order_request_retirement_old_107_form.sql" 2>&1)"
STATUS=$?
set -e

if [ "$STATUS" -eq 0 ]; then
  echo "FAIL: the first form of 20261007000000 applied cleanly here, so this harness"
  echo "      does not reproduce the linked database and proves nothing."
  exit 1
fi
if ! printf '%s' "$OUTPUT" | grep -qF "$EXPECTED_FAILURE"; then
  echo "FAIL: the first form failed, but not with the failure the linked apply reported."
  echo "      expected: $EXPECTED_FAILURE"
  echo "      got:"
  printf '%s\n' "$OUTPUT" | sed 's/^/        /'
  exit 1
fi
echo "── reproduced, exactly: $EXPECTED_FAILURE"

AFTER="$(policy_signature)"
if [ "$BEFORE" != "$AFTER" ]; then
  echo "FAIL: the failed apply did not roll back completely."
  echo "      before: $BEFORE"
  echo "      after:  $AFTER"
  exit 1
fi
echo "── and it rolled back completely: the policy set is byte-identical"

echo "══ reproducing the second linked failure: the demoted read ══"
APPLY_AS="$("${APPLY[@]}" -d "$DB" -At -c 'select current_user, session_user' | tr '|' ' ')"
echo "── applying as current_user=${APPLY_AS% *} session_user=${APPLY_AS#* }"
set +e
OUTPUT="$("${APPLY[@]}" -d "$DB" --single-transaction \
  -f "$REPO/supabase/tests/_order_request_retirement_old_107_read_form.sql" 2>&1)"
STATUS=$?
set -e
if [ "$STATUS" -eq 0 ]; then
  echo "FAIL: the second form applied cleanly here, so this harness does not"
  echo "      reproduce the linked role model and proves nothing."
  exit 1
fi
if ! printf '%s' "$OUTPUT" | grep -qF "$EXPECTED_READ_FAILURE"; then
  echo "FAIL: the second form failed, but not with the failure the linked apply reported."
  echo "      expected: $EXPECTED_READ_FAILURE"
  echo "      got:"
  printf '%s\n' "$OUTPUT" | sed 's/^/        /'
  exit 1
fi
echo "── reproduced, exactly: $EXPECTED_READ_FAILURE"

# The migrations carry their own begin/commit, so no --single-transaction here.
echo "══ applying the corrected 20261007000000, as the migration role ══"
"${APPLY[@]}" -d "$DB" -f "$REPO/supabase/migrations/20261007000000_retire_order_requests.sql"

echo "══ AFTER: the retirement, required to hold ══"
"${Q[@]}" -d "$DB" -f "$REPO/supabase/tests/order_request_retirement_assertions.sql"

echo "══ the provenance contract, and the oracle the first form asked ══"
"${Q[@]}" -d "$DB" -f "$REPO/supabase/tests/order_request_provenance_assertions.sql"

echo "══ applying 20261008000000 on top, as the same migration role ══"
"${APPLY[@]}" -d "$DB" -f "$REPO/supabase/migrations/20261008000000_finance_payment_classification.sql"

"${Q[@]}" -d "$DB" -c "do \$\$
declare
  v_name text;
  v_missing text[] := '{}';
begin
  foreach v_name in array array[
    'order_attributed_total', 'pi_attributed_total', 'available_balance',
    'is_linked_to_order', 'is_linked_to_pi', 'is_available_to_allocate']
  loop
    if not exists (select 1 from information_schema.columns
                   where table_schema = 'public' and table_name = 'finance_received_payments'
                     and column_name = v_name) then
      v_missing := v_missing || v_name;
    end if;
  end loop;
  if array_length(v_missing, 1) is not null then
    raise exception '20261008000000 applied but the classification columns are missing: %', v_missing;
  end if;
  raise notice '20261008000000 applies cleanly after the corrected retirement';
end \$\$;"

echo "══ re-running the retirement assertions after 108, to prove it changed none of them ══"
"${Q[@]}" -d "$DB" -f "$REPO/supabase/tests/order_request_retirement_assertions.sql"

echo "══ the provenance mutation tests ══"
"${Q[@]}" -d "$DB" -f "$REPO/supabase/tests/order_request_provenance_mutations.sql"

echo "══ suite complete; database dropped ══"
