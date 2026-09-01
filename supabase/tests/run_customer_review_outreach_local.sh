#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════════════════
# TEST-ONLY RUNNER — Review Workflow Test (Internal), isolated local database
# ═════════════════════════════════════════════════════════════════════════════
#
# WHAT THIS IS FOR
# ----------------
# customer_review_test_card_assertions.sql proves things no text audit can —
# that booking is refused a second time with an exact SQLSTATE, that opening
# WhatsApp moves no status, that a verified card leaves every active list, and
# that an inactive account is refused everywhere. An earlier round of this module
# shipped a policy defect past 364 passing unit tests precisely because nothing
# executed the SQL. That file needs a database with the module's migration
# applied. This builds one.
#
# It cannot use the repository's own migration history: the 210 files there
# cannot construct a blank database, because public.users, tasks,
# task_activity_log and notifications predate the chain (see
# docs/migrations-are-not-self-contained.md). So it lays down a test-only
# stand-in for public.users, then applies the five REAL prerequisites and the
# REAL pending migration, whole and unmodified.
#
#   1.   the test-only baseline (bootstrap/000_…_baseline.sql) — NOT a migration
#   2-6. five real prerequisite migrations
#   7.   the real pending migration, whose own assertion block runs inside it
#   8.   the workflow assertions
#   9.   the test-card FIXTURE — sixteen fictional cards, so the stack is ready
#        for a manual walk-through. NOT a migration, and it carries its own
#        refusal: it will not insert into a database without the disposable
#        marker, so pointing psql at production and running it writes nothing.
#        Clear it with supabase/fixtures/customer_review_test_cards_clear.sql.
#
# WHAT IT WILL NOT DO
# -------------------
# It will not choose its own target: BOE_DB_CONTAINER must name the container.
# It will not run against a database that has not been marked disposable, or
# whose marker does not match. It will not run if public holds tables, if
# auth.users holds identities, if storage holds objects or buckets, or if the
# migration ledger has history — any one of those means the database is somebody's,
# and an empty public schema alone never proved otherwise. It will not run if a
# prerequisite migration differs from HEAD, because a run proves nothing if the
# ground under the pending migration has shifted.
#
# It never resets, never deletes, never repairs, never edits a migration, and
# never contacts anything outside the named local container. Every guard runs
# before the first statement is applied, so a refusal leaves the database
# untouched.
#
# PREREQUISITES
# -------------
#   1. Docker running, and a local Supabase stack for this repo:
#
#        supabase init          # if supabase/config.toml does not exist yet
#
#      Then, in supabase/config.toml, turn OFF automatic migrations:
#
#        [db.migrations]
#        enabled = false
#
#      Without that, `supabase start` tries the full history and dies on the
#      first file. (config.toml is deliberately not committed: its ports are
#      per-machine. On Windows the defaults may collide with reserved ranges —
#      check `netsh interface ipv4 show excludedportrange protocol=tcp` and
#      shift them if `supabase start` reports a socket permission error.)
#
#   2. supabase start
#   3. supabase db reset --no-seed
#
#   4. NAME THE TARGET, and MARK IT DISPOSABLE. Both are deliberate acts and
#      neither is guessed:
#
#        export BOE_DB_CONTAINER=supabase_db_<your-project>
#        docker exec -i "$BOE_DB_CONTAINER" psql -U postgres -d postgres -c \
#          "comment on database postgres is 'boe-disposable-customer-review-test'"
#
#      The marker lives in the database rather than in a file, so it travels
#      with the thing being protected. Setting it is a statement that this
#      database holds nothing anybody wants.
#
# WHY BOTH, AND WHY NO AUTODETECT
# -------------------------------
# An earlier version picked the only running `supabase_db_*` container and
# accepted any database whose `public` schema was empty. Both were wrong.
# "The only one running" is not the same as "the one you meant" — on a machine
# with one stack it is the same container every time, right up until the day it
# is not. And an empty `public` schema says nothing about `auth.users` or
# `storage.objects`, which is exactly where a real deployment keeps the things
# that must not be written over.
#
# So: the container is named explicitly, the marker must be present and exact,
# and public/auth/storage must all be empty. Every check runs BEFORE any SQL is
# applied, and a failure aborts rather than repairing anything. This script
# never resets a stack, never deletes, and never contacts a linked or remote
# project.
#
# USAGE
#   BOE_DB_CONTAINER=supabase_db_myproject supabase/tests/run_customer_review_outreach_local.sh
#
# THE GUARDS HAVE THEIR OWN TESTS
#   supabase/tests/run_customer_review_outreach_guard_tests.sh
#   drives this script against a wrong container, a missing marker, a mismatched
#   marker, a populated public schema, an existing auth identity, an existing
#   storage object and a database with no auth schema at all, and checks that
#   each is refused with nothing written — then that the correct empty stack is
#   accepted.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

