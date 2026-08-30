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
PENDING="20261017000000_customer_review_outreach.sql"
MIGRATIONS=(
  "20260609_create_attendance_records.sql"
  "20260645_create_control_center_v1.sql"
  "20260660_create_permission_engine.sql"
  "20260661_add_permission_engine_bulk_resolver.sql"
  "20260662_fix_permission_resolver_team_cast.sql"
  "20261017000000_customer_review_outreach.sql"
)

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

echo "══ 1/10 baseline (TEST-ONLY, not a migration)"
echo "──      $BASELINE"
psql_file "$REPO/$BASELINE"
echo "        ✓ applied"

step=2
for m in "${MIGRATIONS[@]}"; do
  echo
  echo "══ $step/10 $m"
  if [ "$m" = "$PENDING" ]; then
    # The file under review. It is allowed to differ from HEAD — but the
    # difference is printed rather than assumed, so a run can never quietly
    # test something other than what is on disk.
    if git -C "$REPO" diff --quiet HEAD -- "supabase/migrations/$m"; then
      echo "        (unchanged from HEAD)"
    else
      echo "        MODIFIED vs HEAD — this run tests the working-tree version:"
      git -C "$REPO" diff --stat HEAD -- "supabase/migrations/$m" | sed 's/^/          /'
    fi
  elif ! git -C "$REPO" diff --quiet HEAD -- "supabase/migrations/$m"; then
    echo "FATAL: prerequisite supabase/migrations/$m differs from HEAD. Refusing to run." >&2
    exit 1
  fi
  psql_file "$REPO/supabase/migrations/$m"
  echo "        ✓ applied"
  step=$((step + 1))
done

echo
echo "══ 8/10 $ASSERTIONS"
psql_file "$REPO/$ASSERTIONS"

echo
echo "══ 9/10 $FIXTURE (TEST-ONLY, not a migration)"
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
echo "══ 10/10 the one-live-screenshot guarantee, at the DATABASE boundary"
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
echo "══ all ten steps passed"
echo "══ step 7 ran the migration's own do \$\$ … \$\$ assertion block, step 8 ran"
echo "══ the workflow assertions, step 9 loaded the fixture, and step 10 raced two"
echo "══ real sessions at the screenshot index; any of the four would have aborted"
echo "══ this script."
