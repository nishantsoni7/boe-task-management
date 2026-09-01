#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════════════════
# THE THINGS THAT ONLY GO WRONG BETWEEN TWO CONNECTIONS
# ═════════════════════════════════════════════════════════════════════════════
#
#   1. BOE_DB_CONTAINER=supabase_db_<project> \
#        bash supabase/tests/run_customer_review_outreach_local.sh
#   2. docker exec -i supabase_db_<project> psql -U postgres -d postgres \
#        -v ON_ERROR_STOP=1 -f - < supabase/fixtures/customer_review_test_cards_clear.sql
#   3. BOE_DB_CONTAINER=supabase_db_<project> \
#        bash supabase/tests/run_customer_review_draft_batch_race.sh
#
# WHY THIS IS NOT IN THE ASSERTION FILE. Sections 13 and 14 of
# customer_review_test_card_assertions.sql prove every rule that ONE connection
# can prove: who may generate, approve, revise and release; that eight is the
# only accepted batch size; that a pending draft is invisible to a candidate;
# that nothing survives a refusal. They cannot prove a rule that exists only
# BETWEEN two connections, because a single session can never observe another
# session's uncommitted work.
#
# THREE RACES, and each was a real hazard in the design rather than a
# hypothetical one:
#
#   A. TWO TAPS OF ONE GENERATE BUTTON. The empty-pool rule used to stop a
#      double submission by accident — the first batch filled the pool, so the
#      second was refused. That rule is gone, so a repeated request is now
#      stopped on purpose: both carry the same request_key, the advisory lock
#      serialises them, and the second returns the batch the first created
#      instead of adding eight more.
#
#   B. SEND-CONFIRM AGAINST UNBOOK. A candidate confirming they sent a review
#      while the same review is being released is the one interleaving that
#      could leave a card both back in the pool and marked as sent. Both
#      functions take the row lock first, so one of them must lose — and which
#      one loses decides what the final state is allowed to be.
#
#   C. TWO VERIFIERS APPROVING OVERLAPPING SELECTIONS. Approval is atomic per
#      selection; two selections sharing a member must not both succeed, and the
#      loser must not have half-approved its private members.
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
                  where proname in ('create_customer_review_draft_batch',
                                    'approve_customer_review_drafts',
                                    'unbook_customer_review_test_card')" | q1)"
[ "$HAVE_FN" = "3" ] \
  || fail "20261026000000 is not applied here; run run_customer_review_outreach_local.sh first."

HAVE_DEL="$(echo "select count(*) from pg_proc
                  where proname in ('delete_customer_review_test_cards',
                                    'customer_review_replace_available')" | q1)"
[ "$HAVE_DEL" = "2" ] \
  || fail "20261030000000 is not applied here; run run_customer_review_outreach_local.sh first."

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
delete from public.customer_review_test_card_events
 where card_id in (select id from public.customer_review_test_cards where batch_id is not null);
delete from public.customer_review_test_cards where batch_id is not null;
delete from public.customer_review_draft_batch_revisions;
delete from public.customer_review_generation_claims
 where claimed_by::text like 'dddddddd-0000-4000-8000-%';
delete from public.customer_review_draft_batches
 where generated_by::text like 'dddddddd-0000-4000-8000-%';
delete from public.employee_permission_overrides
 where user_id::text like 'dddddddd-0000-4000-8000-%';
delete from public.users where id::text like 'dddddddd-0000-4000-8000-%';
CLEANUP
  rm -f /tmp/race_a.out /tmp/race_b.out
}
trap cleanup EXIT

# ── Two verifiers and one candidate ─────────────────────────────────────────
# Committed, because a lock has to be contended on real rows.
q >/dev/null <<'SEED'
insert into public.users (id, full_name, email, role, team, is_active, created_at, updated_at) values
  ('dddddddd-0000-4000-8000-000000000001', 'Race Verifier One', 'race.v1@example.test', 'member', 'sales', true, now(), now()),
  ('dddddddd-0000-4000-8000-000000000002', 'Race Verifier Two', 'race.v2@example.test', 'member', 'sales', true, now(), now()),
  ('dddddddd-0000-4000-8000-000000000003', 'Race Candidate',    'race.c1@example.test', 'member', 'sales', true, now(), now());