BASELINE="supabase/tests/bootstrap/000_customer_review_module_baseline.sql"
ASSERTIONS="supabase/tests/customer_review_test_card_assertions.sql"
FIXTURE="supabase/fixtures/customer_review_test_cards.sql"
# THE FILES UNDER REVIEW. All four are allowed to differ from HEAD; every other
# migration in the list must match it, because a run proves nothing if the
# ground under the pending files has shifted.
PENDING_FILES=(
  "20261023000000_review_workflow_ai_drafts.sql"
  "20261025000000_review_workflow_remove_legacy_test_data.sql"
  "20261026000000_review_workflow_batch_approval.sql"
  "20261027000000_review_workflow_generation_claims.sql"
  "20261030000000_review_workflow_deletion_and_replacement.sql"
)

# ── Test-only files, and where each one has to be applied ───────────────────
#
# Three of them, and the ORDER is the point rather than an accident:
#
#   BEFORE 20261023000000  three cards in three states, so its "only rewrite an
#                          available card" guard has something to be checked
#                          against.
#   AFTER  20261023000000  the check itself, which also clears those three rows
#                          — it has to run here rather than with the rest of the
#                          assertions, because the deletion migration two steps
#                          later refuses any card table that is not exactly the
#                          legacy sixteen.
#   BEFORE 20261025000000  the legacy sixteen, reproduced. The deletion
#                          migration's guard can only be exercised against a
#                          database that actually holds the shape it expects.
REWRITE_PROBE="supabase/tests/_review_workflow_drafts_before.sql"
REWRITE_CHECK="supabase/tests/_review_workflow_drafts_rewrite_check.sql"
LEGACY_STATE="supabase/tests/_review_workflow_legacy_state_before.sql"
# The builder that puts the legacy dataset into every shape the guard has to
# judge — the two it must ACCEPT as much as the ten it must refuse.
LEGACY_CASES="supabase/tests/_review_workflow_legacy_guard_cases.sql"

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
)

is_pending() {
  local m="$1" p
  for p in "${PENDING_FILES[@]}"; do [ "$m" = "$p" ] && return 0; done
  return 1
}

MARKER="boe-disposable-customer-review-test"

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

# The gate lives in its own file so that the tests exercise the same code this
# script trusts, rather than a second copy of it.
DB_NAME="${BOE_DB_NAME:-postgres}"

# shellcheck source=supabase/tests/lib/disposable_stack_guard.sh
. "$REPO/supabase/tests/lib/disposable_stack_guard.sh"

psql_file() {
  # ON_ERROR_STOP=1 makes the first error abort the file rather than leaving a
  # half-applied migration behind.
  docker exec -i "$DB_CONTAINER" psql -U postgres -d "$DB_NAME" -v ON_ERROR_STOP=1 -q < "$1"
}

# ── SAY WHAT IS ABOUT TO BE WRITTEN TO, BEFORE WRITING ──────────────────────
# Printed with the same fail-closed helper: if the target cannot even be
# described, it is certainly not going to be written to.
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

