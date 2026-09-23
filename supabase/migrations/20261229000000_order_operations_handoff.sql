-- ═══════════════════════════════════════════════════════════════════════════
-- THE PI-TO-OPERATIONS HANDOFF, PER APPROVED PI VERSION (Phase 1)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT THIS IS FOR
-- ----------------
-- Commercial approval is one person's decision; running the Order is another
-- person's. Today the second person finds out by word of mouth. From this
-- migration on, EVERY time a PI version becomes the one in force — V1 when a
-- submitted PI becomes a Confirmed Order, V2+ when a revised workbook is
-- approved — a handoff row is recorded for THAT version, the assigned
-- operations reviewer is notified in-app, and the Order shows, in words,
-- whether that exact version is awaiting review, accepted for production, or
-- flagged for clarification.
--
-- WHAT IT IS NOT
-- --------------
-- * Not a claim that manufacturing work is done. Acceptance means "operations
--   has reviewed this version and can work from it", nothing more.
-- * Not production alignment. orders.production_alignment and
--   set_order_production_alignment() are untouched: alignment is the Head of
--   Manufacturing's statement about feasibility; the handoff is the reviewer's
--   statement about the document. The page states both and relates them.
-- * Not a notification matrix. Two types: one to the reviewer when a version
--   is approved, one to the approver when the reviewer decides.
-- * Not a backfill. No Order approved before this migration gets a handoff
--   row; the page says "not recorded" for them. Inventing acceptances nobody
--   made would be a false record.
--
-- WHO THE REVIEWER IS
-- -------------------
-- ONE assignment, made by an administrator in Control Center, held in
-- order_operations_reviewers as a user id — never a display name, never a
-- guessed id in this file. The trigger resolves it at the moment of approval
-- and requires the person to be active and not deleted; otherwise the handoff
-- is recorded UNASSIGNED and stays visibly so until an administrator assigns
-- someone (which assigns every live unassigned handoff at once). Being an
-- administrator does not make somebody the reviewer, and an administrator is
-- not substituted when the reviewer is missing.
--
-- HOW IT IS TRANSACTIONAL AND IDEMPOTENT
-- --------------------------------------
-- An AFTER trigger on order_pi_versions fires when a row's status BECOMES
-- 'approved' — the one write both approval paths already make, inside their
-- own transaction (approve_order_submission §14b; approve_order_pi_revision).
-- Neither function is re-emitted. The handoff table is UNIQUE on the version
-- id, and the trigger returns early if a handoff for that version exists, so a
-- retried approval (both functions are themselves idempotent) cannot record a
-- second handoff or a second notification.
--
-- AUTHORITY, AT THE DATABASE
-- --------------------------
-- decide_order_operations_handoff() re-checks under row locks that the caller
-- IS the assigned reviewer (not merely an admin), that the handoff is live and
-- undecided, that its version is still the Order's approved one, and that the
-- Order is not cancelled. Clients hold SELECT only on both tables.
-- ═══════════════════════════════════════════════════════════════════════════


-- ═══ 1. Notification types ═════════════════════════════════════════════════
--
-- Named only inside function bodies below (never executed in this file), so
-- Postgres does not need them committed mid-transaction.

alter type notification_type add value if not exists 'order_operations_review_requested';
alter type notification_type add value if not exists 'order_operations_review_decided';


-- ═══ 2. The reviewer assignment ════════════════════════════════════════════
--
-- One row per duty; Phase 1 has one duty. user_id NULL means "nobody is
-- assigned" and is a legitimate, visible state — not an error and not a
-- fallback to an admin.

create table if not exists public.order_operations_reviewers (
  duty        text primary key check (duty = 'pi_handoff'),
  user_id     uuid references public.users(id) on delete set null,
  assigned_by uuid references public.users(id) on delete set null,
  assigned_at timestamptz not null default now()
);

comment on table public.order_operations_reviewers is
  'The one operations reviewer a PI-to-operations handoff is addressed to, chosen by an administrator in Control Center. Written only by set_order_operations_reviewer(). A NULL user_id means no reviewer is assigned, and new handoffs are recorded unassigned until one is.';

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
  -- The reviewer this handoff is addressed to. NULL = unassigned, visibly.
  assigned_to                      uuid references public.users(id) on delete set null,
  assigned_at                      timestamptz,
  -- What production alignment said when this version was approved. Later
  -- versions on an aligned Order are exactly the case that needs a warning.
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
    check ((assigned_to is null) = (assigned_at is null)),
  constraint order_operations_handoffs_acceptance_complete
    check (
      (status = 'accepted' and accepted_by is not null and accepted_at is not null)
      or (status <> 'accepted' and accepted_by is null and accepted_at is null and accepted_note is null)
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
    )
);