insert into public.employee_permission_overrides (user_id, module_id, action_id, allowed, granted_by)
select u.id, m.id, a.id, true, 'dddddddd-0000-4000-8000-000000000001'
  from public.users u
  cross join public.permission_modules m
  cross join public.permission_actions a
 where m.module_key = 'customer_review_requests'
   and a.action_key = case when u.id = 'dddddddd-0000-4000-8000-000000000003' then 'use' else 'verify' end
   and u.id::text like 'dddddddd-0000-4000-8000-%';
SEED

for who in 1 2; do
  R="$(echo "select public.resolve_permission('dddddddd-0000-4000-8000-00000000000$who',
                                              'customer_review_requests', 'verify')" | q1)"
  [ "$R" = "t" ] || fail "race verifier $who does not resolve verify"
done
R="$(echo "select public.resolve_permission('dddddddd-0000-4000-8000-000000000003',
                                            'customer_review_requests', 'use')" | q1)"
[ "$R" = "t" ] || fail "the race candidate does not resolve use"
echo "══ two verifiers resolve \`verify\`, one candidate resolves \`use\`"

PAYLOAD="select coalesce(jsonb_agg(jsonb_build_object(
  'title', 'Race draft ' || i,
  'category', 'restaurant_test',
  'body', 'We ordered seating for a small dining room and the fit was right first time. Draft ' || i || ' is long enough to clear the minimum body length.'
)), '[]'::jsonb) from generate_series(1, 8) i"

# ═══ RACE A. ONE REQUEST, TWO TAPS ══════════════════════════════════════════
#
# Caller A opens a transaction, makes a real call — which takes the advisory
# lock — and then sits on it for two seconds before committing. Caller B arrives
# 0.4s in, while the lock is held and the winner's rows are still uncommitted
# and therefore invisible to it. That is precisely the state a check-then-insert
# cannot survive: without the lock, B would look for the request key, find
# nothing, and insert eight more cards.
echo
echo "══ RACE A: the same request key, from two connections, 0.4s apart"

KEY="$(echo "select gen_random_uuid()" | q1)"

call_a() {
  q1 2>&1 <<CALL
begin;
select public.create_customer_review_draft_batch(
  'Race guidance.', 'claude-opus-5', ($PAYLOAD),
  'dddddddd-0000-4000-8000-000000000001', '$KEY');
select pg_sleep($1);
commit;
CALL
}

set +e
call_a 2 >/tmp/race_a.out 2>&1 &
PID_A=$!
sleep 0.4
call_a 0 >/tmp/race_b.out 2>&1
STATUS_B=$?
wait "$PID_A"
STATUS_A=$?
set -e

echo "──   caller A exit $STATUS_A, caller B exit $STATUS_B"
[ $STATUS_A -eq 0 ] && [ $STATUS_B -eq 0 ] \
  || fail "a repeated request must SUCCEED quietly, not error (A=$STATUS_A B=$STATUS_B)"

q1 <<'CHECK' | grep -qx 'OK' || fail "race A left the database in a bad state"
select case when
     (select count(*) from public.customer_review_draft_batches) = 1
 and (select count(*) from public.customer_review_test_cards) = 8
 and (select count(*) from public.customer_review_test_cards where status = 'pending_approval') = 8
 and (select count(distinct card_ref) from public.customer_review_test_cards) = 8
then 'OK' else 'BAD: '
  || (select count(*) from public.customer_review_draft_batches) || ' batch(es), '
  || (select count(*) from public.customer_review_test_cards) || ' card(s)' end;
CHECK
echo "        ✓ ONE batch, EIGHT pending drafts, eight distinct references"

# Both callers were handed the SAME batch id, which is what makes the second
# call a no-op the browser can act on rather than an error it has to interpret.
BATCH="$(echo "select id from public.customer_review_draft_batches" | q1)"
grep -q "$BATCH" /tmp/race_a.out || fail "caller A was not told the batch id"
grep -q "$BATCH" /tmp/race_b.out || fail "caller B was not told the batch that already existed"
echo "        ✓ both callers were handed the same batch id: $BATCH"

# ...and a DIFFERENT key from the second verifier does generate, because asking
# twice on purpose is allowed.
NEW="$(echo "select public.create_customer_review_draft_batch(
        'Second guidance.', 'claude-opus-5', ($PAYLOAD),
        'dddddddd-0000-4000-8000-000000000002', gen_random_uuid())" | q1)"
