#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════════════════
# TEST-ONLY RUNNER — 20261108000000, on an isolated local database
# ═════════════════════════════════════════════════════════════════════════════
#
# WHAT THIS IS FOR
# ----------------
# batchSize.test.ts and variableBatchWorkflow.test.ts read the migration's TEXT
# and model the SELECT policy in TypeScript. This EXECUTES both — the migration
# and the policy — on a throwaway database, which is the only way to prove that
# Postgres agrees with the model.
#
# The runner reconstructs the minimum real prerequisite chain required by the
# Review Workflow, BOE Credits and Payroll objects touched by the migrations
# under test.
#
# WHAT IT PROVES, IN ORDER
# ------------------------
#   1. the migration APPLIES to a production-equivalent database — every real
#      prerequisite, applied whole and unmodified;
#   2. an EIGHT-DRAFT historical batch is created BEFORE 20261031000000 changes
#      new batches from eight drafts to twelve, and remains valid afterward;
#   3. the pending variable-size migration also leaves that historical batch
#      valid and readable;
#   4. a batch of SEVENTEEN is legal and is 11 text + 6 image; six and twenty
#      are legal; five, twenty-one and a count mismatch are refused;
#   5. CANDIDATE ISOLATION THROUGH RLS, at seventeen: the assigned candidate
#      reads all seventeen, another candidate reads none, the verifier reads
#      them. Asserted with `set local role authenticated` and real
#      request.jwt.claims, so the policy is evaluated by Postgres rather than
#      described by a test;
#   6. `intended_for` grants nothing: a batch generated FOR a candidate and not
#      yet assigned is invisible to them, drafts and batch row alike;
#   7. the FIVE-ARGUMENT COMPATIBILITY WRAPPER still makes a twelve-review
#      batch, so applying this migration cannot break the bundle that is live at
#      the moment it is applied.
#
# WHAT IT WILL NOT DO
# -------------------
# It will not choose its own target: BOE_DB_CONTAINER must name the container.
# It will not run against a database that has not been marked disposable, or
# whose marker does not match. It will not run if public holds tables, if
# auth.users holds identities, if storage holds objects, or if the migration
# ledger has history. It will not run if a prerequisite migration differs from
# HEAD, because a run proves nothing if the ground under the pending file has
# shifted.
#
# It never resets, never deletes, never repairs, never edits a migration, and
# never contacts anything outside the named local container. Every guard runs
# before the first statement is applied, so a refusal leaves the database
# untouched. Nothing here calls a model and no ANTHROPIC_API_KEY is read: the
# drafts are supplied as literal JSON by the assertions.
#
# PREREQUISITES
# -------------
#   1. Docker running, and a local Supabase stack for this repo.
#
#      In supabase/config.toml automatic migrations must be disabled:
#
#        [db.migrations]
#        enabled = false
#
#   2. Start the disposable local stack:
#
#        npx supabase start
#
#   3. Reset it before every clean run:
#
#        npx supabase db reset --no-seed
#
#   4. NAME THE TARGET, and MARK IT DISPOSABLE:
#
#        export BOE_DB_CONTAINER=supabase_db_<your-project>
#
#        docker exec -i "$BOE_DB_CONTAINER" \
#          psql -U postgres -d postgres -c \
#          "comment on database postgres is 'boe-disposable-variable-batch-size'"
#
# USAGE
# -----
#   BOE_DB_CONTAINER=supabase_db_myproject \
#     supabase/tests/run_variable_batch_size_local.sh

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

BASELINE="supabase/tests/bootstrap/000_customer_review_module_baseline.sql"
HISTORY="supabase/tests/_review_workflow_eight_draft_history_before.sql"
ASSERTIONS="supabase/tests/variable_batch_size_assertions.sql"

# THE FILE UNDER REVIEW. It alone may differ from HEAD; every prerequisite
# migration must match HEAD.
PENDING="20261108000000_review_workflow_variable_batch_size.sql"

