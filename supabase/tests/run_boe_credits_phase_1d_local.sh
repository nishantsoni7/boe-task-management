#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════════════════
# TEST-ONLY RUNNER — 20261104000000_boe_credits_phase_1d.sql, on an isolated
# bare PostgreSQL container
# ═════════════════════════════════════════════════════════════════════════════
#
# The Phase 1D sibling of run_boe_credits_attendance_redemption_local.sh: the
# same bare target, the same guard, one more prerequisite (Phase 1C) and one
# test-only stub file (003) so the re-created verify transition compiles
# without the Review Workflow chain. The transition itself is never executed
# here; see run_boe_credits_phase_1d_stack_local.sh for that.
#
# WHAT IT PROVES, IN ORDER
#   1. the migration APPLIES on top of its real prerequisites;
#   2. it is SAFE TO APPLY TWICE;
#   3. the Phase 1D rules hold AT THE DATABASE — see the header of
#      boe_credits_phase_1d_assertions.sql (one rolled-back transaction, so it
#      is repeatable);
#   4. the Phase 1C suite's behavioural sections (§0–§12) still pass against
#      the Phase 1D schema once the settings carry the Phase 1C prices (1 / 2)
#      — the old rules are the new rules at the old prices. Its §13, which
#      pins the pre-1D trigger count on the ledger, is cut.
#
# PREREQUISITES
#   1. Docker running.
#   2. A throwaway PostgreSQL container, e.g.
#        docker run -d --name boe-credits-pg -e POSTGRES_PASSWORD=postgres postgres:16-alpine
#   3. Name it and mark it disposable:
#        export BOE_DB_CONTAINER=boe-credits-pg
#        docker exec -i "$BOE_DB_CONTAINER" psql -U postgres -d postgres -c \
#          "comment on database postgres is 'boe-disposable-boe-credits'"
#
# USAGE
#   BOE_DB_CONTAINER=boe-credits-pg supabase/tests/run_boe_credits_phase_1d_local.sh
#
# Afterwards: docker rm -f boe-credits-pg

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DB_CONTAINER="${BOE_DB_CONTAINER:?set BOE_DB_CONTAINER to the throwaway PostgreSQL container}"
DB_NAME="${BOE_DB_NAME:-postgres}"
MARKER="boe-disposable-boe-credits"

BASELINE="$REPO/supabase/tests/bootstrap/002_boe_credits_baseline.sql"
STUBS="$REPO/supabase/tests/bootstrap/003_boe_credits_phase_1d_stubs.sql"
PREREQS=(
  "20260611_create_payroll_periods.sql"
  "20260612000000_create_payroll_generation_tables.sql"
  "20260616_add_generated_status_to_payroll_periods.sql"
  "20261101000000_boe_credits_foundation.sql"
  "20261103000000_boe_credits_attendance_redemption.sql"
)
PENDING="20261104000000_boe_credits_phase_1d.sql"
ASSERTIONS="$REPO/supabase/tests/boe_credits_phase_1d_assertions.sql"
ASSERTIONS_1C="$REPO/supabase/tests/boe_credits_attendance_redemption_assertions.sql"

# shellcheck source=supabase/tests/lib/disposable_stack_guard.sh
. "$REPO/supabase/tests/lib/disposable_stack_guard.sh"

psql_file() {
  docker exec -i "$DB_CONTAINER" psql -U postgres -d "$DB_NAME" -v ON_ERROR_STOP=1 -q < "$1"
}
psql_cmd() {
  docker exec -i "$DB_CONTAINER" psql -U postgres -d "$DB_NAME" -v ON_ERROR_STOP=1 -q -c "$1"
}

# ── The gate, for a bare container (verbatim from run_boe_credits_local.sh) ──
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
      echo "FATAL: $DB_CONTAINER carries no disposable marker."
      echo "       This script only builds on a database somebody has declared throwaway:"
      echo "         docker exec -i $DB_CONTAINER psql -U postgres -d $DB_NAME -c \\"
      echo "           \"comment on database $DB_NAME is '$MARKER'\""
      echo "       Nothing was written."
    } >&2
    return 1
  fi
  if [ "$found_marker" != "$MARKER" ]; then
    {
      echo "FATAL: marker mismatch on $DB_CONTAINER."
      echo "       found    '$found_marker'"
      echo "       expected '$MARKER'"
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

  local ledger
  if ! ledger="$(_psql_raw "select coalesce(to_regclass('supabase_migrations.schema_migrations')::text, '')")"; then
    {
      echo "FATAL: could not determine whether $DB_CONTAINER has a migration ledger."
      printf '%s\n' "$ledger" | sed 's/^/         /'
      echo "       Nothing was written."
    } >&2
    return 1
  fi
  if [ -n "$ledger" ]; then
    _require_empty 'migration ledger' \
      "select count(*) from supabase_migrations.schema_migrations" \
      'row(s) in the migration ledger' || return 1
  fi
}

