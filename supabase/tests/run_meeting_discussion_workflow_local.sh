#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════════════════
# TEST-ONLY RUNNER — 20261213000000_meeting_order_discussion_workflow.sql,
# on an isolated local Supabase stack
# ═════════════════════════════════════════════════════════════════════════════
#
# discussionSchema.test.ts reads the migration's TEXT. This EXECUTES it on the
# real Meetings chain and runs meeting_discussion_workflow_assertions.sql against
# it twice — every scenario acting as a real user through RLS, in one transaction
# that is rolled back.
#
# WHAT IT TARGETS
# ---------------
# A LOCAL SUPABASE STACK, not a bare container: the workflow needs auth.uid(),
# the storage schema (evidence) and the client roles. Same guard as
# run_customer_review_test_card_purge_local.sh.
#
# WHAT IT WILL NOT DO
# -------------------
# It will not choose its own target, run on a database not marked disposable,
# run if public, auth, storage or the ledger hold anything, or run if a
# prerequisite migration differs from HEAD. It never resets, never deletes and
# never contacts anything outside the named container.
#
# PREREQUISITES
#   1. Docker running, and a local Supabase stack with
#      [db.migrations] enabled = false in its config.toml.
#   2. npx supabase start
#        -x studio,imgproxy,mailpit,edge-runtime,logflare,vector,supavisor,realtime,postgres-meta
#   3. NAME THE TARGET, and MARK IT DISPOSABLE:
#        export BOE_DB_CONTAINER=supabase_db_<project>
#        docker exec -i "$BOE_DB_CONTAINER" psql -U postgres -d postgres -c \
#          "comment on database postgres is 'boe-disposable-meeting-discussion-workflow'"
#
# USAGE
#   BOE_DB_CONTAINER=supabase_db_myproject supabase/tests/run_meeting_discussion_workflow_local.sh
#
# Afterwards: npx supabase stop (or db reset --no-seed for another run).

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Production's default privileges, BEFORE anything is created. See the file.
DEFAULT_PRIVILEGES="supabase/tests/bootstrap/006_meeting_discussion_default_privileges.sql"
BASELINE="supabase/tests/bootstrap/000_customer_review_module_baseline.sql"
# public.tasks and module_entry_open(), which the Meetings chain needs and cannot get.
STUBS="supabase/tests/bootstrap/007_meeting_discussion_stubs.sql"
# The six meeting-table entry gates from 20260905000000, once the tables exist.
GATES="supabase/tests/bootstrap/008_meeting_discussion_gates.sql"
ASSERTIONS="supabase/tests/meeting_discussion_workflow_assertions.sql"
PENDING="20261213000000_meeting_order_discussion_workflow.sql"

MIGRATIONS=(
  "20260609_create_attendance_records.sql"
  "20260611_create_payroll_periods.sql"
  "20260612000000_create_payroll_generation_tables.sql"
  "20260616_add_generated_status_to_payroll_periods.sql"
  "20260645_create_control_center_v1.sql"
  "20260660_create_permission_engine.sql"
  "20260661_add_permission_engine_bulk_resolver.sql"
  "20260662_fix_permission_resolver_team_cast.sql"
  "@stubs"
  "20260814000000_create_meetings_module.sql"
  "20260815000000_fix_meetings_select_policy.sql"
  "20260831000000_meeting_pi_import.sql"
  "@gates"
  "20261203000000_meeting_order_evidence.sql"
)

MARKER="boe-disposable-meeting-discussion-workflow"

if [ -z "${BOE_DB_CONTAINER:-}" ]; then
  echo "FATAL: BOE_DB_CONTAINER is not set." >&2
  echo "       Name the container explicitly; this script will not choose one." >&2
  docker ps --format '{{.Names}}' | grep '^supabase_db_' | sed 's/^/         /' >&2 || true
  exit 1
fi
DB_CONTAINER="$BOE_DB_CONTAINER"

if ! docker ps --format '{{.Names}}' | grep -qx "$DB_CONTAINER"; then
  echo "FATAL: no running container named $DB_CONTAINER. Nothing was written." >&2
  exit 1
fi

DB_NAME="${BOE_DB_NAME:-postgres}"

# shellcheck source=supabase/tests/lib/disposable_stack_guard.sh
. "$REPO/supabase/tests/lib/disposable_stack_guard.sh"

psql_file() {
  docker exec -i "$DB_CONTAINER" psql -U postgres -d "$DB_NAME" -v ON_ERROR_STOP=1 -q < "$1"
}

echo "── target: container $DB_CONTAINER, database $DB_NAME"
require_disposable_stack || exit 1
echo "   disposable marker present; public, auth, storage and the ledger are empty"

for m in "${MIGRATIONS[@]}"; do
  case "$m" in @*) continue ;; esac
  if [ ! -f "$REPO/supabase/migrations/$m" ]; then
    echo "FATAL: prerequisite supabase/migrations/$m is missing. Refusing to run." >&2
    exit 1
  elif ! git -C "$REPO" diff --quiet HEAD -- "supabase/migrations/$m"; then
    echo "FATAL: prerequisite supabase/migrations/$m differs from HEAD. Refusing to run." >&2
    exit 1
  fi
done
if [ ! -f "$REPO/supabase/migrations/$PENDING" ]; then
  echo "FATAL: supabase/migrations/$PENDING is missing." >&2
  exit 1
fi

echo "── 1. production's default privileges (TEST-ONLY, before anything exists)"
psql_file "$REPO/$DEFAULT_PRIVILEGES"

echo "── 2. test-only baseline (NOT a migration)"
psql_file "$REPO/$BASELINE"

echo "── 3. the real chain, in order"
for m in "${MIGRATIONS[@]}"; do
  case "$m" in
    "@stubs") echo "      $STUBS (TEST-ONLY)"; psql_file "$REPO/$STUBS"; continue ;;
    "@gates") echo "      $GATES (TEST-ONLY)"; psql_file "$REPO/$GATES"; continue ;;
  esac
  echo "      $m"
  psql_file "$REPO/supabase/migrations/$m"
done

echo "── 4. the migration under test: $PENDING"
psql_file "$REPO/supabase/migrations/$PENDING"

echo "── 5. the same file again — it must be safe to apply twice"
psql_file "$REPO/supabase/migrations/$PENDING"

for pass in 1 2; do
  echo "── $((5 + pass)). $ASSERTIONS (pass $pass of 2 — one transaction, rolled back)"
  set +e
  OUTPUT="$(docker exec -i "$DB_CONTAINER" psql -U postgres -d "$DB_NAME" -v ON_ERROR_STOP=1 < "$REPO/$ASSERTIONS" 2>&1)"
  STATUS=$?
  set -e
  if [ "$pass" = 1 ]; then
    printf '%s\n' "$OUTPUT" | grep -E 'NOTICE|ERROR|FATAL|ASSERT' | sed 's/^psql:[^ ]* *//; s/^NOTICE:  //'
  fi
  if [ $STATUS -ne 0 ] || ! printf '%s' "$OUTPUT" | grep -q 'ALL ASSERTIONS PASSED'; then
    printf '%s\n' "$OUTPUT" | grep -E 'ERROR|FATAL|ASSERT|CONTEXT' >&2 || true
    echo "FAIL: the assertions did not reach the end on pass $pass (psql exit $STATUS)" >&2
    exit 1
  fi
done

echo
echo "OK: $PENDING applied twice on the Meetings chain and every assertion passed twice on $DB_CONTAINER/$DB_NAME."
