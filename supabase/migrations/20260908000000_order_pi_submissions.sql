-- PI import, phase 2 of N: the submission foundation.
--
-- WHAT THIS IS
-- ------------
-- An employee uploads a standard BOE Proforma Invoice workbook that carries NO
-- official order number. src/lib/pi/ parses it (phase 1, already merged). This
-- migration gives that parse somewhere to live, somewhere private to keep the
-- workbook and its product photographs, and a permanent record of who did what
-- to it.
--
-- WHAT THIS IS NOT
-- ----------------
-- It does NOT approve anything, does NOT create an Order, and does NOT allocate
-- an order number. Those are phase 3, deliberately. The proof is structural
-- rather than a promise:
--
--   * the status transition trigger below permits exactly three moves
--     (draft→submitted, needs_changes→submitted, submitted→needs_changes) and
--     RAISES on every other change, including any move to 'approved' or
--     'rejected'. Those two values exist in the column domain so phase 3 is an
--     additive change, and they are unreachable today for every caller, service
--     role included;
--   * nothing here reads, writes or references order_number_cycle,
--     allocate_confirmed_order_number(), format_confirmed_order_number() or
--     public.orders' display_number;
--   * order_submissions.order_id is nullable, constrained to be non-null only
--     when status = 'approved', and no code path in this file ever sets it.
--
-- SOURCE NUMBERS ARE NOT OFFICIAL NUMBERS
-- ---------------------------------------
-- order_submissions.source_order_number holds whatever was printed in cell
-- Master!B20 of the uploaded file — usually the number of whatever older PI the
-- employee copied. It is retained for traceability and must NEVER seed
-- numbering. The same applies to order_submission_items.source_product_code.
-- Official numbers and official product codes come into existence only at
-- approval, in phase 3.
--
-- WRITE MODEL
-- -----------
-- Deny-by-default, and not only through RLS. INSERT/UPDATE/DELETE/TRUNCATE are
-- REVOKED from anon and authenticated on all three tables, so the privilege
-- check refuses a client write before any policy is consulted — the lesson
-- 20260818000000 records about public.orders, applied here from the start
-- rather than retrofitted. Every mutation goes through one of the four SECURITY
-- DEFINER functions in section 8, each of which validates the actor, the
-- permission, the ownership and the state before it writes.
--
-- THE 40% ADVANCE RULE (phase 3, specified here so it is not re-invented)
-- ----------------------------------------------------------------------
-- advance_exception_reason exists now and is written by nothing in this phase.
-- The rule it serves, for whoever builds approval:
--   * a confirmed advance of at least 40% of grand_total is the standard case;
--   * anything below that, INCLUDING ZERO, requires a non-blank exception
--     reason recorded against the submission;
--   * an authorised approver may then approve or reject that exception;
--   * 40% is a threshold for requiring a reason, NOT an amount to enforce
--     exactly — do not reject an advance for being 39.6%.
-- It is not enforced now because multi-order payment allocation and Finance
-- confirmation do not exist yet, and a rule computed from a payment model that
-- has not been built would be enforced against the wrong number.

-- ═══ 1. order_submissions ═══════════════════════════════════════════════════
--
-- One row per uploaded workbook. Holds the parsed snapshot a reviewer judges,
-- so review does not depend on re-reading the file or on the parser behaving
-- identically months later.
--
-- Money columns are NULLABLE with `is null or >= 0` checks rather than NOT NULL.
-- That is deliberate and matches what the phase 1 parser actually produces: a
-- PI legitimately writes words into a commercial cell ("as applicable" in
-- transportation, an unresolved fabric cost), and PiAmountOrText.amount is
-- `number | null` for exactly that reason. A NOT NULL here would reject a
-- workbook the parser accepted. gross_product_amount and discount_amount are
-- the two the parser always produces as numbers, so those are NOT NULL.

create table public.order_submissions (
  id            uuid        primary key default gen_random_uuid(),

  status        text        not null default 'draft'
                  check (status in ('draft', 'submitted', 'needs_changes', 'rejected', 'approved')),

  -- The employee whose submission this is, the account that created the row,
  -- and the reviewer it is routed to. submitted_by and created_by are the same
  -- person today; they are separate columns because an assistant submitting on
  -- somebody's behalf is a foreseeable need and splitting them later would mean
  -- rewriting history.
  submitted_by  uuid        not null references public.users(id),
  created_by    uuid        not null references public.users(id),
  assigned_to   uuid        references public.users(id) on delete set null,

  approved_by   uuid        references public.users(id),
  approved_at   timestamptz,
  rejected_by   uuid        references public.users(id),
  rejected_at   timestamptz,
  review_note   text,

  -- ── Header block, as parsed from Master rows 20–28 and 113 ──
  client_name             text,
  creation_date           date,
  source_created_by       text,
  boe_gst                 text,
  contact_number          text,
  bill_to_name            text,
  bill_to_phone           text,
  bill_to_gst             text,
  billing_address         text,
  ship_to_name            text,
  ship_to_phone           text,
  ship_to_gst             text,
  shipping_address        text,
  order_confirmation_date date,
  dispatch_commitment     text,

  -- Informational ONLY. See the header note: never an official order number.
  source_order_number     text,

  -- ── The uploaded workbook ──
  source_workbook_path       text,
  source_workbook_name       text,
  source_workbook_size_bytes bigint
                               check (source_workbook_size_bytes is null
                                      or source_workbook_size_bytes between 1 and 10485760),
  source_workbook_sha256     text
                               check (source_workbook_sha256 is null
                                      or source_workbook_sha256 ~ '^[0-9a-f]{64}$'),
  template_version           text,

  -- ── The parse result, kept verbatim ──
  parse_warnings        jsonb not null default '[]'::jsonb
                          check (jsonb_typeof(parse_warnings) = 'array'),
  parse_blocking_issues jsonb not null default '[]'::jsonb
                          check (jsonb_typeof(parse_blocking_issues) = 'array'),

  -- ── Commercial footer, Master rows 115–122 ──
  gross_product_amount    numeric(12,2) not null default 0 check (gross_product_amount >= 0),
  -- Stored as the DISCOUNT whatever the workbook labelled the row. Production
  -- files say "Design Fees" as often as "Discount"; the position is the meaning.
  discount_amount         numeric(12,2) not null default 0 check (discount_amount >= 0),
  subtotal_after_discount numeric(12,2) check (subtotal_after_discount is null or subtotal_after_discount >= 0),
  fabric_cost             numeric(12,2) check (fabric_cost is null or fabric_cost >= 0),
  packing_cost            numeric(12,2) check (packing_cost is null or packing_cost >= 0),
  -- Transportation is numeric OR words ("as applicable"), never both.
  transportation_amount   numeric(12,2) check (transportation_amount is null or transportation_amount >= 0),
  transportation_text     text,
  total_before_gst        numeric(12,2) check (total_before_gst is null or total_before_gst >= 0),
  gst_amount              numeric(12,2) check (gst_amount is null or gst_amount >= 0),
  grand_total             numeric(12,2) check (grand_total is null or grand_total >= 0),

  -- Phase 3. Written by nothing here; see the header note on the 40% rule.
  advance_exception_reason text,

  -- The official Order this submission became. Phase 3 sets it; nothing in this
  -- file does.
  order_id      uuid        references public.orders(id),

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint order_submissions_transportation_one_form check (
    transportation_amount is null or transportation_text is null
  ),

  -- 'draft' and 'needs_changes' are the two states the EMPLOYEE owns, and both
  -- may legitimately hold an incomplete or still-broken parse. Everything past
  -- them is a record a reviewer is being asked to act on, so it must be
  -- complete and free of blocking issues. Grouping the two is what lets a
  -- returned submission be re-parsed from a fresh workbook that turns out to
  -- have its own problems.
  constraint order_submissions_reviewable_has_no_blocking_issues check (
    status in ('draft', 'needs_changes')
    or jsonb_array_length(parse_blocking_issues) = 0
  ),

  constraint order_submissions_reviewable_is_complete check (
    status in ('draft', 'needs_changes')
    or (
      client_name is not null and btrim(client_name) <> ''
      and source_workbook_path is not null and btrim(source_workbook_path) <> ''
    )
  ),

  constraint order_submissions_approval_consistency check (
    (status =  'approved' and approved_by is not null and approved_at is not null)
    or
    (status <> 'approved' and approved_by is null and approved_at is null)
  ),

  constraint order_submissions_rejection_consistency check (
    (status =  'rejected' and rejected_by is not null and rejected_at is not null)
    or
    (status <> 'rejected' and rejected_by is null and rejected_at is null)
  ),

  -- An Order can only come from an APPROVED submission.
  constraint order_submissions_order_link_requires_approval check (
    order_id is null or status = 'approved'
  )
);