# ── Every guard runs before a single statement is applied ───────────────────
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
  if is_pending "$m"; then
    # A file under review. It is allowed to differ from HEAD — but the
    # difference is printed rather than assumed, so a run can never quietly
    # test something other than what is on disk.
    PENDING_NOTE=1
  elif ! git -C "$REPO" diff --quiet HEAD -- "supabase/migrations/$m"; then
    echo "FATAL: prerequisite supabase/migrations/$m differs from HEAD. Refusing to run." >&2
    exit 1
  else
    PENDING_NOTE=0
  fi

  # ── Whatever has to be true BEFORE this migration ────────────────────────
  case "$m" in
    20261023000000_*)
      next_step "$REWRITE_PROBE (TEST-ONLY)"
      psql_file "$REPO/$REWRITE_PROBE"
      echo "        ✓ three cards, one available, one booked, one verified"
      ;;
    20261025000000_*)
      next_step "$LEGACY_STATE (TEST-ONLY)"
      psql_file "$REPO/$LEGACY_STATE"
      LEGACY_N="$(_psql_raw "select cards || '/' || available || '/' || booked from public.zz_review_workflow_legacy_probe")"
      [ "$LEGACY_N" = "16/15/1" ] \
        || { echo "FATAL: the legacy state is $LEGACY_N, expected 16/15/1. Nothing further was applied." >&2; exit 1; }
      echo "        ✓ sixteen legacy cards: fifteen available, one booked, with a trail and a screenshot"

      # ── THE REFUSAL, BEFORE THE SUCCESS ─────────────────────────────────
      #
      # A screenshot is attached, and SQL cannot delete the stored object it
      # names (storage.protect_delete). The migration must refuse rather than
      # strand the image, and it must refuse having deleted nothing.
      next_step "$m must REFUSE while a screenshot is attached"
      if psql_file "$REPO/supabase/migrations/$m" >/tmp/legacy_refusal.out 2>&1; then
        echo "FATAL: the deletion migration ran with a screenshot attached. It must refuse." >&2
        exit 1
      fi
      grep -q 'REVIEW_WORKFLOW_LEGACY_SCREENSHOT' /tmp/legacy_refusal.out \
        || { echo "FATAL: it failed for the wrong reason:" >&2; sed 's/^/         /' /tmp/legacy_refusal.out >&2; exit 1; }
      STILL="$(_psql_raw 'select count(*) from public.customer_review_test_cards')"
      [ "$STILL" = "16" ] \
        || { echo "FATAL: the refusal deleted rows — $STILL card(s) remain, expected 16." >&2; exit 1; }
      echo "        ✓ refused by name, and all sixteen cards are untouched"

      next_step "remove the screenshot (TEST-ONLY), the way the product would"
      _psql_raw "delete from public.customer_review_test_card_screenshots
                  where card_id = 'bbbbbbbb-0000-4000-8000-100000000002'" >/dev/null
      echo "        ✓ the image reference is gone; the cards are not"
      ;;
  esac

  next_step "$m"
  if [ "$PENDING_NOTE" = "1" ]; then
    if git -C "$REPO" diff --quiet HEAD -- "supabase/migrations/$m"; then
      echo "        (unchanged from HEAD)"
    else
      echo "        MODIFIED vs HEAD — this run tests the working-tree version:"
      git -C "$REPO" diff --stat HEAD -- "supabase/migrations/$m" | sed 's/^/          /'
    fi
  fi
  psql_file "$REPO/supabase/migrations/$m"
  echo "        ✓ applied"

  # ── Whatever has to be true AFTER it ─────────────────────────────────────
  case "$m" in
    20261023000000_*)
      next_step "$REWRITE_CHECK (TEST-ONLY)"
      psql_file "$REPO/$REWRITE_CHECK"
      REMAINING="$(_psql_raw 'select count(*) from public.customer_review_test_cards')"
      [ "$REMAINING" = "0" ] \
        || { echo "FATAL: $REMAINING probe card(s) survived the rewrite check. Nothing further was applied." >&2; exit 1; }
      echo "        ✓ the rewrite guard held, and the probe rows are gone"
      ;;
    20261025000000_*)
      # THE CLAIM: the legacy sixteen are gone, and their children went with
      # them. Read from the database rather than from the migration's notice.
      LEFT="$(_psql_raw "select (select count(*) from public.customer_review_test_cards)
                             || '|' || (select count(*) from public.customer_review_test_card_events)
                             || '|' || (select count(*) from public.customer_review_test_card_screenshots)")"
      [ "$LEFT" = "0|0|0" ] \
        || { echo "FATAL: after the deletion migration cards|events|screenshots = $LEFT, expected 0|0|0." >&2; exit 1; }
      _psql_raw 'drop table if exists public.zz_review_workflow_legacy_probe' >/dev/null
      echo "        ✓ sixteen cards and their audit trail removed by cascade"

      # ── AND IT IS SAFE TO RUN AGAIN ─────────────────────────────────────
      #
      # Zero cards and zero batches is nothing-to-do, not something-unexpected.
      # Without this branch the file would break the migration chain forever on
      # every new project, which is a landmine rather than a safeguard.
      next_step "$m again — an empty table is a no-op, not an abort"
      psql_file "$REPO/supabase/migrations/$m" >/tmp/legacy_again.out 2>&1 \
        || { echo "FATAL: the deletion migration aborted on an already-empty table:" >&2; sed 's/^/         /' /tmp/legacy_again.out >&2; exit 1; }
      grep -q 'SKIP  review-workflow legacy data' /tmp/legacy_again.out \
        || { echo "FATAL: it did not report the skip:" >&2; sed 's/^/         /' /tmp/legacy_again.out >&2; exit 1; }
      echo "        ✓ re-applying it on an empty table skips cleanly"

      # ── EVERY OTHER SHAPE THE GUARD HAS TO JUDGE ───────────────────────
      #
      # The steps above prove one accept (15/1) and one refusal (a screenshot).
      # A migration that permanently deletes production rows deserves both
      # halves proved properly: the shapes that ARE the legacy dataset must be
      # ACCEPTED — production had already drifted from 15/1 to 13/3 by the time
      # the rollout was attempted — and everything else must be refused BY NAME,
      # with nothing deleted.
      next_step "$LEGACY_CASES (TEST-ONLY)"
      psql_file "$REPO/$LEGACY_CASES"
      echo "        ✓ the case builder is available"

      # case:expectation — ACCEPT, or the marker the refusal has to carry.
      LEGACY_GUARD_CASES=(
        "split_15_1:ACCEPT"
        "split_13_3:ACCEPT"
        "whatsapp_only:ACCEPT"
        "sent_confirmed:REVIEW_WORKFLOW_LEGACY_SEND_CONFIRMED"
        "returned:REVIEW_WORKFLOW_LEGACY_SEND_CONFIRMED"
        "submitted:REVIEW_WORKFLOW_LEGACY_STATE_CHANGED"
        "verified:REVIEW_WORKFLOW_LEGACY_STATE_CHANGED"
        "screenshot:REVIEW_WORKFLOW_LEGACY_SCREENSHOT"
        "storage_object:REVIEW_WORKFLOW_LEGACY_STORAGE"
        "extra_card:REVIEW_WORKFLOW_LEGACY_STATE_CHANGED"
        "missing_card:REVIEW_WORKFLOW_LEGACY_STATE_CHANGED"
        "wrong_ref:REVIEW_WORKFLOW_LEGACY_STATE_CHANGED"
        "with_batch:REVIEW_WORKFLOW_LEGACY_STATE_CHANGED"
      )

      next_step "$m judges every legacy shape"
      for CASE_SPEC in "${LEGACY_GUARD_CASES[@]}"; do
        CASE_NAME="${CASE_SPEC%%:*}"
        CASE_WANT="${CASE_SPEC#*:}"

        _psql_raw "select public.zz_build_legacy('$CASE_NAME')" >/dev/null \
          || { echo "FATAL: could not build the '$CASE_NAME' case." >&2; exit 1; }
        BEFORE="$(_psql_raw 'select count(*) from public.customer_review_test_cards')"

        if [ "$CASE_WANT" = "ACCEPT" ]; then
          psql_file "$REPO/supabase/migrations/$m" >/tmp/legacy_case.out 2>&1 \
            || { echo "FATAL: the guard REFUSED '$CASE_NAME', which IS the legacy dataset:" >&2
                 sed 's/^/         /' /tmp/legacy_case.out >&2; exit 1; }
          AFTER="$(_psql_raw 'select count(*) from public.customer_review_test_cards')"
          [ "$AFTER" = "0" ] \
            || { echo "FATAL: '$CASE_NAME' was accepted but left $AFTER card(s)." >&2; exit 1; }
          echo "        ✓ $CASE_NAME — accepted, all $BEFORE card(s) removed"
        else
          if psql_file "$REPO/supabase/migrations/$m" >/tmp/legacy_case.out 2>&1; then
            echo "FATAL: the guard ACCEPTED '$CASE_NAME'. It must refuse." >&2
            exit 1
          fi
          grep -q "$CASE_WANT" /tmp/legacy_case.out \
            || { echo "FATAL: '$CASE_NAME' was refused for the wrong reason (wanted $CASE_WANT):" >&2
                 sed 's/^/         /' /tmp/legacy_case.out >&2; exit 1; }
          AFTER="$(_psql_raw 'select count(*) from public.customer_review_test_cards')"
          [ "$AFTER" = "$BEFORE" ] \
            || { echo "FATAL: refusing '$CASE_NAME' still deleted rows: $BEFORE -> $AFTER." >&2; exit 1; }
          echo "        ✓ $CASE_NAME — refused $CASE_WANT, all $BEFORE card(s) untouched"
        fi

        _psql_raw 'select public.zz_clear_legacy()' >/dev/null
      done

      _psql_raw 'drop function if exists public.zz_build_legacy(text)' >/dev/null
      _psql_raw 'drop function if exists public.zz_clear_legacy()' >/dev/null
      LEFT="$(_psql_raw 'select count(*) from public.customer_review_test_cards')"
      [ "$LEFT" = "0" ] \
        || { echo "FATAL: $LEFT card(s) survived the guard cases." >&2; exit 1; }
      echo "        ✓ thirteen shapes judged; the table is empty again"

      ;;
  esac
