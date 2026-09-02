-- ═══════════════════════════════════════════════════════════════════════════
-- BOE Credits — Phase 1B: a verified review earns its reward, in the same
-- transaction that verifies it.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT THIS CHANGES
-- -----------------
-- ONE function, re-created: public.transition_customer_review_test_card().
-- Its verify branch now posts exactly one review_reward row to the BOE Credits
-- ledger for the employee who holds the review, and the function returns what
-- it awarded alongside the card. Nothing else in the Review Workflow — no
-- table, no policy, no other function, no grant — is touched.
--
-- WHY HERE, AND NOT IN THE APPLICATION
-- ------------------------------------
-- Verification is decided inside this function, under a row lock. If the
-- reward were posted by the browser or a route AFTER the call returned, there
-- would be two writes with a gap between them: a verified review whose reward
-- never landed, or — worse — a reward for a review whose verification failed.
-- Inside the function both happen or neither does, because a raise anywhere
-- rolls back the UPDATE, the event and the ledger row together.
--
-- WHO IS REWARDED. `booked_by` — the employee who booked, sent, evidenced and
-- submitted the review. It is written only by book_customer_review_test_card()
-- from auth.uid(), is required past `available` by a CHECK, and is never
-- cleared by a return. NOT the verifier (v_uid), NOT submitted_by (equal to
-- booked_by by construction, but cleared by an unbook), NOT the screenshot
-- uploader.
--
-- HOW MUCH. The newest boe_credit_settings.review_reward_credits, read at the
-- instant of verification. No number is written in this file; changing the
-- setting changes the next reward and nothing already posted.
--
-- THE SOURCE. source_type 'customer_review', source_id = the card's immutable
-- id. That pair, with the employee and the kind, is what
-- boe_credit_transactions_one_per_source_idx makes unique.
--
-- WHY A REVIEW CANNOT BE REWARDED TWICE
-- -------------------------------------
-- Three layers, each sufficient on its own:
--   1. `verified` is TERMINAL. The row is locked before its status is read,
--      so a second click, a retried request or a concurrent request wakes on
--      the committed `verified` row, fails the legality guard with
--      CUSTOMER_REVIEW_TEST_BAD_TRANSITION (23514), and never reaches the
--      reward. That is the module's existing rule, unchanged.
--   2. post_boe_credit_transaction() pre-checks (employee, kind, source) under
--      a per-employee advisory lock and refuses a duplicate with
--      BOE_CREDITS_DUPLICATE_SOURCE (23505).
--   3. The partial unique index refuses it at the table, whatever path led
--      there.
--
-- WHAT IS DELIBERATELY NOT HERE
-- -----------------------------
--   * No backfill. Reviews already verified before this file applies earn
--     nothing from it; the post-condition below proves this file wrote zero
--     ledger rows. Only verifications AFTER it is applied are rewarded.
--   * No reversal wiring. The workflow has no unverify, reopen or
--     reject-after-verify; deletion of a verified review is a tombstone that
--     removes the record from the module (singly, in bulk, or by replacement)
--     and says nothing about whether the review was valid — debiting an
--     employee for housekeeping would be wrong. reverse_boe_credit_transaction()
--     remains available to an administrator through the service layer.
--   * No notification, no new RPC, no new grant. The reward arises only
--     through the already-authorized verify path; `authenticated` still cannot
--     execute post_boe_credit_transaction() — the definer body calls it as the
--     owner, which is the whole point of that grant shape.
--
-- THE RETURN TYPE CHANGES, from the card row to jsonb:
--     { "card": <the row, as before>, "reward": null | {
--         "transaction_id", "employee_id", "employee_name", "credits" } }
-- The only caller (src/app/customer-reviews/[id]/TestCardDetailScreen.tsx)
-- discarded the row; it now reads `reward` to confirm the award. A return type
-- cannot be altered in place, so the function is dropped and re-created with
-- the SAME identity arguments, and its grants are restated verbatim from
-- 20261017000000 (revoke public, anon; grant authenticated) — the allow-list of
-- browser-callable signatures is unchanged.
--
-- EVERYTHING ELSE IN THE BODY IS CARRIED FORWARD FROM 20261030000000 UNCHANGED:
-- the signed-out refusal, the row lock before the status read, the deleted
-- tombstone refusal, the active-account check, the engine-resolved
-- permissions with no role and no administrator branch, the legality table,
-- the verifier-only gate, the holder-only submit gate, the submittability
-- assertion, the mandatory return reason, the UPDATE, and the event row.
--
-- ASSUMPTIONS TO CHECK BEFORE THIS IS APPLIED
--   1. 20261030000000 (the current definition) and 20261101000000 (BOE Credits
--      foundation) are applied.
--   2. public.post_boe_credit_transaction(uuid, text, integer, text, uuid, text,
--      uuid, uuid) exists and is executable by the owner.
--
-- PRODUCTION SAFETY
-- -----------------
-- Additive in effect: one function replaced, no data written, no row read for
-- any purpose but the post-conditions. Re-runnable.
--
-- ROLLBACK
-- --------
-- Re-apply the definition in 20261030000000 (§ transition_customer_review_
-- test_card), dropping this one first for the return type. Rewards already
-- posted stay in the ledger, as any ledger row does.