comment on table public.order_operations_handoffs is
  'One row per PI version that became the version in force on a Confirmed Order (V1 at approval, V2+ at revision approval). Records who approved it, who must review it for operations, and that reviewer''s decision. Written only by the order_pi_versions trigger and the two RPCs; clients read. Superseded rows are kept as the audit of earlier versions. Orders approved before this table existed have no row, and are shown as "not recorded".';

-- Exactly one LIVE handoff per Order: the one for the version in force.
create unique index if not exists order_operations_handoffs_one_live_per_order
  on public.order_operations_handoffs (order_id) where superseded_at is null;
create index if not exists order_operations_handoffs_order_idx
  on public.order_operations_handoffs (order_id, version_number desc);
create index if not exists order_operations_handoffs_awaiting_idx
  on public.order_operations_handoffs (assigned_to)
  where status = 'awaiting' and superseded_at is null;


-- ═══ 4. The guard: identity frozen, acceptance permanent, no client writes ══

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
    if old.status = 'accepted' and new.status <> 'accepted' then
      raise exception
        'ORDER_OPERATIONS_HANDOFF_ACCEPTED_IS_PERMANENT: an acceptance is not taken back; a later PI version records a new handoff'
        using errcode = 'P0001';
    end if;
    if old.status = 'accepted' and (
         new.accepted_by is distinct from old.accepted_by
         or new.accepted_at is distinct from old.accepted_at
         or new.accepted_note is distinct from old.accepted_note) then
      raise exception
        'ORDER_OPERATIONS_HANDOFF_ACCEPTED_IS_PERMANENT: who accepted, when and with what note cannot be rewritten'
        using errcode = 'P0001';
    end if;
    if old.superseded_at is not null and (
         new.superseded_at is distinct from old.superseded_at
         or new.superseded_by_version_id is distinct from old.superseded_by_version_id
         or new.status is distinct from old.status) then
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


-- ═══ 5. Recording the handoff, inside the approval's own transaction ═══════

create or replace function public.order_pi_versions_record_operations_handoff()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order        public.orders%rowtype;
  v_prior        public.order_operations_handoffs%rowtype;
  v_reviewer     uuid;
  v_handoff_id   uuid;
  v_now          timestamptz := now();
  v_approver     text;
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

  -- The assigned reviewer, resolved NOW through their user record. Inactive or
  -- deleted means unassigned — never an admin in their place.
  select r.user_id into v_reviewer
    from public.order_operations_reviewers r
    join public.users u on u.id = r.user_id
   where r.duty = 'pi_handoff'
     and u.is_active
     and coalesce(u.is_deleted, false) = false;

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
    assigned_to, assigned_at,
    production_alignment_at_approval, prior_handoff_status
  ) values (
    new.order_id, new.id, new.submission_id, new.version_number,
    new.decided_by, coalesce(new.decided_at, v_now),
    v_reviewer, case when v_reviewer is null then null else v_now end,
    v_order.production_alignment, v_prior.status
  )
  returning id into v_handoff_id;

  insert into public.order_activity_log (order_id, actor_id, event_type, payload)
  values (new.order_id, new.decided_by, 'operations_handoff_recorded',
          jsonb_build_object(
            'handoff_id', v_handoff_id,
            'version_id', new.id,
            'version_number', new.version_number,
            'assigned_to', v_reviewer,
            'production_alignment', v_order.production_alignment,
            'superseded_handoff_id', v_prior.id,
            'superseded_handoff_status', v_prior.status,
            'superseded_version_number', v_prior.version_number));

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
        when v_order.production_alignment = 'aligned' then
          format('This Order is already aligned for production. Review PI V%s and choose Accept for production or Cannot accept.',
                 new.version_number)
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
  'AFTER trigger on order_pi_versions: when a version becomes approved, supersedes the Order''s live handoff (keeping its decision), records a new awaiting handoff for this version addressed to the assigned, active operations reviewer (or unassigned), logs operations_handoff_recorded on the Order, and notifies the reviewer once. Idempotent per version.';

revoke execute on function public.order_pi_versions_record_operations_handoff() from public, anon, authenticated;