done

next_step "$ASSERTIONS"
psql_file "$REPO/$ASSERTIONS"

echo
next_step "$FIXTURE (TEST-ONLY, not a migration)"
psql_file "$REPO/$FIXTURE"
LOADED="$(_psql_raw "select count(*) from public.customer_review_test_cards where card_ref like 'TEST-0%'")"
if [ "$LOADED" != "16" ]; then
  echo "FATAL: the fixture loaded $LOADED card(s), expected 16." >&2
  exit 1
fi
echo "        ✓ 16 test cards loaded"
echo "        clear them with:"
echo "          docker exec -i $DB_CONTAINER psql -U postgres -d $DB_NAME -v ON_ERROR_STOP=1 \\"
echo "            -f - < supabase/fixtures/customer_review_test_cards_clear.sql"


echo
next_step "the one-live-screenshot guarantee, at the DATABASE boundary"
echo "──      Two psql PROCESSES, two connections, two transactions, two DIFFERENT"
echo "──      images, one card. Neither can see the other's uncommitted row, which"
echo "──      is exactly the situation the route's count-then-insert could not"
echo "──      survive: both would read zero live screenshots and both would go on"
echo "──      to insert. If the partial unique index is missing or non-partial,"
echo "──      BOTH inserts succeed here and this step fails."
echo "──"
echo "──      The two are serialised on an advisory lock rather than fired at each"
echo "──      other and hoped about. That makes the outcome deterministic — a"
echo "──      flaky race test that passes when the timing happens to be serial is"
echo "──      worse than no test — and it changes nothing about what is proven,"
echo "──      because the loser still arrives with its own connection, its own"
echo "──      transaction, and no knowledge of the winner's row."

