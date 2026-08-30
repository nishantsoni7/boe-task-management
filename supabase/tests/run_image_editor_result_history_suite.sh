#!/usr/bin/env bash
# Build a Supabase-shaped PostgreSQL database, apply
# 20261021000000_image_editor_result_history.sql verbatim, and prove what its
# policies actually do:
#
#   * the owner reads their unexpired results, and nobody else's
#   * another user reads none of them, and can neither keep nor delete them
#   * an EXPIRED, UNKEPT result is unreadable by its own owner — row and object
#   * an expired KEPT result stays readable, row and object
#   * Keep, Unkeep and Delete still work on an expired result, which is what
#     stops the retention rule from stranding one
#   * losing module entry closes the whole history at the database
#   * a member who still has results CANNOT be deleted — the RESTRICT that keeps
#     a cascade from orphaning every object — and deletes normally once the
#     history is empty
#   * the service role, which bypasses RLS, sweeps a due result
#   * the bucket is private, PNG-only and capped
#
#   supabase/tests/run_image_editor_result_history_suite.sh <psql-host-or-socket-dir> [port]
#
# Creates and drops a database called `boe_image_editor_history`. Touches nothing
# else, and never talks to a linked project — the fixture refuses to build in a
# database whose name is not this one.
set -euo pipefail
HOST="${1:?usage: run_image_editor_result_history_suite.sh <psql host or socket dir> [port]}"
PORT="${2:-5432}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DB=boe_image_editor_history
Q=(psql -h "$HOST" -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -q)

"${Q[@]}" -d postgres -c "drop database if exists $DB" >/dev/null
"${Q[@]}" -d postgres -c "create database $DB" >/dev/null
trap '"${Q[@]}" -d postgres -c "drop database if exists '"$DB"'" >/dev/null 2>&1 || true' EXIT

echo "══ building the shaped schema ══"
"${Q[@]}" -d "$DB" -f "$REPO/supabase/tests/_image_editor_result_history_shaped_schema.sql" >/dev/null

echo "══ applying 20261021000000 ══"
# --single-transaction: the migration's own assertion block must be able to fail
# the whole apply, exactly as it would on a real project.
"${Q[@]}" -d "$DB" --single-transaction \
  -f "$REPO/supabase/migrations/20261021000000_image_editor_result_history.sql"

# The migration creates the table; Supabase grants the API roles their table
# privileges automatically. Row-level security is what this suite tests, so the
# privileges have to be there for the policies to be the thing that decides.
"${Q[@]}" -d "$DB" -c "
  grant select, insert, update, delete on public.image_editor_results
    to authenticated, service_role;" >/dev/null

echo "══ the assertions ══"
"${Q[@]}" -d "$DB" -f "$REPO/supabase/tests/image_editor_result_history_assertions.sql"

echo
echo "ALL CHECKS PASSED"