drop trigger if exists order_pi_versions_record_operations_handoff on public.order_pi_versions;
create trigger order_pi_versions_record_operations_handoff
  after insert or update of status on public.order_pi_versions
  for each row execute function public.order_pi_versions_record_operations_handoff();


-- ═══ 6. Assigning the reviewer (Control Center, administrators only) ═══════

create or replace function public.set_order_operations_reviewer(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor    uuid := public.assert_order_submission_actor();
  v_target   public.users%rowtype;
  v_previous uuid;
  v_moved    integer := 0;
  v_h        record;
  v_now      timestamptz := now();
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
    if not (v_target.role = 'admin' or public.resolve_permission(p_user_id, 'orders', 'view')) then
      raise exception 'ORDER_OPERATIONS_REVIEWER_CANNOT_OPEN_ORDERS: the operations reviewer must be able to open Orders'
        using errcode = 'P0001';
    end if;
  end if;

  select user_id into v_previous from public.order_operations_reviewers where duty = 'pi_handoff';

  insert into public.order_operations_reviewers (duty, user_id, assigned_by, assigned_at)
  values ('pi_handoff', p_user_id, v_actor, v_now)
  on conflict (duty) do update
    set user_id = excluded.user_id, assigned_by = excluded.assigned_by, assigned_at = excluded.assigned_at;

  -- Every LIVE, UNDECIDED handoff is readdressed to the new reviewer — the
  -- unassigned ones, and the ones the previous reviewer never decided. Decided
  -- handoffs keep the name of whoever decided them.
  if p_user_id is not null then
    for v_h in
      select h.id, h.order_id, h.version_number, h.assigned_to, o.display_number
        from public.order_operations_handoffs h
        join public.orders o on o.id = h.order_id
       where h.superseded_at is null
         and h.status = 'awaiting'
         and h.assigned_to is distinct from p_user_id
         and o.status <> 'cancelled'
       order by h.created_at
         for update of h
    loop
      update public.order_operations_handoffs
         set assigned_to = p_user_id, assigned_at = v_now
       where id = v_h.id;

      insert into public.order_activity_log (order_id, actor_id, event_type, payload)
      values (v_h.order_id, v_actor, 'operations_reviewer_assigned',
              jsonb_build_object('handoff_id', v_h.id, 'version_number', v_h.version_number,
                                 'assigned_to', p_user_id, 'previously_assigned_to', v_h.assigned_to));

      if p_user_id is distinct from v_actor then
        insert into public.notifications (user_id, task_id, entity_id, type, title, body, is_push_sent)
        values (
          p_user_id, null, v_h.order_id, 'order_operations_review_requested'::notification_type,
          format('Order %s: PI V%s is awaiting your operations review.', v_h.display_number, v_h.version_number),
          format('You have been assigned as the operations reviewer. Open the Order, review PI V%s, then choose Accept for production or Cannot accept.', v_h.version_number),
          true
        );
      end if;
      v_moved := v_moved + 1;
    end loop;
  end if;

  return jsonb_build_object(
    'user_id', p_user_id,
    'previous_user_id', v_previous,
    'reassigned_handoffs', v_moved);
end;
$$;

comment on function public.set_order_operations_reviewer(uuid) is
  'Control Center: an active administrator names the one operations reviewer (an active user who can open Orders), or clears the assignment with NULL. Every live, undecided handoff is readdressed to the new reviewer, logged on each Order, and the reviewer is notified once per Order. Decided handoffs are untouched.';

revoke execute on function public.set_order_operations_reviewer(uuid) from public, anon;
grant  execute on function public.set_order_operations_reviewer(uuid) to authenticated;


-- ═══ 7. The reviewer's decision ════════════════════════════════════════════

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

  -- The reviewer must be able to open Orders at all; an admin passes, anyone
  -- else through the permission engine.
  if not public.actor_has_module_permission('orders', 'view') then
    raise exception 'You do not have access to Orders' using errcode = '42501';
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

  -- ── Authority: the assigned reviewer, and nobody in their place ──
  if v_h.assigned_to is null then
    raise exception 'ORDER_OPERATIONS_HANDOFF_UNASSIGNED: no operations reviewer is assigned; an administrator must assign one in Control Center'
      using errcode = 'P0001';
  end if;
  if v_h.assigned_to <> v_actor then
    raise exception 'Only the assigned operations reviewer can decide this handoff'
      using errcode = '42501';
  end if;

  -- ── State: live, undecided, and about the version in force ──
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
  if v_h.status = 'accepted' then
    raise exception 'ORDER_OPERATIONS_HANDOFF_ALREADY_ACCEPTED: PI V% was already accepted for production', v_h.version_number
      using errcode = 'P0001';
  end if;
  if v_h.status = 'clarification_needed' and p_decision = 'clarification_needed' then
    raise exception 'ORDER_OPERATIONS_HANDOFF_ALREADY_FLAGGED: PI V% is already flagged for clarification', v_h.version_number
      using errcode = 'P0001';
  end if;

  -- ── The decision ──
  if p_decision = 'accepted' then
    update public.order_operations_handoffs
       set status = 'accepted', accepted_by = v_actor, accepted_at = v_now, accepted_note = v_reason
     where id = v_h.id;
    insert into public.order_activity_log (order_id, actor_id, event_type, payload)
    values (v_h.order_id, v_actor, 'operations_handoff_accepted',
            jsonb_build_object('handoff_id', v_h.id, 'version_id', v_h.pi_version_id,
                               'version_number', v_h.version_number, 'note', v_reason,
                               'after_clarification', v_h.status = 'clarification_needed',
                               'production_alignment', v_order.production_alignment));
  else
    update public.order_operations_handoffs
       set status = 'clarification_needed', clarification_by = v_actor,
           clarification_at = v_now, clarification_reason = v_reason
     where id = v_h.id;
    insert into public.order_activity_log (order_id, actor_id, event_type, payload)
    values (v_h.order_id, v_actor, 'operations_handoff_clarification_needed',
            jsonb_build_object('handoff_id', v_h.id, 'version_id', v_h.pi_version_id,
                               'version_number', v_h.version_number, 'reason', v_reason,
                               'production_alignment', v_order.production_alignment));
  end if;

  -- The approver hears the outcome, unless they decided it themselves.
  if v_h.approved_by is not null and v_h.approved_by is distinct from v_actor then
    select nullif(btrim(u.full_name), '') into v_name from public.users u where u.id = v_actor;
    insert into public.notifications (user_id, task_id, entity_id, type, title, body, is_push_sent)
    values (
      v_h.approved_by, null, v_h.order_id, 'order_operations_review_decided'::notification_type,
      case when p_decision = 'accepted'
        then format('Order %s: %s accepted PI V%s for production.', v_order.display_number, coalesce(v_name, 'The operations reviewer'), v_h.version_number)
        else format('Order %s: %s cannot accept PI V%s. Clarification needed.', v_order.display_number, coalesce(v_name, 'The operations reviewer'), v_h.version_number)
      end,
      v_reason,
      true
    );
  end if;

  return jsonb_build_object(
    'handoff_id', v_h.id, 'order_id', v_h.order_id, 'version_id', v_h.pi_version_id,
    'version_number', v_h.version_number, 'status', p_decision);
end;
$$;

comment on function public.decide_order_operations_handoff(uuid, text, text) is
  'The assigned operations reviewer accepts a PI version for production, or flags it as needing clarification (reason required, at most 1000 characters). Re-checks under row locks: caller is the assigned active reviewer with Orders access; the handoff is live, undecided (or flagged, moving to accepted) and about the Order''s current approved version; the Order is not cancelled. Writes the decision, one Order history event, and one notification to the approver. Acceptance means operations has reviewed and can work from this version — not that manufacturing work is done.';

revoke execute on function public.decide_order_operations_handoff(uuid, text, text) from public, anon;
grant  execute on function public.decide_order_operations_handoff(uuid, text, text) to authenticated;


-- ═══ 8. Apply-time assertions ══════════════════════════════════════════════

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
     or has_function_privilege('anon', 'public.set_order_operations_reviewer(uuid)', 'EXECUTE') then
    raise exception 'ASSERT: anon must not execute the handoff RPCs';
  end if;
  if not has_function_privilege('authenticated', 'public.decide_order_operations_handoff(uuid, text, text)', 'EXECUTE') then
    raise exception 'ASSERT: authenticated must execute decide_order_operations_handoff';
  end if;
  if has_function_privilege('authenticated', 'public.order_pi_versions_record_operations_handoff()', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.order_operations_handoffs_guard()', 'EXECUTE') then
    raise exception 'ASSERT: trigger functions must not be executable by clients';
  end if;
end $$;
