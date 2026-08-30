#!/usr/bin/env bash
# TWO VERIFIERS PRESSING GENERATE AT THE SAME MOMENT.
#
#   1. BOE_DB_CONTAINER=supabase_db_<project> \
#        bash supabase/tests/run_customer_review_outreach_local.sh
#   2. docker exec -i supabase_db_<project> psql -U postgres -d postgres \
#        -v ON_ERROR_STOP=1 -f - < supabase/fixtures/customer_review_test_cards_clear.sql
#   3. BOE_DB_CONTAINER=supabase_db_<project> \
#        bash supabase/tests/run_customer_review_draft_batch_race.sh
#
# WHY THIS IS NOT IN THE ASSERTION FILE. Section 13 of
# customer_review_test_card_assertions.sql proves every rule that one connection
# can prove: who may call, that the pool must be empty, that twenty is the only
# accepted size, that nothing survives a refusal. It cannot prove the one rule
# that exists only BETWEEN two connections — that when both callers find an
# empty pool at the same instant, exactly one batch is created.
#
# THE CLAIM UNDER TEST. create_customer_review_draft_batch takes
# pg_advisory_xact_lock BEFORE it counts the available pool. So the two calls
# serialize on that lock; the winner inserts twenty and commits; and the loser —
# which was told the pool was empty by every check outside the function, and
# would happily have inserted twenty more — counts the pool AFTER acquiring the
# lock, finds the winner's cards, and refuses with
# CUSTOMER_REVIEW_TEST_POOL_NOT_EMPTY.
#
# If the count were taken before the lock, or the lock were session-scoped and
# released early, this test would end with forty cards and two batch rows.
#
# WHY IT RUNS IN THE STACK'S OWN DATABASE, AND NOT A FRESH ONE. The module's
# migration builds policies over auth.uid() and a private storage bucket, so it
# cannot be applied to a bare `create database` — only to a database Supabase
# has scaffolded. Rather than half-reproduce auth and storage, this runs where
# the local runner has already built the real thing.
#
# It therefore REFUSES unless the stack is marked disposable AND the card table
# is completely empty, so it can never be confused with somebody's work, and it
# deletes every row it created before it exits.
set -euo pipefail

DB="${BOE_DB_NAME:-postgres}"
MARKER=boe-disposable-customer-review-test

fail() { echo "FAIL: $*" >&2; exit 1; }

# ── The target is named, never guessed ──────────────────────────────────────
if [ -z "${BOE_DB_CONTAINER:-}" ]; then
  echo "FATAL: BOE_DB_CONTAINER is not set. Nothing was written." >&2
  docker ps --format '{{.Names}}' | grep '^supabase_db_' | sed 's/^/         /' >&2 || true
  exit 1
fi
docker ps --format '{{.Names}}' | grep -qx "$BOE_DB_CONTAINER" \
  || { echo "FATAL: no running container named $BOE_DB_CONTAINER. Nothing was written." >&2; exit 1; }

q()  { docker exec -i "$BOE_DB_CONTAINER" psql -U postgres -v ON_ERROR_STOP=1 -q  -d "$DB"; }
q1() { docker exec -i "$BOE_DB_CONTAINER" psql -U postgres -v ON_ERROR_STOP=1 -t -A -d "$DB"; }

# ── Every guard runs before a single row is written ─────────────────────────
FOUND="$(echo "select coalesce(shobj_description(oid, 'pg_database'), '(none)')
           from pg_database where datname = current_database()" | q1)" \
  || fail "could not query $BOE_DB_CONTAINER at all. Nothing was written."
[ "$FOUND" = "$MARKER" ] \
  || fail "$BOE_DB_CONTAINER/$DB is not marked disposable (marker: $FOUND). Nothing was written."

HAVE_FN="$(echo "select count(*) from pg_proc
                  where proname = 'create_customer_review_draft_batch'" | q1)"
[ "$HAVE_FN" = "1" ] \
  || fail "20261023000000 is not applied here; run run_customer_review_outreach_local.sh first."

CARDS="$(echo 'select count(*) from public.customer_review_test_cards' | q1)"
[ "$CARDS" = "0" ] || fail "the card table holds $CARDS row(s). This test needs it empty — clear the
       fixture with supabase/fixtures/customer_review_test_cards_clear.sql. Nothing was written."

BATCHES="$(echo 'select count(*) from public.customer_review_draft_batches' | q1)"
[ "$BATCHES" = "0" ] || fail "the batch table already holds $BATCHES row(s). Nothing was written."

echo "══ target : $BOE_DB_CONTAINER/$DB (disposable, module applied, card table empty)"

# Everything this script writes carries the dddddddd- prefix, and this removes
# all of it whichever way the script exits.
cleanup() {
  q >/dev/null 2>&1 <<'CLEANUP' || true
delete from public.customer_review_test_cards where batch_id is not null;
delete from public.customer_review_draft_batches
 where generated_by::text like 'dddddddd-0000-4000-8000-%';
delete from public.employee_permission_overrides
 where user_id::text like 'dddddddd-0000-4000-8000-%';
delete from public.users where id::text like 'dddddddd-0000-4000-8000-%';
CLEANUP
  rm -f /tmp/race_a.out /tmp/race_b.out
}
trap cleanup EXIT

