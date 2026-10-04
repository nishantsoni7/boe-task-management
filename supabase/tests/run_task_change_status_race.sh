#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════════════════
# TEST-ONLY — two-connection races for change_task_status()
# ═════════════════════════════════════════════════════════════════════════════
#
# Run on the same DISPOSABLE container as run_task_change_status_local.sh. This script COMMITS its fixtures, so it
# refuses a container that is not marked disposable or that already holds users or tasks. It removes what it adds.
#
#   R1  double press   two connections complete the same self task at once. The second waits on the row lock the first
#                      holds, then finds the task finished and is refused (SQLSTATE 55000). Exactly ONE history row.
#   R2  two doors      change_task_status(working -> started) and transition_task_review(submit) race on one delegated
#                      task. Whichever takes the lock first completes; the other then validates against the CHANGED row.
#                      No lost update, no orphan history row: every history row's from_status is the status the task
#                      actually had, and the final status is the last row's to_status.
#
# Ordering is forced with a held transaction (pg_sleep inside the first session) and confirmed through pg_stat_activity
# — the second session is observed WAITING ON A LOCK — not with a blind sleep.
#
# USAGE  BOE_DB_CONTAINER=supabase_db_boe-task-cs supabase/tests/run_task_change_status_race.sh

set -euo pipefail
C="${BOE_DB_CONTAINER:?set BOE_DB_CONTAINER}"
q() { docker exec -i "$C" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q -t -A -c "$1"; }

case "$(q "select coalesce(shobj_description(oid, 'pg_database'), '') from pg_database where datname = current_database()")" in
  boe-disposable-*) ;;
  *) echo "FATAL: $C is not marked disposable" >&2; exit 1 ;;
esac
[ "$(q "select count(*) from public.users")" = "0" ] || { echo "FATAL: public.users is not empty" >&2; exit 1; }
[ "$(q "select count(*) from public.tasks")" = "0" ] || { echo "FATAL: public.tasks is not empty" >&2; exit 1; }

CREATOR=11111111-1111-4111-8111-111111111111
ASSIGNEE=22222222-2222-4222-8222-222222222222
SELF=f1000000-0000-4000-8000-000000000001
DELEG=f2000000-0000-4000-8000-000000000002

cleanup() {
  q "delete from public.task_activity_log where task_id in ('$SELF','$DELEG')" >/dev/null 2>&1 || true
  q "delete from public.notifications where task_id in ('$SELF','$DELEG')" >/dev/null 2>&1 || true
  q "delete from public.tasks where id in ('$SELF','$DELEG')" >/dev/null 2>&1 || true
  q "delete from public.users where id in ('$CREATOR','$ASSIGNEE')" >/dev/null 2>&1 || true
  rm -f /tmp/tcs_r1a.out /tmp/tcs_r1b.out /tmp/tcs_r2a.out /tmp/tcs_r2b.out
}
trap cleanup EXIT

q "insert into public.users (id, full_name, email, role, team, is_active) values
     ('$CREATOR',  'Race Creator',  'racec@example.test', 'member', 'operations', true),
     ('$ASSIGNEE', 'Race Assignee', 'racea@example.test', 'member', 'sales',      true)" >/dev/null
q "insert into public.tasks (id, title, status, priority, created_by, assigned_to, task_type, acknowledged_at, team) values
     ('$SELF',  'RACE self',  'working', 'medium', '$ASSIGNEE', '$ASSIGNEE', 'general', null,  'sales'),
     ('$DELEG', 'RACE deleg', 'working', 'medium', '$CREATOR',  '$ASSIGNEE', 'general', now(), 'sales')" >/dev/null

as_assignee="select set_config('request.jwt.claim.sub', '$ASSIGNEE', true), set_config('request.jwt.claims', json_build_object('sub', '$ASSIGNEE', 'role', 'authenticated')::text, true);"

wait_blocked() { # a second connection is waiting on a lock
  for _ in $(seq 1 100); do
    [ "$(q "select count(*) from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'")" -ge 1 ] && return 0
    sleep 0.1
  done
  echo "FATAL: the second session never blocked on the row lock" >&2; return 1
}
rows() { q "select count(*) from public.task_activity_log where task_id = '$1' and action = 'status_changed'"; }

# ── R1 double press ──────────────────────────────────────────────────────────
docker exec -i "$C" psql -U postgres -d postgres -q -t -A \
  -c "begin; $as_assignee select public.change_task_status('$SELF', 'completed'); select pg_sleep(2); commit;" > /tmp/tcs_r1a.out 2>&1 &
sleep 0.5
docker exec -i "$C" psql -U postgres -d postgres -q -t -A \
  -c "begin; $as_assignee select public.change_task_status('$SELF', 'completed'); commit;" > /tmp/tcs_r1b.out 2>&1 &
wait_blocked
wait
[ "$(rows "$SELF")" = "1" ] || { echo "FAIL R1: expected exactly 1 history row, found $(rows "$SELF")" >&2; exit 1; }
[ "$(q "select status from public.tasks where id = '$SELF'")" = "completed" ] || { echo "FAIL R1: task is not completed" >&2; exit 1; }
grep -q "TASK_STATUS_FINISHED" /tmp/tcs_r1a.out /tmp/tcs_r1b.out \
  || { echo "FAIL R1: neither session was refused with TASK_STATUS_FINISHED" >&2; cat /tmp/tcs_r1a.out /tmp/tcs_r1b.out >&2; exit 1; }
echo "OK R1: two simultaneous completions -> one change, one history row, one clean refusal"

# ── R2 two doors on one delegated task ───────────────────────────────────────
docker exec -i "$C" psql -U postgres -d postgres -q -t -A \
  -c "begin; $as_assignee select public.change_task_status('$DELEG', 'started'); select pg_sleep(2); commit;" > /tmp/tcs_r2a.out 2>&1 &
sleep 0.5
docker exec -i "$C" psql -U postgres -d postgres -q -t -A \
  -c "begin; $as_assignee select public.transition_task_review('$DELEG', 'submit'); commit;" > /tmp/tcs_r2b.out 2>&1 &
wait_blocked
wait
[ "$(q "select status from public.tasks where id = '$DELEG'")" = "pending_approval" ] \
  || { echo "FAIL R2: final status is not pending_approval" >&2; cat /tmp/tcs_r2a.out /tmp/tcs_r2b.out >&2; exit 1; }
[ "$(rows "$DELEG")" = "2" ] || { echo "FAIL R2: expected 2 history rows (started, submit), found $(rows "$DELEG")" >&2; exit 1; }
chain=$(q "select string_agg(from_status::text || '>' || to_status::text, ',' order by created_at, id) from public.task_activity_log where task_id = '$DELEG' and action = 'status_changed'")
[ "$chain" = "working>started,started>pending_approval" ] || { echo "FAIL R2: history chain is '$chain'" >&2; exit 1; }
echo "OK R2: change_task_status vs transition_task_review -> serialised; chain $chain"
