#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════════════════
# TEST-ONLY — runs task_change_status_assertions.sql on a DISPOSABLE local stack
# ═════════════════════════════════════════════════════════════════════════════
#
# Requires 20260832, 20260833, 20260834 and 20270230000000_task_change_status_rpc.sql to be applied.
# Creates three fixture users (committed), runs the assertions (which roll back), removes the users.
# Refuses any container that is not marked disposable or that already holds users or tasks.
#
# MARK A CONTAINER DISPOSABLE (once, on a stack you created for testing):
#   docker exec -i "$BOE_DB_CONTAINER" psql -U postgres -d postgres -c \
#     "comment on database postgres is 'boe-disposable-task-change-status'"
#
# USAGE  BOE_DB_CONTAINER=supabase_db_boe-task-cs supabase/tests/run_task_change_status_local.sh
#
# ⚠ NEVER point this at a linked or production database. It takes no connection string on purpose.

set -euo pipefail
C="${BOE_DB_CONTAINER:?set BOE_DB_CONTAINER}"
HERE="$(cd "$(dirname "$0")" && pwd)"
q() { docker exec -i "$C" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q -t -A -c "$1"; }

case "$(q "select coalesce(shobj_description(oid, 'pg_database'), '') from pg_database where datname = current_database()")" in
  boe-disposable-*) ;;
  *) echo "FATAL: $C is not marked disposable" >&2; exit 1 ;;
esac
[ "$(q "select count(*) from public.users")" = "0" ] || { echo "FATAL: public.users is not empty" >&2; exit 1; }
[ "$(q "select count(*) from public.tasks")" = "0" ] || { echo "FATAL: public.tasks is not empty" >&2; exit 1; }

CREATOR=11111111-1111-4111-8111-111111111111
ASSIGNEE=22222222-2222-4222-8222-222222222222
OUTSIDER=33333333-3333-4333-8333-333333333333

cleanup() { q "delete from public.users where id in ('$CREATOR','$ASSIGNEE','$OUTSIDER')" >/dev/null 2>&1 || true; }
trap cleanup EXIT

q "insert into public.users (id, full_name, email, role, team, is_active) values
     ('$CREATOR',  'Fixture Creator',  'creator@example.test',  'member', 'operations', true),
     ('$ASSIGNEE', 'Fixture Assignee', 'assignee@example.test', 'member', 'sales',      true),
     ('$OUTSIDER', 'Fixture Outsider', 'outsider@example.test', 'member', 'sales',      true)" >/dev/null

sed -e "s/11111111-1111-1111-1111-111111111111/$CREATOR/" \
    -e "s/22222222-2222-2222-2222-222222222222/$ASSIGNEE/" \
    -e "s/33333333-3333-3333-3333-333333333333/$OUTSIDER/" \
    "$HERE/task_change_status_assertions.sql" \
  | docker exec -i "$C" psql -U postgres -d postgres -v ON_ERROR_STOP=1 2>&1 | tee /tmp/task_change_status_assertions.out

grep -q "ALL ASSERTIONS PASSED" /tmp/task_change_status_assertions.out || { echo "FAIL: assertions did not report success" >&2; exit 1; }
echo "OK: task_change_status_assertions.sql passed on $C"