CONC_CARD='cccccccc-0000-4000-8000-000000000001'
CONC_USER='ffffffff-0000-4000-8000-000000000002'
RACE_DIR="$(mktemp -d)"
trap 'rm -rf "$RACE_DIR"' EXIT

# A card of its own, so the probe cannot disturb anything the assertions built.
_psql_raw "
  insert into public.users (id, full_name, email, role, team, is_active, created_at, updated_at)
  values ('$CONC_USER', 'Concurrency Tester', 'conc.tester@example.test',
          'member', 'sales', true, now(), now())
  on conflict (id) do nothing;
  insert into public.customer_review_test_cards
    (id, card_ref, test_category, test_title, test_body, status, booked_by, booked_at)
  values ('$CONC_CARD', 'TEST-990', 'restaurant_test', 'Concurrency probe',
          'Harness filler. It describes nothing and is not attributed to anybody.',
          'booked', '$CONC_USER', now())
  on conflict (id) do nothing;
  select 1" >/dev/null || {
  echo "FATAL: could not set up the concurrency probe." >&2
  echo "       Nothing further was written." >&2
  exit 1
}

# $1 = a distinct content digest, $2 = a distinct object key, $3 = where to
# put this session's output. Output goes to a FILE rather than a variable: a
# background command substitution assigns in a subshell, and the parent would
# read an empty string and report a pass it never observed.
race_insert() {
  docker exec -i "$DB_CONTAINER" psql -U postgres -d "$DB_NAME" -q -t -A >"$3" 2>&1 <<SQL
begin;
select pg_advisory_xact_lock(4242);
insert into public.customer_review_test_card_screenshots
  (card_id, kind, storage_path, file_name, mime_type, byte_size, content_sha256, uploaded_by)
values ('$CONC_CARD', 'test_screenshot',
        '$CONC_CARD/test_screenshot/$2', '$2',
        'image/png', 2048, '$1', '$CONC_USER');
commit;
SQL
}

