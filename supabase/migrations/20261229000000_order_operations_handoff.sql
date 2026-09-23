-- ═══════════════════════════════════════════════════════════════════════════
-- THE PI-TO-OPERATIONS HANDOFF, PER APPROVED PI VERSION (Phase 1)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT THIS IS FOR
-- ----------------
-- Commercial approval is one person's decision; running the Order is another
-- person's. From this migration on, EVERY time a PI version becomes the one in
-- force — V1 when a submitted PI becomes a Confirmed Order, V2+ when a revised
-- workbook is approved — a handoff row is recorded for THAT version, the
-- assigned operations reviewer is notified in-app, and the Order shows, in
-- words, whether that exact version is awaiting review, accepted for
-- production, or flagged for clarification.
--
-- ONE OPERATIONS DECISION, AND WHAT THE TWO WORDS MEAN AFTER THIS FILE
-- --------------------------------------------------------------------
-- ACCEPTANCE (this file) is the operations reviewer's decision about ONE PI
-- version: "operations has reviewed this exact version and can work from it".
-- It is not a claim that manufacturing work is done.
--
-- ALIGNMENT (orders.production_alignment, 20261119000000) was the Head of
-- Manufacturing's per-Order feasibility answer, moved by
-- set_order_production_alignment() under orders.align_production. From this
-- file on, for every Order that carries a handoff, ALIGNMENT IS THE RESULT OF
-- ACCEPTANCE AND NOTHING ELSE:
--
--   * accepting the version in force ALIGNS the Order (the four alignment
--     columns are written inside the same transaction, by the reviewer);
--   * withdrawing that acceptance ("Cannot accept" on an accepted version,
--     reason required) takes the alignment back;
--   * approving a LATER version RESETS the alignment to not_aligned — the
--     alignment covered the earlier version, and the new one is unaccepted —
--     and records that reset on the Order's history with what it covered;
--   * set_order_production_alignment() is re-emitted to be the SAME door: on
--     an Order with a handoff it routes to the handoff decision, so the
--     assigned reviewer is the only person who can align it, whatever
--     permission or role the caller holds. Being an admin, or holding
--     orders.align_production, no longer aligns such an Order.
--
-- So an older alignment can never make a newer, unaccepted PI look ready:
-- the database resets it the moment the newer version is approved, and only
-- accepting that version can align the Order again.
--
-- LEGACY ORDERS. An Order approved before this file has no handoff row and is
-- shown as "Not recorded". Its alignment, if any, is kept exactly as it is and
-- still moves under the OLD rule (orders.align_production) — until a revised
-- PI is approved on it, at which point a handoff is recorded, the alignment is
-- reset, and the new rule applies. Nothing is backfilled: inventing
-- acceptances nobody made would be a false record.
--
-- WHO THE REVIEWER IS
-- -------------------
-- ONE assignment, made by an administrator in Control Center, held in
-- order_operations_reviewers as a user id — never a display name, never a
-- guessed id in this file. The trigger resolves it at the moment of approval
-- and requires the person to be active and not deleted; otherwise the handoff
-- is recorded UNASSIGNED and stays visibly so. Assigning someone readdresses
-- every live, unresolved handoff (awaiting AND flagged) to them; clearing the
-- assignment unassigns every live, unresolved handoff, visibly. A former
-- reviewer can no longer decide anything. An administrator is never
-- substituted.
--
-- HOW IT IS TRANSACTIONAL AND IDEMPOTENT
-- --------------------------------------
-- An AFTER trigger on order_pi_versions fires when a row's status BECOMES
-- 'approved' — the one write both approval paths already make, inside their
-- own transaction (approve_order_submission §14b; approve_order_pi_revision).
-- Neither function is re-emitted. The handoff table is UNIQUE on the version
-- id, and the trigger returns early if a handoff for that version exists, so a
-- retried approval cannot record a second handoff or a second notification.
--
-- AUTHORITY, AT THE DATABASE
-- --------------------------
-- decide_order_operations_handoff() re-checks under row locks that the caller
-- IS the assigned reviewer (not merely an admin), is active, can open the
-- Order, that the handoff is live and its version still the Order's approved
-- one, and that the Order is not cancelled. Clients hold SELECT only.
-- ═══════════════════════════════════════════════════════════════════════════


-- ═══ 1. Notification types ═════════════════════════════════════════════════
--
-- Named only inside function bodies below (never executed in this file), so
-- Postgres does not need them committed mid-transaction.

alter type notification_type add value if not exists 'order_operations_review_requested';
alter type notification_type add value if not exists 'order_operations_review_decided';


-- ═══ 2. The reviewer assignment ════════════════════════════════════════════

create table if not exists public.order_operations_reviewers (
  duty        text primary key check (duty = 'pi_handoff'),
  user_id     uuid references public.users(id) on delete set null,
  assigned_by uuid references public.users(id) on delete set null,
  assigned_at timestamptz not null default now()
);

comment on table public.order_operations_reviewers is
  'The one operations reviewer a PI-to-operations handoff is addressed to, chosen by an administrator in Control Center. Written only by set_order_operations_reviewer(). A NULL user_id means no reviewer is assigned: new handoffs are recorded unassigned and every live unresolved one is unassigned.';

alter table public.order_operations_reviewers enable row level security;
revoke all on table public.order_operations_reviewers from public, anon, authenticated;
grant select on table public.order_operations_reviewers to authenticated;

drop policy if exists "order_operations_reviewers_admin_select" on public.order_operations_reviewers;
create policy "order_operations_reviewers_admin_select" on public.order_operations_reviewers
  for select to authenticated
  using (exists (
    select 1 from public.users u
    where u.id = auth.uid() and u.role = 'admin' and u.is_active and coalesce(u.is_deleted, false) = false
  ));

-- THE ONE SETTINGS ROW EXISTS FROM THE START, with nobody assigned. Not a
-- decision and not a backfill: it is the row the approval trigger takes a
-- SHARE lock on and the assignment RPC takes an UPDATE lock on, which is what
-- serializes "who is the reviewer right now" between a PI approval and a
-- Control Center change (see §6 and §7).
insert into public.order_operations_reviewers (duty, user_id, assigned_by, assigned_at)
values ('pi_handoff', null, null, now())
on conflict (duty) do nothing;

-- ── Who can be routed an Order at all ──
--
-- A reviewer must be able to OPEN every Order handed to them. orders.view alone
-- opens the module, not every row: the Order's own visibility (the policies of
-- 20260656/20260666/20260903, restated by can_view_order_as_actor) admits an
-- active admin, the operations team, the Order's salesperson or requester, or
-- a holder of the protected orders.view_all. These two helpers ask that rule
-- for a GIVEN user, not for auth.uid(), so the trigger and the assignment RPC
-- can decide before addressing anyone. INTERNAL: not callable by clients.

