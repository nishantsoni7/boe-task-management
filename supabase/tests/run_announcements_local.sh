#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════════════════
# TEST-ONLY RUNNER — 20270110000000_announcements.sql, on a disposable local
# Supabase stack
# ═════════════════════════════════════════════════════════════════════════════
#
# WHAT IT PROVES, IN ORDER
#   1. the migration APPLIES to a blank stack holding its one prerequisite
#      (public.users, supplied by bootstrap/010);
#   2. it is SAFE TO APPLY TWICE;
#   3. announcements_assertions.sql passes: admin-only writes, a named audience,
#      the India-date inclusive window, own-row read state, and the private PDF.
#
# WHY A SUPABASE STACK AND NOT BARE POSTGRES: the migration creates a storage
# bucket and storage.objects policies, which need the storage schema.
#
# WHAT IT WILL NOT DO. It will not choose its own target (BOE_DB_CONTAINER must
# name it), and it refuses any database that is not marked disposable with this
# script's marker or that holds any table, identity, object or bucket — the
# shared gate in lib/disposable_stack_guard.sh. The assertions end in ROLLBACK.
#
# PREREQUISITES
#   1. A fresh local stack: `supabase start` in a throwaway workdir.
#   2. Mark it disposable:
#        docker exec -i supabase_db_<project> psql -U postgres -d postgres -c \
#          "comment on database postgres is 'boe-disposable-announcements'"
#
# USAGE
#   BOE_DB_CONTAINER=supabase_db_<project> supabase/tests/run_announcements_local.sh
#
# Afterwards: `supabase stop --no-backup` in that workdir.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DB_CONTAINER="${BOE_DB_CONTAINER:?set BOE_DB_CONTAINER to the db container of the throwaway stack}"
DB_NAME="${BOE_DB_NAME:-postgres}"
MARKER="boe-disposable-announcements"

PRIVILEGES="$REPO/supabase/tests/bootstrap/006_meeting_discussion_default_privileges.sql"
BASELINE="$REPO/supabase/tests/bootstrap/010_announcements_baseline.sql"
PENDING="20270110000000_announcements.sql"
ASSERTIONS="$REPO/supabase/tests/announcements_assertions.sql"

# shellcheck source=supabase/tests/lib/disposable_stack_guard.sh
. "$REPO/supabase/tests/lib/disposable_stack_guard.sh"

psql_file() {
  docker exec -i "$DB_CONTAINER" psql -U postgres -d "$DB_NAME" -v ON_ERROR_STOP=1 -q < "$1"
}

echo "── target: container $DB_CONTAINER, database $DB_NAME"
require_disposable_stack || exit 1
echo "   disposable marker present; public, auth and storage empty"

if [ ! -f "$REPO/supabase/migrations/$PENDING" ]; then
  echo "FATAL: supabase/migrations/$PENDING is missing." >&2
  exit 1
fi

echo "── 1. production's default privileges (006) and the users baseline (010)"
psql_file "$PRIVILEGES"
psql_file "$BASELINE"

echo "── 2. the migration under test: $PENDING"
psql_file "$REPO/supabase/migrations/$PENDING"

echo "── 3. the same file again — it must be safe to apply twice"
psql_file "$REPO/supabase/migrations/$PENDING"

echo "── 4. announcements_assertions.sql"
set +e
OUTPUT="$(docker exec -i "$DB_CONTAINER" psql -U postgres -d "$DB_NAME" -v ON_ERROR_STOP=1 < "$ASSERTIONS" 2>&1)"
STATUS=$?
set -e
printf '%s\n' "$OUTPUT" | grep -E 'NOTICE|ERROR|FATAL|ASSERT' | grep -v 'does not exist, skipping' | sed 's/^psql:[^ ]* *//; s/^NOTICE:  //'

if [ $STATUS -ne 0 ] || ! printf '%s' "$OUTPUT" | grep -q 'ALL ASSERTIONS PASSED'; then
  echo "FAIL: the assertions did not reach the end (psql exit $STATUS)" >&2
  exit 1
fi

echo
echo "OK: $PENDING applied twice and every assertion passed on $DB_CONTAINER/$DB_NAME."