-- ═══ 1. The function ══════════════════════════════════════════════════════

drop function if exists public.transition_customer_review_test_card(uuid, text, text);

create or replace function public.transition_customer_review_test_card(
  p_card_id     uuid,
  p_next_status text,
  p_detail      text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c             public.customer_review_test_cards%rowtype;
  v_uid         uuid := auth.uid();
  v_use         boolean;
  v_verify      boolean;
  v_holder      boolean;
  v_legal       boolean;
  v_detail      text := nullif(btrim(coalesce(p_detail, '')), '');
  v_reward      integer;
  v_reward_id   uuid;
  v_holder_name text;
begin
  if v_uid is null then
    raise exception 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED: Sign in to continue' using errcode = '42501';
  end if;

  -- Locked for the duration, so two clicks cannot both read 'booked' and both
  -- write 'submitted'. The legality guard below then refuses the second.
  select * into c from public.customer_review_test_cards where id = p_card_id for update;
  if not found then
    raise exception 'CUSTOMER_REVIEW_TEST_NOT_FOUND: That test card no longer exists' using errcode = 'P0002';
  end if;

  -- REFUSED BEFORE ANY OTHER JUDGEMENT. Submitting, verifying and returning are
  -- all workflow actions, and a deleted review has left the workflow. A
  -- verifier can still READ the tombstone; they cannot move it.
  if c.deleted_at is not null then
    raise exception 'CUSTOMER_REVIEW_TEST_DELETED: A verifier deleted this review, so it can no longer be moved'
      using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.users u where u.id = v_uid and u.is_active
  ) then
    raise exception 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED: Your account is not active' using errcode = '42501';
  end if;

  -- RESOLVED FROM THE PERMISSION ENGINE, NOT FROM THE ROLE.
  v_use    := public.resolve_permission(v_uid, 'customer_review_requests', 'use');
  v_verify := public.resolve_permission(v_uid, 'customer_review_requests', 'verify');
  v_holder := (c.booked_by = v_uid);

  if not (v_use or v_verify) then
    raise exception 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED: You do not have access to this module'
      using errcode = '42501';
  end if;

  -- ── Is the move itself legal? ──
  v_legal := case c.status
    when 'booked'    then p_next_status in ('submitted')
    when 'submitted' then p_next_status in ('verified', 'booked')
    else false
  end;

  if not v_legal then
    raise exception 'CUSTOMER_REVIEW_TEST_BAD_TRANSITION: A % card cannot become %', c.status, p_next_status
      using errcode = '23514';
  end if;

  -- ── Is this person allowed to make it? ──
  if p_next_status in ('verified', 'booked') then
    if not v_verify then
      raise exception 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED: Verifying or returning a test needs the Verify permission'
        using errcode = '42501';
    end if;
  else
    -- SUBMITTING IS A TESTER ACTION: the holder, and nobody else.
    if not (v_holder and v_use) then
      raise exception 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED: Only the tester holding this card can submit it'
        using errcode = '42501';
    end if;
  end if;

  if p_next_status = 'submitted' then
    perform public.assert_customer_review_test_card_submittable(p_card_id);
  end if;

  -- A return has to say why.
  if p_next_status = 'booked' and v_detail is null then
    raise exception 'CUSTOMER_REVIEW_TEST_NOT_READY: Give a short reason when returning a test'
      using errcode = '23514';
  end if;

  -- ── Apply ──
  update public.customer_review_test_cards c2
     set status = p_next_status,

         submitted_at = case when p_next_status = 'submitted' then now()  else c2.submitted_at end,
         submitted_by = case when p_next_status = 'submitted' then v_uid  else c2.submitted_by end,

         verified_at = case when p_next_status = 'verified' then now()  else c2.verified_at end,
         verified_by = case when p_next_status = 'verified' then v_uid  else c2.verified_by end,
         verification_note = case
           when p_next_status = 'verified' then v_detail
           else c2.verification_note
         end,

         returned_at   = case when p_next_status = 'booked' then now()    else c2.returned_at end,
         returned_by   = case when p_next_status = 'booked' then v_uid    else c2.returned_by end,
         return_reason = case when p_next_status = 'booked' then v_detail else c2.return_reason end
   -- NOTHING IS CLEARED ON A RETURN, and that is the choice rather than an
   -- omission. The append-only trail keeps every submission and every return.
   where c2.id = p_card_id;

  insert into public.customer_review_test_card_events
    (card_id, event_type, previous_status, new_status, detail, actor_id)
  values
    (p_card_id,
     case p_next_status when 'submitted' then 'submitted'
                        when 'verified'  then 'verified'
                        else 'returned' end,
     c.status, p_next_status, v_detail, v_uid);

  -- ── BOE Credits: the reward, in the same transaction ──
  --
  -- Reached only on submitted -> verified, which the legality guard above
  -- admits exactly once per card. The recipient is the HOLDER, read from the
  -- locked row; the actor recorded on the ledger row is the verifier, whose
  -- decision this is. The amount is the active setting, never a literal.
  if p_next_status = 'verified' then
    if c.booked_by is null then
      raise exception 'CUSTOMER_REVIEW_TEST_NOT_READY: This review has no holder to reward'
        using errcode = '23514';
    end if;

    select s.review_reward_credits into v_reward
      from public.boe_credit_settings s
     order by s.created_at desc
     limit 1;
    if v_reward is null then
      raise exception 'BOE_CREDITS_SETTINGS: no active credit settings row — the review was not verified'
        using errcode = 'P0002';
    end if;

    v_reward_id := public.post_boe_credit_transaction(
      c.booked_by,
      'review_reward',
      v_reward,
      'customer_review',
      p_card_id,
      'Review verified · ' || c.card_ref,
      v_uid
    );

    select u.full_name into v_holder_name from public.users u where u.id = c.booked_by;
  end if;

  select * into c from public.customer_review_test_cards where id = p_card_id;

  return jsonb_build_object(
    'card', to_jsonb(c),
    'reward', case
      when v_reward_id is null then null
      else jsonb_build_object(
        'transaction_id', v_reward_id,
        'employee_id',    c.booked_by,
        'employee_name',  v_holder_name,
        'credits',        v_reward
      )
    end
  );
