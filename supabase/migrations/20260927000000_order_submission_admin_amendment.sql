-- ═══════════════════════════════════════════════════════════════════════════
-- ADMIN AMENDMENT OF A PI, AT ANY STAGE — starting with the billing percentage
--
-- WHY THIS EXISTS
-- ---------------
-- Manual testing found that Set/Edit on Billing percentage fails on a confirmed
-- Order's PI, for an ACTIVE ADMIN, with:
--
--   ORDER_SUBMISSION_BILLING_NOT_EDITABLE: this PI cannot be changed by you in
--   its current state
--
-- That is not a bug in the RPC. It is can_edit_order_submission() (20260908000000)
-- answering exactly what it was written to answer:
--
--   status in ('draft','needs_changes')   AND
--   order_id is null                      AND
--   (owner OR active admin)
--
-- The actor test is ANDed AFTER the two state tests, so the admin branch is
-- UNREACHABLE the moment a PI is submitted or acquires an Order. An admin was
-- never able to correct a submitted PI; the rule simply had not been exercised
-- against one until now.
--
-- The business rule has since been revised: an active admin may correct PI
-- business information at any stage, including after the confirmed Order
-- exists. This migration implements that for the billing percentage.
--
-- ── WHAT THIS DELIBERATELY DOES NOT DO ─────────────────────────────────────
--
-- IT DOES NOT WIDEN can_edit_order_submission(). That predicate gates many
-- other write paths — items, images, files, submission itself. Widening it
-- would hand an admin the ability to mutate a submitted PI through every one of
-- those paths at once, with no reason recorded, no concurrency protection and
-- no activity trail. The new authority is therefore a SEPARATE predicate, and
-- each write path adopts it deliberately, one at a time.
--
-- IT DOES NOT TOUCH approve_order_submission(). billingContinuity.test.ts
-- proves that function is byte-identical to its previous definition minus two
-- lines, and nothing here needs it changed.
--
-- IT DOES NOT MUTATE A GENERATED DOCUMENT. Files already written stay exactly
-- as they are. What changes is the REGISTER's opinion of whether they are
-- current — see §4.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. The admin authority, as its own predicate ─────────────────────────────
--
-- SECURITY DEFINER so it can read public.users regardless of the caller's own
-- row visibility, with a fixed search_path so the tables it names cannot be
-- shadowed. It answers ONLY "is the caller an active admin" — it says nothing
-- about the PI's state, because that is the whole point of the new rule.
--
-- `is_active` and `is_deleted` are both required, matching every other admin
-- test in this schema. A deactivated admin is not an admin.

create or replace function public.can_admin_edit_order_submission(p_submission_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from public.order_submissions s where s.id = p_submission_id)
     and exists (
       select 1 from public.users u
       where u.id = auth.uid()
         and u.role = 'admin'
         and u.is_active
         and coalesce(u.is_deleted, false) = false
     );
$$;

comment on function public.can_admin_edit_order_submission(uuid) is
  'True when the caller is an ACTIVE ADMIN and the submission exists — at ANY stage, including submitted, approved, and after the confirmed Order exists. Deliberately separate from can_edit_order_submission, which remains the owner rule (draft/needs_changes, no Order). Holding orders.approve_order, finance verification, or review access does NOT satisfy this.';

revoke execute on function public.can_admin_edit_order_submission(uuid) from public, anon;
grant  execute on function public.can_admin_edit_order_submission(uuid) to authenticated;


-- ── 2. Recording that documents are no longer current ────────────────────────
--
-- The register has four statuses — pending, claimed, ready, failed — and no way
-- to say "this ready version is stale". Rather than invent a fifth status (which
-- would mean revisiting every CHECK, index and view that reasons about the four),
-- a ready row gains two nullable columns. A ready row with superseded_at set is
-- ready-but-outdated: its files still exist, still download, and still belong to
-- the version that produced them.
--
-- THAT PRESERVES HISTORY, which is the requirement. Nothing is deleted, no file
-- is rewritten, and the previous version stays exactly as generated.

alter table public.order_document_versions
  add column if not exists superseded_at     timestamptz,
  add column if not exists superseded_reason text;

comment on column public.order_document_versions.superseded_at is
  'When a READY version stopped being current, because the PI data behind it changed. The files are untouched and still downloadable; regeneration produces the next version. NULL means current.';
