-- ═══════════════════════════════════════════════════════════════════════════
-- Review Workflow — an administrator may PERMANENTLY delete an internal test
-- record, while it is still provably internal
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT THIS ADDS
--
--   begin_customer_review_test_card_purge(card, actor)    service role only
--   finish_customer_review_test_card_purge(card, actor)   service role only
--   can_purge_customer_review_test_cards()                 authenticated
--   customer_review_test_card_purge_record(card)           authenticated
--
-- The last is the admin's read of ONE card for the purge page: it answers
-- only an active admin, only while the card is still eligible, and it says
-- whether a purge is already in progress — which is what lets an admin without
-- `verify` reach the purge, and lets an interrupted purge be continued after a
-- reload. It returns nothing for any other card and grants no review action.
--
-- Driven by POST /api/customer-reviews/test-cards/purge in three steps:
--
--   START   authority and eligibility are checked under the row lock, and the
--           card is tombstoned with deleted_source = 'purge'. The tombstone is
--           the FREEZE: the existing trigger refuses every later UPDATE, and the
--           existing screenshot trigger refuses every later INSERT, so nothing
--           can approve, book, verify or attach to it while its files go.
--   FILES   the route removes every object under `<card id>/` in
--           customer-review-test-screenshots through the Storage API. SQL cannot
--           (storage.protect_objects_delete), which is why this is a route.
--   FINISH  authority and eligibility again, then REFUSES while any object under
--           the card's prefix remains, and only then deletes the card. Its
--           screenshot and event rows go with it by ON DELETE CASCADE.
--
-- Both functions are safe to repeat: START on a purge already started returns
-- the paths again; FINISH on a card already gone reports it and does nothing.
--
-- ─── WHO ────────────────────────────────────────────────────────────────────
--
-- An ACTIVE, NON-DELETED user whose users.role is admin — the authority BOE
-- already uses for irreversible erasure (Assets purge, PI deletion, BOE Credits
-- management). The Review `verify` permission is NOT required and NOT enough.
--
-- The role is read in exactly ONE function, customer_review_test_card_purge_
-- authorized(), and §6 asserts that none of the others reads it. The module's
-- rule that `use` and `verify` come only from the permission engine is
-- untouched: this is a separate authority for a separate act, and no workflow
-- function consults it. The browser asks can_purge_customer_review_test_cards()
-- rather than reading a role itself.
--
-- ─── WHICH RECORDS: THE ELIGIBILITY PREDICATE ───────────────────────────────
--
-- customer_review_test_card_purge_blocker() is the one definition, asked by
-- both START and FINISH under the row lock. A card is eligible only when ALL of:
--
--   1. no BOE Credits row names it — no boe_credit_transactions.source_id and
--      no boe_credit_review_rewards.card_id equal to the card id, of any type;
--   2. it is not a verifier's soft-deletion tombstone (a purge's own tombstone
--      is allowed, so a retry can resume);
--   3. it was never released beyond an internal draft:
--        status = 'pending_approval', approved_at, assigned_to, booked_by,
--        whatsapp_opened_at, sent_confirmed_at, submitted_at and verified_at
--        all null, whatsapp_opened_count = 0;
--   4. its trail holds ONLY internal event types — generated, revised,
--      draft_edited, image_removed, image_group_set (plus the purge's own
--      deleted event). Any other type, including one added later, refuses;
--   5. no attachment other than a verifier's review image exists (a
--      test_screenshot only ever exists on a booked card).
--
-- WHY APPROVAL IS THE BOUNDARY. Before approval a draft is readable by
-- verifiers only, and assigned_to must be null (20261107000000). After it, the
-- text reached candidates — every `use` holder before 20261107000000, the
-- assignee since — and "Copy message" and the share fallback record nothing.
-- From that point the schema cannot prove the text never left BOE, so this
-- fails closed and refuses every approved card.
--
-- ─── WHAT IS NOT TOUCHED ────────────────────────────────────────────────────
--
--   * custom review submissions, their bucket and their events;
--   * the shared project image groups and their bucket;
--   * the verifier soft deletion, which still removes no row and no file;
--   * the BOE Credits ledger — a rewarded card is refused, never reversed.

