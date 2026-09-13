#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════════════════
# TEST-ONLY RUNNER — 20261204000000_boe_credits_decimal_credits.sql and
# 20261205000000_customer_review_custom_submissions.sql, on an isolated bare
# PostgreSQL container
# ═════════════════════════════════════════════════════════════════════════════
#
# The sibling of run_boe_credits_phase_1d_local.sh: the same bare target, the
# same guard, the same prerequisite chain, plus one test-only stub file (004)
# for what that chain does not reach — the image review reward column, the
# permission engine and Storage.
#
# WHAT IT PROVES, IN ORDER
#   1. both migrations APPLY on top of their real prerequisites;
#   2. both are SAFE TO APPLY TWICE;
#   3. the rules hold AT THE DATABASE — see the header of
#      custom_review_submissions_assertions.sql (one rolled-back transaction,
#      run twice).
#
# PREREQUISITES
#   1. Docker running.
#   2. A throwaway PostgreSQL container, e.g.
#        docker run -d --name boe-custom-review-pg -e POSTGRES_PASSWORD=postgres postgres:16-alpine
#   3. Name it and mark it disposable:
#        export BOE_DB_CONTAINER=boe-custom-review-pg
#        docker exec -i "$BOE_DB_CONTAINER" psql -U postgres -d postgres -c \
#          "comment on database postgres is 'boe-disposable-boe-credits'"
#
# USAGE
#   BOE_DB_CONTAINER=boe-custom-review-pg supabase/tests/run_custom_review_submissions_local.sh
#
# Afterwards: docker rm -f boe-custom-review-pg

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DB_CONTAINER="${BOE_DB_CONTAINER:?set BOE_DB_CONTAINER to the throwaway PostgreSQL container}"
DB_NAME="${BOE_DB_NAME:-postgres}"
MARKER="boe-disposable-boe-credits"

BASELINE="$REPO/supabase/tests/bootstrap/002_boe_credits_baseline.sql"
STUBS_1D="$REPO/supabase/tests/bootstrap/003_boe_credits_phase_1d_stubs.sql"
STUBS_HERE="$REPO/supabase/tests/bootstrap/004_decimal_credits_and_custom_reviews_stubs.sql"
STUBS_PHASE="$REPO/supabase/tests/bootstrap/005_custom_review_phase_stubs.sql"
PREREQS=(
  "20260611_create_payroll_periods.sql"
  "20260612000000_create_payroll_generation_tables.sql"
  "20260616_add_generated_status_to_payroll_periods.sql"
  "20261101000000_boe_credits_foundation.sql"
  "20261103000000_boe_credits_attendance_redemption.sql"
)
PHASE_1D="20261104000000_boe_credits_phase_1d.sql"
PENDING=(
  "20261204000000_boe_credits_decimal_credits.sql"
  "20261205000000_customer_review_custom_submissions.sql"
  "20261206000000_customer_review_custom_reapply_and_monthly_rules.sql"
)
ASSERTION_FILES=(
  "$REPO/supabase/tests/custom_review_submissions_assertions.sql"
  "$REPO/supabase/tests/custom_review_phase_assertions.sql"
)

# shellcheck source=supabase/tests/lib/disposable_stack_guard.sh
. "$REPO/supabase/tests/lib/disposable_stack_guard.sh"

psql_file() {
  docker exec -i "$DB_CONTAINER" psql -U postgres -d "$DB_NAME" -v ON_ERROR_STOP=1 -q < "$1"
}

