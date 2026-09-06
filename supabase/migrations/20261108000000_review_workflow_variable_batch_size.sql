-- Review Workflow — a batch is six to twenty reviews, chosen per generation,
-- and the controls that shaped it are stored beside it.
--
-- ONE FILE, because it is one change to what a batch IS: how many reviews it
-- holds, what mix of types that implies, what the generation was asked for, and
-- who it was meant for. Splitting them would leave a database in which the
-- CHECK admits a batch of seventeen and the generator function still refuses
-- anything but twelve, which is a state nothing wants.
--
-- ── WHAT DOES NOT CHANGE, RE-STATED BECAUSE IT WOULD BE EASY TO LOSE ───────
--
--   * A draft is still `pending_approval` until a person approves it. Nothing
--     here moves a status, and nothing here makes anything visible to anybody.
--   * CANDIDATE VISIBILITY IS UNTOUCHED. A candidate sees an available review
--     because customer_review_test_cards.assigned_to names them — the SELECT
--     policy from 20261107000000 is not re-created here and not weakened. The
--     new `intended_for` column on the BATCH is read by no policy at all.
--   * Generation is still gated on the resolved `verify` permission, resolved
--     from the actor id inside the definer function. No role is read anywhere.
--   * The generation claim, the request key and batch-level idempotence are
--     untouched. This file changes what a valid batch SIZE is, not how a batch
--     is claimed.
--   * Approval, assignment, booking, unbooking, submission, verification and
--     the credit reward are unchanged in every respect except that three of
--     them stop assuming the number twelve.
--
-- ── HISTORY IS NOT REWRITTEN ───────────────────────────────────────────────
--
-- Every batch in the database today holds 20, 8 or 12 — the three fixed sizes
-- this module has had — and every one of those is inside the new range, so
-- nothing that exists becomes illegal. The CHECKs are still added NOT VALID:
-- the point is not that a scan would fail today, it is that a batch row is a
-- RECORD of what a model produced and validating a historical record against a
-- rule invented afterwards is the wrong shape of statement, whatever the answer
-- comes out as.

-- ═══ 1. SIX TO TWENTY ══════════════════════════════════════════════════════

alter table public.customer_review_draft_batches
  drop constraint if exists customer_review_draft_batches_card_count_check;

alter table public.customer_review_draft_batches
  add constraint customer_review_draft_batches_card_count_check
  check (card_count between 6 and 20) not valid;

alter table public.customer_review_draft_batches
  drop constraint if exists customer_review_draft_batches_expected_count_check;

-- expected_count AND card_count STILL HAVE TO AGREE. Holding both is what lets
-- a row say "twenty were asked for and twenty arrived" rather than only the
-- second half; the equality is what stops them drifting apart.
alter table public.customer_review_draft_batches
  add constraint customer_review_draft_batches_expected_count_check
  check (expected_count between 6 and 20 and card_count = expected_count) not valid;

-- WIDENINGS, and these are ordinary. Every value already stored satisfies the
-- new bound, so there is nothing to skip and no reason to skip it.
alter table public.customer_review_draft_batch_revisions
  drop constraint if exists customer_review_draft_batch_revisions_revised_count_check;

alter table public.customer_review_draft_batch_revisions
  add constraint customer_review_draft_batch_revisions_revised_count_check
  check (revised_count between 1 and 20);

alter table public.customer_review_generation_claims
  drop constraint if exists customer_review_generation_claims_result_count_check;

alter table public.customer_review_generation_claims
  add constraint customer_review_generation_claims_result_count_check
  check (result_count is null or result_count between 1 and 20);

