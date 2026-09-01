#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════════════════
# TEST-ONLY RUNNER — 20261031000000, on an isolated local database
# ═════════════════════════════════════════════════════════════════════════════
#
# WHAT THIS IS FOR
# ----------------
# twelveDrafts.test.ts, draftEditing.test.ts and reviewImages.test.ts read the
# migration's TEXT and check it says the right things. This executes it.
#
# The distinction is not academic. On its first run this harness found a defect
# no text audit was going to reveal: begin_customer_review_image_removal()
# refused to take an image OFF an approved review, and nothing refused putting
# one ON. Both halves read correctly on their own; only running them together
# showed that the window had one side.
#
# WHAT IT PROVES, IN ORDER
# ------------------------
#   1. the migration APPLIES to a production-equivalent database — every real
#      prerequisite, applied whole and unmodified;
#   2. it applies to one that already holds an EIGHT-DRAFT BATCH, made by the
#      old generator, and leaves it valid and readable. That is the whole point
#      of the NOT VALID constraints, and it cannot be tested against an empty
#      table;
#   3. a new batch is exactly twelve — eleven, thirteen and the retired eight
#      are all refused, and none of them writes anything;
#   4. the new functions do what they say: edit_customer_review_draft(),
#      begin_/finish_customer_review_image_removal(), and the revised
#      create/approve pair;
#   5. the image slot rules hold AT THE DATABASE — four slots, no fifth, no
#      collision between the two image kinds, and a freed slot reusable;
#   6. the permission and state rules hold: only `verify`, only while pending,
#      approved text and images frozen, and approved images still readable to
#      the person who will share them.
#
# WHAT IT WILL NOT DO
# -------------------
# It will not choose its own target: BOE_DB_CONTAINER must name the container.
# It will not run against a database that has not been marked disposable, or
# whose marker does not match. It will not run if public holds tables, if
# auth.users holds identities, if storage holds objects or buckets, or if the
# migration ledger has history. It will not run if a prerequisite migration
# differs from HEAD, because a run proves nothing if the ground under the
# pending file has shifted.
#
# It never resets, never deletes, never repairs, never edits a migration, and
# never contacts anything outside the named local container. Every guard runs
# before the first statement is applied, so a refusal leaves the database
# untouched. Nothing here calls a model, and no ANTHROPIC_API_KEY is read: the
# drafts are supplied as literal JSON by the harness.
#
# PREREQUISITES
# -------------
#   1. Docker running, and a local Supabase stack for this repo:
#
#        npx supabase init          # if supabase/config.toml does not exist
#
#      Then, in supabase/config.toml, turn OFF automatic migrations:
#
#        [db.migrations]
#        enabled = false
#
#      Without that, `supabase start` tries the full history and dies on the
#      first file. (config.toml is deliberately not committed: its ports are
#      per-machine.)
#
#   2. npx supabase start
#   3. npx supabase db reset --no-seed
#
#   4. NAME THE TARGET, and MARK IT DISPOSABLE. Both are deliberate acts:
#
#        export BOE_DB_CONTAINER=supabase_db_<your-project>
#        docker exec -i "$BOE_DB_CONTAINER" psql -U postgres -d postgres -c \
#          "comment on database postgres is 'boe-disposable-review-twelve-and-images'"
#
# USAGE
#   BOE_DB_CONTAINER=supabase_db_myproject \
#     supabase/tests/run_review_workflow_twelve_and_images_local.sh

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

BASELINE="supabase/tests/bootstrap/000_customer_review_module_baseline.sql"
HISTORY="supabase/tests/_review_workflow_eight_draft_history_before.sql"
ASSERTIONS="supabase/tests/review_workflow_twelve_and_images_assertions.sql"

# THE FILE UNDER REVIEW. It alone may differ from HEAD; every other migration
# must match it.
PENDING="20261031000000_review_workflow_twelve_drafts_editing_and_images.sql"

# The chain, in the order it must apply. The five at the top are the real
# prerequisites the module's own history cannot supply — see
# docs/migrations-are-not-self-contained.md — and the rest is the Review
# Workflow as production has it today.
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
  "$PENDING"
)

MARKER="boe-disposable-review-twelve-and-images"

# ── The target is named, never guessed ──────────────────────────────────────
if [ -z "${BOE_DB_CONTAINER:-}" ]; then
  echo "FATAL: BOE_DB_CONTAINER is not set." >&2
  echo "       Name the container explicitly; this script will not choose one." >&2
  echo "       Running Supabase database containers:" >&2
  docker ps --format '{{.Names}}' | grep '^supabase_db_' | sed 's/^/         /' >&2 || true
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
# shellcheck source=supabase/tests/lib/disposable_stack_guard.sh
. "$REPO/supabase/tests/lib/disposable_stack_guard.sh"