# ── Two verifiers, and an empty pool ────────────────────────────────────────
# Committed, because a lock has to be contended on real rows.
q >/dev/null <<'SEED'
insert into public.users (id, full_name, email, role, team, is_active, created_at, updated_at) values
  ('dddddddd-0000-4000-8000-000000000001', 'Race Verifier One', 'race.v1@example.test', 'member', 'sales', true, now(), now()),
  ('dddddddd-0000-4000-8000-000000000002', 'Race Verifier Two', 'race.v2@example.test', 'member', 'sales', true, now(), now());

insert into public.employee_permission_overrides (user_id, module_id, action_id, allowed, granted_by)
select u.id, m.id, a.id, true, 'dddddddd-0000-4000-8000-000000000001'
  from public.users u
  cross join public.permission_modules m
  cross join public.permission_actions a
 where m.module_key = 'customer_review_requests'
   and a.action_key = 'verify'
   and u.id::text like 'dddddddd-0000-4000-8000-%';
SEED

for who in 1 2; do
  R="$(echo "select public.resolve_permission('dddddddd-0000-4000-8000-00000000000$who',
                                              'customer_review_requests', 'verify')" | q1)"
  [ "$R" = "t" ] || fail "race verifier $who does not resolve verify"
done
echo "══ both callers resolve \`verify\`, and the pool is empty — both are entitled to generate"

PAYLOAD="select coalesce(jsonb_agg(jsonb_build_object(
  'title', 'Race draft ' || i,
  'category', 'restaurant_test',
  'body', 'We ordered seating for a small dining room and the fit was right first time. Draft ' || i || ' is long enough to clear the minimum body length.'
)), '[]'::jsonb) from generate_series(1, 20) i"

# ── The race ────────────────────────────────────────────────────────────────
# Caller A opens a transaction, makes a real call — which takes the advisory
# lock — and then sits on it for two seconds before committing. Caller B arrives
# 0.4s in, while the lock is held and the winner's rows are still uncommitted
# and therefore invisible to it. That is precisely the state a count-then-insert
# cannot survive.
call() {
  q1 2>&1 <<CALL
begin;
select public.create_customer_review_draft_batch(
  'Race guidance $1.', 'claude-opus-5', ($PAYLOAD),
  'dddddddd-0000-4000-8000-00000000000$1');
select pg_sleep($2);
commit;
CALL
}

set +e
call 1 2 >/tmp/race_a.out 2>&1 &
PID_A=$!
sleep 0.4
call 2 0 >/tmp/race_b.out 2>&1
STATUS_B=$?
wait "$PID_A"
STATUS_A=$?
set -e

echo "══ caller A exit $STATUS_A, caller B exit $STATUS_B"

WINNERS=0
[ $STATUS_A -eq 0 ] && WINNERS=$((WINNERS + 1))
[ $STATUS_B -eq 0 ] && WINNERS=$((WINNERS + 1))
[ $WINNERS -eq 1 ] || fail "expected exactly one winner, got $WINNERS (A=$STATUS_A B=$STATUS_B)"

LOSER=/tmp/race_b.out
[ $STATUS_B -eq 0 ] && LOSER=/tmp/race_a.out
grep -q 'CUSTOMER_REVIEW_TEST_POOL_NOT_EMPTY' "$LOSER" \
  || fail "the loser must refuse by name; got: $(cat "$LOSER")"
echo "        ✓ one call won; the other was refused CUSTOMER_REVIEW_TEST_POOL_NOT_EMPTY"

q1 <<'CHECK' | grep -qx 'OK' || fail "the race left the database in a bad state"
select case when
     (select count(*) from public.customer_review_draft_batches) = 1
 and (select count(*) from public.customer_review_test_cards) = 20
 and (select count(*) from public.customer_review_test_cards where status = 'available') = 20
 and (select count(distinct batch_id) from public.customer_review_test_cards) = 1
 and (select count(distinct card_ref) from public.customer_review_test_cards) = 20
then 'OK' else 'BAD: '
  || (select count(*) from public.customer_review_draft_batches) || ' batch(es), '
  || (select count(*) from public.customer_review_test_cards) || ' card(s)' end;
CHECK
echo "        ✓ ONE batch row, TWENTY cards, twenty distinct references"

# The stored guidance must belong to the caller that actually won — not a
# mixture, and not the loser's.
STORED="$(echo 'select guidance from public.customer_review_draft_batches' | q1)"
EXPECTED="Race guidance 1."
[ $STATUS_A -eq 0 ] || EXPECTED="Race guidance 2."
[ "$STORED" = "$EXPECTED" ] || fail "stored guidance is '$STORED', expected '$EXPECTED'"
echo "        ✓ the stored guidance is the winner's: '$STORED'"

echo "══ draft-batch race complete; every row it wrote has been removed"
