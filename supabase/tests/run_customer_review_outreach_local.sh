#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════════════════
# TEST-ONLY RUNNER — Customer Review Outreach, isolated local database
# ═════════════════════════════════════════════════════════════════════════════
#
# WHAT THIS IS FOR
# ----------------
# customer_review_request_visibility_assertions.sql proves things no text audit
# can — chiefly that an authorized employee's `INSERT ... RETURNING` is accepted,
# which is the defect that shipped in 51d2f51 past 364 passing unit tests. That
# file needs a database with the module's migration applied. This builds one.
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
#   8.   the visibility assertions
#
# WHAT IT WILL NOT DO
# -------------------
# It refuses to run against anything but an EMPTY public schema, so it can never
# be pointed at a database that holds real data. It refuses to run if a
# prerequisite migration differs from HEAD, because a run proves nothing if the
# ground under the pending migration has shifted. It never edits a migration and
# never contacts anything outside the local Docker stack.
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
#   3. supabase db reset --no-seed      # guarantees the empty schema below
#
# USAGE
#   supabase/tests/run_customer_review_outreach_local.sh
#
# The database container is detected automatically; override with
# BOE_DB_CONTAINER=<name> if you run more than one Supabase stack.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

BASELINE="supabase/tests/bootstrap/000_customer_review_module_baseline.sql"
ASSERTIONS="supabase/tests/customer_review_request_visibility_assertions.sql"
PENDING="20261017000000_customer_review_outreach.sql"
MIGRATIONS=(
  "20260609_create_attendance_records.sql"
  "20260645_create_control_center_v1.sql"
  "20260660_create_permission_engine.sql"
  "20260661_add_permission_engine_bulk_resolver.sql"
  "20260662_fix_permission_resolver_team_cast.sql"
  "20261017000000_customer_review_outreach.sql"
)

# ── The container ────────────────────────────────────────────────────────────
# `supabase init` names it after the directory, so it differs per checkout.
if [ -n "${BOE_DB_CONTAINER:-}" ]; then
  DB_CONTAINER="$BOE_DB_CONTAINER"
else
  mapfile -t FOUND < <(docker ps --format '{{.Names}}' | grep '^supabase_db_' || true)
  if [ "${#FOUND[@]}" -eq 0 ]; then
    echo "FATAL: no running supabase_db_* container. Run 'supabase start' first." >&2
    exit 1
  fi
  if [ "${#FOUND[@]}" -gt 1 ]; then
    echo "FATAL: more than one Supabase stack is running:" >&2
    printf '         %s\n' "${FOUND[@]}" >&2
    echo "       Set BOE_DB_CONTAINER to the one you mean." >&2
    exit 1
  fi
  DB_CONTAINER="${FOUND[0]}"
fi

psql_q() { docker exec -i "$DB_CONTAINER" psql -U postgres -d postgres -At -c "$1"; }
psql_file() {
  # ON_ERROR_STOP=1 makes the first error abort the file rather than leaving a
  # half-applied migration behind.
  docker exec -i "$DB_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q < "$1"
}

echo "══ target: $DB_CONTAINER"

# ── The guard that makes this safe ───────────────────────────────────────────
# The baseline CREATEs public.users. Against a database that already has one,
# that is at best an error and at worst a question nobody should have to ask.
# An empty public schema is the only state this script will build on, and it is
# exactly what `supabase db reset --no-seed` leaves behind.
EXISTING="$(psql_q "select count(*) from pg_tables where schemaname = 'public'")"
if [ "$EXISTING" != "0" ]; then
  echo "FATAL: the public schema of $DB_CONTAINER already has $EXISTING table(s)." >&2
  echo "       This runner only builds on an EMPTY schema, so that it can never" >&2
  echo "       be pointed at a database holding real data." >&2
  echo "       If this really is a throwaway stack:  supabase db reset --no-seed" >&2
  exit 1
fi
echo "══ public schema is empty — safe to build"
echo

echo "══ 1/8  baseline (TEST-ONLY, not a migration)"
echo "──      $BASELINE"
psql_file "$REPO/$BASELINE"
echo "        ✓ applied"

step=2
for m in "${MIGRATIONS[@]}"; do
  echo
  echo "══ $step/8  $m"
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
echo "══ 8/8  $ASSERTIONS"
psql_file "$REPO/$ASSERTIONS"

echo
echo "══ all eight steps passed"
echo "══ step 7 ran the migration's own do \$\$ … \$\$ assertion block, and step 8"
echo "══ ran the visibility assertions; either would have aborted this script."