# ─────────────────────────────────────────────────────────────────────────────
# MIGRATION CHAIN
#
# This is the minimum real dependency chain required to reproduce the Review
# Workflow schema immediately before 20261108000000.
#
# Important historical ordering:
#
#   _review_workflow_eight_draft_history_before.sql
#
# is NOT part of this array because it must be inserted specifically AFTER
# 20261030000000 and BEFORE
# 20261031000000_review_workflow_twelve_drafts_editing_and_images.sql.
# ─────────────────────────────────────────────────────────────────────────────
MIGRATIONS=(
  "20260609_create_attendance_records.sql"
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

  "20260611_create_payroll_periods.sql"
  "20260612000000_create_payroll_generation_tables.sql"

  "20261101000000_boe_credits_foundation.sql"
  "20261102000000_boe_credits_review_reward.sql"
  "20261103000000_boe_credits_attendance_redemption.sql"
  "20261104000000_boe_credits_phase_1d.sql"

  "20261107000000_review_types_assignment_and_image_groups.sql"

  "$PENDING"
)

MARKER="boe-disposable-variable-batch-size"

# ── The target is named, never guessed ──────────────────────────────────────

if [ -z "${BOE_DB_CONTAINER:-}" ]; then
  echo "FATAL: BOE_DB_CONTAINER is not set." >&2
  echo "       Name the container explicitly; this script will not choose one." >&2
  echo "       Running Supabase database containers:" >&2

  docker ps --format '{{.Names}}' \
    | grep '^supabase_db_' \
    | sed 's/^/         /' >&2 || true

  echo "       Nothing was written." >&2
  exit 1
fi

DB_CONTAINER="$BOE_DB_CONTAINER"

if ! docker ps --format '{{.Names}}' | grep -qx "$DB_CONTAINER"; then
  echo "FATAL: no running container named $DB_CONTAINER." >&2
  echo "       Nothing was written." >&2
  exit 1
fi

DB_NAME="${BOE_DB_NAME:-postgres}"

# The gate lives in its own file so the tests exercise the same code this script
# trusts, rather than a second copy of it.
#
# shellcheck source=supabase/tests/lib/disposable_stack_guard.sh
. "$REPO/supabase/tests/lib/disposable_stack_guard.sh"

psql_file() {
  docker exec -i "$DB_CONTAINER" \
    psql \
      -U postgres \
      -d "$DB_NAME" \
      -v ON_ERROR_STOP=1 \
      -q < "$1"
}

# ── SAY WHAT IS ABOUT TO BE WRITTEN TO, BEFORE WRITING ──────────────────────

if ! TARGET_DB="$(_psql_raw 'select current_database()')"; then
  echo "FATAL: could not query $DB_CONTAINER at all." >&2
  printf '%s\n' "$TARGET_DB" | sed 's/^/         /' >&2
  echo "       Nothing was written." >&2
  exit 1
fi

TARGET_MARKER="$(
  _psql_raw \
    "select coalesce(
       shobj_description(oid, 'pg_database'),
       '(none)'
     )
     from pg_database
     where datname = current_database()" \
  || true
)"

echo "══ target"
echo "──   container : $DB_CONTAINER"
echo "──   database  : $TARGET_DB"
echo "──   marker    : $TARGET_MARKER"
echo

require_disposable_stack || exit 1

echo "══ marker present; public, auth, storage and the ledger are all empty — safe to build"
echo

step=0

next_step() {
  step=$((step + 1))
  echo
  echo "══ step $step  $1"
}

# ── TEST-ONLY BASELINE ───────────────────────────────────────────────────────

next_step "baseline (TEST-ONLY, not a migration)"
echo "──      $BASELINE"

psql_file "$REPO/$BASELINE"

echo "        ✓ applied"

# ── REAL MIGRATIONS ──────────────────────────────────────────────────────────

