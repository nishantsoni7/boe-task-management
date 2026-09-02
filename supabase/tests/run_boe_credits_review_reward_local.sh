#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════════════════
# TEST-ONLY RUNNER — 20261102000000_boe_credits_review_reward.sql, on an
# isolated local Supabase stack
# ═════════════════════════════════════════════════════════════════════════════
#
# WHAT THIS IS FOR
# ----------------
# src/lib/boeCredits/reviewReward.test.ts reads the migration's TEXT and checks
# it says the right things. This executes it, on the REAL Review Workflow chain
# and the REAL BOE Credits foundation, and runs
# boe_credits_review_reward_assertions.sql against the result.
#
# WHAT IT PROVES, IN ORDER
# ------------------------
#   1. the migration APPLIES on top of the production Review Workflow and the
#      Phase 1A foundation — every real prerequisite, whole and unmodified;
#   2. it is SAFE TO APPLY TWICE;
#   3. it REWARDS NOTHING BY ITSELF: a review verified before it applies has no
#      reward afterwards (the fixture creates one; §5 checks it);
#   4. the Phase 1B rules hold AT THE DATABASE: one reward per verification for
#      the holder from the active setting; a retry refused before any reward;
#      a forged duplicate refused by the index; returns, submits, refused and
#      deleted reviews earning nothing; reviewers unable to verify, to post, or
#      to read a colleague's reward; and Phase 1A's sum, immutability and
#      reversal rules unchanged with review rewards in the ledger.
#
# WHAT IT TARGETS
# ---------------
# A LOCAL SUPABASE STACK, not a bare container: 20261017000000 creates storage
# policies and the chain needs auth.uid(), storage.objects and the client
# roles the platform provides. Same posture and same guard as
# run_review_workflow_twelve_and_images_local.sh, whose chain this extends by
# the three files that came after it: 20261031000000 (now applied in
# production), 20261101000000 (the foundation) and the file under test. It
# adds 20260611_create_payroll_periods.sql, which the foundation references.
#
# WHAT IT WILL NOT DO
# -------------------
# It will not choose its own target: BOE_DB_CONTAINER must name the container.
# It will not run against a database that has not been marked disposable, or
# whose marker does not match. It will not run if public holds tables, if
# auth.users holds identities, if storage holds objects or buckets, or if the
# migration ledger has history. It will not run if a prerequisite migration
# differs from HEAD.
#
# It never resets, never deletes, never repairs, never edits a migration, and
# never contacts anything outside the named local container.
#
# PREREQUISITES
# -------------
#   1. Docker running, and a local Supabase stack for THIS worktree with
#      [db.migrations] enabled = false in supabase/config.toml (config.toml is
#      deliberately not committed: its ports are per-machine).
#   2. npx supabase start   (a minimal stack is enough:
#        -x studio,imgproxy,mailpit,edge-runtime,logflare,vector,supavisor,realtime,postgres-meta)
#   3. NAME THE TARGET, and MARK IT DISPOSABLE:
#        export BOE_DB_CONTAINER=supabase_db_<project>
#        docker exec -i "$BOE_DB_CONTAINER" psql -U postgres -d postgres -c \
#          "comment on database postgres is 'boe-disposable-credits-review-reward'"
#
# USAGE
#   BOE_DB_CONTAINER=supabase_db_myproject supabase/tests/run_boe_credits_review_reward_local.sh
#
# Afterwards: npx supabase stop (or db reset --no-seed for another run).

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

BASELINE="supabase/tests/bootstrap/000_customer_review_module_baseline.sql"
BEFORE="supabase/tests/_boe_credits_review_reward_before.sql"
ASSERTIONS="supabase/tests/boe_credits_review_reward_assertions.sql"

# THE FILE UNDER REVIEW. It alone may differ from HEAD; every other migration
# must match it.
PENDING="20261102000000_boe_credits_review_reward.sql"

MIGRATIONS=(
  "20260609_create_attendance_records.sql"
  "20260611_create_payroll_periods.sql"
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

MARKER="boe-disposable-credits-review-reward"

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
if git -C "$REPO" ls-files --error-unmatch "supabase/migrations/$PENDING" >/dev/null 2>&1; then
  if git -C "$REPO" diff --quiet HEAD -- "supabase/migrations/$PENDING"; then
    echo "   $PENDING: tracked, identical to HEAD"
  else
    echo "   $PENDING: tracked, MODIFIED in the working tree"
  fi
else
  echo "   $PENDING: untracked (not yet committed)"
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

echo "── 4. the migration under test: $PENDING"
psql_file "$REPO/supabase/migrations/$PENDING"

echo "── 5. the same file again — it must be safe to apply twice"
psql_file "$REPO/supabase/migrations/$PENDING"

echo "── 6. $ASSERTIONS"
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
