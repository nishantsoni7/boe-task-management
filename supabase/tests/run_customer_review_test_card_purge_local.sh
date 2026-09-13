#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════════════════
# TEST-ONLY RUNNER — 20261209000000_customer_review_test_card_admin_purge.sql,
# on an isolated local Supabase stack
# ═════════════════════════════════════════════════════════════════════════════
#
# testCardPurge.test.ts reads the migration's TEXT and drives the route's order
# of work against a fake. This EXECUTES the migration on the real Review
# Workflow and BOE Credits chain and runs
# customer_review_test_card_purge_assertions.sql against it, twice.
#
# WHAT IT TARGETS
# ---------------
# A LOCAL SUPABASE STACK, not a bare container: the purge reads storage.objects
# and the chain needs auth.uid(), the storage schema and the client roles. Same
# posture and the same guard as run_boe_credits_phase_1d_stack_local.sh, with
# the chain extended to 20261208000000.
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
#          "comment on database postgres is 'boe-disposable-review-test-card-purge'"
#
# USAGE
#   BOE_DB_CONTAINER=supabase_db_myproject supabase/tests/run_customer_review_test_card_purge_local.sh
#
# Afterwards: npx supabase stop (or db reset --no-seed for another run).

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

BASELINE="supabase/tests/bootstrap/000_customer_review_module_baseline.sql"
# The platform's notifications table, which no migration creates; 20261206000000
# adds values to its type and inserts into it.
NOTIFICATION_STUBS="supabase/tests/bootstrap/005_custom_review_phase_stubs.sql"
ASSERTIONS="supabase/tests/customer_review_test_card_purge_assertions.sql"
PENDING="20261209000000_customer_review_test_card_admin_purge.sql"

MIGRATIONS=(
  "20260609_create_attendance_records.sql"
  "20260611_create_payroll_periods.sql"
  "20260612000000_create_payroll_generation_tables.sql"
  "20260616_add_generated_status_to_payroll_periods.sql"
  "20260645_create_control_center_v1.sql"
  "20260660_create_permission_engine.sql"
  "20260661_add_permission_engine_bulk_resolver.sql"
  "20260662_fix_permission_resolver_team_cast.sql"
  "20261017000000_customer_review_outreach.sql"
  "20261023000000_review_workflow_ai_drafts.sql"
  "20261025000000_review_workflow_remove_legacy_test_data.sql"
  "20261026000000_review_workflow_batch_approval.sql"
  "20261027000000_review_workflow_generation_claims.sql"
  "20261030000000_review_workflow_deletion_and_replacement.sql"
  "20261031000000_review_workflow_twelve_drafts_editing_and_images.sql"
  "20261101000000_boe_credits_foundation.sql"
  "20261102000000_boe_credits_review_reward.sql"
  "20261103000000_boe_credits_attendance_redemption.sql"
  "20261104000000_boe_credits_phase_1d.sql"
  "20261107000000_review_types_assignment_and_image_groups.sql"
  "20261108000000_review_workflow_variable_batch_size.sql"
  "20261114000000_review_generation_word_range_and_body_length.sql"
  "20261123000000_review_native_share_records_the_open.sql"
  "20261204000000_boe_credits_decimal_credits.sql"
  "20261205000000_customer_review_custom_submissions.sql"
  "@notification_stubs"
  "20261206000000_customer_review_custom_reapply_and_monthly_rules.sql"
  "20261207000000_customer_review_reapplied_event_attempt_number.sql"
  "20261208000000_boe_credits_redemption_toggles.sql"
)

MARKER="boe-disposable-review-test-card-purge"

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
  [ "$m" = "@notification_stubs" ] && continue
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

echo "── 1. test-only baseline (NOT a migration)"
psql_file "$REPO/$BASELINE"

echo "── 2. the real chain, in order"
for m in "${MIGRATIONS[@]}"; do
  if [ "$m" = "@notification_stubs" ]; then
    echo "      $NOTIFICATION_STUBS (TEST-ONLY)"
    psql_file "$REPO/$NOTIFICATION_STUBS"
    continue
  fi
  echo "      $m"
  psql_file "$REPO/supabase/migrations/$m"
done

echo "── 3. the migration under test: $PENDING"
psql_file "$REPO/supabase/migrations/$PENDING"

echo "── 4. the same file again — it must be safe to apply twice"
psql_file "$REPO/supabase/migrations/$PENDING"

for pass in 1 2; do
  echo "── $((4 + pass)). $ASSERTIONS (pass $pass of 2 — one transaction, rolled back)"
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
echo "OK: $PENDING applied twice on the Review Workflow chain and every assertion passed twice on $DB_CONTAINER/$DB_NAME."