for m in "${MIGRATIONS[@]}"; do

  PENDING_NOTE=""

  # ───────────────────────────────────────────────────────────────────────────
  # HISTORICAL EIGHT-DRAFT FIXTURE
  #
  # This MUST happen before 20261031000000.
  #
  # At this point create_customer_review_draft_batch() still creates exactly
  # eight drafts. 20261031000000 changes future batches to twelve while its
  # NOT VALID constraints deliberately preserve historical eight-draft rows.
  #
  # Putting this fixture immediately before that migration proves the migration
  # actually preserves genuine old history rather than a manually inserted
  # imitation.
  # ───────────────────────────────────────────────────────────────────────────
  if [ "$m" = "20261031000000_review_workflow_twelve_drafts_editing_and_images.sql" ]; then

    next_step "$HISTORY (TEST-ONLY)"

    psql_file "$REPO/$HISTORY"

    echo "        ✓ pre-20261031000000 eight-draft history seeded"
  fi

  # ── Only the pending migration may differ from HEAD ───────────────────────
  if [ "$m" = "$PENDING" ]; then

    if git -C "$REPO" diff --quiet HEAD -- "supabase/migrations/$m" 2>/dev/null; then
      PENDING_NOTE="(unchanged from HEAD)"
    else
      PENDING_NOTE="NEW or MODIFIED vs HEAD — this run tests the working-tree version"
    fi

  elif ! git -C "$REPO" diff --quiet HEAD -- "supabase/migrations/$m"; then

    echo "FATAL: prerequisite supabase/migrations/$m differs from HEAD. Refusing to run." >&2
    exit 1

  fi

  # ── Apply the real migration ───────────────────────────────────────────────
  next_step "$m"

  if [ -n "$PENDING_NOTE" ]; then
    echo "        $PENDING_NOTE"
  fi

  psql_file "$REPO/supabase/migrations/$m"

  echo "        ✓ applied"

  # ───────────────────────────────────────────────────────────────────────────
  # After 20261031000000 the historical eight-draft batch must still exist.
  # This proves the original 8 → 12 migration behaved as promised.
  # ───────────────────────────────────────────────────────────────────────────
  if [ "$m" = "20261031000000_review_workflow_twelve_drafts_editing_and_images.sql" ]; then

    HISTORICAL_AFTER_TWELVE="$(
      _psql_raw \
        "select card_count || '/' || expected_count
           from public.customer_review_draft_batches
          where card_count = 8
          limit 1"
    )"

    if [ "$HISTORICAL_AFTER_TWELVE" != "8/8" ]; then
      echo "FATAL: after 20261031000000 the historical batch reads" \
           "'$HISTORICAL_AFTER_TWELVE', expected '8/8'." >&2
      exit 1
    fi

    echo "        ✓ historical eight-draft batch survived the 8 → 12 migration"
  fi

  # ───────────────────────────────────────────────────────────────────────────
  # After the pending variable-size migration the SAME historical batch must
  # still exist and still report 8/8.
  # ───────────────────────────────────────────────────────────────────────────
  if [ "$m" = "$PENDING" ]; then

    SURVIVED="$(
      _psql_raw \
        "select card_count || '/' || expected_count
           from public.customer_review_draft_batches
          where card_count = 8
          limit 1"
    )"

    if [ "$SURVIVED" != "8/8" ]; then
      echo "FATAL: after the variable-size migration the historical batch reads" \
           "'$SURVIVED', expected '8/8'." >&2
      exit 1
    fi

    echo "        ✓ the eight-draft batch survived the variable-size migration intact"
  fi

done

# ── THE PENDING MIGRATION MUST BE IDEMPOTENT ────────────────────────────────

next_step "$PENDING again — re-applying must be a no-op"

psql_file "$REPO/supabase/migrations/$PENDING"

echo "        ✓ re-applied cleanly"

# ── EXECUTE THE REAL DATABASE ASSERTIONS ────────────────────────────────────

next_step "$ASSERTIONS"

psql_file "$REPO/$ASSERTIONS"

# ── SUCCESS ──────────────────────────────────────────────────────────────────

echo
echo "══ all $step steps passed"
echo "══ The migration applied to a production-equivalent disposable database."
echo "══ A genuine eight-draft historical batch was created before the 8 → 12"
echo "══ migration and survived both that migration and the new variable-size"
echo "══ migration. Batches of 6, 17 and 20 were created; 5, 21 and a count"
echo "══ mismatch were refused. Candidate isolation at seventeen was proved"
echo "══ THROUGH RLS with a real authenticated role; intended_for was shown to"
echo "══ grant nothing; and the five-argument compatibility wrapper still makes"
echo "══ a twelve-review batch."
echo "══ No model was called and no external network was contacted."