-- ── 1. A FIFTH DELETION SOURCE ──────────────────────────────────────────────
--
-- Only ever seen on a purge that has started and not finished. Every read
-- already treats a tombstone as gone.
alter table public.customer_review_test_cards
  drop constraint if exists customer_review_test_cards_deleted_source_check;
alter table public.customer_review_test_cards
  add constraint customer_review_test_cards_deleted_source_check
  check (deleted_source is null or deleted_source in (
    'single',
    'selected',
    'all',
    'replacement',
    'purge'         -- an administrator's permanent deletion, in progress
  ));

-- ── 2. THE AUTHORITY ────────────────────────────────────────────────────────

create or replace function public.customer_review_test_card_purge_authorized(p_user_id uuid)
returns boolean
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select p_user_id is not null and exists (
    select 1
      from public.users u
     where u.id = p_user_id
       and u.role::text = 'admin'
       and u.is_active = true
       and coalesce(u.is_deleted, false) = false
  );
$$;

comment on function public.customer_review_test_card_purge_authorized(uuid) is
  'Internal. True for an active, non-deleted admin. The only function in the Review Workflow that reads users.role, and it authorizes nothing but the permanent purge of an internal test record.';

revoke execute on function public.customer_review_test_card_purge_authorized(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.can_purge_customer_review_test_cards()
returns boolean
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select public.customer_review_test_card_purge_authorized(auth.uid());
$$;

comment on function public.can_purge_customer_review_test_cards() is
  'May the signed-in user permanently delete internal test records? Lets the detail screen decide whether to draw the control without reading a role.';

revoke execute on function public.can_purge_customer_review_test_cards() from public, anon;
grant  execute on function public.can_purge_customer_review_test_cards() to authenticated;

-- ── 3. THE ELIGIBILITY PREDICATE ────────────────────────────────────────────
--
-- Returns NULL when the card may be purged, otherwise the first reason it may
-- not. The caller holds the row lock.
create or replace function public.customer_review_test_card_purge_blocker(p_card_id uuid)
returns text
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  c public.customer_review_test_cards%rowtype;
begin
  select * into c from public.customer_review_test_cards where id = p_card_id;
  if not found then
    return 'missing';
  end if;

  -- 1. Credits first, so a rewarded card always gets the sentence that says so.
  if exists (select 1 from public.boe_credit_transactions t where t.source_id = p_card_id)
     or exists (select 1 from public.boe_credit_review_rewards r where r.card_id = p_card_id) then
    return 'reward';
  end if;

  -- 2. A verifier's tombstone is an audit record, not an internal draft.
  if c.deleted_at is not null and c.deleted_source is distinct from 'purge' then
    return 'deleted';
  end if;

  -- 3. Never released beyond an internal draft.
  if c.status <> 'pending_approval'
     or c.approved_at is not null
     or c.assigned_to is not null
     or c.booked_by is not null
     or c.whatsapp_opened_at is not null
     or c.whatsapp_opened_count <> 0
     or c.sent_confirmed_at is not null
     or c.submitted_at is not null
     or c.verified_at is not null then
    return 'released';
  end if;

  -- 4. Nothing in the trail beyond internal drafting. An allow-list, so an
  --    event type added later refuses until somebody decides otherwise.
  if exists (
    select 1
      from public.customer_review_test_card_events e
     where e.card_id = p_card_id
       and e.event_type not in ('generated', 'revised', 'draft_edited', 'image_removed', 'image_group_set')
       and not (e.event_type = 'deleted' and c.deleted_source is not distinct from 'purge')
  ) then
    return 'history';
  end if;

  -- 5. A verifier's review images are internal; any other attachment is not.
  if exists (
    select 1
      from public.customer_review_test_card_screenshots s
     where s.card_id = p_card_id
       and s.kind <> 'review_image'
  ) then
    return 'evidence';
  end if;

  return null;
end;
$$;

comment on function public.customer_review_test_card_purge_blocker(uuid) is
  'Internal. NULL when a card is still an internal draft that may be permanently deleted; otherwise missing, reward, deleted, released, history or evidence.';

revoke execute on function public.customer_review_test_card_purge_blocker(uuid)
  from public, anon, authenticated, service_role;

-- One sentence per reason, shared by START and FINISH.
create or replace function public.customer_review_test_card_purge_refuse(p_blocker text)
returns void
language plpgsql
set search_path = public, pg_temp
as $$
begin
  case p_blocker
    when 'missing' then
      raise exception 'CUSTOMER_REVIEW_TEST_NOT_FOUND: That test record no longer exists'
        using errcode = 'P0002';
    when 'reward' then
      raise exception 'CUSTOMER_REVIEW_TEST_PURGE_REWARD_ATTACHED: This review has BOE Credits attached. The reward must be handled separately, so the record cannot be permanently deleted'
        using errcode = '23514';
    when 'deleted' then
      raise exception 'CUSTOMER_REVIEW_TEST_PURGE_NOT_ELIGIBLE: A verifier already deleted this review; it is kept as an audit record and cannot be permanently deleted'
        using errcode = '23514';
    when 'released' then
      raise exception 'CUSTOMER_REVIEW_TEST_PURGE_NOT_ELIGIBLE: This review has been approved, assigned, booked, shared or submitted, so it is no longer an internal test record and cannot be permanently deleted'
        using errcode = '23514';
    when 'history' then
      raise exception 'CUSTOMER_REVIEW_TEST_PURGE_NOT_ELIGIBLE: This review''s activity shows it was used beyond an internal draft, so it cannot be permanently deleted'
        using errcode = '23514';
    when 'evidence' then
      raise exception 'CUSTOMER_REVIEW_TEST_PURGE_NOT_ELIGIBLE: This review carries a test screenshot, so it cannot be permanently deleted'
        using errcode = '23514';
    else
      raise exception 'CUSTOMER_REVIEW_TEST_PURGE_NOT_ELIGIBLE: This review cannot be permanently deleted'
        using errcode = '23514';
  end case;
end;
$$;

revoke execute on function public.customer_review_test_card_purge_refuse(text)
  from public, anon, authenticated, service_role;

-- ── 3b. THE PURGE PAGE'S READ ───────────────────────────────────────────────
--
-- ONE CARD, FOR ONE PURPOSE. RLS shows a pending draft to verifiers only, and a
-- tombstone to verifiers only, so an admin without `verify` — and anybody
-- reloading a purge that stopped half way — could not otherwise see the card
-- they may purge. This returns it:
--
--   * only to an active, non-deleted admin (NULL for everybody else);
--   * only while the eligibility predicate still allows the purge (NULL for an
--     approved, used, rewarded or verifier-deleted card);
--   * with purge_in_progress = true on a purge tombstone, so the page can offer
--     to continue it.
--
-- Read-only, and it reads nothing a purge would not delete.
create or replace function public.customer_review_test_card_purge_record(p_card_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
stable
as $$
declare
  c public.customer_review_test_cards%rowtype;
begin
  if not public.customer_review_test_card_purge_authorized(auth.uid()) then
    return null;
  end if;

  select * into c from public.customer_review_test_cards where id = p_card_id;
  if not found then
    return null;
  end if;

  if public.customer_review_test_card_purge_blocker(p_card_id) is not null then
    return null;
  end if;

  return jsonb_build_object(
    'id',                c.id,
    'card_ref',          c.card_ref,
    'test_title',        c.test_title,
    'test_body',         c.test_body,
    'status',            c.status,
    'review_type',       c.review_type,
    'created_at',        c.created_at,
    'purge_in_progress', c.deleted_source is not distinct from 'purge',
    'attachments', coalesce((
      select jsonb_agg(jsonb_build_object('kind', s.kind, 'file_name', s.file_name) order by s.uploaded_at)
        from public.customer_review_test_card_screenshots s
       where s.card_id = p_card_id
    ), '[]'::jsonb),
    'events', coalesce((
      select jsonb_agg(jsonb_build_object('event_type', e.event_type, 'detail', e.detail, 'created_at', e.created_at)
                       order by e.created_at desc)
        from public.customer_review_test_card_events e
       where e.card_id = p_card_id
    ), '[]'::jsonb)
  );
end;
$$;

comment on function public.customer_review_test_card_purge_record(uuid) is
  'The purge page''s read of one card: returned only to an active, non-deleted admin and only while the card may still be permanently deleted, with purge_in_progress set on a purge already started. NULL otherwise. Grants no review action.';

revoke execute on function public.customer_review_test_card_purge_record(uuid) from public, anon;
grant  execute on function public.customer_review_test_card_purge_record(uuid) to authenticated;

-- ── 4. START ────────────────────────────────────────────────────────────────

create or replace function public.begin_customer_review_test_card_purge(
  p_card_id  uuid,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c        public.customer_review_test_cards%rowtype;
  v_block  text;
  v_paths  jsonb;
begin
  if not public.customer_review_test_card_purge_authorized(p_actor_id) then
    raise exception 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED: Only an active administrator can permanently delete a test record'
      using errcode = '42501';
  end if;

  -- The same row lock the approval, booking and verification paths take, so
  -- none of them can move the card between this check and the tombstone.
  select * into c from public.customer_review_test_cards where id = p_card_id for update;
  if not found then
    perform public.customer_review_test_card_purge_refuse('missing');
  end if;

  v_block := public.customer_review_test_card_purge_blocker(p_card_id);
  if v_block is not null then
    perform public.customer_review_test_card_purge_refuse(v_block);
  end if;

  -- A repeat finds the purge tombstone already in place and changes nothing.
  -- The event goes first: once deleted_at is set the freeze trigger refuses
  -- every further UPDATE of the row.
  if c.deleted_at is null then
    insert into public.customer_review_test_card_events
      (card_id, event_type, previous_status, new_status, detail, actor_id)
    values
      (p_card_id, 'deleted', c.status, null,
       'Permanent deletion started by an administrator. Its files are removed next, then the record.',
       p_actor_id);

    update public.customer_review_test_cards
       set deleted_at     = now(),
           deleted_by     = p_actor_id,
           deleted_source = 'purge',
           updated_at     = now()
     where id = p_card_id;
  end if;

  select coalesce(jsonb_agg(s.storage_path order by s.storage_path), '[]'::jsonb)
    into v_paths
    from public.customer_review_test_card_screenshots s
   where s.card_id = p_card_id;

  return jsonb_build_object(
    'card_id',       p_card_id,
    'card_ref',      c.card_ref,
    'storage_paths', v_paths
  );
end;
$$;

comment on function public.begin_customer_review_test_card_purge(uuid, uuid) is
  'Starts the permanent deletion of one internal test record: checks the admin authority and the eligibility predicate under the row lock, tombstones the card with deleted_source purge (which freezes it), and returns the storage paths its attachments name. Repeatable. Service role only.';

revoke execute on function public.begin_customer_review_test_card_purge(uuid, uuid) from public, anon, authenticated;
grant  execute on function public.begin_customer_review_test_card_purge(uuid, uuid) to service_role;

-- ── 5. FINISH ───────────────────────────────────────────────────────────────

create or replace function public.finish_customer_review_test_card_purge(
  p_card_id  uuid,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c          public.customer_review_test_cards%rowtype;
  v_block    text;
  v_objects  integer;
  v_shots    integer;
  v_events   integer;
begin
  if not public.customer_review_test_card_purge_authorized(p_actor_id) then
    raise exception 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED: Only an active administrator can permanently delete a test record'
      using errcode = '42501';
  end if;

  select * into c from public.customer_review_test_cards where id = p_card_id for update;
  if not found then
    -- Already finished, by this call's lost response or another tab.
    return jsonb_build_object('purged', false, 'already_gone', true);
  end if;

  if c.deleted_at is null or c.deleted_source is distinct from 'purge' then
    raise exception 'CUSTOMER_REVIEW_TEST_PURGE_NOT_STARTED: The permanent deletion of this record has not been started'
      using errcode = '23514';
  end if;

  v_block := public.customer_review_test_card_purge_blocker(p_card_id);
  if v_block is not null then
    perform public.customer_review_test_card_purge_refuse(v_block);
  end if;

  -- THE FILES MUST BE GONE FIRST. Every attachment path starts with the card id
  -- (customer_review_screenshot_path_matches_card), so the prefix also catches
  -- an object whose metadata row was never written.
  select count(*) into v_objects
    from storage.objects o
   where o.bucket_id = 'customer-review-test-screenshots'
     and split_part(o.name, '/', 1) = p_card_id::text;

  if v_objects > 0 then
    raise exception 'CUSTOMER_REVIEW_TEST_PURGE_FILES_REMAIN: % file(s) of this record are still stored; nothing was deleted', v_objects
      using errcode = '23514';
  end if;

  select count(*) into v_shots
    from public.customer_review_test_card_screenshots where card_id = p_card_id;
  select count(*) into v_events
    from public.customer_review_test_card_events where card_id = p_card_id;

  delete from public.customer_review_test_cards where id = p_card_id;

  return jsonb_build_object(
    'purged',       true,
    'already_gone', false,
    'card_ref',     c.card_ref,
    'screenshots',  v_shots,
    'events',       v_events
  );
end;
$$;

comment on function public.finish_customer_review_test_card_purge(uuid, uuid) is
  'Finishes the permanent deletion of one internal test record: re-checks the admin authority and eligibility, refuses while any object under the card id remains in customer-review-test-screenshots, then deletes the card (its screenshot and event rows cascade). Repeatable. Service role only.';

revoke execute on function public.finish_customer_review_test_card_purge(uuid, uuid) from public, anon, authenticated;
grant  execute on function public.finish_customer_review_test_card_purge(uuid, uuid) to service_role;

-- ── 6. WHAT THIS FILE CLAIMS, EXECUTED ──────────────────────────────────────

do $$
declare
  v_src  text;
  v_name text;
begin
  select pg_get_constraintdef(con.oid) into v_src
    from pg_constraint con
    join pg_class cls on cls.oid = con.conrelid
   where cls.relname = 'customer_review_test_cards'
     and con.conname = 'customer_review_test_cards_deleted_source_check';
  if v_src is null or position('purge' in v_src) = 0 then
    raise exception 'PURGE: the deleted_source check does not allow purge';
  end if;

  for v_name in
    select unnest(array[
      'customer_review_test_card_purge_authorized',
      'can_purge_customer_review_test_cards',
      'customer_review_test_card_purge_record',
      'begin_customer_review_test_card_purge',
      'finish_customer_review_test_card_purge'
    ])
  loop
    if not exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = v_name and p.prosecdef
    ) then
      raise exception 'PURGE: %() is missing or not security definer', v_name;
    end if;
  end loop;

  -- ── Grants ──
  if has_function_privilege('authenticated', 'public.begin_customer_review_test_card_purge(uuid, uuid)', 'EXECUTE')
     or has_function_privilege('anon', 'public.begin_customer_review_test_card_purge(uuid, uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.finish_customer_review_test_card_purge(uuid, uuid)', 'EXECUTE')
     or has_function_privilege('anon', 'public.finish_customer_review_test_card_purge(uuid, uuid)', 'EXECUTE') then
    raise exception 'PURGE: a browser role can call START or FINISH';
  end if;
  if not has_function_privilege('service_role', 'public.begin_customer_review_test_card_purge(uuid, uuid)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.finish_customer_review_test_card_purge(uuid, uuid)', 'EXECUTE') then
    raise exception 'PURGE: the service role cannot call START or FINISH';
  end if;
  if has_function_privilege('authenticated', 'public.customer_review_test_card_purge_authorized(uuid)', 'EXECUTE')
     or has_function_privilege('anon', 'public.customer_review_test_card_purge_authorized(uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.customer_review_test_card_purge_blocker(uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.customer_review_test_card_purge_refuse(text)', 'EXECUTE') then
    raise exception 'PURGE: an internal helper is callable by a browser role';
  end if;
  if not has_function_privilege('authenticated', 'public.can_purge_customer_review_test_cards()', 'EXECUTE')
     or has_function_privilege('anon', 'public.can_purge_customer_review_test_cards()', 'EXECUTE') then
    raise exception 'PURGE: can_purge_customer_review_test_cards() has the wrong grants';
  end if;
  if not has_function_privilege('authenticated', 'public.customer_review_test_card_purge_record(uuid)', 'EXECUTE')
     or has_function_privilege('anon', 'public.customer_review_test_card_purge_record(uuid)', 'EXECUTE') then
    raise exception 'PURGE: customer_review_test_card_purge_record() has the wrong grants';
  end if;

  -- ── The purge page's read answers only the purge authority, only while eligible ──
  select p.prosrc into v_src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'customer_review_test_card_purge_record';
  if position('customer_review_test_card_purge_authorized(auth.uid())' in v_src) = 0
     or position('customer_review_test_card_purge_blocker(p_card_id) is not null' in v_src) = 0
     or position('customer_review_test_card_purge_authorized(auth.uid())' in v_src)
        > position('from public.customer_review_test_cards' in v_src) then
    raise exception 'PURGE: the purge page read is not gated on the authority and the eligibility rule';
  end if;

  -- ── The role is read in exactly one place ──
  select p.prosrc into v_src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'customer_review_test_card_purge_authorized';
  if position('u.role' in v_src) = 0 or position('is_active' in v_src) = 0 or position('is_deleted' in v_src) = 0 then
    raise exception 'PURGE: the authority is not active, non-deleted admin';
  end if;

  for v_name, v_src in
    select p.proname, p.prosrc
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in (
         'can_purge_customer_review_test_cards',
         'customer_review_test_card_purge_record',
         'customer_review_test_card_purge_blocker',
         'customer_review_test_card_purge_refuse',
         'begin_customer_review_test_card_purge',
         'finish_customer_review_test_card_purge'
       )
  loop
    if v_src ~ '\mrole\M|''admin''' then
      raise exception 'PURGE: %() reads a role outside the authority helper', v_name;
    end if;
    -- Nothing here reaches custom submissions or the shared project images.
    if v_src ~* 'customer_review_custom|customer-review-custom-proofs|customer-review-project-images|customer_review_group_images|customer_review_image_groups' then
      raise exception 'PURGE: %() reaches beyond internal test records', v_name;
    end if;
  end loop;

  -- ── FINISH checks storage before it deletes ──
  select p.prosrc into v_src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'finish_customer_review_test_card_purge';
  if position('storage.objects' in v_src) = 0
     or position('storage.objects' in v_src) > position('delete from public.customer_review_test_cards' in v_src) then
    raise exception 'PURGE: finish does not refuse remaining files before deleting';
  end if;

  -- ── The eligibility predicate says what the header says ──
  select p.prosrc into v_src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'customer_review_test_card_purge_blocker';
  if position('boe_credit_transactions' in v_src) = 0
     or position('boe_credit_review_rewards' in v_src) = 0
     or position('pending_approval' in v_src) = 0
     or position('approved_at is not null' in v_src) = 0
     or position('assigned_to is not null' in v_src) = 0
     or position('whatsapp_opened_at is not null' in v_src) = 0 then
    raise exception 'PURGE: the eligibility predicate is incomplete';
  end if;

  -- ── The verifier soft deletion is unchanged ──
  for v_name, v_src in
    select p.proname, p.prosrc
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in (
         'delete_customer_review_test_cards',
         'delete_all_customer_review_test_cards',
         'customer_review_replace_available'
       )
  loop
    if v_src ~* 'storage\.|delete\s+from' then
      raise exception 'PURGE: soft deletion %() now deletes rows or touches storage', v_name;
    end if;
  end loop;

  -- ── Still no client write policy on the cards ──
  if exists (
    select 1 from pg_policy pol
      join pg_class c on c.oid = pol.polrelid
     where c.relname = 'customer_review_test_cards'
       and pol.polcmd <> 'r'
  ) then
    raise exception 'PURGE: a write policy appeared on customer_review_test_cards';
  end if;

  raise notice 'PASS  review-workflow admin purge of internal test records';
end $$;
