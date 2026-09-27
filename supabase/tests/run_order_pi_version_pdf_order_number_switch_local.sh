#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════════════════
# TEST-ONLY RUNNER — the whole PI PDF Order number release, in order, on a
# DISPOSABLE local Supabase stack:
#   20270201000000 (stamps the old form) → 20270202000000 (stamps the stored form)
# ═════════════════════════════════════════════════════════════════════════════
#
# WHAT IT DOES, IN ORDER
#   1. Runs run_order_pi_version_pdf_order_number_local.sh: versions of every
#      status committed BEFORE 20270201000000, the refusal of a missing number,
#      the migration applied twice, and its assertions at stage 'old' (a new
#      version stores exactly what the route being replaced prints).
#   2. Commits versions made BETWEEN the two migrations
#      (_order_pi_version_pdf_order_number_between_versions.sql).
#   3. Applies 20270202000000 — twice, to prove it is safe to apply again.
#   4. Runs the same assertions again at stage 'stored' (a new version stores
#      "0004"), then order_pi_version_pdf_order_number_switch_assertions.sql:
#      every version keeps the number its PDF first printed.
#
# It will not choose its own target (BOE_DB_CONTAINER must name a local
# supabase_db_* container), reads no environment file, names no linked project
# and never pushes. Steps 1-3 COMMIT: use a throwaway stack or a throwaway copy
# of one (BOE_DB_NAME) that does not yet have 20270201000000.
#
# USAGE
#   BOE_DB_CONTAINER=supabase_db_<project_id> [BOE_DB_NAME=postgres] \
#     bash supabase/tests/run_order_pi_version_pdf_order_number_switch_local.sh
# ═════════════════════════════════════════════════════════════════════════════
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SWITCH="$HERE/../migrations/20270202000000_order_pi_version_pdf_order_number_stored_form.sql"
HELPERS="$HERE/_order_pi_version_pdf_order_number_helpers.sql"
BETWEEN="$HERE/_order_pi_version_pdf_order_number_between_versions.sql"
ASSERTIONS="$HERE/order_pi_version_pdf_order_number_assertions.sql"
SWITCH_ASSERTIONS="$HERE/order_pi_version_pdf_order_number_switch_assertions.sql"

: "${BOE_DB_CONTAINER:?BOE_DB_CONTAINER must name the database container of the disposable stack}"
DB="${BOE_DB_NAME:-postgres}"
case "$BOE_DB_CONTAINER" in
  supabase_db_*) ;;
  *) echo "refusing: $BOE_DB_CONTAINER is not a local Supabase database container" >&2; exit 2 ;;
esac

sql()     { tr -d '\r' < "$1"; }
psql_in() { docker exec -i "$BOE_DB_CONTAINER" psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 -q "$@"; }

echo "== stage 1: 20270201000000 (the old form), through run_order_pi_version_pdf_order_number_local.sh"
bash "$HERE/run_order_pi_version_pdf_order_number_local.sh"

echo "== stage 2: versions made between the migrations (commits)"
{ sql "$HELPERS"; sql "$BETWEEN"; } | psql_in -f - > /dev/null

echo "== stage 3: applying 20270202000000, then AGAIN (must be a no-op)"
sql "$SWITCH" | psql_in --single-transaction -f -
sql "$SWITCH" | psql_in --single-transaction -f -

echo "== stage 4: the same assertions at stage 'stored', then the switch assertions (each rolls back)"
for suite in "$ASSERTIONS" "$SWITCH_ASSERTIONS"; do
  out="$({ sql "$HELPERS"; echo "select set_config('test.stage', 'stored', false);"; sql "$suite"; } \
    | docker exec -i "$BOE_DB_CONTAINER" psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 -q -f - 2>&1)" \
    || { echo "$out" | grep -E "NOTICE|ERROR|CONTEXT" >&2; echo "FAILED: $(basename "$suite")" >&2; exit 1; }
  echo "$out" | grep -E "NOTICE:  [0-9]\.|ASSERTIONS PASSED"
  echo "$out" | grep -q "ASSERTIONS PASSED" || { echo "FAILED: no success line from $(basename "$suite")" >&2; exit 1; }
done
echo "OK: the release sequence keeps every PI version's PDF number as first printed; new versions print the stored number"