[ -n "$NEW" ] || fail "a deliberate second generation was refused"
[ "$(echo 'select count(*) from public.customer_review_test_cards' | q1)" = "16" ] \
  || fail "the second batch did not produce eight more cards"
echo "        ✓ a different key from a different verifier produced a second batch of eight"

# ═══ RACE B. SEND-CONFIRM AGAINST UNBOOK ════════════════════════════════════
echo
echo "══ RACE B: confirming a send while the same review is being released"

CARD="$(echo "select id from public.customer_review_test_cards order by card_ref limit 1" | q1)"

q >/dev/null <<SETUP
select set_config('request.jwt.claims',
  json_build_object('sub','dddddddd-0000-4000-8000-000000000001','role','authenticated')::text, false);
select public.approve_customer_review_drafts(array['$CARD']::uuid[], false);
select set_config('request.jwt.claims', '', false);
update public.customer_review_test_cards
   set status = 'booked', booked_by = 'dddddddd-0000-4000-8000-000000000003', booked_at = now(),
       whatsapp_opened_at = now(), whatsapp_opened_count = 1, whatsapp_target_last_four = '4321'
 where id = '$CARD';
SETUP

STATE="$(echo "select status || '/' || coalesce(sent_confirmed_at::text,'-')
                 from public.customer_review_test_cards where id = '$CARD'" | q1)"
[ "$STATE" = "booked/-" ] || fail "race B setup left the card at $STATE"
echo "──   one approved review, booked by the candidate, WhatsApp opened, not yet confirmed"

# Both run AS THE CANDIDATE, because both are candidate actions. A holds the row
# lock for two seconds; B arrives while it is held.
as_candidate() {
  docker exec -i "$BOE_DB_CONTAINER" psql -U postgres -v ON_ERROR_STOP=1 -t -A -d "$DB" 2>&1 <<SQL
begin;
select set_config('request.jwt.claims',
  json_build_object('sub','dddddddd-0000-4000-8000-000000000003','role','authenticated')::text, true);
select ($1);
select pg_sleep($2);
commit;
SQL
}

set +e
as_candidate "(public.confirm_customer_review_test_card_sent('$CARD')).status" 2 >/tmp/race_a.out 2>&1 &
PID_A=$!
sleep 0.4
as_candidate "(public.unbook_customer_review_test_card('$CARD')).status" 0 >/tmp/race_b.out 2>&1
STATUS_B=$?
wait "$PID_A"
STATUS_A=$?
set -e

echo "──   confirm exit $STATUS_A, release exit $STATUS_B"

# EXACTLY ONE OF THEM MAY WIN, and the final row has to agree with whichever
# did. A card that is available AND confirmed sent, or booked AND released, is
# the ambiguous half-state this race exists to rule out.
FINAL="$(echo "select status || '/' || coalesce(sent_confirmed_at::text,'-')
                 || '/' || coalesce(booked_by::text,'-')
                 from public.customer_review_test_cards where id = '$CARD'" | q1)"