comment on column public.order_document_versions.superseded_reason is
  'A short, prewritten phrase naming what changed. Never free text from a user, never a value, never a name.';

-- Only a READY version can be superseded: a pending or claimed one has produced
-- nothing to be stale, and a failed one is already not current.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'order_document_versions_superseded_only_ready'
  ) then
    alter table public.order_document_versions
      add constraint order_document_versions_superseded_only_ready
      check (superseded_at is null or status = 'ready');
  end if;
end $$;

-- The two new columns are READABLE by clients — the card must be able to say
-- "regenerate" — and writable by none. Only the function below sets them.
grant select (superseded_at, superseded_reason) on public.order_document_versions to authenticated;

/**
 * Mark an Order's current READY documents as no longer current.
 *
 * Idempotent: a version already superseded keeps its ORIGINAL timestamp and
 * reason, because the first thing that invalidated it is the true answer and a
 * second edit must not overwrite that history.
 *
 * Returns how many versions this call actually superseded, so a caller can
 * report the impact rather than guess at it.
 */
create or replace function public.supersede_order_documents(
  p_order_id uuid,
  p_reason   text
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer := 0;
begin
  if p_order_id is null then
    return 0;
  end if;

  -- The reason is chosen from a fixed set by the CALLER, never supplied by a
  -- user. Anything unrecognised becomes the neutral phrase rather than being
  -- written through: this column is rendered.
  if coalesce(p_reason, '') not in ('billing_percentage_changed', 'pi_data_amended') then
    p_reason := 'pi_data_amended';
  end if;

  update public.order_document_versions
     set superseded_at     = now(),
         superseded_reason = p_reason
   where order_id = p_order_id
     and status = 'ready'
     and superseded_at is null;

  get diagnostics v_count = row_count;

  if v_count > 0 then
    perform public.log_order_document_event(
      p_order_id, auth.uid(), 'document_generation_superseded',
      jsonb_build_object('reason', p_reason, 'versions', v_count)
    );
  end if;

  return v_count;
end;
$$;

comment on function public.supersede_order_documents(uuid, text) is
  'Marks an Order''s current READY document versions as no longer current after the PI data behind them changed. Never deletes, never rewrites a file, never overwrites an earlier supersession. Server-side only.';

revoke execute on function public.supersede_order_documents(uuid, text) from public, anon, authenticated;

-- The event vocabulary gains one entry. Re-emitted in full rather than altered,
-- so the allowed set is readable in one place.
create or replace function public.log_order_document_event(
  p_order_id uuid,
  p_actor_id uuid,
  p_event    text,
  p_payload  jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_event not in (
    'document_generation_started',
    'document_generation_ready',
    'document_generation_failed',
    'document_generation_retried',
    -- NEW: the PI data behind a ready version changed, so it is no longer
    -- current. Not a failure — the files are intact and still downloadable.
    'document_generation_superseded'
  ) then
    raise exception 'ORDER_DOCUMENT_UNKNOWN_EVENT: %', p_event using errcode = 'P0001';
  end if;

  insert into public.order_activity_log (order_id, actor_id, event_type, payload)
  values (p_order_id, p_actor_id, p_event, coalesce(p_payload, '{}'::jsonb));
end;
$$;

revoke execute on function public.log_order_document_event(uuid, uuid, text, jsonb)
  from public, anon, authenticated;


-- ── 3. The billing percentage, under the revised authority ───────────────────
--
-- A THREE-ARGUMENT OVERLOAD rather than a changed signature. The existing
-- two-argument function keeps working and keeps its callers; it now delegates.
-- Adding a required parameter to the applied signature would have broken every
-- caller at once for the sake of a value most of them do not need.

create or replace function public.set_order_submission_billing_percentage(
  p_submission_id uuid,
  p_percentage    numeric,
  p_reason        text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor      uuid := auth.uid();
  v_sub        public.order_submissions%rowtype;
  v_previous   numeric(5,2);
  v_next       numeric(5,2);
  v_is_admin   boolean;
  v_is_owner   boolean;
  v_after_sub  boolean;
  v_reason     text;
  v_superseded integer := 0;
begin
  if v_actor is null then
    raise exception 'You must be signed in to change the billing percentage'
      using errcode = '42501';
  end if;

  -- THE ROW LOCK COMES FIRST, before any judgement of state or authority, so
  -- the state the checks read is the state the write lands on. Unchanged from
  -- the original, and the reason is unchanged too.
  select * into v_sub
  from public.order_submissions
  where id = p_submission_id
  for update;

  if not found then
    raise exception 'Order submission % not found', p_submission_id using errcode = 'P0002';
  end if;

  v_is_admin := public.can_admin_edit_order_submission(p_submission_id);
  -- The OWNER rule is the pre-existing predicate, untouched: draft or
  -- needs_changes, no Order, owner or admin.
  v_is_owner := public.can_edit_order_submission(p_submission_id);

  if not (v_is_admin or v_is_owner) then
    raise exception
      'ORDER_SUBMISSION_BILLING_NOT_EDITABLE: this PI cannot be changed by you in its current state'
      using errcode = '42501';
  end if;

  -- "After submission" is every state the owner rule does not cover. An admin
  -- editing there must say why; an owner editing a draft never has to, because
  -- a draft is theirs to shape and a mandatory reason on every keystroke of
  -- ordinary work is a ritual, not an audit trail.
  v_after_sub := v_sub.status not in ('draft', 'needs_changes') or v_sub.order_id is not null;

  if v_after_sub and not v_is_owner then
    v_reason := nullif(btrim(coalesce(p_reason, '')), '');
    if v_reason is null then
      raise exception
        'ORDER_SUBMISSION_BILLING_REASON_REQUIRED: editing a submitted PI needs a reason'
        using errcode = 'P0001';
    end if;
    if length(v_reason) > 500 then
      raise exception
        'ORDER_SUBMISSION_BILLING_REASON_TOO_LONG: the reason may be at most 500 characters'
        using errcode = 'P0001';
    end if;
  else
    v_reason := null;
  end if;

  v_previous := v_sub.billing_percentage;

  if p_percentage is null then
    v_next := null;
  else
    if not (p_percentage >= 35 and p_percentage <= 100) then
      raise exception
        'ORDER_SUBMISSION_BILLING_OUT_OF_RANGE: the billing percentage must be between 35 and 100'
        using errcode = 'P0001';
    end if;
    if scale(p_percentage) > 2 then
      raise exception
        'ORDER_SUBMISSION_BILLING_PRECISION: the billing percentage may have at most two decimal places'
        using errcode = 'P0001';
    end if;
    v_next := p_percentage;
  end if;

  -- NOTHING CHANGED: no write, no event, no supersession. `is distinct from`
  -- is what makes that true for the NULL cases as well. Unchanged behaviour,
  -- and now it also means an unchanged save never invalidates a document.
  if v_next is not distinct from v_previous then
    return jsonb_build_object(
      'submission_id',      p_submission_id,
      'billing_percentage', v_next,
      'changed',            false,
      'superseded_documents', 0
    );
  end if;

  update public.order_submissions
  set billing_percentage = v_next,
      updated_at         = now()
  where id = p_submission_id;

  -- ── The linked Order carries the same declaration ──
  --
  -- orders.billing_percentage is written at approval from the PI's value, so
  -- leaving it behind here would make the Order state a figure its own PI no
  -- longer says. Same transaction, so the two cannot disagree.
  --
  -- NOTHING ELSE ON THE ORDER IS TOUCHED: not the number, not the link, not a
  -- total, not an allocation.
  if v_sub.order_id is not null then
    update public.orders
       set billing_percentage = v_next,
           updated_at         = now()
     where id = v_sub.order_id;

    insert into public.order_activity_log (order_id, actor_id, event_type, payload)
    values (
      v_sub.order_id, v_actor, 'order_billing_percentage_amended',
      jsonb_build_object(
        'previous_billing_percentage', v_previous,
        'new_billing_percentage',      v_next,
        'by_admin',                    v_is_admin and not v_is_owner,
        'reason',                      v_reason
      )
    );

    -- The billing percentage is printed on the confirmed documents, so a
    -- changed value makes an existing ready pair no longer current.
    v_superseded := public.supersede_order_documents(
      v_sub.order_id, 'billing_percentage_changed');
  end if;

  -- OWNER AND ADMIN EDITS ARE DISTINGUISHABLE IN THE TRAIL. Two different
  -- actions, not one action with a flag, so a reader scanning the Activity list
  -- sees the difference without opening anything.
  perform public.log_order_submission_activity(
    p_submission_id,
    v_actor,
    case when v_after_sub and not v_is_owner
         then 'billing_percentage_amended_by_admin'
         else 'billing_percentage_set' end,
    v_sub.status,
    v_sub.status,
    v_reason,
    jsonb_build_object(
      'previous_billing_percentage', v_previous,
      'new_billing_percentage',      v_next,
      'stage',                       v_sub.status,
      'after_submission',            v_after_sub,
      'superseded_documents',        v_superseded
    )
  );

  return jsonb_build_object(
    'submission_id',        p_submission_id,
    'billing_percentage',   v_next,
    'changed',              true,
    'superseded_documents', v_superseded
  );
end;
$$;

comment on function public.set_order_submission_billing_percentage(uuid, numeric, text) is
  'Declares, changes or clears a PI billing percentage. The OWNER may do so in draft/needs_changes (can_edit_order_submission); an ACTIVE ADMIN may do so at any stage (can_admin_edit_order_submission) but must give a reason once the PI has been submitted. 35-100 or NULL. An unchanged value writes nothing. A change mirrors onto the linked Order and supersedes its ready documents.';

revoke all    on function public.set_order_submission_billing_percentage(uuid, numeric, text) from public, anon;
grant  execute on function public.set_order_submission_billing_percentage(uuid, numeric, text) to authenticated;

-- The two-argument form stays, and delegates. Every existing caller keeps
-- working; an owner editing a draft passes no reason and needs none.
create or replace function public.set_order_submission_billing_percentage(
  p_submission_id uuid,
  p_percentage    numeric default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return public.set_order_submission_billing_percentage(p_submission_id, p_percentage, null);
end;
$$;

comment on function public.set_order_submission_billing_percentage(uuid, numeric) is
  'Delegates to the three-argument form with no reason. Kept so every existing caller continues to work: an owner editing a draft never needs a reason, and an admin editing after submission is refused by the delegate with ORDER_SUBMISSION_BILLING_REASON_REQUIRED rather than being allowed through unaudited.';

revoke all    on function public.set_order_submission_billing_percentage(uuid, numeric) from public, anon;
grant  execute on function public.set_order_submission_billing_percentage(uuid, numeric) to authenticated;


-- ── 4. What this migration promises, checked here ────────────────────────────
do $$
declare
  v_def text;
begin
  -- the new authority exists, is DEFINER, and has a fixed search_path
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'can_admin_edit_order_submission'
      and p.prosecdef
  ) then
    raise exception 'can_admin_edit_order_submission must exist and be SECURITY DEFINER';
  end if;

  for v_def in
    select pg_get_functiondef(p.oid)
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('can_admin_edit_order_submission',
                        'supersede_order_documents',
                        'set_order_submission_billing_percentage')
  loop
    if v_def !~ 'SET search_path TO ''?public''?, ''?pg_temp''?' then
      raise exception 'a function in this migration has no fixed search_path: %',
        left(v_def, 120);
    end if;
  end loop;

  -- THE OWNER RULE IS UNTOUCHED. If this migration had widened
  -- can_edit_order_submission instead of adding beside it, every other write
  -- path in the module would have silently gained the new authority.
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'can_edit_order_submission';
  if v_def !~ '''draft''' or v_def !~ '''needs_changes''' or v_def !~ 'order_id is null' then
    raise exception 'can_edit_order_submission has been altered; it must remain the owner rule';
  end if;

  -- the server-only helper is reachable by no client role
  if exists (
    select 1 from information_schema.routine_privileges
    where routine_schema = 'public' and routine_name = 'supersede_order_documents'
      and grantee in ('anon', 'authenticated', 'public')
  ) then
    raise exception 'supersede_order_documents must not be executable by a client role';
  end if;

  -- claim_token is STILL not readable, after adding two readable columns
  if exists (
    select 1 from information_schema.column_privileges
    where table_schema = 'public' and table_name = 'order_document_versions'
      and column_name = 'claim_token' and grantee in ('anon', 'authenticated', 'public')
  ) then
    raise exception 'claim_token has become readable by a client role';
  end if;

  raise notice '20260927000000 applied: admin amendment authority, document supersession.';
end $$;
