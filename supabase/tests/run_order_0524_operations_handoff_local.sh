#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════════════════
# TEST-ONLY RUNNER — 20261230000000_order_0524_operations_handoff_for_existing_approval.sql,
# on a DISPOSABLE local Supabase stack
# ═════════════════════════════════════════════════════════════════════════════
#
# 1. Applies the migration AS WRITTEN, twice. On a disposable database there is
#    no Order 0524, so both runs must say so and write nothing.
# 2. Runs order_0524_operations_handoff_assertions.sql, which executes the same
#    text against a fixture shaped like production's Order 0524 (its pinned ids
#    replaced by the fixture's), and ends in ROLLBACK.
#
# Same stack and guards as run_order_operations_handoff_local.sh: the chain
# replayed through 20261229000000, the TEST-001 owner account, no real Orders.
# It reads no environment file, names no linked project, never pushes.
#
# USAGE
#   BOE_DB_CONTAINER=supabase_db_<project_id> bash supabase/tests/run_order_0524_operations_handoff_local.sh
# ═════════════════════════════════════════════════════════════════════════════
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIGRATION="$HERE/../migrations/20261230000000_order_0524_operations_handoff_for_existing_approval.sql"
ASSERTIONS="$HERE/order_0524_operations_handoff_assertions.sql"

: "${BOE_DB_CONTAINER:?BOE_DB_CONTAINER must name the database container of the disposable stack}"
case "$BOE_DB_CONTAINER" in
  supabase_db_*) ;;
  *) echo "refusing: $BOE_DB_CONTAINER is not a local Supabase database container" >&2; exit 2 ;;
esac

psql_in() { docker exec -i "$BOE_DB_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q "$@"; }
scalar()  { docker exec -i "$BOE_DB_CONTAINER" psql -U postgres -d postgres -Atc "$1"; }

# ── Guards: the right kind of database, and a disposable one ──
[ "$(scalar "select to_regclass('public.order_operations_handoffs') is not null")" = "t" ] \
  || { echo "refusing: order_operations_handoffs is missing — replay the chain through 20261229000000 first" >&2; exit 3; }
[ "$(scalar "select count(*) from public.orders where client_name not like 'ASSERT%'")" = "0" ] \
  || { echo "refusing: this database holds Orders that are not test fixtures; it is not disposable" >&2; exit 4; }
[ "$(scalar "select count(*) from public.users where employee_code = 'TEST-001' and id = '11111111-1111-1111-1111-111111111111'")" = "1" ] \
  || { echo "refusing: the owner account (TEST-001, id 1111…) is missing" >&2; exit 3; }
grep -q '\$MIG\$' "$MIGRATION" && { echo "refusing: the migration contains the quoting tag \$MIG\$" >&2; exit 5; }

footprint="select (select count(*) from public.order_operations_handoffs) || '/' || (select count(*) from public.notifications)"
before="$(scalar "$footprint")"
echo "1/2 applying the migration as written, twice (no Order 0524 here: both must write nothing)"
psql_in --single-transaction -f - < "$MIGRATION" 2>&1 | grep -F "is not in this database; nothing to do"
psql_in --single-transaction -f - < "$MIGRATION" 2>&1 | grep -F "is not in this database; nothing to do"
[ "$(scalar "$footprint")" = "$before" ] || { echo "FAILED: the migration wrote to a database without Order 0524" >&2; exit 1; }

echo "2/2 assertions against a fixture shaped like Order 0524 (one transaction, rolls back)"
out="$( { printf 'select set_config(%s, $MIG$%s$MIG$, false) \\g /dev/null\n' "'test.migration'" "$(cat "$MIGRATION")"; cat "$ASSERTIONS"; } \
  | docker exec -i "$BOE_DB_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q -f - 2>&1 )" || { echo "$out" | grep -E "ERROR|ASSERT" >&2; exit 1; }
echo "$out" | grep -F "ALL ORDER 0524 HANDOFF ASSERTIONS PASSED" || { echo "$out" >&2; exit 1; }
[ "$(scalar "$footprint")" = "$before" ] || { echo "FAILED: the assertions left rows behind" >&2; exit 1; }
echo "OK: 20261230000000 is harmless without the Order, and every Order 0524 assertion holds"
