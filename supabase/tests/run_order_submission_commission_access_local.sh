#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════════════════
# TEST-ONLY RUNNER — who can read and change a PI's middleman commission
# (20270122000000 §1b, §5), on a DISPOSABLE local database
# ═════════════════════════════════════════════════════════════════════════════
#
# Applies 20270122000000 TWICE (safe to apply again), then runs
# order_submission_commission_access_assertions.sql, which builds a draft, a
# returned, a submitted and an Order-linked PI from synthetic records, reads
# them as every allowed and refused audience, and ends in ROLLBACK.
#
# Needs a database carrying the Orders/PI chain through 20270120000000 and the
# order-files bucket. It will not choose its own target, reads no environment
# file, names no linked project and never pushes.
#
# USAGE
#   BOE_CONFIRM_DISPOSABLE=1 BOE_DB_CONTAINER=supabase_db_<project_id> [BOE_DB_NAME=postgres] \
#     bash supabase/tests/run_order_submission_commission_access_local.sh
# ═════════════════════════════════════════════════════════════════════════════
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIGRATION="$HERE/../migrations/20270122000000_order_submission_internal_details.sql"
ASSERTIONS="$HERE/order_submission_commission_access_assertions.sql"

: "${BOE_DB_CONTAINER:?BOE_DB_CONTAINER must name the database container of the disposable stack}"
case "$BOE_DB_CONTAINER" in
  supabase_db_*) ;;
  *) echo "refusing: $BOE_DB_CONTAINER is not a local Supabase database container" >&2; exit 2 ;;
esac
DB="${BOE_DB_NAME:-postgres}"
export MSYS_NO_PATHCONV=1

if [ "${BOE_CONFIRM_DISPOSABLE:-}" != "1" ]; then
  echo "refusing: set BOE_CONFIRM_DISPOSABLE=1 to confirm $BOE_DB_CONTAINER/$DB is a disposable local database" >&2; exit 2
fi
psql_in() { docker exec -i "$BOE_DB_CONTAINER" psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 -q "$@"; }
psql_in -tAc "select 1" >/dev/null || { echo "refusing: cannot read $DB" >&2; exit 2; }

for pass in 1 2; do
  echo "── applying 20270122000000 (pass $pass)"
  tr -d '\r' < "$MIGRATION" | psql_in --single-transaction
done

echo "── assertions"
tr -d '\r' < "$ASSERTIONS" | psql_in 2>&1 | grep -E 'NOTICE:  (section|ALL)|ERROR|ASSERT'