psql_file() {
  # ON_ERROR_STOP=1 makes the first error abort the file rather than leaving a
  # half-applied migration behind.
  docker exec -i "$DB_CONTAINER" psql -U postgres -d "$DB_NAME" -v ON_ERROR_STOP=1 -q < "$1"
}

# ── SAY WHAT IS ABOUT TO BE WRITTEN TO, BEFORE WRITING ──────────────────────
if ! TARGET_DB="$(_psql_raw 'select current_database()')"; then
  echo "FATAL: could not query $DB_CONTAINER at all." >&2
  printf '%s\n' "$TARGET_DB" | sed 's/^/         /' >&2
  echo "       Nothing was written." >&2
  exit 1
fi
TARGET_MARKER="$(_psql_raw "select coalesce(shobj_description(oid, 'pg_database'), '(none)') from pg_database where datname = current_database()" || true)"

echo "══ target"
echo "──   container : $DB_CONTAINER"
echo "──   database  : $TARGET_DB"
echo "──   marker    : $TARGET_MARKER"
echo

require_disposable_stack || exit 1

echo "══ marker present; public, auth, storage and the ledger are all empty — safe to build"
echo

step=0
next_step() { step=$((step + 1)); echo; echo "══ step $step  $1"; }

next_step "baseline (TEST-ONLY, not a migration)"
echo "──      $BASELINE"
psql_file "$REPO/$BASELINE"
echo "        ✓ applied"

for m in "${MIGRATIONS[@]}"; do
  if [ "$m" = "$PENDING" ]; then
    # ── THE HISTORY GOES IN FIRST ─────────────────────────────────────────
    #
    # An eight-draft batch, made by the generator as it stood BEFORE this
    # migration. Everything §1 of the assertions claims about NOT VALID depends
    # on this row existing when the migration runs, and on it being made by the
    # real function rather than hand-inserted.
    next_step "$HISTORY (TEST-ONLY)"
    psql_file "$REPO/$HISTORY"
    HIST="$(_psql_raw "select (select count(*) from public.customer_review_draft_batches) || '/' ||
                              (select max(card_count) from public.customer_review_draft_batches) || '/' ||
                              (select count(*) from public.customer_review_test_cards)")"
    [ "$HIST" = "1/8/8" ] \
      || { echo "FATAL: the pre-migration history is $HIST, expected 1/8/8. Nothing further was applied." >&2; exit 1; }
    echo "        ✓ one eight-draft batch exists, made by the OLD generator"

    if git -C "$REPO" diff --quiet HEAD -- "supabase/migrations/$m"; then
      PENDING_NOTE="(unchanged from HEAD)"
    else
      PENDING_NOTE="MODIFIED vs HEAD — this run tests the working-tree version"
    fi
  elif ! git -C "$REPO" diff --quiet HEAD -- "supabase/migrations/$m"; then
    echo "FATAL: prerequisite supabase/migrations/$m differs from HEAD. Refusing to run." >&2
    exit 1
  else
    PENDING_NOTE=""
  fi

  next_step "$m"
  [ -n "$PENDING_NOTE" ] && echo "        $PENDING_NOTE"
  psql_file "$REPO/supabase/migrations/$m"
  echo "        ✓ applied"

  if [ "$m" = "$PENDING" ]; then
    # THE CLAIM, READ FROM THE DATABASE rather than from the migration's own
    # notices: the historical batch is still there and still says eight.
    SURVIVED="$(_psql_raw "select card_count || '/' || expected_count from public.customer_review_draft_batches")"
    [ "$SURVIVED" = "8/8" ] \
      || { echo "FATAL: after the migration the historical batch reads $SURVIVED, expected 8/8." >&2; exit 1; }
    echo "        ✓ the eight-draft batch survived the twelve-draft migration intact"
  fi
done

# ── IT IS SAFE TO APPLY TWICE ───────────────────────────────────────────────
#
# Every statement in the file is drop-if-exists / create-or-replace / add-if-not-
# exists, which is a claim worth executing rather than reading. A migration that
# aborted on a second application would be a landmine for any environment where
# the ledger and the schema ever disagree.
next_step "$PENDING again — re-applying must be a no-op"
psql_file "$REPO/supabase/migrations/$PENDING"
echo "        ✓ re-applied cleanly"

next_step "$ASSERTIONS"
psql_file "$REPO/$ASSERTIONS"

echo
echo "══ all $step steps passed"
echo "══ The migration applied to a production-equivalent database that already held"
echo "══ an eight-draft batch; that batch survived; a new batch must be twelve; the"
echo "══ edit and image-removal functions were executed against real rows; the slot"
echo "══ rules, the permission rules and the approved-review freeze were all proved"
echo "══ at the database rather than read from the file. No model was called and no"
echo "══ network was contacted."
