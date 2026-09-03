#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════════════════
# TEST-ONLY RUNNER — 20261104000000_boe_credits_phase_1d.sql on an isolated
# local Supabase stack carrying the REAL Review Workflow chain
# ═════════════════════════════════════════════════════════════════════════════
#
# The bare-container runner (run_boe_credits_phase_1d_local.sh) proves the
# credits functions with the verify transition stubbed out of reach. This one
# applies the full Review Workflow chain and every credits migration, then
# runs boe_credits_phase_1d_stack_assertions.sql, which verifies reviews
# through transition_customer_review_test_card() exactly as a verifier's
# browser does — the reward, its month attribution (including the 31 August
# 23:59:59 IST boundary and a returned-then-resubmitted review), a lapse, and
# the grants.
#
# Same posture and the same guard as run_boe_credits_review_reward_local.sh.
#
# PREREQUISITES
#   1. Docker running, and a local Supabase stack for THIS worktree with
#      [db.migrations] enabled = false in supabase/config.toml.
#   2. npx supabase start
#        -x studio,imgproxy,mailpit,edge-runtime,logflare,vector,supavisor,realtime,postgres-meta
#   3. NAME THE TARGET, and MARK IT DISPOSABLE:
#        export BOE_DB_CONTAINER=supabase_db_<project>
#        docker exec -i "$BOE_DB_CONTAINER" psql -U postgres -d postgres -c \
#          "comment on database postgres is 'boe-disposable-credits-phase-1d'"
#
# USAGE
#   BOE_DB_CONTAINER=supabase_db_myproject supabase/tests/run_boe_credits_phase_1d_stack_local.sh
#
# Afterwards: npx supabase stop (or db reset --no-seed for another run).

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

BASELINE="supabase/tests/bootstrap/000_customer_review_module_baseline.sql"
BEFORE="supabase/tests/_boe_credits_review_reward_before.sql"
ASSERTIONS="supabase/tests/boe_credits_phase_1d_stack_assertions.sql"
PENDING="20261104000000_boe_credits_phase_1d.sql"

# The chain the Phase 1B runner applies, plus the payroll tables the credits
# functions reference, Phase 1B and Phase 1C. Every file must match HEAD.
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
)
# Applied after the "before" fixture, so the historical verified review earns nothing from any of them.
AFTER_FIXTURE=(
  "20261102000000_boe_credits_review_reward.sql"
  "20261103000000_boe_credits_attendance_redemption.sql"
)

MARKER="boe-disposable-credits-phase-1d"

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

for m in "${MIGRATIONS[@]}" "${AFTER_FIXTURE[@]}"; do
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
  echo "      $m"
  psql_file "$REPO/supabase/migrations/$m"
done

echo "── 3. the world before Phase 1B: people, grants, one historical verified review"
psql_file "$REPO/$BEFORE"

echo "── 4. Phase 1B and Phase 1C"
for m in "${AFTER_FIXTURE[@]}"; do
  echo "      $m"
  psql_file "$REPO/supabase/migrations/$m"
done

echo "── 5. the migration under test: $PENDING"
psql_file "$REPO/supabase/migrations/$PENDING"

echo "── 6. the same file again — it must be safe to apply twice"
psql_file "$REPO/supabase/migrations/$PENDING"

echo "── 7. $ASSERTIONS"
set +e
OUTPUT="$(docker exec -i "$DB_CONTAINER" psql -U postgres -d "$DB_NAME" -v ON_ERROR_STOP=1 < "$REPO/$ASSERTIONS" 2>&1)"
STATUS=$?
set -e
printf '%s\n' "$OUTPUT" | grep -E 'NOTICE|ERROR|FATAL|ASSERT' | sed 's/^psql:[^ ]* *//; s/^NOTICE:  //'

if [ $STATUS -ne 0 ] || ! printf '%s' "$OUTPUT" | grep -q 'ALL ASSERTIONS PASSED'; then
  echo "FAIL: the assertions did not reach the end (psql exit $STATUS)" >&2
  exit 1
fi

echo
echo "OK: $PENDING applied twice on the Review Workflow chain and every assertion passed on $DB_CONTAINER/$DB_NAME."