# ── The gate, for a bare container (as run_boe_credits_phase_1d_local.sh) ────
require_disposable_bare_postgres() {
  local found_marker

  if ! found_marker="$(_psql_raw "select coalesce(shobj_description(oid, 'pg_database'), '') from pg_database where datname = current_database()")"; then
    {
      echo "FATAL: could not read the disposable marker from $DB_CONTAINER."
      printf '%s\n' "$found_marker" | sed 's/^/         /'
      echo "       Nothing was written."
    } >&2
    return 1
  fi
  if [ -z "$found_marker" ]; then
    {
      echo "FATAL: $DB_CONTAINER carries no disposable marker. Nothing was written."
    } >&2
    return 1
  fi
  if [ "$found_marker" != "$MARKER" ]; then
    {
      echo "FATAL: marker mismatch on $DB_CONTAINER: found '$found_marker', expected '$MARKER'."
      echo "       Nothing was written."
    } >&2
    return 1
  fi

  _require_empty 'public tables' \
    "select count(*) from pg_tables where schemaname = 'public'" \
    'table(s) in public' || return 1

  _require_empty 'public functions' \
    "select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'" \
    'function(s) in public' || return 1
}

echo "── target: container $DB_CONTAINER, database $DB_NAME"
require_disposable_bare_postgres || exit 1
echo "   disposable marker present, public empty"

for m in "${PREREQS[@]}" "$PHASE_1D"; do
  if [ ! -f "$REPO/supabase/migrations/$m" ]; then
    echo "FATAL: prerequisite supabase/migrations/$m is missing. Refusing to run." >&2
    exit 1
  elif ! git -C "$REPO" diff --quiet HEAD -- "supabase/migrations/$m"; then
    echo "FATAL: prerequisite supabase/migrations/$m differs from HEAD. Refusing to run." >&2
    exit 1
  fi
done

# ── Build ────────────────────────────────────────────────────────────────────
n=1
echo "── $n. test-only baseline (NOT a migration)"; psql_file "$BASELINE"; n=$((n + 1))
for m in "${PREREQS[@]}"; do
  echo "── $n. real prerequisite: $m"; psql_file "$REPO/supabase/migrations/$m"; n=$((n + 1))
done
echo "── $n. test-only compile stubs for Phase 1D (NOT a migration)"; psql_file "$STUBS_1D"; n=$((n + 1))
echo "── $n. real prerequisite: $PHASE_1D"; psql_file "$REPO/supabase/migrations/$PHASE_1D"; n=$((n + 1))
echo "── $n. test-only stubs: image reward column, permission engine, storage (NOT a migration)"; psql_file "$STUBS_HERE"; n=$((n + 1))
echo "── $n. test-only stubs: notification_type and notifications (NOT a migration)"; psql_file "$STUBS_PHASE"; n=$((n + 1))

for pass in 1 2; do
  for m in "${PENDING[@]}"; do
    echo "── $n. the migration under test (apply $pass of 2): $m"
    psql_file "$REPO/supabase/migrations/$m"
    n=$((n + 1))
  done
done

# ── Assert (repeatable: one transaction, rolled back) ────────────────────────
for ASSERTIONS in "${ASSERTION_FILES[@]}"; do
  for pass in 1 2; do
    echo "── $n. $(basename "$ASSERTIONS") (pass $pass of 2 — it must leave nothing behind)"
    set +e
    OUTPUT="$(docker exec -i "$DB_CONTAINER" psql -U postgres -d "$DB_NAME" -v ON_ERROR_STOP=1 < "$ASSERTIONS" 2>&1)"
    STATUS=$?
    set -e
    if [ "$pass" = 1 ]; then
      printf '%s\n' "$OUTPUT" | grep -E 'NOTICE|ERROR|FATAL|ASSERT' | sed 's/^psql:[^ ]* *//; s/^NOTICE:  //'
    fi
    if [ $STATUS -ne 0 ] || ! printf '%s' "$OUTPUT" | grep -q 'ALL ASSERTIONS PASSED'; then
      printf '%s\n' "$OUTPUT" | grep -E 'ERROR|FATAL|ASSERT|CONTEXT' >&2 || true
      echo "FAIL: $(basename "$ASSERTIONS") did not reach the end on pass $pass (psql exit $STATUS)" >&2
      exit 1
    fi
    n=$((n + 1))
  done
done

echo
echo "OK: the three migrations applied twice and every assertion passed twice on $DB_CONTAINER/$DB_NAME."
echo "    Drop the container when done: docker rm -f $DB_CONTAINER"