if [ $STATUS_A -eq 0 ] && [ $STATUS_B -ne 0 ]; then
  # The confirmation committed first; the release found sent_confirmed_at set.
  grep -q 'CUSTOMER_REVIEW_TEST_ALREADY_SENT' /tmp/race_b.out \
    || fail "the release lost, but not by name: $(cat /tmp/race_b.out)"
  case "$FINAL" in
    booked/*/dddddddd-0000-4000-8000-000000000003) ;;
    *) fail "confirm won but the card is $FINAL" ;;
  esac
  echo "        ✓ the confirmation won; the release was refused ALREADY_SENT and the card is still booked and sent"
elif [ $STATUS_B -eq 0 ] && [ $STATUS_A -ne 0 ]; then
  # The release committed first; the confirmation found no booking of its own.
  grep -q 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED\|CUSTOMER_REVIEW_TEST_BAD_TRANSITION' /tmp/race_a.out \
    || fail "the confirmation lost, but not by name: $(cat /tmp/race_a.out)"
  [ "$FINAL" = "available/-/-" ] \
    || fail "the release won but the card is $FINAL"
  echo "        ✓ the release won; the confirmation was refused and the card is cleanly available"
else
  fail "expected exactly one winner (confirm=$STATUS_A release=$STATUS_B), card is $FINAL"
fi

# WHICHEVER WON, THE ROW IS NEVER BOTH. This is the assertion the whole race is
# for, and it is checked outside the branches so a future edit to either cannot
# quietly drop it.
echo "select case when status = 'available'
                   and (sent_confirmed_at is not null or booked_by is not null)
              then 'BAD' else 'OK' end
         from public.customer_review_test_cards where id = '$CARD'" | q1 | grep -qx 'OK' \
  || fail "the card is released AND still carries a send or a holder — the ambiguous state"
echo "        ✓ the row is never both released and sent"

# ═══ RACE C. TWO OVERLAPPING APPROVALS ══════════════════════════════════════
echo
echo "══ RACE C: two verifiers approving selections that share a member"

read -r SHARED PRIV_A PRIV_B <<<"$(echo "select string_agg(id::text, ' ' order by card_ref)
  from (select id, card_ref from public.customer_review_test_cards
         where status = 'pending_approval' order by card_ref limit 3) t" | q1)"
[ -n "$PRIV_B" ] || fail "race C needs three pending drafts"

approve_as() {
  docker exec -i "$BOE_DB_CONTAINER" psql -U postgres -v ON_ERROR_STOP=1 -t -A -d "$DB" 2>&1 <<SQL
begin;
select set_config('request.jwt.claims',
  json_build_object('sub','dddddddd-0000-4000-8000-00000000000$1','role','authenticated')::text, true);
select public.approve_customer_review_drafts(array[$2]::uuid[], false);
select pg_sleep($3);
commit;
SQL
}

set +e
approve_as 1 "'$SHARED','$PRIV_A'" 2 >/tmp/race_a.out 2>&1 &
PID_A=$!
sleep 0.4
approve_as 2 "'$SHARED','$PRIV_B'" 0 >/tmp/race_b.out 2>&1
STATUS_B=$?
wait "$PID_A"
STATUS_A=$?
set -e

echo "──   verifier one exit $STATUS_A, verifier two exit $STATUS_B"
WINNERS=0
[ $STATUS_A -eq 0 ] && WINNERS=$((WINNERS + 1))
[ $STATUS_B -eq 0 ] && WINNERS=$((WINNERS + 1))
[ $WINNERS -eq 1 ] || fail "expected exactly one winner, got $WINNERS (A=$STATUS_A B=$STATUS_B)"

LOSER=/tmp/race_b.out
LOSER_PRIVATE="$PRIV_B"
if [ $STATUS_B -eq 0 ]; then LOSER=/tmp/race_a.out; LOSER_PRIVATE="$PRIV_A"; fi
grep -q 'CUSTOMER_REVIEW_TEST_NOT_PENDING' "$LOSER" \
  || fail "the loser must refuse by name; got: $(cat "$LOSER")"
echo "        ✓ one selection was approved; the other was refused NOT_PENDING"

# AND THE LOSER APPROVED NOTHING — not even the member the winner never touched.
# A partial approval is the failure this atomicity exists to prevent.
LOSER_STATE="$(echo "select status from public.customer_review_test_cards
                      where id = '$LOSER_PRIVATE'" | q1)"
[ "$LOSER_STATE" = "pending_approval" ] \
  || fail "the loser's own draft was approved anyway (it is $LOSER_STATE) — a partial approval happened"
echo "        ✓ the loser's private draft is still pending: no partial approval"

APPROVED="$(echo "select count(*) from public.customer_review_test_cards
                   where status = 'available'" | q1)"
[ "$APPROVED" = "2" ] || fail "expected exactly 2 approved reviews after race C, found $APPROVED"
echo "        ✓ exactly two reviews are approved: the winner's pair"

echo
# ═══ RACE D. TWO SERVERS CLAIMING ONE REQUEST KEY ═══════════════════════════
#
# THE HALF OF THE PROVIDER-CALL GUARANTEE THAT NEEDS TWO CONNECTIONS.
#
# src/lib/customerReviews/generationRun.test.ts counts provider invocations and
# proves the orchestrator calls the model only when its claim came back
# 'claimed'. That proof rests entirely on an assumption this race exists to
# check: that TWO SESSIONS ASKING AT THE SAME INSTANT CANNOT BOTH BE TOLD
# 'claimed'. A Node test cannot check it — one process, one connection, no
# committed rows to contend on.
#
# If claim_customer_review_generation were a read followed by a write, both
# callers below would be told 'claimed', both would call Anthropic, and BOE
# would be billed twice for one batch. It is a single
# `insert … on conflict (request_key) do update … where expired`, so the loser
# blocks on the unique index, re-evaluates against the winner's committed row,
# finds a live claim, and is told 'in_progress'.
echo
echo "══ RACE D: two connections claiming ONE request key, 0.4s apart"

RKEY="$(echo "select gen_random_uuid()" | q1)"

claim_as() {
  docker exec -i "$BOE_DB_CONTAINER" psql -U postgres -v ON_ERROR_STOP=1 -t -A -d "$DB" 2>&1 <<SQL
begin;
select outcome from public.claim_customer_review_generation(
  '$RKEY', 'generate', null, 'dddddddd-0000-4000-8000-00000000000$1', 300);
select pg_sleep($2);
commit;
SQL
}

set +e
claim_as 1 2 >/tmp/race_a.out 2>&1 &
PID_A=$!
sleep 0.4
claim_as 2 0 >/tmp/race_b.out 2>&1
STATUS_B=$?
wait "$PID_A"
STATUS_A=$?
set -e

[ $STATUS_A -eq 0 ] && [ $STATUS_B -eq 0 ] \
  || fail "both claims must SUCCEED as calls and differ in their answer (A=$STATUS_A B=$STATUS_B)"

CLAIMED=0
INPROGRESS=0
for f in /tmp/race_a.out /tmp/race_b.out; do
  grep -qx 'claimed'     "$f" && CLAIMED=$((CLAIMED + 1))
  grep -qx 'in_progress' "$f" && INPROGRESS=$((INPROGRESS + 1))
done
echo "──   answers: $(tr '\n' ' ' </tmp/race_a.out) | $(tr '\n' ' ' </tmp/race_b.out)"
[ "$CLAIMED" = "1" ] \
  || fail "EXACTLY ONE caller may be told 'claimed'; $CLAIMED were. Both would have called the provider."
[ "$INPROGRESS" = "1" ] \
  || fail "the loser must be told 'in_progress'; got $INPROGRESS"
echo "        ✓ exactly one 'claimed', one 'in_progress' — one provider call would follow"

ROWS="$(echo "select count(*) from public.customer_review_generation_claims
                where request_key = '$RKEY'" | q1)"
[ "$ROWS" = "1" ] || fail "one key produced $ROWS claim row(s)"
ATTEMPTS="$(echo "select attempts from public.customer_review_generation_claims
                   where request_key = '$RKEY'" | q1)"
[ "$ATTEMPTS" = "1" ] || fail "a live claim was taken over: attempts = $ATTEMPTS"
echo "        ✓ one claim row, attempts = 1 — the loser did not steal a live claim"

# ...and a completed claim answers a later repeat instead of re-running.
echo "select public.finish_customer_review_generation('$RKEY', 'completed',
        (select id from public.customer_review_draft_batches limit 1), 8)" | q >/dev/null
AGAIN="$(echo "select outcome from public.claim_customer_review_generation(
          '$RKEY', 'generate', null, 'dddddddd-0000-4000-8000-000000000001', 300)" | q1)"
[ "$AGAIN" = "completed" ] || fail "a completed key answered '$AGAIN', expected 'completed'"
echo "        ✓ once completed, the same key is answered rather than re-run"

# A FAILED run RELEASES the key, so a legitimate retry is a fresh attempt.
RKEY2="$(echo "select gen_random_uuid()" | q1)"
echo "select public.claim_customer_review_generation('$RKEY2', 'generate', null,
        'dddddddd-0000-4000-8000-000000000001', 300)" | q >/dev/null
echo "select public.finish_customer_review_generation('$RKEY2', 'failed', null, null)" | q >/dev/null
LEFT="$(echo "select count(*) from public.customer_review_generation_claims
               where request_key = '$RKEY2'" | q1)"
[ "$LEFT" = "0" ] || fail "a failed run left its claim behind; a retry would be refused forever"
RETRY="$(echo "select outcome from public.claim_customer_review_generation('$RKEY2', 'generate', null,
          'dddddddd-0000-4000-8000-000000000001', 300)" | q1)"
[ "$RETRY" = "claimed" ] || fail "a retry after a failure answered '$RETRY', expected 'claimed'"
echo "        ✓ a failed run releases the key, and the retry is claimed afresh"

# An EXPIRED claim may be taken over, so a crashed server cannot block forever.
RKEY3="$(echo "select gen_random_uuid()" | q1)"
echo "select public.claim_customer_review_generation('$RKEY3', 'generate', null,
        'dddddddd-0000-4000-8000-000000000001', 30)" | q >/dev/null
echo "update public.customer_review_generation_claims
        set expires_at = now() - interval '1 second' where request_key = '$RKEY3'" | q >/dev/null
TAKEN="$(echo "select outcome from public.claim_customer_review_generation('$RKEY3', 'generate', null,
          'dddddddd-0000-4000-8000-000000000002', 300)" | q1)"
[ "$TAKEN" = "claimed" ] || fail "an EXPIRED claim answered '$TAKEN'; a crashed server would block forever"
TA="$(echo "select attempts from public.customer_review_generation_claims
             where request_key = '$RKEY3'" | q1)"
[ "$TA" = "2" ] || fail "the takeover was not counted as a second attempt (attempts = $TA)"
echo "        ✓ an abandoned claim expires and is taken over, counted as attempt 2"

# A CANDIDATE CANNOT CLAIM. The claim authorises spending a credential, so it
# asks the same resolved permission the write does.
DENIED="$(echo "select public.claim_customer_review_generation(gen_random_uuid(), 'generate', null,
           'dddddddd-0000-4000-8000-000000000003', 300)" | q1 2>&1 || true)"
echo "$DENIED" | grep -q 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED' \
  || fail "a candidate holding only \`use\` was able to claim a provider call: $DENIED"
echo "        ✓ a candidate holding only \`use\` cannot claim a provider call"


# ═══ RACE E. A REPLACEMENT AGAINST A BOOKING ════════════════════════════════
#
# THE ONE THE ADD/REPLACE CHOICE MADE POSSIBLE, and the only race in this file
# where the two contenders want opposite things with the same row.
#
# A verifier approves a new batch and chooses REPLACE, which soft-deletes every
# review currently available. At the same moment a candidate books one of those
# very reviews. Both cannot be true: a review cannot be handed to somebody and
# withdrawn from the pool in the same instant.
#
# EITHER OUTCOME IS CORRECT; A MIXTURE IS NOT.
#
#   the booking commits first   the card is 'booked', so it is no longer in the
#                               set the replacement selects — it SURVIVES, which
#                               is exactly the promise that booked work is never
#                               displaced.
#   the replacement commits     the booking blocks on the row lock, re-evaluates
#   first                       "status = available and deleted_at is null",
#                               matches nothing, and is refused BY NAME.
#
# What must never happen is a review that is booked and deleted at once, or a
# candidate told they hold a review that has been withdrawn.
echo
echo "══ RACE E: replacing the available list while a candidate books one of it"

# Approve four drafts with ADD, so there is a list to fight over.
read -r ADD1 ADD2 ADD3 ADD4 <<<"$(echo "select string_agg(id::text, ' ' order by card_ref)
  from (select id, card_ref from public.customer_review_test_cards
         where status = 'pending_approval' and deleted_at is null
         order by card_ref limit 4) t" | q1)"
[ -n "$ADD4" ] || fail "race E needs four pending drafts"

echo "select set_config('request.jwt.claims',
  json_build_object('sub','dddddddd-0000-4000-8000-000000000001','role','authenticated')::text, false);
  select public.approve_customer_review_drafts(
    array['$ADD1','$ADD2','$ADD3','$ADD4']::uuid[], false)" | q >/dev/null

TARGET="$ADD1"
AVAIL="$(echo "select count(*) from public.customer_review_test_cards
                where status = 'available' and deleted_at is null" | q1)"
# Earlier races leave approved reviews behind, so this counts what is actually
# there rather than assuming the four it just added are the only ones. What
# matters is that a list EXISTS to be replaced and that the contested review is
# in it — not how long the list is.
[ "$AVAIL" -ge 4 ] || fail "race E needs an available list to replace, found $AVAIL"
echo "──   $AVAIL review(s) are available, and the candidate will go for one of them"

# A fresh batch for the replacement to publish.
KEY_E="$(echo "select gen_random_uuid()" | q1)"
echo "select public.create_customer_review_draft_batch('Race E guidance.', 'claude-opus-5',
        ($PAYLOAD), 'dddddddd-0000-4000-8000-000000000001', '$KEY_E')" | q >/dev/null
BATCH_E="$(echo "select id from public.customer_review_draft_batches
                  where guidance = 'Race E guidance.'" | q1)"
[ -n "$BATCH_E" ] || fail "race E could not create the replacing batch"

replace_as() {
  docker exec -i "$BOE_DB_CONTAINER" psql -U postgres -v ON_ERROR_STOP=1 -t -A -d "$DB" 2>&1 <<SQL
begin;
select set_config('request.jwt.claims',
  json_build_object('sub','dddddddd-0000-4000-8000-000000000001','role','authenticated')::text, true);
select public.approve_customer_review_draft_batch('$BATCH_E', true);
select pg_sleep($1);
commit;
SQL
}

book_as() {
  docker exec -i "$BOE_DB_CONTAINER" psql -U postgres -v ON_ERROR_STOP=1 -t -A -d "$DB" 2>&1 <<SQL
begin;
select set_config('request.jwt.claims',
  json_build_object('sub','dddddddd-0000-4000-8000-000000000003','role','authenticated')::text, true);
select public.book_customer_review_test_card('$TARGET');
commit;
SQL
}

set +e
replace_as 2 >/tmp/race_a.out 2>&1 &
PID_R=$!
sleep 0.4
book_as >/tmp/race_b.out 2>&1
STATUS_BOOK=$?
wait "$PID_R"
STATUS_REPL=$?
set -e

echo "──   replacement exit $STATUS_REPL, booking exit $STATUS_BOOK"
[ $STATUS_REPL -eq 0 ] || fail "the replacement itself failed: $(cat /tmp/race_a.out)"

read -r FINAL_STATUS FINAL_DELETED FINAL_HOLDER <<<"$(echo "select status || ' ' ||
    case when deleted_at is null then 'live' else 'deleted' end || ' ' ||
    coalesce(booked_by::text, 'nobody')
  from public.customer_review_test_cards where id = '$TARGET'" | q1)"
echo "──   the contested review ended: $FINAL_STATUS / $FINAL_DELETED / held by $FINAL_HOLDER"

if [ $STATUS_BOOK -eq 0 ]; then
  # The booking won. It must have survived the replacement intact.
  [ "$FINAL_STATUS" = "booked" ] \
    || fail "the booking reported success but the review is $FINAL_STATUS"
  [ "$FINAL_DELETED" = "live" ] \
    || fail "A REVIEW WAS BOOKED AND DELETED AT ONCE — the candidate holds a withdrawn review"
  [ "$FINAL_HOLDER" = "dddddddd-0000-4000-8000-000000000003" ] \
    || fail "the booking succeeded but the holder is $FINAL_HOLDER"
  echo "        ✓ the booking committed first, and the replacement left it alone"
else
  # The replacement won. The booking must have been refused BY NAME, and the
  # review must be a clean tombstone with no holder.
  grep -qE 'CUSTOMER_REVIEW_TEST_DELETED|CUSTOMER_REVIEW_TEST_ALREADY_BOOKED' /tmp/race_b.out \
    || fail "the booking failed for the wrong reason: $(cat /tmp/race_b.out)"
  [ "$FINAL_DELETED" = "deleted" ] \
    || fail "the booking was refused but the review is still live"
  [ "$FINAL_HOLDER" = "nobody" ] \
    || fail "A REFUSED BOOKING STILL CLAIMED THE REVIEW (held by $FINAL_HOLDER)"
  echo "        ✓ the replacement committed first, and the booking was refused by name"
fi

# WHICHEVER WAY IT WENT, THE INVARIANT HOLDS FOR EVERY ROW.
BOTH="$(echo "select count(*) from public.customer_review_test_cards
               where deleted_at is not null and booked_by is not null
                 and deleted_source = 'replacement'" | q1)"
[ "$BOTH" = "0" ] || fail "$BOTH review(s) were displaced by a replacement while somebody held them"

NEW_AVAIL="$(echo "select count(*) from public.customer_review_test_cards
                    where status = 'available' and deleted_at is null and batch_id = '$BATCH_E'" | q1)"
[ "$NEW_AVAIL" = "8" ] || fail "the replacing batch left $NEW_AVAIL available, expected 8"
echo "        ✓ no displaced review has a holder, and the new batch of 8 is available"

echo
echo "══ all five races complete; every row they wrote has been removed"