comment on table public.order_submissions is
  'An uploaded BOE PI workbook and its parsed snapshot, awaiting review. Carries no official order number: numbering happens only at approval, in a later phase.';
comment on column public.order_submissions.source_order_number is
  'Whatever was printed in Master!B20 of the uploaded workbook — normally the number of the older PI it was copied from. Informational and traceability ONLY. It must never seed public.orders.display_number or the order number cycle.';
comment on column public.order_submissions.discount_amount is
  'Master!I115, stored as the discount regardless of whether the workbook labels that row "Discount" or "Design Fees". Position is the business meaning; the label is not consulted.';
comment on column public.order_submissions.advance_exception_reason is
  'Reserved for the approval phase. A confirmed advance below 40% of grand_total — zero included — requires a non-blank reason here, which an authorised approver then accepts or rejects. Not written or enforced in this phase because payment allocation does not exist yet.';
comment on column public.order_submissions.order_id is
  'The official Order this submission became. Set only by the approval phase; nothing in 20260908000000 writes it.';

create index order_submissions_status_idx       on public.order_submissions (status);
create index order_submissions_submitted_by_idx on public.order_submissions (submitted_by);
create index order_submissions_created_by_idx   on public.order_submissions (created_by);
create index order_submissions_assigned_to_idx  on public.order_submissions (assigned_to);
create index order_submissions_created_at_idx   on public.order_submissions (created_at desc);

-- One Order per submission, and one submission per Order.
create unique index order_submissions_order_id_key
  on public.order_submissions (order_id) where order_id is not null;

drop trigger if exists order_submissions_set_updated_at on public.order_submissions;
create trigger order_submissions_set_updated_at
  before update on public.order_submissions
  for each row execute function public.set_updated_at();

-- ═══ 2. order_submission_items ══════════════════════════════════════════════
--
-- One row per genuine product line, in workbook order.
--
-- MATERIAL AND CUSTOMIZATION ARE SEPARATE COLUMNS and must stay that way.
-- Material is what the piece is made of; customization is how it differs from
-- the reference image. Folding them together would lose the difference the
-- factory needs.
--
-- item_sequence, product_name and image_storage_path are nullable at rest but
-- REQUIRED to submit — submit_order_submission() refuses without them. That
-- split is deliberate: a draft is a work-in-progress that must be able to hold
-- an incomplete parse so the employee can see what is wrong and fix it. Making
-- them NOT NULL would mean an incomplete row could not be stored at all, and
-- the reviewer's preview would silently lose lines.
--
-- quantity and cost_per_piece are different: a line with no quantity or no rate
-- is not a product line at any stage, so they are NOT NULL and strictly
-- positive, matching the phase 1 parser's own blocking rules.

create table public.order_submission_items (
  id                 uuid        primary key default gen_random_uuid(),
  submission_id      uuid        not null references public.order_submissions(id) on delete cascade,

  -- 1-based worksheet row, so any figure can be traced to the cell it came from.
  source_row         integer     not null check (source_row > 0),

  item_sequence      text        check (item_sequence is null or btrim(item_sequence) <> ''),
  -- The code the uploaded workbook already carried. NOT an official product
  -- code: those are {order_number}-{item_sequence} and are formed at approval.
  source_product_code text,
  product_name       text        check (product_name is null or btrim(product_name) <> ''),

  quantity           numeric(12,2) not null check (quantity > 0),
  dimensions         text,
  material           text,
  customization      text,
  cost_per_piece     numeric(12,2) not null check (cost_per_piece > 0),
  -- The workbook's own line total, kept as stored. The parser reports a
  -- disagreement with quantity × rate as a warning and never overwrites it.
  total_amount       numeric(12,2) not null check (total_amount >= 0),

  image_storage_path text        check (image_storage_path is null or btrim(image_storage_path) <> ''),
  image_mime_type    text        check (image_mime_type is null
                                        or image_mime_type in ('image/png', 'image/jpeg', 'image/webp')),
  image_sha256       text        check (image_sha256 is null or image_sha256 ~ '^[0-9a-f]{64}$'),
  image_anchor_row   integer     check (image_anchor_row is null or image_anchor_row > 0),

  sort_order         integer     not null check (sort_order >= 0),
  created_at         timestamptz not null default now()
);

comment on table public.order_submission_items is
  'Parsed product lines of one PI submission. material and customization are separate fields by design. No official product code exists at this stage.';
comment on column public.order_submission_items.source_product_code is
  'The product code printed in the uploaded workbook. The official code is {order_number}-{item_sequence} and is formed only at approval.';

create index order_submission_items_submission_idx
  on public.order_submission_items (submission_id, sort_order);

-- The sequence is the line's identity within the submission, and is what the
-- official product code will be built from — it cannot repeat. Partial, because
-- a draft may legitimately hold a line whose sequence has not been read yet.
create unique index order_submission_items_sequence_key
  on public.order_submission_items (submission_id, item_sequence)
  where item_sequence is not null;

create unique index order_submission_items_sort_order_key
  on public.order_submission_items (submission_id, sort_order);

-- ═══ 3. order_submission_activity ═══════════════════════════════════════════
--
-- Append-only. Written ONLY by the SECURITY DEFINER logger in section 7, which
-- no client role may execute. There is no UPDATE policy and no DELETE policy
-- for anybody, admin included, and the write privileges are revoked in section
-- 5 — so history cannot be edited, spoofed or erased through the API.
--
-- The action set is CLOSED to what this phase can actually produce. A phase
-- that adds approval extends this constraint in its own migration, which is a
-- visible change rather than a silent new event type.

create table public.order_submission_activity (
  id              uuid        primary key default gen_random_uuid(),
  submission_id   uuid        not null references public.order_submissions(id) on delete cascade,
  actor_id        uuid        references public.users(id) on delete set null,
  action          text        not null
                    check (action in (
                      'submission_created',
                      'parse_replaced',
                      'submitted',
                      'changes_requested'
                    )),
  previous_status text,
  new_status      text,
  note            text,
  metadata        jsonb       not null default '{}'::jsonb
                    check (jsonb_typeof(metadata) = 'object'),
  created_at      timestamptz not null default now()
);

comment on table public.order_submission_activity is
  'Append-only history of one PI submission. Written only by log_order_submission_activity(), which is not executable by any client role. No UPDATE or DELETE policy exists for any role.';

create index order_submission_activity_submission_idx
  on public.order_submission_activity (submission_id, created_at);

-- ═══ 4. Status transitions ══════════════════════════════════════════════════
--
-- The graph, enforced for EVERY caller including the service role and direct
-- SQL, which is what makes "this phase cannot approve an order" an invariant of
-- the database rather than a property of the application:
--
--   draft         → submitted
--   needs_changes → submitted
--   submitted     → needs_changes
--
-- 'approved' and 'rejected' are reachable from nothing. They are present in the
-- column's CHECK so the approval phase adds transitions rather than rewriting
-- the domain, and any attempt to reach them now fails loudly.

-- Fires on INSERT as well as UPDATE, deliberately. Guarding only UPDATE would
-- leave a submission creatable AT 'approved' by anything holding an INSERT
-- privilege — which is the service role, and the service role bypasses RLS. The
-- INSERT branch is what makes "this phase cannot reach approved" true for every
-- caller rather than only for signed-in clients.