end;
$$;

-- The grants, restated verbatim from 20261017000000: a browser-callable
-- function, on the same identity signature the allow-list names.
revoke execute on function public.transition_customer_review_test_card(uuid, text, text) from public, anon;
grant  execute on function public.transition_customer_review_test_card(uuid, text, text) to authenticated;

comment on function public.transition_customer_review_test_card(uuid, text, text) is
  'Moves one review between booked, submitted and verified (or back to booked with a reason). Actor is auth.uid(); use/verify are resolved from the permission engine, never a role. On submitted -> verified it also posts exactly one review_reward row to the BOE Credits ledger for the holder (booked_by), for the active review_reward_credits, in the same transaction, and returns {card, reward}.';

-- ═══ 2. Assertions ═════════════════════════════════════════════════════════
--
-- These fail the migration rather than let a partial apply look successful.

do $$
declare
  v_n    integer;
  v_ret  text;
  v_src  text;
begin
  -- 2a. the function exists once, on the same identity signature, returning jsonb
  select count(*), max(pg_get_function_result(p.oid)), max(p.prosrc)
    into v_n, v_ret, v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'transition_customer_review_test_card'
     and pg_get_function_identity_arguments(p.oid) = 'p_card_id uuid, p_next_status text, p_detail text';
  if v_n <> 1 then
    raise exception 'BOE_CREDITS_1B: expected exactly one transition_customer_review_test_card(uuid, text, text), found %', v_n;
  end if;
  if v_ret <> 'jsonb' then
    raise exception 'BOE_CREDITS_1B: the function returns %, expected jsonb', v_ret;
  end if;

  -- 2b. it consults no role (the Review Workflow's own rule, 20261030000000 §)
  if v_src ~ '(u\.role|users\.role|''admin'')' then
    raise exception 'BOE_CREDITS_1B: the transition consults a role';
  end if;

  -- 2c. it rewards the holder from the setting, through the one write path
  if position('c.booked_by' in v_src) = 0
     or position('review_reward_credits' in v_src) = 0
     or position('public.post_boe_credit_transaction(' in v_src) = 0
     or position('''customer_review''' in v_src) = 0 then
    raise exception 'BOE_CREDITS_1B: the reward branch is not shaped as documented';
  end if;
  if v_src ~ 'insert into public\.boe_credit_transactions' then
    raise exception 'BOE_CREDITS_1B: the transition inserts into the ledger directly';
  end if;

  -- 2d. grants: browser-callable on the same signature; the posting function
  --     is STILL not
  if not has_function_privilege('authenticated', 'public.transition_customer_review_test_card(uuid, text, text)', 'EXECUTE') then
    raise exception 'BOE_CREDITS_1B: authenticated lost EXECUTE on the transition';
  end if;
  if has_function_privilege('anon', 'public.transition_customer_review_test_card(uuid, text, text)', 'EXECUTE') then
    raise exception 'BOE_CREDITS_1B: anon can execute the transition';
  end if;
  if has_function_privilege('authenticated', 'public.post_boe_credit_transaction(uuid, text, integer, text, uuid, text, uuid, uuid)', 'EXECUTE')
     or has_function_privilege('anon', 'public.post_boe_credit_transaction(uuid, text, integer, text, uuid, text, uuid, uuid)', 'EXECUTE') then
    raise exception 'BOE_CREDITS_1B: a client role can execute post_boe_credit_transaction';
  end if;

  -- 2e. NO BACKFILL. This file wrote nothing to the ledger: no review_reward
  --     row carries this transaction's timestamp.
  select count(*) into v_n
    from public.boe_credit_transactions
   where transaction_type = 'review_reward'
     and created_at >= transaction_timestamp();
  if v_n <> 0 then
    raise exception 'BOE_CREDITS_1B: this migration created % review_reward row(s); it must create none', v_n;
  end if;
end $$;