create or replace function public.operations_reviewer_can_open_order(p_user uuid, p_order_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.users u
      join public.orders o on o.id = p_order_id
     where u.id = p_user
       and u.is_active
       and coalesce(u.is_deleted, false) = false
       -- module entry, as module_entry_open('orders') decides it
       and (u.role = 'admin' or public.resolve_permission(u.id, 'orders', 'view'))
       -- the Order's own visibility, as can_view_order_as_actor decides it
       and (
         u.role = 'admin'
         or u.team::text = 'operations'
         or o.requested_by = u.id
         or o.assigned_to  = u.id
         or public.resolve_permission(u.id, 'orders', 'view_all')
       )
  );
$$;

comment on function public.operations_reviewer_can_open_order(uuid, uuid) is
  'Whether p_user, as they are now (active, not deleted), can open Order p_order_id: module entry plus the Order''s own visibility rule, for a given user rather than auth.uid(). Internal.';

revoke execute on function public.operations_reviewer_can_open_order(uuid, uuid) from public, anon, authenticated;

create or replace function public.operations_reviewer_covers_all_orders(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.users u
     where u.id = p_user
       and u.is_active
       and coalesce(u.is_deleted, false) = false
       and (u.role = 'admin' or public.resolve_permission(u.id, 'orders', 'view'))
       and (
         u.role = 'admin'
         or u.team::text = 'operations'
         or public.resolve_permission(u.id, 'orders', 'view_all')
       )
  );
$$;

comment on function public.operations_reviewer_covers_all_orders(uuid) is
  'Whether p_user can open EVERY Confirmed Order: an active admin, an active member of the operations team, or an active holder of orders.view_all, with Orders module entry. The bar for being assigned as the operations reviewer. Internal.';

revoke execute on function public.operations_reviewer_covers_all_orders(uuid) from public, anon, authenticated;


-- ═══ 3. The handoff, one per approved PI version ═══════════════════════════

create table if not exists public.order_operations_handoffs (
  id                               uuid primary key default gen_random_uuid(),
  order_id                         uuid not null references public.orders(id) on delete cascade,
  pi_version_id                    uuid not null references public.order_pi_versions(id) on delete cascade,
  submission_id                    uuid not null references public.order_submissions(id) on delete cascade,
  version_number                   integer not null check (version_number >= 1),
  -- Who approved the version, and when: copied from order_pi_versions at the
  -- moment of approval so the handoff still names them if the version row's
  -- actor is later set null.
  approved_by                      uuid references public.users(id) on delete set null,
  approved_at                      timestamptz not null,
  -- The reviewer this handoff is addressed to. NULL = unassigned, visibly —
  -- and unassigned_reason says WHY, so the Order and the queues can tell an
  -- administrator what to fix: nobody is configured, the configured person
  -- is no longer active, or they cannot open this particular Order.
  assigned_to                      uuid references public.users(id) on delete set null,
  assigned_at                      timestamptz,
  unassigned_reason                text
    check (unassigned_reason is null or unassigned_reason in ('no_reviewer', 'reviewer_inactive', 'reviewer_cannot_open_order')),
  -- What production alignment said when this version was approved, BEFORE
  -- the trigger reset it. 'aligned' here means the Order was in production
  -- against an earlier version: exactly the case that needs a warning.
  production_alignment_at_approval text not null
    check (production_alignment_at_approval in ('not_aligned', 'aligned')),
  -- The decision state of the handoff this one superseded, if any — so the
  -- page can say "V1 was accepted; V2 has not been" without a second read.
  prior_handoff_status             text
    check (prior_handoff_status is null or prior_handoff_status in ('awaiting', 'accepted', 'clarification_needed')),
  status                           text not null default 'awaiting'
    check (status in ('awaiting', 'accepted', 'clarification_needed')),
  accepted_by                      uuid references public.users(id) on delete set null,
  accepted_at                      timestamptz,
  accepted_note                    text,
  -- An acceptance can be WITHDRAWN by the same reviewer, with a reason: the
  -- version goes back to clarification_needed and the Order's alignment is
  -- taken back. The acceptance columns are KEPT so the row still says who
  -- accepted and when; the withdrawal says who took it back and why.
  acceptance_withdrawn_by          uuid references public.users(id) on delete set null,
  acceptance_withdrawn_at          timestamptz,
  acceptance_withdrawn_reason      text,
  clarification_by                 uuid references public.users(id) on delete set null,
  clarification_at                 timestamptz,
  clarification_reason             text,
  -- Set when a later version is approved. The decision columns are KEPT: a
  -- superseded handoff is the audit record of what operations said about the
  -- earlier version.
  superseded_at                    timestamptz,
  superseded_by_version_id         uuid references public.order_pi_versions(id) on delete set null,
  created_at                       timestamptz not null default now(),

  constraint order_operations_handoffs_version_key unique (pi_version_id),
  constraint order_operations_handoffs_assignment_complete
    check (
      (assigned_to is null) = (assigned_at is null)
      and (assigned_to is null) = (unassigned_reason is not null)
    ),
  constraint order_operations_handoffs_acceptance_complete
    check (
      -- accepted: the acceptance is present and NOT withdrawn
      (status = 'accepted' and accepted_by is not null and accepted_at is not null
        and acceptance_withdrawn_at is null and acceptance_withdrawn_by is null and acceptance_withdrawn_reason is null)
      -- not accepted: either never accepted, or accepted and then withdrawn
      or (status <> 'accepted' and (
           (accepted_by is null and accepted_at is null and accepted_note is null
             and acceptance_withdrawn_at is null and acceptance_withdrawn_by is null and acceptance_withdrawn_reason is null)
           or (accepted_by is not null and accepted_at is not null
             and acceptance_withdrawn_at is not null and acceptance_withdrawn_by is not null and acceptance_withdrawn_reason is not null)
      ))
    ),
  constraint order_operations_handoffs_clarification_complete
    check (
      status = 'awaiting'
      or status = 'accepted'
      or (clarification_by is not null and clarification_at is not null and clarification_reason is not null)
    ),
  constraint order_operations_handoffs_superseded_complete
    check ((superseded_at is null) = (superseded_by_version_id is null)),
  constraint order_operations_handoffs_reason_lengths
    check (
      (accepted_note is null or char_length(accepted_note) <= 1000)
      and (clarification_reason is null or char_length(clarification_reason) <= 1000)
      and (acceptance_withdrawn_reason is null or char_length(acceptance_withdrawn_reason) <= 1000)
    )
);