race_insert "$(printf 'a%.0s' $(seq 64))" a.png "$RACE_DIR/a.out" &
PID_A=$!
race_insert "$(printf 'b%.0s' $(seq 64))" b.png "$RACE_DIR/b.out" &
PID_B=$!
wait "$PID_A" || true
wait "$PID_B" || true

LIVE="$(_psql_raw "select count(*) from public.customer_review_test_card_screenshots
                    where card_id = '$CONC_CARD' and removal_started_at is null")"

if [ "$LIVE" != "1" ]; then
  echo "FATAL: after two concurrent inserts the card holds $LIVE live screenshot(s)." >&2
  echo "       Expected exactly 1. The partial unique index is not doing its job." >&2
  cat "$RACE_DIR"/*.out | sed 's/^/         /' >&2
  exit 1
fi
echo "        ✓ exactly one of the two inserts survived"

# ...and the loser failed for the RIGHT reason. A session lost to a deadlock, a
# dropped connection or a typo would also leave one row behind, and would prove
# nothing at all about the index.
if ! grep -q 'duplicate key value' "$RACE_DIR"/a.out "$RACE_DIR"/b.out; then
  echo "FATAL: neither session reported a unique violation." >&2
  echo "       One insert must have failed ON THE INDEX, not on something else." >&2
  cat "$RACE_DIR"/*.out | sed 's/^/         /' >&2
  exit 1
fi
if ! grep -q 'customer_review_screenshot_one_live_per_card' "$RACE_DIR"/a.out "$RACE_DIR"/b.out; then
  echo "FATAL: the unique violation did not come from the one-live-per-card index." >&2
  cat "$RACE_DIR"/*.out | sed 's/^/         /' >&2
  exit 1
fi
echo "        ✓ the loser failed on customer_review_screenshot_one_live_per_card"

_psql_raw "
  delete from public.customer_review_test_card_screenshots where card_id = '$CONC_CARD';
  delete from public.customer_review_test_cards where id = '$CONC_CARD';
  delete from public.users where id = '$CONC_USER';
  select 1" >/dev/null || true
echo "        ✓ probe rows removed"
echo
echo "══ all $step steps passed"
echo "══ Every migration ran its own do \$\$ … \$\$ assertion block; the rewrite check"
echo "══ proved 20261023000000 touched only an available card; the legacy sixteen"
echo "══ were built and then removed by 20261025000000 together with their audit"
echo "══ trail and screenshot; the workflow assertions ran; the fixture loaded; and"
echo "══ two real sessions raced at the screenshot index. Any one of them would"
echo "══ have aborted this script."
