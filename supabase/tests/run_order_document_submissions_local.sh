#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════════════════
# TEST-ONLY RUNNER — 20270112000000_order_document_submissions.sql, on a
# DISPOSABLE local Supabase stack
# ═════════════════════════════════════════════════════════════════════════════
#
# WHAT THIS IS FOR
# ----------------
# src/lib/orders/orderDocumentSubmissions*.test.ts check the screen's logic.
# This EXECUTES the migration — twice, to prove it is safe to apply again — and
# then runs order_document_submissions_assertions.sql through the real doors:
# submit, the admin decision and the operations decision; permissions, races,
# stale tabs, snapshot integrity, append-only history, and that no Order field,
# PI version or handoff moves.
#
# WHAT IT TARGETS, AND WHY
# ------------------------
# A LOCAL SUPABASE STACK, not a bare container: the handoff hooks the writes
# approve_order_submission() and approve_order_pi_revision() make, and the
# fixture drives the first of them for real, which needs the whole Orders and
# Finance chain, storage.objects and a real auth.uid(). Building that stack is
# the recipe in docs/migrations-are-not-self-contained.md: the four tables the
# migrations never create are supplied from supabase/tests/bootstrap, and a
# handful of migrations that assert PRODUCTION DATA exists (a specific test
# Order, the baseline accounts, the owner's employee_code) are applied against
# throwaway copies in which those data assertions are downgraded to notices.
# None of that touches this repository: the copies live in a temporary folder.
#
# WHAT IT WILL NOT DO
# -------------------
# It will not choose its own target: BOE_DB_CONTAINER must name the container.
# It reads no environment file, names no linked project, never pushes. It refuses a database
# that does not carry order_pi_versions (the chain was not replayed) or that
# holds real-looking Orders (it is not disposable). The assertions end in
# ROLLBACK; the migration itself is left applied, as it would be after a deploy.
#
# PREREQUISITES
# -------------
#   1. Docker running, and a local stack started from THIS worktree with its own
#      config.toml (see supabase/tests/README notes in the memory file
#      local-supabase-stack-per-worktree): `npx supabase start`.
#   2. The chain replayed into it (bootstrap 006 first, the four stub tables,
#      then every migration in order, tolerating the unrelated failures).
#   3. A user with employee_code TEST-001 and id
#      11111111-1111-1111-1111-111111111111 (the owner's permanent grant), which
#      the replay of 20261224000000 requires anyway.
#
# USAGE
#   BOE_DB_CONTAINER=supabase_db_<project_id> bash supabase/tests/run_order_operations_handoff_local.sh
# ═════════════════════════════════════════════════════════════════════════════
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIGRATION="$HERE/../migrations/20270112000000_order_document_submissions.sql"
ASSERTIONS="$HERE/order_document_submissions_assertions.sql"

: "${BOE_DB_CONTAINER:?BOE_DB_CONTAINER must name the database container of the disposable stack}"
case "$BOE_DB_CONTAINER" in
  supabase_db_*) ;;
  *) echo "refusing: $BOE_DB_CONTAINER is not a local Supabase database container" >&2; exit 2 ;;
esac

psql_in() { docker exec -i "$BOE_DB_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q "$@"; }
scalar()  { docker exec -i "$BOE_DB_CONTAINER" psql -U postgres -d postgres -Atc "$1"; }

# ── Guards: the right kind of database, and a disposable one ──
[ "$(scalar "select to_regclass('public.order_pi_versions') is not null")" = "t" ] \
  || { echo "refusing: order_pi_versions is missing — replay the chain first" >&2; exit 3; }
[ "$(scalar "select to_regprocedure('public.approve_order_submission(uuid, uuid, date, date, text)') is not null")" = "t" ] \
  || { echo "refusing: approve_order_submission(uuid, uuid, date, date, text) is missing — 20261201000000+ not applied" >&2; exit 3; }
[ "$(scalar "select count(*) from public.orders where client_name not like 'ASSERT%'")" = "0" ] \
  || { echo "refusing: this database holds Orders that are not test fixtures; it is not disposable" >&2; exit 4; }
[ "$(scalar "select count(*) from public.users where employee_code = 'TEST-001' and id = '11111111-1111-1111-1111-111111111111'")" = "1" ] \
  || { echo "refusing: the owner account (TEST-001, id 1111…) is missing" >&2; exit 3; }

echo "1/3 applying the migration"
psql_in --single-transaction -f - < "$MIGRATION"
echo "2/3 applying it AGAIN (must be a no-op)"
psql_in --single-transaction -f - < "$MIGRATION"
echo "3/3 assertions (one transaction, rolls back)"
docker exec -i "$BOE_DB_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f - < "$ASSERTIONS" \
  | grep -E "ALL DOCUMENT SUBMISSION ASSERTIONS PASSED|ERROR" || true
docker exec -i "$BOE_DB_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q -f - < "$ASSERTIONS" > /dev/null
echo "OK: 20270112000000 applies twice and every document submission assertion holds"