comment on table public.order_operations_handoffs is
  'One row per PI version that became the version in force on a Confirmed Order (V1 at approval, V2+ at revision approval). Records who approved it, who must review it for operations, and that reviewer''s decision. Accepting ALIGNS the Order for production; withdrawing or flagging takes the alignment back; a later version supersedes the row (its decision kept) and resets the alignment. Written only by the order_pi_versions trigger and the RPCs; clients read. Orders approved before this table existed have no row, and are shown as "not recorded".';

-- Exactly one LIVE handoff per Order: the one for the version in force.
create unique index if not exists order_operations_handoffs_one_live_per_order
  on public.order_operations_handoffs (order_id) where superseded_at is null;
create index if not exists order_operations_handoffs_order_idx
  on public.order_operations_handoffs (order_id, version_number desc);
create index if not exists order_operations_handoffs_awaiting_idx
  on public.order_operations_handoffs (assigned_to)
  where status <> 'accepted' and superseded_at is null;


-- ═══ 4. The guard: identity frozen, decisions are events, no client writes ═

create or replace function public.order_operations_handoffs_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    if public.in_test_data_cleanup() then
      return old;
    end if;
    raise exception
      'ORDER_OPERATIONS_HANDOFF_PERMANENT: a handoff record is never deleted; it is superseded by the next approved version'
      using errcode = 'P0001';
  end if;

  if tg_op = 'UPDATE' then
    if new.id is distinct from old.id
       or new.order_id is distinct from old.order_id
       or new.pi_version_id is distinct from old.pi_version_id
       or new.submission_id is distinct from old.submission_id
       or new.version_number is distinct from old.version_number
       or new.approved_by is distinct from old.approved_by
       or new.approved_at is distinct from old.approved_at
       or new.production_alignment_at_approval is distinct from old.production_alignment_at_approval
       or new.prior_handoff_status is distinct from old.prior_handoff_status
       or new.created_at is distinct from old.created_at then
      raise exception
        'ORDER_OPERATIONS_HANDOFF_FROZEN: the version, the approver and the approval time of a handoff cannot be changed'
        using errcode = 'P0001';
    end if;
    -- An acceptance is never silently edited or reverted to "awaiting": it is
    -- either in force, or withdrawn with a reason (an event on the Order).
    if old.status = 'accepted' and new.status = 'awaiting' then
      raise exception
        'ORDER_OPERATIONS_HANDOFF_ACCEPTED_IS_PERMANENT: an acceptance is withdrawn with a reason, never erased'
        using errcode = 'P0001';
    end if;
    if old.status = 'accepted' and new.status = 'clarification_needed' and (
         new.acceptance_withdrawn_at is null
         or new.accepted_by is distinct from old.accepted_by
         or new.accepted_at is distinct from old.accepted_at
         or new.accepted_note is distinct from old.accepted_note) then
      raise exception
        'ORDER_OPERATIONS_HANDOFF_ACCEPTED_IS_PERMANENT: withdrawing keeps who accepted, when and with what note'
        using errcode = 'P0001';
    end if;
    if old.status = new.status and (
         new.accepted_by is distinct from old.accepted_by
         or new.accepted_at is distinct from old.accepted_at
         or new.accepted_note is distinct from old.accepted_note
         or new.acceptance_withdrawn_by is distinct from old.acceptance_withdrawn_by
         or new.acceptance_withdrawn_at is distinct from old.acceptance_withdrawn_at
         or new.acceptance_withdrawn_reason is distinct from old.acceptance_withdrawn_reason
         or new.clarification_by is distinct from old.clarification_by
         or new.clarification_at is distinct from old.clarification_at
         or new.clarification_reason is distinct from old.clarification_reason) then
      raise exception
        'ORDER_OPERATIONS_HANDOFF_DECISION_IS_AN_EVENT: a decision''s actor, time and words change only with the decision itself'
        using errcode = 'P0001';
    end if;
    if old.superseded_at is not null and (
         new.superseded_at is distinct from old.superseded_at
         or new.superseded_by_version_id is distinct from old.superseded_by_version_id
         or new.status is distinct from old.status
         or new.assigned_to is distinct from old.assigned_to) then
      raise exception
        'ORDER_OPERATIONS_HANDOFF_SUPERSEDED: a superseded handoff is history and cannot change'
        using errcode = 'P0001';
    end if;
  end if;

  return new;
end;
$$;

revoke execute on function public.order_operations_handoffs_guard() from public, anon, authenticated;

drop trigger if exists order_operations_handoffs_guard on public.order_operations_handoffs;
create trigger order_operations_handoffs_guard
  before update or delete on public.order_operations_handoffs
  for each row execute function public.order_operations_handoffs_guard();

-- ── Privileges and RLS ──
-- Read only, through the Order's own visibility door; every write goes through
-- the trigger or a definer function.
alter table public.order_operations_handoffs enable row level security;
revoke all on table public.order_operations_handoffs from public, anon, authenticated;
grant select on table public.order_operations_handoffs to authenticated;

drop policy if exists "order_operations_handoffs_select" on public.order_operations_handoffs;
create policy "order_operations_handoffs_select" on public.order_operations_handoffs
  for select to authenticated
  using (public.can_view_order(order_id));

drop policy if exists "order_operations_handoffs_module_entry_gate" on public.order_operations_handoffs;
create policy "order_operations_handoffs_module_entry_gate" on public.order_operations_handoffs
  as restrictive for all to authenticated
  using (public.module_entry_open('orders'))
  with check (public.module_entry_open('orders'));


-- ═══ 5. Moving the Order's alignment from a handoff decision ═══════════════
--
-- INTERNAL. The one place the four alignment columns are written on behalf of
-- a handoff: by acceptance (→ aligned), by withdrawal or a flag (→ not
-- aligned), and by the trigger when a later version is approved (→ not
-- aligned). It opens the same production_alignment context
-- set_order_production_alignment() opens, so orders_guard_amendable_columns
-- admits the write, and it records the SAME production_alignment_changed
-- event that function records — with the version and the reason — so the
-- Order's history reads as one story. Idempotent: no change, no event.

