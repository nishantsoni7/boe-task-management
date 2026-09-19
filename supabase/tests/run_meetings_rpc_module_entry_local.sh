#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════════════════
# TEST-ONLY RUNNER — 20261214000000_meetings_rpcs_require_module_entry.sql,
# on an isolated local Supabase stack
# ═════════════════════════════════════════════════════════════════════════════
#
# Proves, by EXECUTING the real Meetings chain, that the defect exists before the
# migration and is gone after it:
#
#   BEFORE  meetings_rpc_module_entry_assertions.sql must FAIL, with refusal
#           failures only — a lead, a creator, a Meetings 'edit' holder and a
#           'manage' holder whose Meetings 'view' was removed get through the
#           write RPCs, while every normal editor works. The failures are printed.
#   AFTER   the migration is applied twice (it must be safe to re-run), and the
#           same file must pass twice: every one of those calls refused with
#           'MEETING_FORBIDDEN: You do not have access to Meetings', every normal
#           editor still working.
#
# WHAT IT TARGETS
# ---------------
# A LOCAL SUPABASE STACK, not a bare container: the RPCs need auth.uid(), the
# storage schema (evidence) and the client roles. Same guard and same TEST-ONLY
# bootstrap files as run_meeting_discussion_workflow_local.sh.
#
# WHAT IT WILL NOT DO
# -------------------
# It will not choose its own target, run on a database not marked disposable,
# run if public, auth, storage or the ledger hold anything, or run if a migration
# it applies differs from HEAD. It never resets, never deletes and never contacts
# anything outside the named container.
#
# PREREQUISITES
#   1. Docker running, and a local Supabase stack with
#      [db.migrations] enabled = false in its config.toml.
#   2. npx supabase start
#        -x studio,imgproxy,mailpit,edge-runtime,logflare,vector,supavisor,realtime,postgres-meta
#   3. NAME THE TARGET, and MARK IT DISPOSABLE:
#        export BOE_DB_CONTAINER=supabase_db_<project>
#        docker exec -i "$BOE_DB_CONTAINER" psql -U postgres -d postgres -c \
#          "comment on database postgres is 'boe-disposable-meetings-rpc-module-entry'"
#
# USAGE
#   BOE_DB_CONTAINER=supabase_db_myproject supabase/tests/run_meetings_rpc_module_entry_local.sh
#
# Afterwards: npx supabase stop (or db reset --no-seed + the marker for another run).

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

DEFAULT_PRIVILEGES="supabase/tests/bootstrap/006_meeting_discussion_default_privileges.sql"
BASELINE="supabase/tests/bootstrap/000_customer_review_module_baseline.sql"
STUBS="supabase/tests/bootstrap/007_meeting_discussion_stubs.sql"
GATES="supabase/tests/bootstrap/008_meeting_discussion_gates.sql"
ASSERTIONS="supabase/tests/meetings_rpc_module_entry_assertions.sql"
PENDING="20261214000000_meetings_rpcs_require_module_entry.sql"

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

MARKER="boe-disposable-meetings-rpc-module-entry"

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

# -1 -f -: one transaction per file (psql ignores -1 when the file arrives on
# plain stdin). Server NOTICEs from the chain are silenced; errors are not.
psql_file() {
  docker exec -i -e "PGOPTIONS=-c client_min_messages=warning" "$DB_CONTAINER" \
    psql -U postgres -d "$DB_NAME" -v ON_ERROR_STOP=1 -q -1 -f - < "$1"
}

run_assertions() {
  set +e
  OUTPUT="$(docker exec -i "$DB_CONTAINER" psql -U postgres -d "$DB_NAME" -v ON_ERROR_STOP=1 < "$REPO/$ASSERTIONS" 2>&1)"
  STATUS=$?
  set -e
}

show() {
  printf '%s\n' "$OUTPUT" | grep -E 'NOTICE|ERROR|FATAL|ASSERT' | sed 's/^psql:[^ ]* *//; s/^NOTICE:  //; s/^/      /'
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

echo "── 3. the real Meetings chain, in order"
for m in "${MIGRATIONS[@]}"; do
  case "$m" in
    "@stubs") echo "      $STUBS (TEST-ONLY)"; psql_file "$REPO/$STUBS"; continue ;;
    "@gates") echo "      $GATES (TEST-ONLY)"; psql_file "$REPO/$GATES"; continue ;;
  esac
  echo "      $m"
  psql_file "$REPO/supabase/migrations/$m"
done

echo "── 4. BEFORE the fix: $ASSERTIONS must fail, on refusals only"
run_assertions
show
if [ $STATUS -eq 0 ] || printf '%s' "$OUTPUT" | grep -q 'ALL ASSERTIONS PASSED'; then
  echo "FAIL: the assertions passed WITHOUT the migration, so they do not detect the defect" >&2
  exit 1
fi
if ! printf '%s' "$OUTPUT" | grep -Eq 'SUMMARY refusal_failures=[1-9][0-9]* allow_failures=0 other_failures=0([^0-9]|$)'; then
  echo "FAIL: before the fix the suite must fail on refusals only, with every normal editor working" >&2
  exit 1
fi
echo "   confirmed: the defect is present before the migration"

echo "── 5. the migration under test: $PENDING"
psql_file "$REPO/supabase/migrations/$PENDING"

echo "── 6. the same file again — it must be safe to apply twice"
psql_file "$REPO/supabase/migrations/$PENDING"

for pass in 1 2; do
  echo "── $((6 + pass)). $ASSERTIONS (pass $pass of 2 — one transaction, rolled back)"
  run_assertions
  if [ "$pass" = 1 ]; then show; fi
  if [ $STATUS -ne 0 ] || ! printf '%s' "$OUTPUT" | grep -q 'ALL ASSERTIONS PASSED'; then
    show >&2
    echo "FAIL: the assertions did not pass on pass $pass (psql exit $STATUS)" >&2
    exit 1
  fi
done

echo
echo "OK: the defect reproduced before $PENDING; after applying it twice every assertion passed twice on $DB_CONTAINER/$DB_NAME."
