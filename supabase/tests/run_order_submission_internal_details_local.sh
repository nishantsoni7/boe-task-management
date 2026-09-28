#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════════════════
# TEST-ONLY RUNNER — 20270122000000 / 20270123000000 (PI internal details), on
# a DISPOSABLE local database
# ═════════════════════════════════════════════════════════════════════════════
#
# Applies 20270122000000 TWICE (to prove it is safe to apply again), then runs
# order_submission_internal_details_assertions.sql, which applies
# 20270123000000 inside its own transaction and ends in ROLLBACK.
#
# It needs a database that already carries the Orders/PI chain through
# 20270120000000 (see docs/migrations-are-not-self-contained.md). A copy of a
# replayed stack's database works: pg_dump it and restore it under a new name
# in the same container, then point BOE_DB_NAME at the copy.
#
# It will not choose its own target, reads no environment file, names no linked
# project and never pushes.
#
# USAGE
#   BOE_CONFIRM_DISPOSABLE=1 BOE_DB_CONTAINER=supabase_db_<project_id> [BOE_DB_NAME=postgres] \
#     bash supabase/tests/run_order_submission_internal_details_local.sh
# ═════════════════════════════════════════════════════════════════════════════
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIGRATION_A="$HERE/../migrations/20270122000000_order_submission_internal_details.sql"
MIGRATION_B="$HERE/../migrations/20270123000000_order_submission_internal_details_required_on_submit.sql"
ASSERTIONS="$HERE/order_submission_internal_details_assertions.sql"

: "${BOE_DB_CONTAINER:?BOE_DB_CONTAINER must name the database container of the disposable stack}"
case "$BOE_DB_CONTAINER" in
  supabase_db_*) ;;
  *) echo "refusing: $BOE_DB_CONTAINER is not a local Supabase database container" >&2; exit 2 ;;
esac
DB="${BOE_DB_NAME:-postgres}"
export MSYS_NO_PATHCONV=1

psql_in() { docker exec -i "$BOE_DB_CONTAINER" psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 -q "$@"; }

# Disposable only, and said so: the caller confirms it, and the target must be
# a local Supabase container (checked above). Fails closed if it cannot even
# read the database.
if [ "${BOE_CONFIRM_DISPOSABLE:-}" != "1" ]; then
  echo "refusing: set BOE_CONFIRM_DISPOSABLE=1 to confirm $BOE_DB_CONTAINER/$DB is a disposable local database" >&2; exit 2
fi
psql_in -tAc "select 1" >/dev/null || { echo "refusing: cannot read $DB" >&2; exit 2; }

# Files go in through stdin (docker cp mangles Windows paths), CR stripped.
docker exec "$BOE_DB_CONTAINER" mkdir -p /tmp/pid/supabase/tests /tmp/pid/supabase/migrations
tr -d '\r' < "$MIGRATION_B" | docker exec -i "$BOE_DB_CONTAINER" sh -c \
  "cat > /tmp/pid/supabase/migrations/$(basename "$MIGRATION_B")"
tr -d '\r' < "$ASSERTIONS" | docker exec -i "$BOE_DB_CONTAINER" sh -c \
  'cat > /tmp/pid/supabase/tests/order_submission_internal_details_assertions.sql'

for pass in 1 2; do
  echo "── applying 20270122000000 (pass $pass)"
  tr -d '\r' < "$MIGRATION_A" | psql_in --single-transaction
done

echo "── assertions"
docker exec "$BOE_DB_CONTAINER" psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 -q \
  -f /tmp/pid/supabase/tests/order_submission_internal_details_assertions.sql 2>&1 \
  | grep -E 'NOTICE:  (section|ALL)|ERROR|ASSERTION'