create or replace function public.order_submissions_enforce_status_transition()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      raise exception
        'ORDER_SUBMISSION_TRANSITION_INVALID: a submission must be created as draft, not %', new.status
        using errcode = '42501';
    end if;
    return new;
  end if;

  if new.status is not distinct from old.status then
    return new;
  end if;

  if not (
    (old.status = 'draft'         and new.status = 'submitted')
    or (old.status = 'needs_changes' and new.status = 'submitted')
    or (old.status = 'submitted'     and new.status = 'needs_changes')
  ) then
    raise exception
      'ORDER_SUBMISSION_TRANSITION_INVALID: % cannot move from % to %',
      old.id, old.status, new.status
      using errcode = '42501';
  end if;

  return new;
end;
$$;

revoke execute on function public.order_submissions_enforce_status_transition()
  from public, anon, authenticated;

drop trigger if exists order_submissions_enforce_status_transition on public.order_submissions;
create trigger order_submissions_enforce_status_transition
  before insert or update on public.order_submissions
  for each row execute function public.order_submissions_enforce_status_transition();

-- The two provenance columns are the record of who filed this and when it was
-- created. Nothing may rewrite them, amendment context or not.
create or replace function public.order_submissions_guard_frozen_columns()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.created_by is distinct from old.created_by
     or new.submitted_by is distinct from old.submitted_by
     or new.created_at is distinct from old.created_at then
    raise exception
      'ORDER_SUBMISSION_FIELD_FROZEN: the creation record of submission % cannot be changed', old.id
      using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke execute on function public.order_submissions_guard_frozen_columns()
  from public, anon, authenticated;

drop trigger if exists order_submissions_guard_frozen_columns on public.order_submissions;
create trigger order_submissions_guard_frozen_columns
  before update on public.order_submissions
  for each row execute function public.order_submissions_guard_frozen_columns();

-- ═══ 5. Privileges — the first gate, before any policy ══════════════════════
--
-- Supabase grants ALL on new public tables to anon and authenticated by
-- default. Narrowing that here means a client write is refused by PostgreSQL
-- before RLS is consulted, and cannot be re-opened by a future permissive
-- policy written in error. Reading is still governed by the policies in
-- section 6.

revoke insert, update, delete, truncate, references, trigger
  on public.order_submissions        from anon, authenticated;
revoke insert, update, delete, truncate, references, trigger
  on public.order_submission_items   from anon, authenticated;
revoke insert, update, delete, truncate, references, trigger
  on public.order_submission_activity from anon, authenticated;

grant select on public.order_submissions         to authenticated;
grant select on public.order_submission_items    to authenticated;
grant select on public.order_submission_activity to authenticated;

-- ═══ 6. RLS ═════════════════════════════════════════════════════════════════

alter table public.order_submissions         enable row level security;
alter table public.order_submission_items    enable row level security;
alter table public.order_submission_activity enable row level security;

-- Who may see one submission. Encapsulated so the parent table, the two child
-- tables and the storage policies cannot drift apart, and SECURITY DEFINER so
-- the child policies do not re-enter the parent's own RLS.
--
-- actor_has_module_permission (20260901000000) supplies the admin branch and
-- requires an ACTIVE, non-deleted account on both of its own branches, so a
-- deactivated approver loses sight here too.
create or replace function public.can_view_order_submission(p_submission_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.order_submissions s
    where s.id = p_submission_id
      and (
        s.created_by  = auth.uid()
        or s.submitted_by = auth.uid()
        or s.assigned_to  = auth.uid()
        or public.actor_has_module_permission('orders', 'approve_order')
      )
  );
$$;

comment on function public.can_view_order_submission(uuid) is
  'True for the submission owner, its named reviewer, an active admin, or a holder of orders.approve_order. The single visibility rule shared by the tables and the storage policies.';

revoke execute on function public.can_view_order_submission(uuid) from public, anon;
grant  execute on function public.can_view_order_submission(uuid) to authenticated;

-- Who may still CHANGE one. The employee's two states only: once submitted, the
-- record a reviewer is looking at cannot be edited except by being sent back.
create or replace function public.can_edit_order_submission(p_submission_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.order_submissions s
    where s.id = p_submission_id
      and s.status in ('draft', 'needs_changes')
      and s.order_id is null
      and (
        s.created_by = auth.uid()
        or s.submitted_by = auth.uid()
        or exists (
          select 1 from public.users u
          where u.id = auth.uid()
            and u.role = 'admin'
            and u.is_active
            and coalesce(u.is_deleted, false) = false
        )
      )
  );
$$;

comment on function public.can_edit_order_submission(uuid) is
  'True only while a submission is in one of the two employee-owned states (draft, needs_changes) and the caller owns it or is an active admin. A submitted record is not editable by anyone until a reviewer returns it.';

revoke execute on function public.can_edit_order_submission(uuid) from public, anon;
grant  execute on function public.can_edit_order_submission(uuid) to authenticated;

-- Who may WRITE a file. Strictly narrower than can_edit_order_submission, and
-- separate from it on purpose: reading a submission and adding a file to it are
-- different authorities, and the read rule is the wider of the two.
--
-- Narrower in three ways:
--   * ONLY the owner. An assigned reviewer and an orders.approve_order holder
--     can SEE every file — that is what review means — and neither gains the
--     ability to add or remove one. A reviewer who can silently replace the
--     workbook they are reviewing is not a reviewer.
--   * NO admin branch. An administrator is not the author of somebody's
--     submission; administrative file work goes through the service role, which
--     is not subject to these policies at all.
--   * orders.create is REQUIRED, not merely ownership. An employee whose
--     create permission has been withdrawn stops being able to add files, even
--     to a draft they started.
-- The draft/needs_changes window is unchanged: once submitted, nobody writes.
create or replace function public.can_write_order_submission_file(p_submission_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.order_submissions s
    join public.users u on u.id = auth.uid()
    where s.id = p_submission_id
      and s.status in ('draft', 'needs_changes')
      and s.order_id is null
      and (s.created_by = auth.uid() or s.submitted_by = auth.uid())
      and u.is_active
      and coalesce(u.is_deleted, false) = false
      and coalesce(public.resolve_permission(auth.uid(), 'orders', 'create'), false)
  );
$$;

comment on function public.can_write_order_submission_file(uuid) is
  'True only for the submission OWNER, while it is a draft or has been returned, and only while they still hold orders.create. Reviewers and approve_order holders are excluded by design: they may read every file and write none.';

revoke execute on function public.can_write_order_submission_file(uuid) from public, anon;
grant  execute on function public.can_write_order_submission_file(uuid) to authenticated;

create policy "order_submissions_select" on public.order_submissions
  for select to authenticated
  using (
    created_by = auth.uid()
    or submitted_by = auth.uid()
    or assigned_to = auth.uid()
    or public.actor_has_module_permission('orders', 'approve_order')
  );

create policy "order_submission_items_select" on public.order_submission_items
  for select to authenticated
  using (public.can_view_order_submission(submission_id));

create policy "order_submission_activity_select" on public.order_submission_activity
  for select to authenticated
  using (public.can_view_order_submission(submission_id));

-- No INSERT, UPDATE or DELETE policy exists on any of the three tables, for any
-- role. Combined with the revokes in section 5 that is two independent refusals
-- of every client write.

-- Parent module gate, matching 20260905000000. RESTRICTIVE, so it ANDs with the
-- policies above: an employee whose Order Management access is switched off
-- reaches nothing here even for a submission they created.
create policy "order_submissions_module_entry_gate" on public.order_submissions
  as restrictive for all to authenticated
  using (public.module_entry_open('orders'))
  with check (public.module_entry_open('orders'));

create policy "order_submission_items_module_entry_gate" on public.order_submission_items
  as restrictive for all to authenticated
  using (public.module_entry_open('orders'))
  with check (public.module_entry_open('orders'));

create policy "order_submission_activity_module_entry_gate" on public.order_submission_activity
  as restrictive for all to authenticated
  using (public.module_entry_open('orders'))
  with check (public.module_entry_open('orders'));

