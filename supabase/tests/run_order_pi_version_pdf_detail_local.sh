#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════════════════
# TEST-ONLY RUNNER — 20270203000000_order_pi_version_pdf_detail.sql, on a
# DISPOSABLE local Supabase stack
# ═════════════════════════════════════════════════════════════════════════════
#   1. Applies the migration twice (it must be safe to apply again).
#   2. Runs order_pi_version_pdf_detail_assertions.sql (one transaction, rolled
#      back): the copy matches the original in the catalog, and answers every
#      version identically for an admin, Sales and a reader without Orders access.
#
# It will not choose its own target: BOE_DB_CONTAINER must name a local
# supabase_db_* container. It reads no environment file, names no linked
# project, never pushes. Step 1 COMMITS: use a throwaway database (BOE_DB_NAME)
# that already holds PI versions, e.g. one prepared by
# run_order_pi_version_pdf_order_number_local.sh.
#
#   BOE_DB_CONTAINER=supabase_db_<project_id> BOE_DB_NAME=<db> \
#     bash supabase/tests/run_order_pi_version_pdf_detail_local.sh
set -euo pipefail
: "${BOE_DB_CONTAINER:?set BOE_DB_CONTAINER to a local supabase_db_* container}"
[[ "$BOE_DB_CONTAINER" == supabase_db_* ]] || { echo "refusing: $BOE_DB_CONTAINER is not a local supabase_db_* container"; exit 1; }
DB=${BOE_DB_NAME:-postgres}
HERE=$(cd "$(dirname "$0")" && pwd)
MIG="$HERE/../migrations/20270203000000_order_pi_version_pdf_detail.sql"
psql_() { docker exec -i "$BOE_DB_CONTAINER" psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 -q "$@"; }

psql_ < "$MIG"
psql_ < "$MIG"
echo "applied twice"
psql_ < "$HERE/order_pi_version_pdf_detail_assertions.sql" 2>&1 | tee /dev/stderr | grep -q 'ALL PI VERSION PDF DETAIL ASSERTIONS PASSED'
echo "OK: 20270203000000 copies order_pi_version_detail exactly and answers every reader identically"