create or replace function public.order_operations_handoff_set_alignment(
  p_order_id  uuid,
  p_actor     uuid,
  p_aligned   boolean,
  p_note      text,
  p_detail    jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order  public.orders%rowtype;
  v_target text := case when p_aligned then 'aligned' else 'not_aligned' end;
  v_now    timestamptz := now();
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    return false;
  end if;
  if v_order.production_alignment = v_target then
    return false;
  end if;

  perform set_config('boe.production_alignment_context', 'production_alignment', true);
  update public.orders
     set production_alignment      = v_target,
         production_aligned_by     = case when p_aligned then p_actor else null end,
         production_aligned_at     = case when p_aligned then v_now else null end,
         production_alignment_note = p_note,
         updated_at                = v_now
   where id = p_order_id;
  perform set_config('boe.production_alignment_context', '', true);

  insert into public.order_activity_log (order_id, actor_id, event_type, payload)
  values (p_order_id, p_actor, 'production_alignment_changed',
          jsonb_build_object('from', v_order.production_alignment, 'to', v_target, 'note', p_note,
                             'previous_aligned_by', v_order.production_aligned_by,
                             'previous_aligned_at', v_order.production_aligned_at)
          || coalesce(p_detail, '{}'::jsonb));
  return true;
end;
$$;

comment on function public.order_operations_handoff_set_alignment(uuid, uuid, boolean, text, jsonb) is
  'Internal: writes the Order''s production alignment on behalf of a handoff decision or a version change, inside the production_alignment context, and records production_alignment_changed with the version and reason. Not callable by any client role.';

revoke execute on function public.order_operations_handoff_set_alignment(uuid, uuid, boolean, text, jsonb) from public, anon, authenticated;


-- ═══ 6. Recording the handoff, inside the approval's own transaction ═══════

create or replace function public.order_pi_versions_record_operations_handoff()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order        public.orders%rowtype;
  v_prior        public.order_operations_handoffs%rowtype;
  v_configured   uuid;
  v_reviewer     uuid;
  v_unassigned   text;
  v_handoff_id   uuid;
  v_now          timestamptz := now();
  v_approver     text;
  v_alignment    text;
begin
  -- Only the moment a version BECOMES the one in force.
  if new.status <> 'approved' then
    return null;
  end if;
  if tg_op = 'UPDATE' and old.status = 'approved' then
    return null;
  end if;
  -- Idempotent: one handoff per version, whatever path re-runs.
  if exists (select 1 from public.order_operations_handoffs h where h.pi_version_id = new.id) then
    return null;
  end if;

  select * into v_order from public.orders where id = new.order_id;
  if not found then
    return null;
  end if;
  v_alignment := v_order.production_alignment;

  -- WHO THE REVIEWER IS RIGHT NOW — read under a SHARE lock on the one
  -- settings row. set_order_operations_reviewer() takes the UPDATE lock on
  -- that same row before it changes anything, so the two serialize: either
  -- this approval reads the reviewer AFTER a Control Center change committed,
  -- or the change waits for this approval to commit and then readdresses the
  -- handoff written here. Nothing can be addressed to a reviewer who was
  -- replaced mid-approval. (Lock order everywhere: orders → reviewers →
  -- handoffs. The assignment RPC never locks orders; the decision RPC never
  -- locks reviewers.)
  select r.user_id into v_configured
    from public.order_operations_reviewers r
   where r.duty = 'pi_handoff'
     for share;

  -- ADDRESSED ONLY TO SOMEBODY WHO CAN OPEN THIS ORDER, as they are now:
  -- active, not deleted, with module entry and this Order's own visibility.
  -- Otherwise the handoff is recorded UNASSIGNED with the reason, and the
  -- administrators are told. Never an admin in the reviewer's place.
  if v_configured is null then
    v_reviewer := null;
    v_unassigned := 'no_reviewer';
  elsif not exists (
    select 1 from public.users u
    where u.id = v_configured and u.is_active and coalesce(u.is_deleted, false) = false
  ) then
    v_reviewer := null;
    v_unassigned := 'reviewer_inactive';
  elsif not public.operations_reviewer_can_open_order(v_configured, new.order_id) then
    v_reviewer := null;
    v_unassigned := 'reviewer_cannot_open_order';
  else
    v_reviewer := v_configured;
    v_unassigned := null;
  end if;

  -- The earlier version's handoff, whatever it decided, is now history. Its
  -- decision columns are untouched; only the supersession is stamped.
  update public.order_operations_handoffs
     set superseded_at = v_now,
         superseded_by_version_id = new.id
   where order_id = new.order_id
     and superseded_at is null
  returning * into v_prior;

  insert into public.order_operations_handoffs (
    order_id, pi_version_id, submission_id, version_number,
    approved_by, approved_at,
    assigned_to, assigned_at, unassigned_reason,
    production_alignment_at_approval, prior_handoff_status
  ) values (
    new.order_id, new.id, new.submission_id, new.version_number,
    new.decided_by, coalesce(new.decided_at, v_now),
    v_reviewer, case when v_reviewer is null then null else v_now end, v_unassigned,
    v_alignment, v_prior.status
  )
  returning id into v_handoff_id;

  insert into public.order_activity_log (order_id, actor_id, event_type, payload)
  values (new.order_id, new.decided_by, 'operations_handoff_recorded',
          jsonb_build_object(
            'handoff_id', v_handoff_id,
            'version_id', new.id,
            'version_number', new.version_number,
            'assigned_to', v_reviewer,
            'unassigned_reason', v_unassigned,
            'production_alignment', v_alignment,
            'superseded_handoff_id', v_prior.id,
            'superseded_handoff_status', v_prior.status,
            'superseded_version_number', v_prior.version_number));

  -- UNASSIGNED IS AN ADMINISTRATOR'S PROBLEM, and they are told at once —
  -- every active administrator, the approver included, because the fix
  -- (assign somebody in Control Center) is theirs and not the reviewer's.
  -- This is what keeps a handoff recorded before a reviewer is configured,
  -- or while the configured one cannot open the Order, from going unseen.
  if v_reviewer is null then
    insert into public.notifications (user_id, task_id, entity_id, type, title, body, is_push_sent)
    select u.id, null, new.order_id, 'order_operations_review_requested'::notification_type,
           format('Order %s: PI V%s approved, but no operations reviewer can take it. Assign one in Control Center.',
                  v_order.display_number, new.version_number),
           case v_unassigned
             when 'reviewer_inactive' then 'The configured operations reviewer is no longer an active account.'
             when 'reviewer_cannot_open_order' then 'The configured operations reviewer cannot open this Order. Choose an admin, a member of the operations team, or a holder of orders.view_all.'
             else 'No operations reviewer is configured. Control Center → Operations Handoff.'
           end,
           true
      from public.users u
     where u.role = 'admin' and u.is_active and coalesce(u.is_deleted, false) = false;
  end if;

  -- AN OLDER ALIGNMENT NEVER COVERS A NEWER VERSION. If the Order was aligned
  -- for production, that alignment was for the version just superseded (or,
  -- on a legacy Order, for whatever was current before tracking); the new
  -- version is unaccepted, so the Order goes back to not_aligned NOW, with the
  -- reset on its history saying what the alignment had covered. Nothing about
  -- the earlier alignment or acceptance is erased.
  if v_alignment = 'aligned' then
    perform public.order_operations_handoff_set_alignment(
      new.order_id, new.decided_by, false, null,
      jsonb_build_object('reason', 'pi_version_approved',
                         'version_id', new.id, 'version_number', new.version_number,
                         'covered_version_number', v_prior.version_number,
                         'covered_handoff_status', v_prior.status,
                         'handoff_id', v_handoff_id));
  end if;

  -- The reviewer hears about it — unless they are the approver, who was
  -- looking at the screen. The handoff itself is still recorded as awaiting:
  -- approving is not accepting, even for the same person.
  if v_reviewer is not null and v_reviewer is distinct from new.decided_by then
    select nullif(btrim(u.full_name), '') into v_approver from public.users u where u.id = new.decided_by;
    insert into public.notifications (user_id, task_id, entity_id, type, title, body, is_push_sent)
    values (
      v_reviewer, null, new.order_id, 'order_operations_review_requested'::notification_type,
      format('Order %s: PI V%s approved by %s. Awaiting your operations review.',
             v_order.display_number, new.version_number, coalesce(v_approver, 'an administrator')),
      case
        when v_prior.status = 'accepted' then
          format('You accepted PI V%s earlier. Open the Order, review what changed in V%s, then choose Accept for production or Cannot accept.',
                 v_prior.version_number, new.version_number)
        when v_alignment = 'aligned' then
          format('This Order was aligned for production before PI V%s; that alignment has been reset. Review PI V%s and choose Accept for production or Cannot accept.',
                 new.version_number, new.version_number)
        else
          format('Open the Order, review PI V%s, then choose Accept for production or Cannot accept.',
                 new.version_number)
      end,
      true
    );
  end if;

  return null;
end;
$$;

comment on function public.order_pi_versions_record_operations_handoff() is
  'AFTER trigger on order_pi_versions: when a version becomes approved, supersedes the Order''s live handoff (keeping its decision), records a new awaiting handoff for this version addressed to the assigned, active operations reviewer (or unassigned), resets a production alignment that covered the earlier version (recorded on the history), logs operations_handoff_recorded, and notifies the reviewer once. Idempotent per version.';

revoke execute on function public.order_pi_versions_record_operations_handoff() from public, anon, authenticated;

drop trigger if exists order_pi_versions_record_operations_handoff on public.order_pi_versions;
create trigger order_pi_versions_record_operations_handoff
  after insert or update of status on public.order_pi_versions
  for each row execute function public.order_pi_versions_record_operations_handoff();


-- ═══ 7. Assigning the reviewer (Control Center, administrators only) ═══════

create or replace function public.set_order_operations_reviewer(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor      uuid := public.assert_order_submission_actor();
  v_target     public.users%rowtype;
  v_previous   uuid;
  v_moved      integer := 0;
  v_unassigned integer := 0;
  v_h          record;
  v_now        timestamptz := now();
begin
  if not exists (
    select 1 from public.users u
    where u.id = v_actor and u.role = 'admin' and u.is_active and coalesce(u.is_deleted, false) = false
  ) then
    raise exception 'Only an administrator can assign the operations reviewer'
      using errcode = '42501';
  end if;

  if p_user_id is not null then
    select * into v_target from public.users where id = p_user_id;
    if not found then
      raise exception 'ORDER_OPERATIONS_REVIEWER_NOT_FOUND: that person has no user record'
        using errcode = 'P0002';
    end if;
    if not v_target.is_active or coalesce(v_target.is_deleted, false) then
      raise exception 'ORDER_OPERATIONS_REVIEWER_INACTIVE: the operations reviewer must be an active account'
        using errcode = 'P0001';
    end if;
    -- THE REVIEWER MUST BE ABLE TO OPEN EVERY ORDER routed to them. orders.view
    -- opens the module, not every row; the bar is an admin, the operations
    -- team, or orders.view_all (with module entry).
    if not public.operations_reviewer_covers_all_orders(p_user_id) then
      raise exception 'ORDER_OPERATIONS_REVIEWER_CANNOT_OPEN_ORDERS: the operations reviewer must be able to open every Order — an admin, a member of the operations team, or a holder of orders.view_all, with Orders access'
        using errcode = 'P0001';
    end if;
  end if;

  -- THE UPDATE LOCK on the one settings row, taken BEFORE anything else is
  -- read or written, is what serializes this change against a PI approval in
  -- flight: the approval trigger takes a SHARE lock on the same row to read
  -- the reviewer, so this statement waits for any approval mid-transaction
  -- to commit — and the loop below then sees the handoff it wrote.
  select user_id into v_previous
    from public.order_operations_reviewers
   where duty = 'pi_handoff'
     for update;

  insert into public.order_operations_reviewers (duty, user_id, assigned_by, assigned_at)
  values ('pi_handoff', p_user_id, v_actor, v_now)
  on conflict (duty) do update
    set user_id = excluded.user_id, assigned_by = excluded.assigned_by, assigned_at = excluded.assigned_at;

  -- EVERY LIVE, UNRESOLVED HANDOFF — awaiting or flagged — follows the
  -- assignment: readdressed to the new reviewer, or UNASSIGNED when the
  -- assignment is cleared, so the Order and the queues say so. Accepted
  -- handoffs keep the name of whoever accepted them, and a superseded one is
  -- history. A former reviewer can decide nothing from here on: the decision
  -- door checks assigned_to at the moment of the call. Handoffs the new
  -- reviewer cannot open (cannot happen under the bar above, checked anyway
  -- per Order) stay unassigned with that reason.
  for v_h in
    select h.id, h.order_id, h.version_number, h.status, h.assigned_to, h.unassigned_reason, o.display_number
      from public.order_operations_handoffs h
      join public.orders o on o.id = h.order_id
     where h.superseded_at is null
       and h.status <> 'accepted'
       and (h.assigned_to is distinct from p_user_id
            or (p_user_id is null and h.unassigned_reason is distinct from 'no_reviewer'))
       and o.status <> 'cancelled'
     order by h.created_at
       for update of h
  loop
    if p_user_id is not null and not public.operations_reviewer_can_open_order(p_user_id, v_h.order_id) then
      update public.order_operations_handoffs
         set assigned_to = null, assigned_at = null, unassigned_reason = 'reviewer_cannot_open_order'
       where id = v_h.id;
      insert into public.order_activity_log (order_id, actor_id, event_type, payload)
      values (v_h.order_id, v_actor, 'operations_reviewer_unassigned',
              jsonb_build_object('handoff_id', v_h.id, 'version_number', v_h.version_number,
                                 'handoff_status', v_h.status, 'unassigned_reason', 'reviewer_cannot_open_order',
                                 'assigned_to', null, 'previously_assigned_to', v_h.assigned_to));
      v_unassigned := v_unassigned + 1;
      continue;
    end if;

    update public.order_operations_handoffs
       set assigned_to = p_user_id,
           assigned_at = case when p_user_id is null then null else v_now end,
           unassigned_reason = case when p_user_id is null then 'no_reviewer' else null end
     where id = v_h.id;

    insert into public.order_activity_log (order_id, actor_id, event_type, payload)
    values (v_h.order_id, v_actor,
            case when p_user_id is null then 'operations_reviewer_unassigned' else 'operations_reviewer_assigned' end,
            jsonb_build_object('handoff_id', v_h.id, 'version_number', v_h.version_number,
                               'handoff_status', v_h.status,
                               'unassigned_reason', case when p_user_id is null then 'no_reviewer' end,
                               'assigned_to', p_user_id, 'previously_assigned_to', v_h.assigned_to));

    if p_user_id is null then
      v_unassigned := v_unassigned + 1;
    else
      if p_user_id is distinct from v_actor then
        insert into public.notifications (user_id, task_id, entity_id, type, title, body, is_push_sent)
        values (
          p_user_id, null, v_h.order_id, 'order_operations_review_requested'::notification_type,
          case when v_h.status = 'clarification_needed'
            then format('Order %s: PI V%s is flagged for clarification and now waits on you.', v_h.display_number, v_h.version_number)
            else format('Order %s: PI V%s is awaiting your operations review.', v_h.display_number, v_h.version_number)
          end,
          format('You have been assigned as the operations reviewer. Open the Order, review PI V%s, then choose Accept for production or Cannot accept.', v_h.version_number),
          true
        );
      end if;
      v_moved := v_moved + 1;
    end if;
  end loop;

  return jsonb_build_object(
    'user_id', p_user_id,
    'previous_user_id', v_previous,
    'reassigned_handoffs', v_moved,
    'unassigned_handoffs', v_unassigned);
end;
$$;

comment on function public.set_order_operations_reviewer(uuid) is
  'Control Center: an active administrator names the one operations reviewer (an active user who can open Orders), or clears the assignment with NULL. Every live, unresolved handoff (awaiting or flagged) is readdressed to the new reviewer — or unassigned when cleared — and logged on each Order; a new reviewer is notified once per Order. Accepted handoffs are untouched.';

revoke execute on function public.set_order_operations_reviewer(uuid) from public, anon;
grant  execute on function public.set_order_operations_reviewer(uuid) to authenticated;


-- ═══ 8. The reviewer's decision — the one operations decision ══════════════

create or replace function public.decide_order_operations_handoff(
  p_handoff_id uuid,
  p_decision   text,
  p_reason     text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor    uuid := public.assert_order_submission_actor();
  v_order_id uuid;
  v_order    public.orders%rowtype;
  v_h        public.order_operations_handoffs%rowtype;
  v_version  public.order_pi_versions%rowtype;
  v_reason   text := nullif(btrim(coalesce(p_reason, '')), '');
  v_now      timestamptz := now();
  v_name     text;
  v_event    text;
  v_withdraw boolean := false;
begin
  if p_decision is null or p_decision not in ('accepted', 'clarification_needed') then
    raise exception 'ORDER_OPERATIONS_HANDOFF_DECISION_UNKNOWN: the decision must be accepted or clarification_needed'
      using errcode = 'P0001';
  end if;
  if p_decision = 'clarification_needed' and v_reason is null then
    raise exception 'ORDER_OPERATIONS_HANDOFF_REASON_REQUIRED: say what needs clarifying before this version can be accepted'
      using errcode = 'P0001';
  end if;
  if v_reason is not null and char_length(v_reason) > 1000 then
    raise exception 'ORDER_OPERATIONS_HANDOFF_REASON_TOO_LONG: the reason may be at most 1000 characters (this one is %)',
      char_length(v_reason) using errcode = 'P0001';
  end if;

  -- LOCK ORDER: the Order first, then the handoff — the same order the
  -- approval path takes (order → versions → handoffs), so the two cannot
  -- deadlock.
  select order_id into v_order_id from public.order_operations_handoffs where id = p_handoff_id;
  if v_order_id is null then
    raise exception 'ORDER_OPERATIONS_HANDOFF_NOT_FOUND: that handoff no longer exists' using errcode = 'P0002';
  end if;
  select * into v_order from public.orders where id = v_order_id for update;
  select * into v_h from public.order_operations_handoffs where id = p_handoff_id for update;
  if not found then
    raise exception 'ORDER_OPERATIONS_HANDOFF_NOT_FOUND: that handoff no longer exists' using errcode = 'P0002';
  end if;

  -- ── Authority: the assigned reviewer, active, able to open this Order, and
  --    nobody in their place ──
  if v_h.assigned_to is null then
    raise exception 'ORDER_OPERATIONS_HANDOFF_UNASSIGNED: no operations reviewer is assigned; an administrator must assign one in Control Center'
      using errcode = 'P0001';
  end if;
  if v_h.assigned_to <> v_actor then
    raise exception 'Only the assigned operations reviewer can decide this handoff'
      using errcode = '42501';
  end if;
  if not public.can_view_order_as_actor(v_h.order_id) then
    raise exception 'You do not have access to this Order' using errcode = '42501';
  end if;

  -- ── State: live, about the version in force, on an open Order ──
  if v_order.status = 'cancelled' then
    raise exception 'ORDER_OPERATIONS_HANDOFF_CLOSED: Order % is cancelled', v_order.display_number
      using errcode = 'P0001';
  end if;
  if v_h.superseded_at is not null then
    raise exception 'ORDER_OPERATIONS_HANDOFF_SUPERSEDED: PI V% has been replaced by a later approved version; review the current one',
      v_h.version_number using errcode = 'P0001';
  end if;
  select * into v_version from public.order_pi_versions where id = v_h.pi_version_id;
  if not found or v_version.status <> 'approved'
     or exists (select 1 from public.order_pi_versions v
                 where v.order_id = v_h.order_id and v.status = 'approved' and v.id <> v_h.pi_version_id) then
    raise exception 'ORDER_OPERATIONS_HANDOFF_STALE: PI V% is no longer the approved version of Order %',
      v_h.version_number, v_order.display_number using errcode = 'P0001';
  end if;
  if v_h.status = 'accepted' and p_decision = 'accepted' then
    raise exception 'ORDER_OPERATIONS_HANDOFF_ALREADY_ACCEPTED: PI V% was already accepted for production', v_h.version_number
      using errcode = 'P0001';
  end if;
  if v_h.status = 'clarification_needed' and p_decision = 'clarification_needed' then
    raise exception 'ORDER_OPERATIONS_HANDOFF_ALREADY_FLAGGED: PI V% is already flagged for clarification', v_h.version_number
      using errcode = 'P0001';
  end if;

  -- ── The decision ──
  if p_decision = 'accepted' then
    -- From awaiting, or from clarification_needed once the question is
    -- settled (including after a withdrawal: the new acceptance replaces the
    -- withdrawn one, and both are on the history as events).
    update public.order_operations_handoffs
       set status = 'accepted',
           accepted_by = v_actor, accepted_at = v_now, accepted_note = v_reason,
           acceptance_withdrawn_by = null, acceptance_withdrawn_at = null, acceptance_withdrawn_reason = null
     where id = v_h.id;
    v_event := 'operations_handoff_accepted';
    insert into public.order_activity_log (order_id, actor_id, event_type, payload)
    values (v_h.order_id, v_actor, v_event,
            jsonb_build_object('handoff_id', v_h.id, 'version_id', v_h.pi_version_id,
                               'version_number', v_h.version_number, 'note', v_reason,
                               'after_clarification', v_h.status = 'clarification_needed',
                               'after_withdrawal', v_h.acceptance_withdrawn_at is not null));
    -- ACCEPTING ALIGNS. The Order is in production against THIS version, by
    -- this reviewer, from now.
    perform public.order_operations_handoff_set_alignment(
      v_h.order_id, v_actor, true, v_reason,
      jsonb_build_object('reason', 'operations_handoff_accepted', 'handoff_id', v_h.id,
                         'version_id', v_h.pi_version_id, 'version_number', v_h.version_number));
  else
    v_withdraw := v_h.status = 'accepted';
    if v_withdraw then
      -- WITHDRAWING an acceptance: the acceptance stays on the row as what
      -- happened; the withdrawal says who took it back and why.
      update public.order_operations_handoffs
         set status = 'clarification_needed',
             acceptance_withdrawn_by = v_actor, acceptance_withdrawn_at = v_now, acceptance_withdrawn_reason = v_reason,
             clarification_by = v_actor, clarification_at = v_now, clarification_reason = v_reason
       where id = v_h.id;
      v_event := 'operations_handoff_acceptance_withdrawn';
    else
      update public.order_operations_handoffs
         set status = 'clarification_needed', clarification_by = v_actor,
             clarification_at = v_now, clarification_reason = v_reason
       where id = v_h.id;
      v_event := 'operations_handoff_clarification_needed';
    end if;
    insert into public.order_activity_log (order_id, actor_id, event_type, payload)
    values (v_h.order_id, v_actor, v_event,
            jsonb_build_object('handoff_id', v_h.id, 'version_id', v_h.pi_version_id,
                               'version_number', v_h.version_number, 'reason', v_reason,
                               'previously_accepted_at', case when v_withdraw then v_h.accepted_at end));
    -- A FLAGGED OR WITHDRAWN VERSION IS NOT ONE THE ORDER IS ALIGNED AGAINST.
    perform public.order_operations_handoff_set_alignment(
      v_h.order_id, v_actor, false, v_reason,
      jsonb_build_object('reason', v_event, 'handoff_id', v_h.id,
                         'version_id', v_h.pi_version_id, 'version_number', v_h.version_number));
  end if;

  -- The approver hears the outcome, unless they decided it themselves.
  if v_h.approved_by is not null and v_h.approved_by is distinct from v_actor then
    select nullif(btrim(u.full_name), '') into v_name from public.users u where u.id = v_actor;
    insert into public.notifications (user_id, task_id, entity_id, type, title, body, is_push_sent)
    values (
      v_h.approved_by, null, v_h.order_id, 'order_operations_review_decided'::notification_type,
      case
        when p_decision = 'accepted' then
          format('Order %s: %s accepted PI V%s for production.', v_order.display_number, coalesce(v_name, 'The operations reviewer'), v_h.version_number)
        when v_withdraw then
          format('Order %s: %s withdrew the acceptance of PI V%s. Clarification needed.', v_order.display_number, coalesce(v_name, 'The operations reviewer'), v_h.version_number)
        else
          format('Order %s: %s cannot accept PI V%s. Clarification needed.', v_order.display_number, coalesce(v_name, 'The operations reviewer'), v_h.version_number)
      end,
      v_reason,
      true
    );
  end if;

  return jsonb_build_object(
    'handoff_id', v_h.id, 'order_id', v_h.order_id, 'version_id', v_h.pi_version_id,
    'version_number', v_h.version_number, 'status', p_decision,
    'production_alignment', case when p_decision = 'accepted' then 'aligned' else 'not_aligned' end,
    'withdrawn', v_withdraw);
end;
$$;

comment on function public.decide_order_operations_handoff(uuid, text, text) is
  'The assigned operations reviewer accepts a PI version for production — which ALIGNS the Order — or flags it as needing clarification (reason required, at most 1000 characters), which takes the alignment back; on an accepted version, a flag is a withdrawal that keeps the acceptance on record. Re-checks under row locks: caller is the assigned, active reviewer who can open the Order; the handoff is live and about the Order''s current approved version; the Order is not cancelled. Writes the decision, the Order history events, and one notification to the approver. Acceptance means operations has reviewed and can work from this version, not that manufacturing work is done.';

revoke execute on function public.decide_order_operations_handoff(uuid, text, text) from public, anon;
grant  execute on function public.decide_order_operations_handoff(uuid, text, text) to authenticated;


-- ═══ 9. set_order_production_alignment(), re-emitted: the SAME door ════════
--
-- RE-EMITTED IN FULL from 20261119000000 §8. It differs in exactly one place:
-- an Order that carries a live handoff routes BOTH directions through
-- decide_order_operations_handoff(), so the assigned reviewer is the only
-- person who can align it (accept) or take the alignment back (withdraw /
-- flag, reason required) — whatever permission or role the caller holds. An
-- Order with NO handoff (approved before 20261229000000, never revised since)
-- keeps the previous rule, word for word.

create or replace function public.set_order_production_alignment(
  p_order_id uuid,
  p_aligned  boolean,
  p_note     text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor  uuid := public.assert_order_submission_actor();
  v_order  public.orders%rowtype;
  v_target text := case when coalesce(p_aligned, false) then 'aligned' else 'not_aligned' end;
  v_note   text := nullif(btrim(coalesce(p_note, '')), '');
  v_now    timestamptz := now();
  v_live   uuid;
begin
  -- ── An Order with a handoff has ONE operations decision, and this is it ──
  select h.id into v_live
    from public.order_operations_handoffs h
   where h.order_id = p_order_id and h.superseded_at is null;
  if v_live is not null then
    return public.decide_order_operations_handoff(
      v_live,
      case when coalesce(p_aligned, false) then 'accepted' else 'clarification_needed' end,
      v_note);
  end if;

  -- ── A legacy Order: the rule of 20261119000000, unchanged ──
  if not public.actor_has_module_permission('orders', 'align_production') then
    raise exception 'You do not have permission to align an Order for production'
      using errcode = '42501';
  end if;

  if v_note is not null and char_length(v_note) > 500 then
    raise exception
      'ORDER_PRODUCTION_ALIGNMENT_NOTE_TOO_LONG: the note may be at most 500 characters (this one is %)',
      char_length(v_note)
      using errcode = 'P0001';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'ORDER_NOT_FOUND: That Order no longer exists' using errcode = 'P0002';
  end if;

  if v_order.status = 'cancelled' then
    raise exception
      'ORDER_PRODUCTION_ALIGNMENT_CLOSED: Order % is cancelled', v_order.display_number
      using errcode = 'P0001';
  end if;

  if v_order.production_alignment = v_target then
    return jsonb_build_object(
      'order_id', v_order.id, 'production_alignment', v_target, 'unchanged', true);
  end if;

  perform set_config('boe.production_alignment_context', 'production_alignment', true);
  update public.orders
     set production_alignment      = v_target,
         production_aligned_by     = case when v_target = 'aligned' then v_actor else null end,
         production_aligned_at     = case when v_target = 'aligned' then v_now else null end,
         production_alignment_note = v_note,
         updated_at                = v_now
   where id = p_order_id;
  perform set_config('boe.production_alignment_context', '', true);

  insert into public.order_activity_log (order_id, actor_id, event_type, payload)
  values (p_order_id, v_actor, 'production_alignment_changed',
          jsonb_build_object('from', v_order.production_alignment, 'to', v_target, 'note', v_note,
                             'legacy_order', true));

  return jsonb_build_object(
    'order_id', v_order.id, 'production_alignment', v_target, 'unchanged', false);
end;
$$;

comment on function public.set_order_production_alignment(uuid, boolean, text) is
  'Aligns a Confirmed Order for production, or takes the alignment back. On an Order that carries an operations handoff (20261229000000) this IS the handoff decision: aligning accepts the version in force and un-aligning flags it (reason required), and only the assigned operations reviewer may do either. On a legacy Order with no handoff, the rule of 20261119000000 applies unchanged: orders.align_production (or an active admin), optional note of at most 500 characters, cancelled Orders refused, idempotent.';

revoke execute on function public.set_order_production_alignment(uuid, boolean, text) from public, anon;
grant  execute on function public.set_order_production_alignment(uuid, boolean, text) to authenticated;


-- ═══ 10. Apply-time assertions ═════════════════════════════════════════════

do $$
begin
  if not exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'order_operations_handoffs') then
    raise exception 'ASSERT: order_operations_handoffs missing';
  end if;
  if not exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'order_operations_reviewers') then
    raise exception 'ASSERT: order_operations_reviewers missing';
  end if;
  if not exists (
    select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
    where c.relname = 'order_pi_versions' and t.tgname = 'order_pi_versions_record_operations_handoff' and not t.tgisinternal
  ) then
    raise exception 'ASSERT: the handoff trigger is not attached to order_pi_versions';
  end if;
  if not exists (
    select 1 from pg_indexes where schemaname = 'public'
      and indexname = 'order_operations_handoffs_one_live_per_order'
  ) then
    raise exception 'ASSERT: one-live-handoff-per-order index missing';
  end if;
  if has_table_privilege('anon', 'public.order_operations_handoffs', 'SELECT')
     or has_table_privilege('authenticated', 'public.order_operations_handoffs', 'INSERT')
     or has_table_privilege('authenticated', 'public.order_operations_handoffs', 'UPDATE')
     or has_table_privilege('authenticated', 'public.order_operations_handoffs', 'DELETE') then
    raise exception 'ASSERT: order_operations_handoffs client privileges are wrong';
  end if;
  if has_table_privilege('authenticated', 'public.order_operations_reviewers', 'INSERT')
     or has_table_privilege('authenticated', 'public.order_operations_reviewers', 'UPDATE') then
    raise exception 'ASSERT: order_operations_reviewers must be written only through set_order_operations_reviewer()';
  end if;
  if has_function_privilege('anon', 'public.decide_order_operations_handoff(uuid, text, text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.set_order_operations_reviewer(uuid)', 'EXECUTE')
     or has_function_privilege('anon', 'public.set_order_production_alignment(uuid, boolean, text)', 'EXECUTE') then
    raise exception 'ASSERT: anon must not execute the handoff or alignment RPCs';
  end if;
  if not has_function_privilege('authenticated', 'public.decide_order_operations_handoff(uuid, text, text)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.set_order_production_alignment(uuid, boolean, text)', 'EXECUTE') then
    raise exception 'ASSERT: authenticated must execute the decision door and the alignment door';
  end if;
  if has_function_privilege('authenticated', 'public.order_pi_versions_record_operations_handoff()', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.order_operations_handoffs_guard()', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.order_operations_handoff_set_alignment(uuid, uuid, boolean, text, jsonb)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.operations_reviewer_can_open_order(uuid, uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.operations_reviewer_covers_all_orders(uuid)', 'EXECUTE') then
    raise exception 'ASSERT: internal functions must not be executable by clients';
  end if;
  -- The one settings row the approval trigger and the assignment RPC lock.
  if (select count(*) from public.order_operations_reviewers where duty = 'pi_handoff') <> 1 then
    raise exception 'ASSERT: the pi_handoff settings row must exist exactly once';
  end if;
  -- The alignment door now names the handoff door: the two cannot diverge.
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'set_order_production_alignment'
      and p.prosrc like '%public.decide_order_operations_handoff(%'
  ) then
    raise exception 'ASSERT: set_order_production_alignment must route a handoff Order through decide_order_operations_handoff';
  end if;
end $$;