-- ═══ 2. WHAT THE BATCH WAS ASKED TO BE ═════════════════════════════════════
--
-- TWO NULLABLE COLUMNS, AND NULLABLE IS THE COMPATIBILITY STORY. Every batch
-- generated before today has neither, reads back as NULL, and renders exactly
-- as it did — there is no backfill, no default row and no screen that requires
-- a value.
--
-- generation_settings IS AUDIT, NOT AUTHORITY. It records the numbers an
-- administrator chose so a batch can be explained, compared and repeated later.
-- Nothing branches on it: not a policy, not a permission check, not the
-- composition, not the reward. The counts it describes were computed in the
-- route BEFORE the model was called and are already spent by the time this row
-- exists.
--
-- intended_for IS A TARGET, NOT AN ASSIGNMENT, and the distinction is the whole
-- security question here. It says who the administrator had in mind while
-- generating. It grants nothing: candidate visibility is decided by
-- customer_review_test_cards.assigned_to, which only assign_customer_review_batch()
-- ever writes, and no policy in this module reads a batch column at all. Its
-- one job is to prefill the picker at the assignment step so the right name is
-- already selected.
alter table public.customer_review_draft_batches
  add column if not exists generation_settings jsonb,
  add column if not exists intended_for uuid references public.users(id);

comment on column public.customer_review_draft_batches.generation_settings is
  'The generation controls as submitted: batch size, word range, and the language, location, project, staff, issue and perspective percentages. AUDIT ONLY — no policy, permission check, composition rule or reward reads it. NULL on every batch generated before 20261108000000.';

comment on column public.customer_review_draft_batches.intended_for is
  'The employee the batch was generated for. A TARGET AND A PREFILL, NOT AN ASSIGNMENT and NOT A GRANT: candidate visibility is decided by customer_review_test_cards.assigned_to, written only by assign_customer_review_batch(). No RLS policy reads this column.';

-- ═══ 3. THE GENERATOR, TAKING A SIZE ═══════════════════════════════════════
--
-- THE OLD FIVE-ARGUMENT FORM IS KEPT, AS A WRAPPER. An earlier draft of this
-- file dropped it, on the reasoning that two overloads risk PostgREST's
-- PGRST203 "could not choose the best candidate". That reasoning was right
-- about the hazard and wrong about the cost of avoiding it this way.
--
-- THE DEPLOYMENT WINDOW IS THE PROBLEM. A migration is applied before the
-- bundle that needs it is live — that is the ordinary order, and on Vercel the
-- two are minutes apart at best. Between those two moments the CURRENTLY
-- DEPLOYED route is still calling the five-argument form. Dropping it makes
-- every generation in that window fail with PGRST202, and a rollback of the
-- application code would not fix it because the function would still be gone.
--
-- THE OVERLOAD IS SAFE BECAUSE THE ARITIES CANNOT BOTH MATCH. PostgREST picks
-- a candidate by the set of argument NAMES in the request body. The new form
-- takes eight and gives none of them a DEFAULT, so a five-name call cannot
-- satisfy it; the wrapper takes exactly those five, so an eight-name call
-- cannot satisfy the wrapper either. There is no request that both can serve,
-- which is the condition PGRST203 reports. (This is also why the defaults that
-- an earlier draft put on p_settings and p_intended_for are gone: a default is
-- exactly what would let one call match both.)
--
-- THE WRAPPER IS NOT A SECOND IMPLEMENTATION. It delegates, so the size range,
-- the composition rule, the permission check, the telephone check and the
-- idempotence all have one home. It passes twelve because twelve is what the
-- code that calls the five-argument form always sends — that form has no way to
-- say anything else.
--
-- IT IS MEANT TO BE REMOVED. Once the new bundle is live everywhere, a later
-- migration should `drop function public.create_customer_review_draft_batch(text, text, jsonb, uuid, uuid);`
-- and this comment is the note saying so. It is deliberately NOT dropped here.

