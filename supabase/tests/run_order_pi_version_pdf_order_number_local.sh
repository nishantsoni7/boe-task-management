#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════════════════
# TEST-ONLY RUNNER — 20270201000000_order_pi_version_pdf_order_number.sql, on a
# DISPOSABLE local Supabase stack
# ═════════════════════════════════════════════════════════════════════════════
#
# WHAT IT DOES, IN ORDER
#   1. Commits PI versions in every status (superseded, approved, rejected,
#      pending) through the real doors on the schema BEFORE the migration:
#      _order_pi_version_pdf_order_number_prior_versions.sql.
#   2. Proves the migration REFUSES, before writing anything, when a version's
#      Order has a missing or a blank number (each attempt rolls back). Neither
#      can happen today — display_number is NOT NULL and CHECKed — so each
#      attempt lifts both inside its own rolled-back transaction.
#   3. Applies the migration — twice, to prove it is safe to apply again.
#   4. Runs order_pi_version_pdf_order_number_assertions.sql (one transaction,
#      rolls back): backfill, V1, Edit PI and workbook revisions approved and
#      rejected, direct writes, and reading.
#
# WHAT IT WILL NOT DO
#   It will not choose its own target: BOE_DB_CONTAINER must name a local
#   supabase_db_* container. It reads no environment file, names no linked
#   project, never pushes. It refuses a database that holds Orders other than
#   test fixtures, or one where the migration is already applied (step 1 needs
#   the schema before it). Steps 1 and 3 COMMIT: use a throwaway stack or a
#   throwaway copy of one (BOE_DB_NAME).
#
# PREREQUISITES
#   A local stack started from this worktree with its own config.toml, the
#   chain replayed into it (docs/migrations-are-not-self-contained.md), the
#   owner account TEST-001 (1111…), and the suite people: sales 5555…,
#   operations 7777…, outsider 4444… (no Orders permission), sales holding
#   orders view + create.
#
# USAGE
#   BOE_DB_CONTAINER=supabase_db_<project_id> [BOE_DB_NAME=postgres] \
#     bash supabase/tests/run_order_pi_version_pdf_order_number_local.sh
# ═════════════════════════════════════════════════════════════════════════════
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIGRATION="$HERE/../migrations/20270201000000_order_pi_version_pdf_order_number.sql"
HELPERS="$HERE/_order_pi_version_pdf_order_number_helpers.sql"
FIXTURE="$HERE/_order_pi_version_pdf_order_number_prior_versions.sql"
ASSERTIONS="$HERE/order_pi_version_pdf_order_number_assertions.sql"

: "${BOE_DB_CONTAINER:?BOE_DB_CONTAINER must name the database container of the disposable stack}"
DB="${BOE_DB_NAME:-postgres}"
case "$BOE_DB_CONTAINER" in
  supabase_db_*) ;;
  *) echo "refusing: $BOE_DB_CONTAINER is not a local Supabase database container" >&2; exit 2 ;;
esac

# Windows checkouts are CRLF; psql reads stdin.
sql()     { tr -d '\r' < "$1"; }
psql_in() { docker exec -i "$BOE_DB_CONTAINER" psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 -q "$@"; }
scalar()  { docker exec -i "$BOE_DB_CONTAINER" psql -U postgres -d "$DB" -Atc "$1"; }

[ "$(scalar "select to_regclass('public.order_pi_versions') is not null")" = "t" ] \
  || { echo "refusing: order_pi_versions is missing — replay the chain first" >&2; exit 3; }
[ "$(scalar "select count(*) from public.orders where client_name not like 'ASSERT%'")" = "0" ] \
  || { echo "refusing: this database holds Orders that are not test fixtures; it is not disposable" >&2; exit 4; }
[ "$(scalar "select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'order_pi_versions' and column_name = 'pdf_order_number'")" = "0" ] \
  || { echo "refusing: 20270201000000 is already applied; the backfill needs the schema before it" >&2; exit 3; }
[ "$(scalar "select count(*) from public.users where id in ('11111111-1111-1111-1111-111111111111', '55555555-5555-5555-5555-555555555555', '77777777-7777-7777-7777-777777777777', '44444444-4444-4444-4444-444444444444')")" = "4" ] \
  || { echo "refusing: the owner and suite people (1111…, 5555…, 7777…, 4444…) are missing" >&2; exit 3; }

echo "1/5 earlier PI versions, every status, through the real doors (commits)"
{ sql "$HELPERS"; sql "$FIXTURE"; } | psql_in -f - > /dev/null

echo "2/5 the migration refuses a missing or blank Order number, and writes nothing"
for bad in "null" "'   '"; do
  out="$({ printf '%s\n' \
      'begin;' \
      'alter table public.orders disable trigger user;' \
      'alter table public.orders drop constraint orders_display_number_four_digit;' \
      'alter table public.orders alter column display_number drop not null;' \
      "update public.orders set display_number = $bad where client_name = 'ASSERT pdfnum prior B';"; \
    sql "$MIGRATION"; echo 'rollback;'; } \
    | docker exec -i "$BOE_DB_CONTAINER" psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 -q -f - 2>&1 || true)"
  echo "$out" | grep -q "PDF_ORDER_NUMBER_BACKFILL_BLOCKED: 2 PI version(s) belong to an Order with a blank or missing Order number" \
    || { echo "FAILED: display_number = $bad was not refused as expected:" >&2; echo "$out" >&2; exit 1; }
done
[ "$(scalar "select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'order_pi_versions' and column_name = 'pdf_order_number'")" = "0" ] \
  || { echo "FAILED: a refused migration left the column behind" >&2; exit 1; }
[ "$(scalar "select count(*) from public.orders where client_name = 'ASSERT pdfnum prior B' and display_number ~ '^[0-9]{4}\$'")" = "1" ] \
  || { echo "FAILED: the refusal test left the Order changed" >&2; exit 1; }

echo "3/5 applying the migration"
sql "$MIGRATION" | psql_in --single-transaction -f -
echo "4/5 applying it AGAIN (must be a no-op)"
sql "$MIGRATION" | psql_in --single-transaction -f -

echo "5/5 assertions (one transaction, rolls back)"
out="$({ sql "$HELPERS"; sql "$ASSERTIONS"; } | docker exec -i "$BOE_DB_CONTAINER" psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 -q -f - 2>&1)" \
  || { echo "$out" | grep -E "NOTICE|ERROR|CONTEXT" >&2; echo "FAILED" >&2; exit 1; }
echo "$out" | grep -E "NOTICE:  [0-9]\.|ALL PI PDF ORDER NUMBER ASSERTIONS PASSED"
echo "$out" | grep -q "ALL PI PDF ORDER NUMBER ASSERTIONS PASSED" || { echo "FAILED: no success line" >&2; exit 1; }
echo "OK: 20270201000000 backfills, refuses a missing number, applies twice, and every PDF Order number assertion holds"