echo "── target: container $DB_CONTAINER, database $DB_NAME"
require_disposable_bare_postgres || exit 1
echo "   disposable marker present, public empty"

# ── The prerequisites must be what HEAD says they are ────────────────────────
for m in "${PREREQS[@]}"; do
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

# ── Build ────────────────────────────────────────────────────────────────────
echo "── 1. test-only baseline (NOT a migration)"
psql_file "$BASELINE"

n=2
for m in "${PREREQS[@]}"; do
  echo "── $n. real prerequisite: $m"
  psql_file "$REPO/supabase/migrations/$m"
  n=$((n + 1))
done

echo "── $n. test-only compile stubs for the verify transition (NOT a migration)"
psql_file "$STUBS"
n=$((n + 1))

echo "── $n. the migration under test: $PENDING"
psql_file "$REPO/supabase/migrations/$PENDING"
n=$((n + 1))

echo "── $n. the same file again — it must be safe to apply twice"
psql_file "$REPO/supabase/migrations/$PENDING"
n=$((n + 1))

run_suite() {
  local file="$1" label="$2" pass
  for pass in 1 2; do
    echo "── $n. $label (pass $pass of 2 — it must leave nothing behind)"
    set +e
    OUTPUT="$(docker exec -i "$DB_CONTAINER" psql -U postgres -d "$DB_NAME" -v ON_ERROR_STOP=1 < "$file" 2>&1)"
    STATUS=$?
    set -e
    if [ "$pass" = 1 ]; then
      printf '%s\n' "$OUTPUT" | grep -E 'NOTICE|ERROR|FATAL|ASSERT' | sed 's/^psql:[^ ]* *//; s/^NOTICE:  //'
    fi
    if [ $STATUS -ne 0 ] || ! printf '%s' "$OUTPUT" | grep -q 'ALL ASSERTIONS PASSED'; then
      printf '%s\n' "$OUTPUT" | grep -E 'ERROR|FATAL|ASSERT' >&2 || true
      echo "FAIL: $label did not reach the end on pass $pass (psql exit $STATUS)" >&2
      exit 1
    fi
    n=$((n + 1))
  done
}

# ── Assert (repeatable: one transaction, rolled back) ────────────────────────
run_suite "$ASSERTIONS" "boe_credits_phase_1d_assertions.sql"

# ── The Phase 1C suite, at the Phase 1C prices ───────────────────────────────
# The 1C assertions were written when a half day cost 1 and an absent day 2.
# With those prices active they must still pass in full: the Phase 1D schema
# changes nothing the 1C rules relied on except where the cost comes from.
# The settings row is the only thing left behind, and the container is disposable.
echo "── $n. a settings row at the Phase 1C prices (1 / 2), so the 1C suite reads its own world"
psql_cmd "insert into public.boe_credit_settings (review_reward_credits, credit_value, half_day_redemption_credits, full_day_redemption_credits, minimum_monthly_reviews, note) values (1, 100.00, 1, 2, 3, 'test-only: Phase 1C prices for the 1C suite')"
n=$((n + 1))
# Its §13 pins the PRE-1D trigger set on the ledger ("exactly two triggers");
# Phase 1D adds two more by design, so that one structural block is cut and
# every behavioural section (§0–§12) runs as written.
ONE_C_TRIMMED="$(mktemp)"
awk '/^-- ═══ §13. The foundation is untouched/{skip=1} /^do [$][$] begin raise notice .ALL ASSERTIONS PASSED/{skip=0} !skip' "$ASSERTIONS_1C" > "$ONE_C_TRIMMED"
run_suite "$ONE_C_TRIMMED" "boe_credits_attendance_redemption_assertions.sql §0–§12 (Phase 1C rules on the Phase 1D schema)"
rm -f "$ONE_C_TRIMMED"

echo
echo "OK: $PENDING applied twice and every Phase 1D and Phase 1C assertion passed twice on $DB_CONTAINER/$DB_NAME."
echo "    The database still holds the schema; drop the container when done."