-- Identical to 20261107000000's definition except that the size is a parameter,
-- the composition is derived from it, and two audit values are stored. Repeated
-- in full rather than patched because plpgsql has no partial redefinition, and
-- a reader comparing the two files should see what changed rather than have to
-- reconstruct a body from a diff.
--
-- WHY THE SIZE IS CHECKED HERE AND NOT ONLY IN THE ROUTE. The route validates
-- the request and assigns the types, and it is right that it does. But the
-- route is one deployment away from a bug, and a batch with the wrong mix is a
-- batch an employee is paid the wrong amount for. The database refusing it
-- means the worst case is a failed generation rather than a silently wrong
-- batch.
--
-- p_card_count IS WHAT WAS ASKED FOR; jsonb_array_length(p_drafts) is what
-- arrived. They are compared rather than one being inferred from the other,
-- because inferring the request from the reply is exactly how a provider that
-- returned the wrong number would end up defining the batch.
--
-- IT IS NOT THE MODEL'S CHOICE. The model is told what to write; it is not
-- asked how many of each type to produce, and a `type` it invented would be one
-- of the two allowed values or the insert fails. See buildUserPrompt() and
-- assignReviewTypes() in src/lib/customerReviews.
create or replace function public.create_customer_review_draft_batch(
  p_guidance      text,
  p_model         text,
  p_drafts        jsonb,
  p_actor_id      uuid,
  p_request_key   uuid,
  p_card_count    integer,
  -- NO DEFAULTS. See the note above the wrapper: a default on either of these
  -- would let a five-argument call match this function as well as the wrapper,
  -- and an ambiguous call is PGRST203 at run time.
  p_settings      jsonb,
  p_intended_for  uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_batch_id uuid;
  v_n        integer;
  v_next     integer;
  v_item     jsonb;
  v_title    text;
  v_body     text;
  v_type     text;
  v_text_n   integer;
  v_image_n  integer;
  v_want_img integer;
  v_want_txt integer;
begin
  if p_request_key is null then
    raise exception 'CUSTOMER_REVIEW_TEST_BAD_BATCH: a generation request needs a request key'
      using errcode = '23514';
  end if;

  if not exists (select 1 from public.users u where u.id = p_actor_id and u.is_active) then
    raise exception 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED: Your account is not active'
      using errcode = '42501';
  end if;

  if not public.resolve_permission(p_actor_id, 'customer_review_requests', 'verify') then
    raise exception 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED: Generating drafts needs the Verify permission'
      using errcode = '42501';
  end if;

  -- ── The size, before anything else is looked at ──────────────────────────
  if p_card_count is null or p_card_count < 6 or p_card_count > 20 then
    raise exception 'CUSTOMER_REVIEW_TEST_BAD_BATCH: a batch is between 6 and 20 reviews; % were requested', coalesce(p_card_count, -1)
      using errcode = '23514';
  end if;

  -- ── The intended candidate, if one was named ─────────────────────────────
  --
  -- CHECKED THE SAME WAY assign_customer_review_batch() checks its employee,
  -- because recording an intention toward somebody who cannot use the module
  -- would produce a prefilled picker that refuses when it is used. It still
  -- grants nothing: this column is read by no policy.
  if p_intended_for is not null and not exists (
    select 1 from public.users u
     where u.id = p_intended_for
       and u.is_active
       and coalesce(u.is_deleted, false) = false
       and public.resolve_permission(p_intended_for, 'customer_review_requests', 'use')
  ) then
    raise exception 'CUSTOMER_REVIEW_TEST_BAD_BATCH: That employee cannot use the Review Workflow, so a batch cannot be intended for them'
      using errcode = '23514';
  end if;

  perform pg_advisory_xact_lock(hashtext('customer_review_draft_batch'));

  select id into v_batch_id
    from public.customer_review_draft_batches
   where request_key = p_request_key;
  if v_batch_id is not null then
    return v_batch_id;
  end if;

  -- ── Exactly what was asked for, all valid ────────────────────────────────
  if jsonb_typeof(p_drafts) <> 'array' then
    raise exception 'CUSTOMER_REVIEW_TEST_BAD_BATCH: the drafts payload is not an array'
      using errcode = '23514';
  end if;

  v_n := jsonb_array_length(p_drafts);
  if v_n <> p_card_count then
    raise exception 'CUSTOMER_REVIEW_TEST_BAD_BATCH: the batch holds % draft(s), expected exactly %', v_n, p_card_count
      using errcode = '23514';
  end if;

  -- ── ONE IMAGE REVIEW IN THREE, AND NOTHING ELSE ──────────────────────────
  --
  -- The same arithmetic as imageReviewsFor() in src/lib/customerReviews/reviewTypes.ts,
  -- and it has to stay the same: `round(n / 3)`. No batch size between 6 and 20
  -- divides by three to a halfway value, so there is no tie for Postgres and
  -- JavaScript to break in opposite directions.
  --
  -- Counted before the loop, so a batch with the wrong composition writes no
  -- row at all rather than most of them and a failure.
  v_want_img := round(p_card_count::numeric / 3);
  v_want_txt := p_card_count - v_want_img;

  select count(*) filter (where coalesce(d->>'type', 'text') = 'text'),
         count(*) filter (where coalesce(d->>'type', 'text') = 'image')
    into v_text_n, v_image_n
    from jsonb_array_elements(p_drafts) d;

  if v_text_n <> v_want_txt or v_image_n <> v_want_img then
    raise exception 'CUSTOMER_REVIEW_TEST_BAD_BATCH: a batch of % is % text and % image reviews; this one is % text and % image', p_card_count, v_want_txt, v_want_img, v_text_n, v_image_n
      using errcode = '23514';
  end if;

  insert into public.customer_review_draft_batches
    (generated_by, guidance, model, card_count, expected_count, request_key,
     generation_settings, intended_for)
  values (p_actor_id, p_guidance, p_model, p_card_count, p_card_count, p_request_key,
          p_settings, p_intended_for)
  returning id into v_batch_id;

  -- References continue from the highest RW- already used, so a reference is
  -- never reused even after cards are deleted, and stays stable once assigned.
  select coalesce(max(substring(card_ref from 4)::integer), 0)
    into v_next
    from public.customer_review_test_cards
   where card_ref ~ '^RW-[0-9]{6}$';

  for v_item in select * from jsonb_array_elements(p_drafts)
  loop
    v_title := btrim(coalesce(v_item->>'title', ''));
    v_body  := btrim(coalesce(v_item->>'body', ''));
    v_type  := coalesce(v_item->>'type', 'text');

    if v_title = '' or v_body = '' then
      raise exception 'CUSTOMER_REVIEW_TEST_BAD_BATCH: a draft has an empty title or body'
        using errcode = '23514';
    end if;

    -- THE DATABASE REFUSES A CONTACT DETAIL TOO, rather than trusting that the
    -- route checked. Title as well as body: a title is displayed on the card.
    if public.customer_review_contains_phone(v_title)
    or public.customer_review_contains_phone(v_body) then
      raise exception 'CUSTOMER_REVIEW_TEST_BAD_BATCH: a draft contains a telephone number'
        using errcode = '23514';
    end if;

    v_next := v_next + 1;

    -- pending_approval, NOT available. This one word is the whole of the
    -- workflow's safety property: a model's output is never a thing a candidate
    -- can pick up.
    insert into public.customer_review_test_cards
      (card_ref, test_category, test_title, test_body, batch_id, status, review_type)
    values ('RW-' || lpad(v_next::text, 6, '0'),
            coalesce(v_item->>'category', 'service_test')::text,
            v_title, v_body, v_batch_id, 'pending_approval', v_type);

    insert into public.customer_review_test_card_events
      (card_id, event_type, previous_status, new_status, detail, actor_id)
    select c.id, 'generated', null, 'pending_approval',
           case when v_type = 'image'
                then 'Image review drafted from batch guidance. Awaiting approval.'
                else 'Text review drafted from batch guidance. Awaiting approval.' end,
           p_actor_id
      from public.customer_review_test_cards c
     where c.card_ref = 'RW-' || lpad(v_next::text, 6, '0');
  end loop;

  return v_batch_id;
end;
$$;

comment on function public.create_customer_review_draft_batch(text, text, jsonb, uuid, uuid, integer, jsonb, uuid) is
  'Creates one batch of exactly p_card_count pending drafts, between 6 and 20 — one image review in three, derived here rather than trusted from the caller — atomically, keyed by request_key so a repeated request returns the batch that already exists. Stores the generation controls for auditing and the intended employee as a prefill that grants nothing. Requires the resolved verify permission.';

revoke execute on function public.create_customer_review_draft_batch(text, text, jsonb, uuid, uuid, integer, jsonb, uuid)
  from public, anon, authenticated;
grant  execute on function public.create_customer_review_draft_batch(text, text, jsonb, uuid, uuid, integer, jsonb, uuid)
  to service_role;

-- ── The compatibility wrapper ───────────────────────────────────────────────
--
-- The signature the currently deployed route calls, preserved so that applying
-- this migration cannot break generation before the new bundle is live.
--
-- IT ADDS NO RULE AND RELAXES NONE. Every check — active actor, resolved
-- `verify`, the advisory lock, request-key idempotence, the size range, the
-- composition, the telephone check, `pending_approval` — happens inside the
-- function it delegates to, once.
--
-- TWELVE, AND NOT A PARAMETER, because the caller this exists for cannot say
-- anything else: the five-argument form predates the batch size being a choice,
-- and every batch it ever created held twelve.
--
-- SECURITY INVOKER, deliberately. It is a pass-through, and the definer
-- privileges belong to the function that actually writes. Making the wrapper a
-- definer too would mean two places holding the same elevated rights, which is
-- one more than the number that can be reasoned about.
create or replace function public.create_customer_review_draft_batch(
  p_guidance    text,
  p_model       text,
  p_drafts      jsonb,
  p_actor_id    uuid,
  p_request_key uuid
)
returns uuid
language sql
security invoker
set search_path = public, pg_temp
as $$
  select public.create_customer_review_draft_batch(
    p_guidance, p_model, p_drafts, p_actor_id, p_request_key, 12, null::jsonb, null::uuid
  );
$$;

comment on function public.create_customer_review_draft_batch(text, text, jsonb, uuid, uuid) is
  'DEPRECATED COMPATIBILITY WRAPPER for the pre-20261108000000 callers. Delegates to the eight-argument form with a batch of twelve, no stored settings and no intended employee. Kept so that applying this migration cannot break the currently deployed bundle; drop it once the new bundle is live everywhere.';

revoke execute on function public.create_customer_review_draft_batch(text, text, jsonb, uuid, uuid)
  from public, anon, authenticated;
grant  execute on function public.create_customer_review_draft_batch(text, text, jsonb, uuid, uuid)
  to service_role;

-- ═══ 4. APPROVING A SELECTION, UP TO A WHOLE BATCH ═════════════════════════
--
-- Identical to 20261031000000's definition except for the upper bound, which
-- was the batch size written down a second time. A batch you can generate but
-- not approve would be worse than one you cannot generate: the drafts would
-- exist, be visible to a verifier, and refuse to be released.
--
-- IT IS A SANITY BOUND, NOT A BUSINESS RULE. Nothing about approval depends on
-- how many reviews were selected; the bound exists so that a caller cannot hand
-- this function ten thousand ids and make it lock ten thousand rows. Twenty is
-- the largest batch there can be, so it is the largest selection there can be.
create or replace function public.approve_customer_review_drafts(
  p_card_ids uuid[],
  p_replace  boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid      uuid := auth.uid();
  v_ids      uuid[];
  v_asked    integer;
  v_locked   integer;
  v_bad      text;
  v_batches  integer;
  v_batch_id uuid;
  v_replaced integer := 0;
begin
  if v_uid is null then
    raise exception 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED: Sign in to continue' using errcode = '42501';
  end if;

  -- ACTIVE, AND HOLDING `verify`. No role branch.
  if not exists (
    select 1 from public.users u
     where u.id = v_uid
       and u.is_active
       and public.resolve_permission(v_uid, 'customer_review_requests', 'verify')
  ) then
    raise exception 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED: Approving a review needs the Verify permission'
      using errcode = '42501';
  end if;

  if p_replace is null then
    raise exception 'CUSTOMER_REVIEW_TEST_BAD_BATCH: an approval must say whether it adds to the list or replaces it'
      using errcode = '23514';
  end if;

  select array_agg(distinct x) into v_ids from unnest(coalesce(p_card_ids, '{}'::uuid[])) x;
  v_asked := coalesce(array_length(v_ids, 1), 0);

  if v_asked = 0 then
    raise exception 'CUSTOMER_REVIEW_TEST_BAD_BATCH: Select at least one review to approve'
      using errcode = '23514';
  end if;
  if v_asked > 20 then
    raise exception 'CUSTOMER_REVIEW_TEST_BAD_BATCH: A batch holds at most twenty reviews; % were selected', v_asked
      using errcode = '23514';
  end if;

  -- Lock every named row before deciding anything, in id order so two verifiers
  -- approving overlapping selections queue rather than deadlock.
  select count(*) into v_locked from (
    select id from public.customer_review_test_cards
     where id = any(v_ids)
     order by id
       for update
  ) l;

  if v_locked <> v_asked then
    raise exception 'CUSTOMER_REVIEW_TEST_NOT_FOUND: % of the selected reviews no longer exist; nothing was approved', v_asked - v_locked
      using errcode = 'P0002';
  end if;

  -- RECHECKED AFTER THE LOCK. A deleted draft fails this too: deletion does not
  -- move the status, so the clause names both conditions.
  select string_agg(card_ref, ', ' order by card_ref) into v_bad
    from public.customer_review_test_cards
   where id = any(v_ids)
     and (status <> 'pending_approval' or deleted_at is not null);

  if v_bad is not null then
    raise exception 'CUSTOMER_REVIEW_TEST_NOT_PENDING: % is no longer awaiting approval; nothing was approved', v_bad
      using errcode = '23514';
  end if;

  -- ── The replacement, BEFORE the approval ─────────────────────────────────
  --
  -- Order is load-bearing. Displacing the available list after approving would
  -- delete the reviews this call has just published; doing it first means the
  -- displaced set cannot contain them.
  if p_replace then
    -- WHICH BATCH DISPLACED THEM has to be a single answer for the tombstone to
    -- mean anything. Selection is scoped to one batch in the UI; this is the
    -- database refusing to record a half-truth if that ever stops being so.
    -- array_agg rather than min(): THERE IS NO min(uuid) IN POSTGRES.
    select count(distinct batch_id), (array_agg(distinct batch_id))[1]
      into v_batches, v_batch_id
      from public.customer_review_test_cards
     where id = any(v_ids);

    if v_batches > 1 then
      raise exception 'CUSTOMER_REVIEW_TEST_BAD_BATCH: a replacement must come from one batch; the selection spans %', v_batches
        using errcode = '23514';
    end if;

    v_replaced := public.customer_review_replace_available(v_uid, v_batch_id);
  end if;

  update public.customer_review_test_cards
     set status      = 'available',
         approved_at = now(),
         approved_by = v_uid,
         updated_at  = now()
   where id = any(v_ids)
     and status = 'pending_approval'
     and deleted_at is null;

  insert into public.customer_review_test_card_events
    (card_id, event_type, previous_status, new_status, detail, actor_id)
  select id, 'approved', 'pending_approval', 'available',
         case when p_replace
           then 'Approved, replacing the reviews that were available. It is now available for a candidate to book.'
           else 'Approved. The review is now available for a candidate to book.'
         end,
         v_uid
    from public.customer_review_test_cards
   where id = any(v_ids);

  return jsonb_build_object('approved', v_asked, 'replaced', v_replaced);
end;
$$;

comment on function public.approve_customer_review_drafts(uuid[], boolean) is
  'Approves a selected set of pending drafts atomically, up to a whole batch of twenty. With p_replace, the reviews currently available are soft-deleted in the same transaction and stamped with the batch that displaced them; booked, sent, submitted, verified and pending rows are never touched. Requires the resolved verify permission. Returns {approved, replaced}.';

revoke execute on function public.approve_customer_review_drafts(uuid[], boolean) from public, anon;
grant  execute on function public.approve_customer_review_drafts(uuid[], boolean) to authenticated;

-- APPROVE ALL IS UNTOUCHED, and it is worth saying why it needed nothing.
-- approve_customer_review_draft_batch() selects every still-pending draft in
-- the batch under a row lock and approves what it found; it never named a
-- count, so a batch of six and a batch of twenty were already the same code
-- path. The same is true of revise_customer_review_draft_batch(), which
-- compares the replacements it was given against the pending rows it locked.

-- ═══ 5. ASSIGNING A WHOLE BATCH, WHATEVER SIZE IT IS ═══════════════════════
--
-- Identical to 20261107000000's definition except that the size it insists on
-- comes from the batch row rather than from the literal 12.
--
-- STILL ASSIGNED WHOLE. The rule has not softened: every live review in the
-- batch must be `available` and unassigned, and the count must be the batch's
-- own card_count. A batch of twenty where somebody has deleted three is not a
-- twenty-review batch, and handing over seventeen under a name that promises
-- twenty would be the wrong kind of helpful.
--
-- THE SIZE IS READ INSIDE THE TRANSACTION, after the rows are locked, so it is
-- the batch as it is now rather than as a page saw it.
create or replace function public.assign_customer_review_batch(
  p_batch_id    uuid,
  p_employee_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid       uuid := auth.uid();
  v_ids       uuid[];
  v_n         integer;
  v_expected  integer;
  v_bad       text;
  v_assigned  integer;
  v_image_ids uuid[];
  v_groups    uuid[];
  v_i         integer;
  v_with      integer := 0;
  v_now       timestamptz := now();
begin
  if v_uid is null then
    raise exception 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED: Sign in to continue' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.users u
     where u.id = v_uid
       and u.is_active
       and public.resolve_permission(v_uid, 'customer_review_requests', 'verify')
  ) then
    raise exception 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED: Assigning a batch needs the Verify permission'
      using errcode = '42501';
  end if;

  if p_employee_id is null then
    raise exception 'CUSTOMER_REVIEW_TEST_BAD_ASSIGNMENT: Choose the employee this batch is for'
      using errcode = '23514';
  end if;

  if not exists (
    select 1 from public.users u
     where u.id = p_employee_id
       and u.is_active
       and coalesce(u.is_deleted, false) = false
       and public.resolve_permission(p_employee_id, 'customer_review_requests', 'use')
  ) then
    raise exception 'CUSTOMER_REVIEW_TEST_BAD_ASSIGNMENT: That employee cannot use the Review Workflow, so a batch assigned to them would be invisible'
      using errcode = '23514';
  end if;

  -- Lock every live review in the batch, in id order so two verifiers assigning
  -- overlapping work queue rather than deadlock.
  select array_agg(c.id order by c.id) into v_ids
    from (
      select id from public.customer_review_test_cards
       where batch_id = p_batch_id
         and deleted_at is null
       order by id
         for update
    ) c;

  v_n := coalesce(array_length(v_ids, 1), 0);
  if v_n = 0 then
    raise exception 'CUSTOMER_REVIEW_TEST_NOT_FOUND: That batch has no reviews left to assign'
      using errcode = 'P0002';
  end if;

  -- HOW BIG THIS BATCH IS, from the batch. A missing row means reviews pointing
  -- at a batch that does not exist, which nothing in this module can produce;
  -- falling back to v_n would make that case silently assignable, so it is an
  -- error instead.
  select card_count into v_expected
    from public.customer_review_draft_batches
   where id = p_batch_id;

  if v_expected is null then
    raise exception 'CUSTOMER_REVIEW_TEST_NOT_FOUND: That batch no longer exists'
      using errcode = 'P0002';
  end if;

  if v_n <> v_expected then
    raise exception 'CUSTOMER_REVIEW_TEST_BAD_ASSIGNMENT: A batch is assigned whole; this one holds % of its % reviews', v_n, v_expected
      using errcode = '23514';
  end if;

  -- RECHECKED AFTER THE LOCK, which is the only place a check means anything.
  select string_agg(card_ref, ', ' order by card_ref) into v_bad
    from public.customer_review_test_cards
   where id = any(v_ids)
     and (status <> 'available' or assigned_to is not null);

  if v_bad is not null then
    raise exception 'CUSTOMER_REVIEW_TEST_BAD_ASSIGNMENT: % is not an unassigned approved review; nothing was assigned', v_bad
      using errcode = '23514';
  end if;

  update public.customer_review_test_cards
     set assigned_to = p_employee_id,
         assigned_at = v_now,
         assigned_by = v_uid,
         updated_at  = v_now
   where id = any(v_ids);

  get diagnostics v_assigned = row_count;

  insert into public.customer_review_test_card_events
    (card_id, event_type, previous_status, new_status, detail, actor_id)
  select unnest(v_ids), 'assigned', null, null,
         'Assigned to one employee with the rest of the batch.', v_uid;

  -- ── The image reviews get different projects ─────────────────────────────
  --
  -- Ordered by card_ref so the pairing is stable and reproducible rather than
  -- whatever order the planner felt like. How many there are is whatever the
  -- batch holds — pick_customer_review_image_groups() already takes a count and
  -- returns up to that many DISTINCT ready groups, so a batch of twenty asking
  -- for seven behaves exactly as a batch of twelve asking for four did: any it
  -- cannot fill stay `awaiting_images`, which is a readiness fact the verifier
  -- is told about in the return value.
  select array_agg(c.id order by c.card_ref) into v_image_ids
    from public.customer_review_test_cards c
   where c.id = any(v_ids) and c.review_type = 'image';

  if coalesce(array_length(v_image_ids, 1), 0) > 0 then
    v_groups := public.pick_customer_review_image_groups(array_length(v_image_ids, 1));

    for v_i in 1 .. array_length(v_image_ids, 1) loop
      exit when v_i > coalesce(array_length(v_groups, 1), 0);

      update public.customer_review_test_cards
         set image_group_id = v_groups[v_i],
             updated_at     = v_now
       where id = v_image_ids[v_i];

      insert into public.customer_review_test_card_events
        (card_id, event_type, previous_status, new_status, detail, actor_id)
      select v_image_ids[v_i], 'image_group_set', null, null,
             'Project images attached: ' || g.label, v_uid
        from public.customer_review_image_groups g
       where g.id = v_groups[v_i];

      v_with := v_with + 1;
    end loop;
  end if;

  return jsonb_build_object(
    'assigned',        v_assigned,
    'image_reviews',   coalesce(array_length(v_image_ids, 1), 0),
    -- HOW MANY ARE STILL WAITING FOR IMAGES, so the verifier is told at the
    -- moment they assign rather than finding out from a candidate.
    'with_images',     v_with,
    'awaiting_images', coalesce(array_length(v_image_ids, 1), 0) - v_with
  );
end;
$$;

revoke execute on function public.assign_customer_review_batch(uuid, uuid) from public, anon;
grant  execute on function public.assign_customer_review_batch(uuid, uuid) to authenticated;

comment on function public.assign_customer_review_batch(uuid, uuid) is
  'Assigns one whole batch of approved reviews to one employee, and gives its image reviews different ready project groups, atomically. The size it insists on is the batch''s own card_count, read inside the transaction. The set is locked and rechecked inside the transaction. Actor is auth.uid(); the employee is a target and must resolve `use`.';

-- ═══ 6. WHAT THIS FILE DID NOT DO ══════════════════════════════════════════
--
-- No SELECT policy is created, dropped or re-created here. No permission, no
-- module registration, no grant to `authenticated` that did not already exist,
-- and no change to who can see a review. A batch is bigger or smaller than it
-- used to be; nothing about who may read one has moved.