-- ═══ 7. The activity logger ═════════════════════════════════════════════════
--
-- The ONLY writer of order_submission_activity. Not executable by any client
-- role; the RPCs below call it as the definer.
--
-- The actor is an explicit parameter rather than auth.uid(). That is NOT a
-- spoofing hole, because no client role can execute this function at all — and
-- it is required, because replace_order_submission_parse runs under the service
-- role, where auth.uid() is NULL and an auth.uid()-based logger would silently
-- attribute every parse to nobody. Each caller passes an actor it has already
-- validated.

create or replace function public.log_order_submission_activity(
  p_submission_id   uuid,
  p_actor_id        uuid,
  p_action          text,
  p_previous_status text,
  p_new_status      text,
  p_note            text default null,
  p_metadata        jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.order_submission_activity
    (submission_id, actor_id, action, previous_status, new_status, note, metadata)
  values
    (p_submission_id, p_actor_id, p_action, p_previous_status, p_new_status,
     nullif(btrim(coalesce(p_note, '')), ''), coalesce(p_metadata, '{}'::jsonb));
end;
$$;

revoke execute on function public.log_order_submission_activity(uuid, uuid, text, text, text, text, jsonb)
  from public, anon, authenticated, service_role;

-- ═══ 8. The write paths ═════════════════════════════════════════════════════
--
-- All of them: SECURITY DEFINER, search_path pinned to public + pg_temp,
-- EXECUTE revoked from PUBLIC and anon, and an active, non-deleted actor
-- required.
--
-- THREE ARE CLIENT-CALLABLE, ONE IS NOT.
--
--   create_order_submission          authenticated — creates an EMPTY draft.
--   submit_order_submission          authenticated — changes status only.
--   request_order_submission_changes authenticated — changes status only.
--   replace_order_submission_parse   SERVICE ROLE ONLY.
--
-- The split is the whole point. Every commercial figure and every product line
-- comes from parsing the uploaded workbook, and a browser must not be able to
-- manufacture them. The three client doors move a submission through its states
-- and write no price, quantity, total, item or image mapping; the one door that
-- writes all of those is unreachable from a browser. Its caller resolves the
-- actor from an authenticated request and re-validates it here.
--
-- There is deliberately no approve function and no reject function. Both belong
-- to the phase that creates Orders, and the transition trigger in section 4
-- refuses both moves regardless.

-- The caller, proven to be a real, active, non-deleted account.
create or replace function public.assert_order_submission_actor()
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
begin
  if v_actor is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if not exists (
    select 1 from public.users u
    where u.id = v_actor and u.is_active and coalesce(u.is_deleted, false) = false
  ) then
    raise exception 'This account is not active' using errcode = '42501';
  end if;
  return v_actor;
end;
$$;

revoke execute on function public.assert_order_submission_actor()
  from public, anon, authenticated, service_role;

-- The explicit-actor equivalent, for the one path where auth.uid() does not
-- exist because the caller is the service role.
--
-- IT TRUSTS NOTHING ABOUT p_actor_id. Being handed a user id by the service role
-- proves only that a server process said so, which is worth exactly as much as a
-- browser saying it. Every property is re-derived here from the database: the
-- account is real, active and not soft-deleted; it holds orders.create through
-- the permission engine (or is an active admin); the submission exists; it is in
-- one of the two employee-owned states; and this actor OWNS it. A server bug
-- that forwarded the wrong id therefore fails closed rather than writing one
-- employee's parse onto another employee's submission.
create or replace function public.assert_order_submission_editor(
  p_submission_id uuid,
  p_actor_id      uuid
)
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_is_admin boolean;
  v_sub      public.order_submissions%rowtype;
begin
  if p_actor_id is null then
    raise exception 'ORDER_SUBMISSION_ACTOR_REQUIRED: an acting employee is required'
      using errcode = '28000';
  end if;

  -- coalesced to false, not left as a bare comparison. If v_is_admin were ever
  -- NULL, `not (NULL or false)` evaluates to NULL, an IF on NULL does not take
  -- its branch, and BOTH guards below would silently pass. users.role is NOT
  -- NULL today so this cannot fire; it is written this way so that a future
  -- schema change cannot turn a nullable column into an authorization bypass.
  select coalesce(u.role = 'admin', false) into v_is_admin
  from public.users u
  where u.id = p_actor_id
    and u.is_active
    and coalesce(u.is_deleted, false) = false;

  if not found then
    raise exception 'ORDER_SUBMISSION_ACTOR_INVALID: that account is not active'
      using errcode = '42501';
  end if;

  -- The permission engine answers for THIS actor, not for auth.uid().
  if not (coalesce(v_is_admin, false)
          or coalesce(public.resolve_permission(p_actor_id, 'orders', 'create'), false)) then
    raise exception 'ORDER_SUBMISSION_FORBIDDEN: that employee cannot create order submissions'
      using errcode = '42501';
  end if;

  select * into v_sub from public.order_submissions where id = p_submission_id;

  if not found then
    raise exception 'Order submission % not found', p_submission_id using errcode = 'P0002';
  end if;

  if v_sub.status not in ('draft', 'needs_changes') or v_sub.order_id is not null then
    raise exception
      'ORDER_SUBMISSION_NOT_EDITABLE: a submission can only be changed while it is a draft or has been returned (this one is %)',
      v_sub.status
      using errcode = '42501';
  end if;

  if not (v_sub.created_by = p_actor_id
          or v_sub.submitted_by = p_actor_id
          or coalesce(v_is_admin, false)) then
    raise exception 'ORDER_SUBMISSION_NOT_OWNED: that employee does not own this submission'
      using errcode = '42501';
  end if;
end;
$$;

revoke execute on function public.assert_order_submission_editor(uuid, uuid)
  from public, anon, authenticated, service_role;

-- ── 8a. Create a draft ──────────────────────────────────────────────────────
-- The row must exist before the workbook is uploaded, because the object key is
-- submissions/{submission_id}/original/... and the storage policies authorize
-- from that id. Same ordering as Order Request attachments (20260711000000).

create or replace function public.create_order_submission(p_client_name text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := public.assert_order_submission_actor();
  v_id    uuid;
begin
  if not public.actor_has_module_permission('orders', 'create') then
    raise exception 'You do not have permission to create an order submission'
      using errcode = '42501';
  end if;

  insert into public.order_submissions (status, submitted_by, created_by, client_name)
  values ('draft', v_actor, v_actor, nullif(btrim(coalesce(p_client_name, '')), ''))
  returning id into v_id;

  perform public.log_order_submission_activity(
    v_id, v_actor, 'submission_created', null, 'draft', null, '{}'::jsonb
  );

  return jsonb_build_object('id', v_id, 'status', 'draft');
end;
$$;

revoke execute on function public.create_order_submission(text) from public, anon;
grant  execute on function public.create_order_submission(text) to authenticated;

-- ── 8b. Replace the parsed snapshot, atomically — SERVICE ROLE ONLY ─────────
--
-- THIS FUNCTION IS NOT CALLABLE FROM A BROWSER, AND MUST NEVER BECOME SO.
--
-- It is the only thing that writes a price, a quantity, a line total, a product
-- line or an image mapping. Every one of those values must come from parsing the
-- workbook the employee actually uploaded. If an authenticated client could
-- reach this function it could simply state its own figures — the parser would
-- become decoration, and an approver would be reviewing numbers nobody derived
-- from the document. So EXECUTE is revoked from PUBLIC, anon AND authenticated,
-- and granted to service_role alone.
--
-- THE SERVER API THAT WILL CALL IT (a later phase) MUST:
--   1. authenticate the request and resolve the employee from that session —
--      never from the request body;
--   2. read the uploaded workbook from the order-files bucket;
--   3. run the Phase 1 parser (src/lib/pi/masterSheetParser.ts) server-side;
--   4. call this function with a service-role client, passing the parser's
--      output and the authenticated employee's id as p_actor_id.
-- It must NOT accept a parse result from the browser, because a client-supplied
-- parse is a client-supplied price.
--
-- p_actor_id is for audit AND authorization, and is re-validated from scratch by
-- assert_order_submission_editor: being handed an id by the service role proves
-- nothing on its own.
--
-- One transaction replaces the header, the commercial footer, the workbook
-- reference, the parse diagnostics AND every item. Items are deleted and
-- re-inserted rather than merged: a re-parse is a new reading of the document,
-- and merging would leave lines from a previous upload behind.
--
-- p_payload contract (keys absent are treated as null / empty):
--   header     : client_name, creation_date, source_created_by, boe_gst,
--                contact_number, bill_to_name, bill_to_phone, bill_to_gst,
--                billing_address, ship_to_name, ship_to_phone, ship_to_gst,
--                shipping_address, order_confirmation_date, dispatch_commitment,
--                source_order_number
--   commercial : gross_product_amount, discount_amount, subtotal_after_discount,
--                fabric_cost, packing_cost, transportation_amount,
--                transportation_text, total_before_gst, gst_amount, grand_total
--   source     : workbook_path, workbook_name, workbook_size_bytes,
--                workbook_sha256, template_version
--   parse      : warnings (array), blocking_issues (array)
--   items      : array of { id, source_row, item_sequence, source_product_code,
--                product_name, quantity, dimensions, material, customization,
--                cost_per_piece, total_amount, image_storage_path,
--                image_mime_type, image_sha256, image_anchor_row, sort_order }
--                `id` is optional and client-chosen; see the note on the insert.
--
-- A single jsonb argument rather than forty scalar parameters, matching
-- import_meeting_rows (20260814000000). The shape is validated here; the column
-- constraints are the backstop.

create or replace function public.replace_order_submission_parse(
  p_submission_id uuid,
  p_actor_id      uuid,
  p_payload       jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_status     text;
  v_header     jsonb := coalesce(p_payload -> 'header', '{}'::jsonb);
  v_commercial jsonb := coalesce(p_payload -> 'commercial', '{}'::jsonb);
  v_source     jsonb := coalesce(p_payload -> 'source', '{}'::jsonb);
  v_parse      jsonb := coalesce(p_payload -> 'parse', '{}'::jsonb);
  v_items      jsonb := coalesce(p_payload -> 'items', '[]'::jsonb);
  v_warnings   jsonb := coalesce(v_parse -> 'warnings', '[]'::jsonb);
  v_blocking   jsonb := coalesce(v_parse -> 'blocking_issues', '[]'::jsonb);
  v_count      integer;
begin
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'ORDER_SUBMISSION_PAYLOAD_INVALID: a JSON object is required'
      using errcode = 'P0001';
  end if;
  if jsonb_typeof(v_items) <> 'array' then
    raise exception 'ORDER_SUBMISSION_PAYLOAD_INVALID: items must be an array'
      using errcode = 'P0001';
  end if;
  if jsonb_typeof(v_warnings) <> 'array' or jsonb_typeof(v_blocking) <> 'array' then
    raise exception 'ORDER_SUBMISSION_PAYLOAD_INVALID: parse.warnings and parse.blocking_issues must be arrays'
      using errcode = 'P0001';
  end if;

  -- Serializes two uploads racing on the same submission, so the row the items
  -- are attached to is the row that was checked.
  select s.status into v_status
  from public.order_submissions s
  where s.id = p_submission_id
  for update;

  if not found then
    raise exception 'Order submission % not found', p_submission_id using errcode = 'P0002';
  end if;

  -- Re-derives everything about p_actor_id from the database: active, holds
  -- orders.create, owns THIS submission, and the submission is still editable.
  -- Deliberately NOT can_edit_order_submission(), which resolves auth.uid() —
  -- under the service role that is NULL and the check would pass vacuously for
  -- an admin branch or fail for everyone. The actor is explicit on this path,
  -- so the authorization must be explicit too.
  perform public.assert_order_submission_editor(p_submission_id, p_actor_id);

  update public.order_submissions set
    client_name             = nullif(btrim(coalesce(v_header ->> 'client_name', '')), ''),
    creation_date           = nullif(v_header ->> 'creation_date', '')::date,
    source_created_by       = nullif(btrim(coalesce(v_header ->> 'source_created_by', '')), ''),
    boe_gst                 = nullif(btrim(coalesce(v_header ->> 'boe_gst', '')), ''),
    contact_number          = nullif(btrim(coalesce(v_header ->> 'contact_number', '')), ''),
    bill_to_name            = nullif(btrim(coalesce(v_header ->> 'bill_to_name', '')), ''),
    bill_to_phone           = nullif(btrim(coalesce(v_header ->> 'bill_to_phone', '')), ''),
    bill_to_gst             = nullif(btrim(coalesce(v_header ->> 'bill_to_gst', '')), ''),
    billing_address         = nullif(btrim(coalesce(v_header ->> 'billing_address', '')), ''),
    ship_to_name            = nullif(btrim(coalesce(v_header ->> 'ship_to_name', '')), ''),
    ship_to_phone           = nullif(btrim(coalesce(v_header ->> 'ship_to_phone', '')), ''),
    ship_to_gst             = nullif(btrim(coalesce(v_header ->> 'ship_to_gst', '')), ''),
    shipping_address        = nullif(btrim(coalesce(v_header ->> 'shipping_address', '')), ''),
    order_confirmation_date = nullif(v_header ->> 'order_confirmation_date', '')::date,
    dispatch_commitment     = nullif(btrim(coalesce(v_header ->> 'dispatch_commitment', '')), ''),
    source_order_number     = nullif(btrim(coalesce(v_header ->> 'source_order_number', '')), ''),

    source_workbook_path       = nullif(btrim(coalesce(v_source ->> 'workbook_path', '')), ''),
    source_workbook_name       = nullif(btrim(coalesce(v_source ->> 'workbook_name', '')), ''),
    source_workbook_size_bytes = nullif(v_source ->> 'workbook_size_bytes', '')::bigint,
    source_workbook_sha256     = nullif(btrim(lower(coalesce(v_source ->> 'workbook_sha256', ''))), ''),
    template_version           = nullif(btrim(coalesce(v_source ->> 'template_version', '')), ''),

    parse_warnings        = v_warnings,
    parse_blocking_issues = v_blocking,

    gross_product_amount    = coalesce(nullif(v_commercial ->> 'gross_product_amount', '')::numeric, 0),
    discount_amount         = coalesce(nullif(v_commercial ->> 'discount_amount', '')::numeric, 0),
    subtotal_after_discount = nullif(v_commercial ->> 'subtotal_after_discount', '')::numeric,
    fabric_cost             = nullif(v_commercial ->> 'fabric_cost', '')::numeric,
    packing_cost            = nullif(v_commercial ->> 'packing_cost', '')::numeric,
    transportation_amount   = nullif(v_commercial ->> 'transportation_amount', '')::numeric,
    transportation_text     = nullif(btrim(coalesce(v_commercial ->> 'transportation_text', '')), ''),
    total_before_gst        = nullif(v_commercial ->> 'total_before_gst', '')::numeric,
    gst_amount              = nullif(v_commercial ->> 'gst_amount', '')::numeric,
    grand_total             = nullif(v_commercial ->> 'grand_total', '')::numeric
  where id = p_submission_id;

  -- Atomic replacement: the old reading of the document goes, the new one lands,
  -- and no caller can observe a half-replaced item list.
  delete from public.order_submission_items where submission_id = p_submission_id;

  insert into public.order_submission_items (
    id, submission_id, source_row, item_sequence, source_product_code, product_name,
    quantity, dimensions, material, customization, cost_per_piece, total_amount,
    image_storage_path, image_mime_type, image_sha256, image_anchor_row, sort_order
  )
  select
    -- The CLIENT may supply the item id, and normally does.
    --
    -- The documented image key is submissions/{submission_id}/images/{item_id},
    -- and the images are uploaded BEFORE this function runs — so an id the
    -- database invented here would be one the already-stored object could never
    -- match. Letting the caller choose it also means a re-parse that keeps the
    -- same ids keeps its images addressable, instead of orphaning every one of
    -- them. A collision inside one payload is refused by the primary key.
    coalesce(nullif(item ->> 'id', '')::uuid, gen_random_uuid()),
    p_submission_id,
    (item ->> 'source_row')::integer,
    nullif(btrim(coalesce(item ->> 'item_sequence', '')), ''),
    nullif(btrim(coalesce(item ->> 'source_product_code', '')), ''),
    nullif(btrim(coalesce(item ->> 'product_name', '')), ''),
    (item ->> 'quantity')::numeric,
    nullif(btrim(coalesce(item ->> 'dimensions', '')), ''),
    -- Separate columns, deliberately. Never merged.
    nullif(btrim(coalesce(item ->> 'material', '')), ''),
    nullif(btrim(coalesce(item ->> 'customization', '')), ''),
    (item ->> 'cost_per_piece')::numeric,
    (item ->> 'total_amount')::numeric,
    nullif(btrim(coalesce(item ->> 'image_storage_path', '')), ''),
    nullif(btrim(coalesce(item ->> 'image_mime_type', '')), ''),
    nullif(btrim(lower(coalesce(item ->> 'image_sha256', ''))), ''),
    nullif(item ->> 'image_anchor_row', '')::integer,
    coalesce(nullif(item ->> 'sort_order', '')::integer, (ordinality - 1)::integer)
  from jsonb_array_elements(v_items) with ordinality as t(item, ordinality);

  select count(*) into v_count
  from public.order_submission_items where submission_id = p_submission_id;

  perform public.log_order_submission_activity(
    p_submission_id, p_actor_id, 'parse_replaced', v_status, v_status, null,
    jsonb_build_object(
      'item_count',           v_count,
      'warning_count',        jsonb_array_length(v_warnings),
      'blocking_issue_count', jsonb_array_length(v_blocking)
    )
  );

  return jsonb_build_object(
    'id', p_submission_id,
    'status', v_status,
    'item_count', v_count,
    'blocking_issue_count', jsonb_array_length(v_blocking)
  );
end;
$$;

-- authenticated is revoked ALONGSIDE public and anon — the whole point of this
-- function. service_role is granted explicitly rather than left to Supabase's
-- default privileges, so the intent is stated in the schema and survives any
-- change to those defaults.
revoke execute on function public.replace_order_submission_parse(uuid, uuid, jsonb)
  from public, anon, authenticated;
grant  execute on function public.replace_order_submission_parse(uuid, uuid, jsonb)
  to service_role;

comment on function public.replace_order_submission_parse(uuid, uuid, jsonb) is
  'SERVICE ROLE ONLY. Writes the parsed commercial snapshot and every product line of a PI submission. Not callable by anon or authenticated, because these values must come from parsing the uploaded workbook server-side and never from a browser. p_actor_id is re-validated against the database, not trusted.';

-- ── 8c. Submit for review ───────────────────────────────────────────────────
-- draft → submitted, and needs_changes → submitted for a corrected record.
--
-- A PATH STRING IS NOT A FILE. Every file this submission claims is proved to
-- exist as a real storage.objects row, in the right bucket, at the exact key the
-- database records, carrying an acceptable content type — before the status
-- moves. Without that, a submission could reach a reviewer with source_workbook_path
-- set to a plausible string and nothing behind it, and the emptiness would only
-- surface when somebody tried to open the workbook.
--
-- The key shapes are re-derived here rather than trusted:
--   workbook  submissions/{submission_id}/original/{filename}
--   image     submissions/{submission_id}/images/{item_id}.{png|jpg|jpeg|webp}
-- The submission id and the ITEM id are matched literally, so a path naming
-- another submission, or another item's id, is refused. Traversal, absolute and
-- backslash keys cannot match the anchored patterns at all.

create or replace function public.submit_order_submission(p_submission_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor      uuid := public.assert_order_submission_actor();
  v_sub        public.order_submissions%rowtype;
  v_item_count integer;
  v_incomplete integer;
  v_bad        integer;
  v_bad_row    integer;
begin
  if not public.actor_has_module_permission('orders', 'create') then
    raise exception 'You do not have permission to submit an order submission'
      using errcode = '42501';
  end if;

  select * into v_sub
  from public.order_submissions
  where id = p_submission_id
  for update;

  if not found then
    raise exception 'Order submission % not found', p_submission_id using errcode = 'P0002';
  end if;

  if not public.can_edit_order_submission(p_submission_id) then
    raise exception 'This order submission cannot be submitted by you in its current state'
      using errcode = '42501';
  end if;

  if jsonb_array_length(v_sub.parse_blocking_issues) > 0 then
    raise exception
      'ORDER_SUBMISSION_BLOCKED: % issue(s) must be fixed in the workbook before this can be submitted',
      jsonb_array_length(v_sub.parse_blocking_issues)
      using errcode = 'P0001';
  end if;

  if coalesce(btrim(v_sub.client_name), '') = '' then
    raise exception 'ORDER_SUBMISSION_INCOMPLETE: a client name is required'
      using errcode = 'P0001';
  end if;

  if coalesce(btrim(v_sub.source_workbook_path), '') = '' then
    raise exception 'ORDER_SUBMISSION_INCOMPLETE: the uploaded workbook is missing'
      using errcode = 'P0001';
  end if;

  -- ── The workbook: shape, then existence, then type ──
  --
  -- The anchored pattern pins the whole key: the literal prefix, THIS
  -- submission's id, the original/ folder, and a single final segment with no
  -- slash in it. A traversal, an absolute key or a backslash cannot satisfy it,
  -- and neither can another submission's folder.
  if v_sub.source_workbook_path !~
     ('^submissions/' || p_submission_id::text || '/original/[^/]+$') then
    raise exception
      'ORDER_SUBMISSION_BAD_WORKBOOK_PATH: the workbook is not stored under submissions/%/original/', p_submission_id
      using errcode = 'P0001';
  end if;

  if not exists (
    select 1 from storage.objects o
    where o.bucket_id = 'order-files'
      and o.name = v_sub.source_workbook_path
  ) then
    raise exception
      'ORDER_SUBMISSION_WORKBOOK_NOT_STORED: no file exists in order-files at the recorded workbook path'
      using errcode = 'P0001';
  end if;

  -- Content type is read from the object Storage recorded at upload, not from
  -- anything the caller said. The bucket's allowed_mime_types already refuses a
  -- disallowed upload, so an object here always carries one; a row without a
  -- recorded type is treated as unproven rather than waved through.
  if not exists (
    select 1 from storage.objects o
    where o.bucket_id = 'order-files'
      and o.name = v_sub.source_workbook_path
      and o.metadata ->> 'mimetype'
          = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ) then
    raise exception
      'ORDER_SUBMISSION_WORKBOOK_NOT_XLSX: the stored workbook is not an .xlsx file'
      using errcode = 'P0001';
  end if;

  select count(*) into v_item_count
  from public.order_submission_items where submission_id = p_submission_id;

  if v_item_count = 0 then
    raise exception 'ORDER_SUBMISSION_INCOMPLETE: at least one product line is required'
      using errcode = 'P0001';
  end if;

  -- The three fields that are optional at rest and required to submit.
  select count(*) into v_incomplete
  from public.order_submission_items
  where submission_id = p_submission_id
    and (
      item_sequence is null
      or product_name is null
      or image_storage_path is null
    );

  if v_incomplete > 0 then
    raise exception
      'ORDER_SUBMISSION_INCOMPLETE: % product line(s) are missing an item sequence, a name or a representative image',
      v_incomplete
      using errcode = 'P0001';
  end if;

  -- ── Every image: the key must name THIS submission and THIS item ──
  --
  -- i.id is interpolated into the pattern, so a row whose image_storage_path
  -- points at a different item's id — or at another submission entirely — is
  -- refused even though the string looks perfectly well formed. That is the
  -- check that stops one product's photograph being presented as another's.
  select count(*), min(i.source_row) into v_bad, v_bad_row
  from public.order_submission_items i
  where i.submission_id = p_submission_id
    and i.image_storage_path !~
        ('^submissions/' || p_submission_id::text || '/images/' || i.id::text
         || '\.(png|jpg|jpeg|webp)$');

  if v_bad > 0 then
    raise exception
      'ORDER_SUBMISSION_BAD_IMAGE_PATH: % product image path(s) do not name this submission and their own product line (first at row %)',
      v_bad, v_bad_row
      using errcode = 'P0001';
  end if;

  -- ── Every image: a real object, of a real image type ──
  select count(*), min(i.source_row) into v_bad, v_bad_row
  from public.order_submission_items i
  where i.submission_id = p_submission_id
    and not exists (
      select 1 from storage.objects o
      where o.bucket_id = 'order-files'
        and o.name = i.image_storage_path
        and o.metadata ->> 'mimetype' in ('image/png', 'image/jpeg', 'image/webp')
    );

  if v_bad > 0 then
    raise exception
      'ORDER_SUBMISSION_IMAGE_NOT_STORED: % product image(s) are missing from storage or are not a PNG, JPEG or WEBP (first at row %)',
      v_bad, v_bad_row
      using errcode = 'P0001';
  end if;

  update public.order_submissions
     set status = 'submitted',
         review_note = null
   where id = p_submission_id;

  perform public.log_order_submission_activity(
    p_submission_id, v_actor, 'submitted', v_sub.status, 'submitted', null,
    jsonb_build_object('item_count', v_item_count, 'resubmitted', v_sub.status = 'needs_changes')
  );

  return jsonb_build_object('id', p_submission_id, 'status', 'submitted', 'item_count', v_item_count);
end;
$$;

revoke execute on function public.submit_order_submission(uuid) from public, anon;
grant  execute on function public.submit_order_submission(uuid) to authenticated;

-- ── 8d. Send it back ────────────────────────────────────────────────────────
-- submitted → needs_changes, by a reviewer holding orders.approve_order. The
-- reason is mandatory: returning a submission without saying why produces
-- another submission with the same problem.

create or replace function public.request_order_submission_changes(
  p_submission_id uuid,
  p_note          text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor  uuid := public.assert_order_submission_actor();
  v_status text;
  v_note   text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if not public.actor_has_module_permission('orders', 'approve_order') then
    raise exception 'You do not have permission to review order submissions'
      using errcode = '42501';
  end if;

  if v_note is null then
    raise exception 'ORDER_SUBMISSION_NOTE_REQUIRED: say what needs to change'
      using errcode = 'P0001';
  end if;

  select s.status into v_status
  from public.order_submissions s
  where s.id = p_submission_id
  for update;

  if not found then
    raise exception 'Order submission % not found', p_submission_id using errcode = 'P0002';
  end if;

  if v_status <> 'submitted' then
    raise exception
      'ORDER_SUBMISSION_NOT_UNDER_REVIEW: only a submitted record can be sent back (this one is %)', v_status
      using errcode = 'P0001';
  end if;

  update public.order_submissions
     set status = 'needs_changes',
         review_note = v_note
   where id = p_submission_id;

  perform public.log_order_submission_activity(
    p_submission_id, v_actor, 'changes_requested', 'submitted', 'needs_changes', v_note, '{}'::jsonb
  );

  return jsonb_build_object('id', p_submission_id, 'status', 'needs_changes');
end;
$$;

revoke execute on function public.request_order_submission_changes(uuid, text) from public, anon;
grant  execute on function public.request_order_submission_changes(uuid, text) to authenticated;

-- ═══ 9. Private storage ═════════════════════════════════════════════════════
--
-- One bucket for the whole PI lifecycle.
--
--   submissions/{submission_id}/original/{uuid}-{safe_filename}   the upload
--   submissions/{submission_id}/images/{item_id}.{ext}            extracted photos
--
-- Reserved for later phases, and reachable today by NO client role — the
-- policies below authorize the `submissions/` prefix only, so these paths are
-- service-role territory until the approval phase adds rules for them:
--
--   orders/{order_id}/versions/{version}/approved.xlsx
--   orders/{order_id}/versions/{version}/approved.pdf
--
-- 10 MiB per object, the same product limit as order-request-attachments
-- (20260711000000) and src/lib/pi/workbookReader.ts PI_MAX_WORKBOOK_BYTES.
-- application/pdf is admitted now so the approval phase adds no bucket change;
-- nothing writes a PDF yet.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'order-files',
  'order-files',
  false,
  10485760,
  array[
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'image/png',
    'image/jpeg',
    'image/webp',
    'application/pdf'
  ]
)
on conflict (id) do update set
  public             = excluded.public,
  file_size_limit    = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- The submission id an object key belongs to, or null when the key is not a
-- submission path. split_part never raises, so a malformed name fails closed
-- rather than erroring — the same reasoning as 20260711000000's storage rules,
-- and the reason there is no ::uuid cast anywhere in this chain.
-- Every built-in is schema-qualified to pg_catalog. The function is not
-- SECURITY DEFINER — it is pure string arithmetic — but it is evaluated inside
-- storage policies, so pinning the operators and functions it resolves means a
-- caller-controlled search_path can never change what a path decodes to.
create or replace function public.order_file_submission_id(p_object_name text)
returns uuid
language sql
immutable
as $$
  select case
    -- A key containing a traversal segment, a backslash or a leading slash is
    -- not a well-formed object key. Refusing it here means a caller cannot
    -- authorize against their OWN submission id and then have the stored key
    -- resolve somewhere else — including into the reserved orders/ prefix.
    -- Mirrors isUnsafeEntryName in src/lib/xlsxMediaOptimizer.ts.
    when p_object_name is null then null
    when p_object_name like '/%' then null
    -- '%\\%' and not '%\%': backslash is LIKE's default escape character, so a
    -- single one would escape the trailing % and match a literal percent sign
    -- instead of the backslash this is looking for.
    when p_object_name like '%\\%' then null
    when p_object_name = '..'
      or p_object_name like '../%'
      or p_object_name like '%/..'
      or p_object_name like '%/../%' then null
    when pg_catalog.split_part(p_object_name, '/', 1) <> 'submissions' then null
    when pg_catalog.split_part(p_object_name, '/', 2) !~
         '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then null
    else pg_catalog.split_part(p_object_name, '/', 2)::uuid
  end;
$$;

comment on function public.order_file_submission_id(text) is
  'The submission id encoded in an order-files object key, or null when the key is not a submissions/{id}/... path. Returns null rather than raising on a malformed key, so storage policies fail closed.';

revoke execute on function public.order_file_submission_id(text) from public, anon;
grant  execute on function public.order_file_submission_id(text) to authenticated;

-- Objects are authorized by the SUBMISSION their path names. An object key that
-- does not decode to a submission this caller may reach matches nothing, so
-- knowing a path grants nothing.
--
-- READING AND WRITING ARE DIFFERENT AUTHORITIES, and the two predicates below
-- are deliberately not the same one:
--
--   SELECT  can_view_order_submission        owner, assigned reviewer, an
--                                            orders.approve_order holder, or an
--                                            active admin. Review needs sight of
--                                            the workbook and every photograph.
--   INSERT  can_write_order_submission_file  the OWNER only, only while the
--   DELETE                                   submission is a draft or has been
--                                            returned, and only while they hold
--                                            orders.create.
--
-- A reviewer therefore reads everything and writes nothing. Being able to open
-- a file confers no ability to replace it, which is what keeps "the workbook the
-- approver read is the workbook the employee uploaded" true.

create policy "order_files_select" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'order-files'
    and public.module_entry_open('orders')
    and public.can_view_order_submission(public.order_file_submission_id(name))
  );

create policy "order_files_insert" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'order-files'
    and public.module_entry_open('orders')
    and public.can_write_order_submission_file(public.order_file_submission_id(name))
  );

create policy "order_files_delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'order-files'
    and public.module_entry_open('orders')
    and public.can_write_order_submission_file(public.order_file_submission_id(name))
  );

-- NO UPDATE POLICY, and that is what makes stored files immutable.
--
-- It is also what defeats upsert. A Supabase upload sent with x-upsert resolves
-- to an UPDATE of storage.objects when the key already exists; with no UPDATE
-- policy for any client role that write is refused outright, so an upsert cannot
-- be used to swap a submitted workbook while leaving its path, size and hash
-- looking untouched. A genuine correction is delete + insert, and both halves
-- are refused once the submission leaves the employee's hands.

-- ═══ 10. Permission: orders.approve_order ═══════════════════════════════════
--
-- A NEW action, deliberately not orders.approve. That one already means
-- "convert an Order Request" and is checked by convert_order_request_to_order,
-- reject_order_request and request_order_request_clarification
-- (20260901000000). Reusing it would silently hand PI approval authority to
-- everyone who can convert an Order Request today.
--
-- default_allowed = false, and it is registered in PROTECTED_ACTIONS in
-- src/lib/permissions/levels.ts so no Viewer / Contributor / Manager preset can
-- reach it. It is granted explicitly, per employee, or not at all. Nothing here
-- grants it to anybody.

insert into public.permission_actions (action_key, display_name, is_system)
values ('approve_order', 'Approve Order Submissions', false)
on conflict (action_key) do nothing;

insert into public.module_permission_actions (module_id, action_id, default_allowed)
select pm.id, pa.id, false
from public.permission_modules pm
join public.permission_actions pa on pa.action_key = 'approve_order'
where pm.module_key = 'orders'
on conflict (module_id, action_id) do nothing;

-- ═══ 11. Assertions ═════════════════════════════════════════════════════════
--
-- These fail the migration rather than let a partial apply look successful.

do $$
declare
  v_bad text;
  v_n   integer;
begin
  -- RLS on, on all three tables.
  select string_agg(c.relname, ', ') into v_bad
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname in ('order_submissions', 'order_submission_items', 'order_submission_activity')
    and not c.relrowsecurity;
  if v_bad is not null then
    raise exception 'RLS is not enabled on: %', v_bad;
  end if;

  -- Not one write policy exists for a client role on any of the three.
  select string_agg(p.polname, ', ') into v_bad
  from pg_policy p
  join pg_class c on c.oid = p.polrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname in ('order_submissions', 'order_submission_items', 'order_submission_activity')
    and p.polpermissive
    and p.polcmd in ('a', 'w', 'd');
  if v_bad is not null then
    raise exception 'Unexpected client write policies: %', v_bad;
  end if;

  -- The module entry gates must be RESTRICTIVE. A permissive one would OR with
  -- the ownership rules and GRANT access instead of restricting it.
  select string_agg(p.polname, ', ') into v_bad
  from pg_policy p
  join pg_class c on c.oid = p.polrelid
  where p.polname = c.relname || '_module_entry_gate'
    and c.relname in ('order_submissions', 'order_submission_items', 'order_submission_activity')
    and p.polpermissive;
  if v_bad is not null then
    raise exception 'These gates are PERMISSIVE and would grant access: %', v_bad;
  end if;

  select count(*) into v_n
  from pg_policy p
  join pg_class c on c.oid = p.polrelid
  where p.polname = c.relname || '_module_entry_gate'
    and c.relname in ('order_submissions', 'order_submission_items', 'order_submission_activity');
  if v_n <> 3 then
    raise exception 'Expected 3 module entry gates on the submission tables, found %', v_n;
  end if;

  -- No client role may write the tables directly.
  select string_agg(format('%s:%s', table_name, privilege_type), ', ') into v_bad
  from information_schema.role_table_grants
  where table_schema = 'public'
    and table_name in ('order_submissions', 'order_submission_items', 'order_submission_activity')
    and grantee in ('anon', 'authenticated')
    and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE');
  if v_bad is not null then
    raise exception 'Client roles still hold write privileges: %', v_bad;
  end if;

  -- Every SECURITY DEFINER function this migration adds must pin search_path.
  select string_agg(p.proname, ', ') into v_bad
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prosecdef
    and p.proname in (
      'order_submissions_enforce_status_transition',
      'order_submissions_guard_frozen_columns',
      'can_view_order_submission',
      'can_edit_order_submission',
      'can_write_order_submission_file',
      'log_order_submission_activity',
      'assert_order_submission_actor',
      'assert_order_submission_editor',
      'create_order_submission',
      'replace_order_submission_parse',
      'submit_order_submission',
      'request_order_submission_changes'
    )
    and not exists (
      select 1 from unnest(coalesce(p.proconfig, array[]::text[])) cfg
      where cfg like 'search_path=%'
    );
  if v_bad is not null then
    raise exception 'These SECURITY DEFINER functions have a mutable search_path: %', v_bad;
  end if;

  -- The parse writer must be unreachable from a browser. This is the assertion
  -- that would fail if a future edit "helpfully" granted it back.
  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'replace_order_submission_parse'
      and (
        has_function_privilege('authenticated', p.oid, 'EXECUTE')
        or has_function_privilege('anon', p.oid, 'EXECUTE')
      )
  ) then
    raise exception
      'replace_order_submission_parse is executable by a client role; parsed commercial data would be client-writable';
  end if;

  -- ...and it must remain reachable by the server that will call it.
  if not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'replace_order_submission_parse'
      and has_function_privilege('service_role', p.oid, 'EXECUTE')
  ) then
    raise exception 'replace_order_submission_parse is not executable by service_role';
  end if;

  -- The internal helpers must be reachable by nobody but their definer callers.
  select string_agg(p.proname, ', ') into v_bad
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in (
      'log_order_submission_activity',
      'assert_order_submission_actor',
      'assert_order_submission_editor'
    )
    and (
      has_function_privilege('authenticated', p.oid, 'EXECUTE')
      or has_function_privilege('anon', p.oid, 'EXECUTE')
      or has_function_privilege('service_role', p.oid, 'EXECUTE')
    );
  if v_bad is not null then
    raise exception 'These internal functions are executable by a role: %', v_bad;
  end if;

  -- Storage writes must not resolve the READ predicate.
  select string_agg(p.polname, ', ') into v_bad
  from pg_policy p
  join pg_class c on c.oid = p.polrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'storage' and c.relname = 'objects'
    and p.polname in ('order_files_insert', 'order_files_delete')
    and coalesce(pg_get_expr(p.polqual, p.polrelid), '')
        || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')
        not like '%can_write_order_submission_file%';
  if v_bad is not null then
    raise exception 'These storage write policies do not use the write predicate: %', v_bad;
  end if;

  -- No UPDATE policy on order-files, or upsert would defeat immutability.
  if exists (
    select 1
    from pg_policy p
    join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'storage' and c.relname = 'objects'
      and p.polname like 'order_files_%'
      and p.polcmd = 'w'
  ) then
    raise exception 'An UPDATE policy exists on order-files; stored files would not be immutable';
  end if;

  -- The bucket is private and capped.
  if not exists (
    select 1 from storage.buckets
    where id = 'order-files' and public = false and file_size_limit = 10485760
  ) then
    raise exception 'order-files is not private at the 10 MiB limit';
  end if;

  -- approve_order exists, on Orders, denied by default.
  if not exists (
    select 1
    from public.module_permission_actions mpa
    join public.permission_modules pm on pm.id = mpa.module_id
    join public.permission_actions pa on pa.id = mpa.action_id
    where pm.module_key = 'orders'
      and pa.action_key = 'approve_order'
      and mpa.default_allowed = false
  ) then
    raise exception 'orders.approve_order is not registered as deny-by-default';
  end if;

  -- Nobody has been granted it by this migration.
  select count(*) into v_n
  from public.employee_permission_overrides epo
  join public.permission_actions pa on pa.id = epo.action_id
  where pa.action_key = 'approve_order';
  if v_n <> 0 then
    raise exception 'approve_order has been granted to % employee(s); this migration must grant it to nobody', v_n;
  end if;
end $$;
