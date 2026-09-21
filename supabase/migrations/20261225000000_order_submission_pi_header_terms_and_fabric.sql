-- ═══════════════════════════════════════════════════════════════════════════
-- 20261225000000 — What a Draft PI must say before it is finalized:
--                  the client's city, the standard commercial terms, and
--                  who is providing the fabric
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHY THIS EXISTS (owner decision 2026-09-21)
-- -------------------------------------------
-- Three facts a BOE PI is not complete without, and which nothing in the
-- product could record:
--
--   1. WHERE THE CLIENT IS. A PI carries a billing address as one free-text
--      blob, or nothing at all. Operations needs the city to route and to plan
--      dispatch, and "somewhere inside a paragraph, if the workbook bothered"
--      is not an answer a query can give. So the city becomes its own column,
--      mandatory for finalization alongside the client's name.
--
--   2. WHAT WAS ACTUALLY QUOTED. Every BOE PI carries the same standard
--      sentence about what the price does and does not include. It was nowhere
--      in the system, so it was nowhere on a generated document; and because
--      individual client agreements DO fold in fabric, packing or transport, it
--      cannot be a constant printed at render time. It is a stored, editable
--      value that STARTS at the standard wording.
--
--   3. WHO IS PROVIDING THE FABRIC. The PI has always carried a Total Fabric
--      Cost, and the figure alone does not say whether BOE is sourcing the
--      fabric, the client is supplying it, or the question is still open. The
--      three readings have opposite commercial consequences, and a document
--      that leaves the reader to guess is a document that will be guessed
--      wrong.
--
-- ── WHY fabric_responsibility HAS NO DEFAULT ───────────────────────────────
--
-- Deliberately NULL on every existing row and on every new one. NULL means
-- NOBODY HAS ANSWERED, which is a different fact from 'not_selected' — the
-- answer "we have not decided yet", given on purpose.
--
-- A default would have been the easy thing and the wrong one: it would make the
-- system take a commercial position on a document a client is sent. So NULL
-- blocks finalization, and all three explicit values — including 'not_selected'
-- — unblock it, because choosing "not decided yet" IS a decision about what the
-- PI should say. The generated PI states whichever of the three was chosen, in
-- words, and never leaves it to inference.
--
-- ── WHY commercial_terms_note HAS ONE, AND WHY IT IS SET IN TWO STATEMENTS ──
--
-- The opposite case. There IS a standard BOE answer, it applies unless somebody
-- says otherwise, and printing it is what the business already does on paper.
-- So a new draft carries it without any code having to remember to.
--
-- BUT IT MUST NOT REWRITE HISTORY, and a single `add column ... default` would.
-- PostgreSQL fills EVERY EXISTING ROW when a default is supplied on ADD COLUMN,
-- which would make a PI approved months ago read as though it had always stated
-- these terms. It had not. Regenerating that Order’s documents would then print
-- a commercial condition nobody agreed to, on a document a client already holds.
-- That is not a cosmetic difference; it is the system asserting something untrue
-- about a finalized record.
--
-- So the column is added WITHOUT a default and the default is set AFTERWARDS, in
-- its own statement. ADD COLUMN with no default leaves every existing row NULL;
-- ALTER COLUMN SET DEFAULT applies only to rows inserted from then on. Existing
-- PIs therefore say NULL — "this record never stated terms", which is exactly
-- what is true of them — and NULL prints nothing at all on a regenerated
-- document, so a historical PDF comes out as it always did.
--
-- The same reasoning gives fabric_responsibility and client_city no default and
-- no backfill either, and §5 asserts that no row was touched.
--
-- ── WHAT THE WORKBOOK ITSELF SAYS ─────────────────────────────────────────
--
-- The BOE template carries both: a dropdown beside the Total Fabric Cost row
-- ("Under BOE" / "Client will send Fabric" / "Not Selected") and the red
-- "Note:" block that states the same standard terms. A person who filled
-- those in has already answered, and asking again on screen would be asking
-- twice. The parser reads both (src/lib/pi/masterSheetParser.ts).
--
-- CRITICALLY, replace_order_submission_parse DOES NOT TOUCH EITHER COLUMN,
-- and this migration does not make it. Every other parsed value is REPLACED
-- on every upload, which is right for a value the workbook is the record of;
-- these two are not, because a person may legitimately know better than the
-- sheet — a fabric answer settled on a call, terms negotiated afterwards.
--
-- So they are SEEDED instead, by seed_order_submission_pi_terms (§3b), under
-- one rule: FILL A HOLE, NEVER OVERWRITE AN ANSWER. That is what stops a
-- re-upload, a regeneration or a PI change from silently reinstating the
-- sheet's wording over an agreement somebody negotiated and typed in.
--
-- ── WHERE FINALIZATION IS REFUSED, AND WHERE IT IS NOT ─────────────────────
--
-- THE UPLOAD IS NOT A GATE. A workbook missing any of this still becomes an
-- editable draft: the draft is where the gaps get filled, and refusing the
-- import would send somebody back to Excel to type what the form in front of
-- them could take. Everything here is checked at SUBMISSION, against the STORED
-- COLUMNS, so a hand-corrected draft passes on its own merits.
--
-- ── PHASE 1 OF TWO, AND THE ORDER IS THE POINT ─────────────────────────────
--
-- THIS FILE ENFORCES NOTHING. It adds the columns, the editors and the gate
-- FUNCTION; it does not put that gate in front of any submission door. A
-- separate, minimal migration does that, after the new Draft PI screen is live
-- in production and verified.
--
-- WHY, CONCRETELY. The deployed application has no field for client_city and
-- no control for fabric_responsibility. Enforcing the seven fields at the same
-- moment the columns appear would refuse EVERY PI SUBMISSION in the window
-- between applying the migration and deploying the new code — for values
-- nobody could enter — and a failed deploy would leave the Orders module
-- unable to submit at all.
--
-- Each half is therefore safe on its own. Applying this file to production
-- today changes nothing the current application does: three nullable columns
-- with no backfill, one editor that gained a field old callers never send, one
-- new editor nothing calls yet, one service-role seed, and an inert function.
-- §5 asserts exactly that, door by door.
--
-- APPROVAL IS NOT GATED IN EITHER PHASE. approve_order_submission and
-- approve_pi_review decide a PI that was already submitted, and PIs submitted
-- before this feature carry none of the new fields. Gating approval would
-- strand them: a record legitimately awaiting a decision could never receive
-- one. The rule belongs where a PI BECOMES final, which is submission.
--
-- ── WHAT THIS DOES NOT TOUCH ───────────────────────────────────────────────
--
-- No submission door, no PI number, no order number, no figure, no total, no
-- status, no payment,
-- no allocation, no document file, no policy, no grant to anon, no existing
-- product row. submit_pi_for_review_internal, approve_order_submission,
-- replace_order_submission_parse and update_order_submission_schedule_terms
-- are not re-emitted at all. No production row is rewritten beyond the column
-- default this migration introduces.
--
-- NO FABRIC FIGURE IS EVER WRITTEN OR CLEARED HERE. Neither the terms editor
-- nor the seed assigns fabric_cost, fabric_cost_meaning or fabric_cost_text,
-- and §5 asserts it against the function bodies rather than trusting it:
-- changing who provides the fabric leaves the figure the workbook stated
-- exactly where it was, and correcting that figure stays what it always was,
-- a correction to the workbook.
-- ═══════════════════════════════════════════════════════════════════════════

do $$
begin
  if to_regprocedure('public.can_admin_edit_order_submission(uuid)') is null then
    raise exception 'DEPENDENCY MISSING: 20260927000000 must be applied before this migration';
  end if;
  if to_regprocedure('public.update_order_submission_client_details(uuid, jsonb, integer, text)') is null then
    raise exception 'DEPENDENCY MISSING: 20260928000000 must be applied before this migration';
  end if;
  if to_regprocedure('public.submit_pi_for_review_internal(uuid, text, text, text, text)') is null then
    raise exception 'DEPENDENCY MISSING: 20260921000000 must be applied before this migration';
  end if;
  if to_regprocedure('public.supersede_order_documents(uuid, text)') is null then
    raise exception 'DEPENDENCY MISSING: the document supersession helper must exist before this migration';
  end if;
end $$;


-- ═══ 1. The three columns ═══════════════════════════════════════════════════

alter table public.order_submissions
  add column if not exists client_city text;

comment on column public.order_submissions.client_city is
  'The client''s city or location. Its own column rather than a line inside billing_address, because operations routes and plans dispatch by it and a paragraph cannot be queried. Mandatory before a PI can be submitted; optional while it is a draft.';

-- TWO STATEMENTS, AND THE ORDER IS THE POINT. See the header: ADD COLUMN with a
-- default would backfill every historical PI with terms it never stated.
alter table public.order_submissions
  add column if not exists commercial_terms_note text;

alter table public.order_submissions
  alter column commercial_terms_note
  set default 'Given prices are ex-factory. Fabric, packaging and GST, if not quoted, will be extra as applicable.';

comment on column public.order_submissions.commercial_terms_note is
  'What the quoted prices do and do not include, as the PI states it. A NEW draft starts at the standard BOE wording (the column DEFAULT, set in its own statement so no existing row was backfilled — a historical PI says NULL, because it never stated terms, and prints none). Editable, because individual client agreements fold in fabric, packing or transportation. replace_order_submission_parse does NOT write this column: a re-upload or a PI change must never reinstate the standard wording over a negotiated one.';

alter table public.order_submissions
  add column if not exists fabric_responsibility text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.order_submissions'::regclass
      and conname  = 'order_submissions_fabric_responsibility_valid'
  ) then
    alter table public.order_submissions
      add constraint order_submissions_fabric_responsibility_valid
      check (fabric_responsibility is null
             or fabric_responsibility in ('not_selected', 'boe', 'client'));
  end if;
end $$;

comment on column public.order_submissions.fabric_responsibility is
  'Who provides the fabric on this order: ''boe'', ''client'', or ''not_selected'' for a deliberate "not decided yet". NULL means NOBODY HAS ANSWERED and is not a fourth option — it blocks submission, while all three explicit values allow it. No DEFAULT, on purpose: a default would have the system take a commercial position on a document a client is sent. Carries no figure; fabric_cost is written and cleared elsewhere and is never touched when this changes.';


-- ═══ 2. Supplying the city, through the editor that already owns the client ══
--
-- The 20260928000000 body, re-emitted with ONE field added to the allow-list
-- and to the printed list, plus the matching keep-it rule beside the client
-- name's. Every other line — the lock-first ordering, the authority pair, the
-- row_version check, the reason rule, the unknown-key refusal, the
-- blank-is-NULL rule, the Order mirror, the supersession and both trails — is
-- unchanged.
--
-- THE CITY IS A PRINTED FIELD. It appears in the billing block of the generated
-- documents, so changing it makes a ready pair no longer current, exactly as
-- changing the billing address does.

create or replace function public.update_order_submission_client_details(
  p_submission_id    uuid,
  p_fields           jsonb,
  p_expected_version integer default null,
  p_reason           text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor      uuid := auth.uid();
  v_sub        public.order_submissions%rowtype;
  v_is_admin   boolean;
  v_is_owner   boolean;
  v_after_sub  boolean;
  v_reason     text;
  v_key        text;
  v_new        text;
  v_old        text;
  v_changes    jsonb := '{}'::jsonb;
  v_changed    integer := 0;
  v_superseded integer := 0;
  v_version    integer;
  v_client_changed boolean := false;

  -- THE ALLOW-LIST. Every editable field of this section, and nothing else.
  -- A key not on this list is refused, not skipped.
  c_fields constant text[] := array[
    'client_name', 'client_city', 'contact_number',
    'bill_to_name', 'bill_to_phone', 'bill_to_gst', 'billing_address',
    'ship_to_name', 'ship_to_phone', 'ship_to_gst', 'shipping_address'
  ];

  -- Fields that appear on the confirmed documents. A change to one of these
  -- makes an existing ready pair no longer current.
  c_printed constant text[] := array[
    'client_name', 'client_city', 'bill_to_name', 'billing_address',
    'ship_to_name', 'shipping_address'
  ];
begin
  if v_actor is null then
    raise exception 'ORDER_SUBMISSION_NOT_AUTHENTICATED: you must be signed in'
      using errcode = '42501';
  end if;

  if p_fields is null or jsonb_typeof(p_fields) <> 'object' then
    raise exception 'ORDER_SUBMISSION_BAD_FIELDS: a JSON object of fields is required'
      using errcode = 'P0001';
  end if;

  -- THE ROW LOCK COMES FIRST, before any judgement of state, authority or
  -- staleness, so the state every check reads is the state the write lands on.
  select * into v_sub
  from public.order_submissions
  where id = p_submission_id
  for update;

  if not found then
    raise exception 'ORDER_SUBMISSION_NOT_FOUND: submission % not found', p_submission_id
      using errcode = 'P0002';
  end if;

  -- ── Authority ──
  v_is_admin := public.can_admin_edit_order_submission(p_submission_id);
  v_is_owner := public.can_edit_order_submission(p_submission_id);

  if not (v_is_admin or v_is_owner) then
    raise exception
      'ORDER_SUBMISSION_NOT_EDITABLE: this PI cannot be changed by you in its current state'
      using errcode = '42501';
  end if;

  -- ── Optimistic concurrency ──
  if p_expected_version is not null
     and v_sub.row_version is distinct from p_expected_version then
    raise exception
      'ORDER_SUBMISSION_STALE: this PI changed while you were editing it. Reopen it and apply your change again.'
      using errcode = 'P0001';
  end if;

  -- ── The reason, for an amendment ──
  v_after_sub := v_sub.status not in ('draft', 'needs_changes') or v_sub.order_id is not null;

  if v_after_sub and not v_is_owner then
    v_reason := nullif(btrim(coalesce(p_reason, '')), '');
    if v_reason is null then
      raise exception
        'ORDER_SUBMISSION_REASON_REQUIRED: editing a submitted PI needs a reason'
        using errcode = 'P0001';
    end if;
    if length(v_reason) > 500 then
      raise exception
        'ORDER_SUBMISSION_REASON_TOO_LONG: the reason may be at most 500 characters'
        using errcode = 'P0001';
    end if;
  else
    v_reason := null;
  end if;

  -- ── Every key must be one this function owns ──
  for v_key in select jsonb_object_keys(p_fields) loop
    if not (v_key = any (c_fields)) then
      raise exception
        'ORDER_SUBMISSION_UNKNOWN_FIELD: % is not an editable client detail', v_key
        using errcode = 'P0001';
    end if;
    if jsonb_typeof(p_fields -> v_key) not in ('string', 'null') then
      raise exception
        'ORDER_SUBMISSION_BAD_FIELD_TYPE: % must be text or null', v_key
        using errcode = 'P0001';
    end if;
  end loop;

  -- ── Compute the change set ──
  --
  -- Blank becomes NULL, matching replace_order_submission_parse exactly, so a
  -- field cleared by hand and a field the parser never found are the same
  -- state.
  for v_key in select unnest(c_fields) loop
    continue when not (p_fields ? v_key);

    v_new := nullif(btrim(coalesce(p_fields ->> v_key, '')), '');

    if v_new is not null and length(v_new) > 500 then
      raise exception
        'ORDER_SUBMISSION_FIELD_TOO_LONG: % may be at most 500 characters', v_key
        using errcode = 'P0001';
    end if;

    execute format('select ($1).%I::text', v_key) into v_old using v_sub;

    if v_new is distinct from v_old then
      v_changed := v_changed + 1;
      v_changes := v_changes || jsonb_build_object(
        v_key, jsonb_build_object('from', v_old, 'to', v_new));
      if v_key = 'client_name' then v_client_changed := true; end if;
    end if;
  end loop;

  -- ── A reviewable PI must keep its client name ──
  if v_changes ? 'client_name'
     and (v_changes -> 'client_name' ->> 'to') is null
     and v_sub.status not in ('draft', 'needs_changes') then
    raise exception
      'ORDER_SUBMISSION_CLIENT_NAME_REQUIRED: a PI that has been submitted must keep a client name'
      using errcode = 'P0001';
  end if;

  -- ── AND ITS CITY, for the same reason ──
  --
  -- The city became mandatory at submission (20261225000000), so emptying it
  -- afterwards would leave a record standing in a state it could not have
  -- reached. A DRAFT may be emptied freely — that is what a draft is for.
  if v_changes ? 'client_city'
     and (v_changes -> 'client_city' ->> 'to') is null
     and v_sub.status not in ('draft', 'needs_changes') then
    raise exception
      'ORDER_SUBMISSION_CLIENT_CITY_REQUIRED: a PI that has been submitted must keep a client city'
      using errcode = 'P0001';
  end if;

  -- NOTHING CHANGED: no write, no event, no supersession.
  if v_changed = 0 then
    return jsonb_build_object(
      'submission_id', p_submission_id,
      'changed',       false,
      'fields',        0,
      'row_version',   v_sub.row_version,
      'superseded_documents', 0
    );
  end if;

  -- ── The write ──
  --
  -- Each column takes its new value only when the caller SENT that key, so a
  -- partial object edits exactly what it names and leaves the rest alone.
  update public.order_submissions set
    client_name      = case when p_fields ? 'client_name'      then nullif(btrim(coalesce(p_fields ->> 'client_name', '')), '')      else client_name      end,
    client_city      = case when p_fields ? 'client_city'      then nullif(btrim(coalesce(p_fields ->> 'client_city', '')), '')      else client_city      end,
    contact_number   = case when p_fields ? 'contact_number'   then nullif(btrim(coalesce(p_fields ->> 'contact_number', '')), '')   else contact_number   end,
    bill_to_name     = case when p_fields ? 'bill_to_name'     then nullif(btrim(coalesce(p_fields ->> 'bill_to_name', '')), '')     else bill_to_name     end,
    bill_to_phone    = case when p_fields ? 'bill_to_phone'    then nullif(btrim(coalesce(p_fields ->> 'bill_to_phone', '')), '')    else bill_to_phone    end,
    bill_to_gst      = case when p_fields ? 'bill_to_gst'      then nullif(btrim(coalesce(p_fields ->> 'bill_to_gst', '')), '')      else bill_to_gst      end,
    billing_address  = case when p_fields ? 'billing_address'  then nullif(btrim(coalesce(p_fields ->> 'billing_address', '')), '')  else billing_address  end,
    ship_to_name     = case when p_fields ? 'ship_to_name'     then nullif(btrim(coalesce(p_fields ->> 'ship_to_name', '')), '')     else ship_to_name     end,
    ship_to_phone    = case when p_fields ? 'ship_to_phone'    then nullif(btrim(coalesce(p_fields ->> 'ship_to_phone', '')), '')    else ship_to_phone    end,
    ship_to_gst      = case when p_fields ? 'ship_to_gst'      then nullif(btrim(coalesce(p_fields ->> 'ship_to_gst', '')), '')      else ship_to_gst      end,
    shipping_address = case when p_fields ? 'shipping_address' then nullif(btrim(coalesce(p_fields ->> 'shipping_address', '')), '') else shipping_address end,
    row_version      = row_version + 1,
    updated_at       = now()
  where id = p_submission_id
  returning row_version into v_version;

  -- ── The linked Order carries the client's name ──
  if v_sub.order_id is not null and v_client_changed then
    update public.orders
       set client_name = (v_changes -> 'client_name' ->> 'to'),
           updated_at  = now()
     where id = v_sub.order_id;
  end if;

  -- ── Ready documents stop being current ──
  if v_sub.order_id is not null
     and exists (select 1 from unnest(c_printed) k where v_changes ? k) then
    v_superseded := public.supersede_order_documents(v_sub.order_id, 'pi_data_amended');
  end if;

  if v_sub.order_id is not null then
    insert into public.order_activity_log (order_id, actor_id, event_type, payload)
    values (
      v_sub.order_id, v_actor, 'order_client_details_amended',
      jsonb_build_object(
        'fields',   v_changed,
        'changed',  v_changes,
        'by_admin', v_is_admin and not v_is_owner,
        'reason',   v_reason
      )
    );
  end if;

  -- ── The PI's own trail ──
  perform public.log_order_submission_activity(
    p_submission_id,
    v_actor,
    case when v_after_sub and not v_is_owner
         then 'client_details_amended_by_admin'
         else 'client_details_updated' end,
    v_sub.status,
    v_sub.status,
    v_reason,
    jsonb_build_object(
      'fields',                v_changed,
      'changed',               v_changes,
      'stage',                 v_sub.status,
      'after_submission',      v_after_sub,
      'superseded_documents',  v_superseded
    )
  );

  return jsonb_build_object(
    'submission_id',        p_submission_id,
    'changed',              true,
    'fields',               v_changed,
    'row_version',          v_version,
    'superseded_documents', v_superseded
  );
end;
$$;

comment on function public.update_order_submission_client_details(uuid, jsonb, integer, text) is
  'Edits a PI''s client and party details — the eleven named text fields and nothing else. The OWNER may do so in draft/needs_changes; an ACTIVE ADMIN at any stage, with a reason once the PI has been submitted. Optimistic concurrency through p_expected_version. Touches no derived value, no status, no payment and no document file. A change to a printed field — which now includes the client city — supersedes the linked Order''s ready documents.';

revoke all    on function public.update_order_submission_client_details(uuid, jsonb, integer, text) from public, anon;
grant  execute on function public.update_order_submission_client_details(uuid, jsonb, integer, text) to authenticated;


-- ═══ 3. The PI's own terms: creation date, commercial note, fabric answer ════
--
-- ITS OWN SECTION AND ITS OWN RPC, following the convention 20260928000000 set:
-- one narrow, named write path per section, so the authority and the validation
-- of each can be held in a reader's head at once.
--
-- WHY THESE THREE TOGETHER. They are what the PI SAYS ABOUT ITSELF as a
-- commercial document — when it was drawn up, what the price covers, and who
-- buys the fabric — as opposed to who the client is (§2) or when the order runs
-- (update_order_submission_schedule_terms). All three are printed, none is an
-- input to any arithmetic, and none has a twin column on public.orders, which
-- is why this function never writes public.orders and needs no amendment
-- context.
--
-- WHY IT CANNOT DELETE A FABRIC FIGURE. It assigns three columns. fabric_cost,
-- fabric_cost_meaning and fabric_cost_text are not among them. Moving the
-- responsibility to the client therefore leaves the figure the workbook carried
-- exactly where it was — the screen warns before the change and the document
-- states the answer; nothing is erased on anybody's behalf. An assertion at the
-- foot of this file holds that.

create or replace function public.update_order_submission_pi_terms(
  p_submission_id    uuid,
  p_fields           jsonb,
  p_expected_version integer default null,
  p_reason           text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor      uuid := auth.uid();
  v_sub        public.order_submissions%rowtype;
  v_is_admin   boolean;
  v_is_owner   boolean;
  v_after_sub  boolean;
  v_reason     text;
  v_key        text;
  v_new        text;
  v_old        text;
  v_changes    jsonb := '{}'::jsonb;
  v_changed    integer := 0;
  v_superseded integer := 0;
  v_version    integer;

  c_fields constant text[] := array[
    'creation_date', 'commercial_terms_note', 'fabric_responsibility'
  ];
  -- No c_printed here: every one of the three appears on the generated
  -- documents, so every one of them supersedes a ready pair. A second array
  -- listing all of them would only be something for the first to drift from.
begin
  if v_actor is null then
    raise exception 'ORDER_SUBMISSION_NOT_AUTHENTICATED: you must be signed in'
      using errcode = '42501';
  end if;

  if p_fields is null or jsonb_typeof(p_fields) <> 'object' then
    raise exception 'ORDER_SUBMISSION_BAD_FIELDS: a JSON object of fields is required'
      using errcode = 'P0001';
  end if;

  -- The row lock first, so the state every check reads is the state the write
  -- lands on.
  select * into v_sub
  from public.order_submissions
  where id = p_submission_id
  for update;

  if not found then
    raise exception 'ORDER_SUBMISSION_NOT_FOUND: submission % not found', p_submission_id
      using errcode = 'P0002';
  end if;

  v_is_admin := public.can_admin_edit_order_submission(p_submission_id);
  v_is_owner := public.can_edit_order_submission(p_submission_id);

  if not (v_is_admin or v_is_owner) then
    raise exception
      'ORDER_SUBMISSION_NOT_EDITABLE: this PI cannot be changed by you in its current state'
      using errcode = '42501';
  end if;

  if p_expected_version is not null
     and v_sub.row_version is distinct from p_expected_version then
    raise exception
      'ORDER_SUBMISSION_STALE: this PI changed while you were editing it. Reopen it and apply your change again.'
      using errcode = 'P0001';
  end if;

  v_after_sub := v_sub.status not in ('draft', 'needs_changes') or v_sub.order_id is not null;

  if v_after_sub and not v_is_owner then
    v_reason := nullif(btrim(coalesce(p_reason, '')), '');
    if v_reason is null then
      raise exception
        'ORDER_SUBMISSION_REASON_REQUIRED: editing a submitted PI needs a reason'
        using errcode = 'P0001';
    end if;
    if length(v_reason) > 500 then
      raise exception
        'ORDER_SUBMISSION_REASON_TOO_LONG: the reason may be at most 500 characters'
        using errcode = 'P0001';
    end if;
  else
    v_reason := null;
  end if;

  -- ── Every key must be one this function owns ──
  for v_key in select jsonb_object_keys(p_fields) loop
    if not (v_key = any (c_fields)) then
      -- Named explicitly where the mistake is an understandable one, so the
      -- caller is pointed at the right door rather than told "unknown field".
      if v_key in ('fabric_cost', 'fabric_cost_meaning', 'fabric_cost_text') then
        raise exception
          'ORDER_SUBMISSION_WRONG_EDITOR: % is a commercial figure and is not set through the PI terms editor', v_key
          using errcode = 'P0001';
      end if;
      if v_key in ('payment_terms', 'billing_terms', 'order_confirmation_date', 'due_date') then
        raise exception
          'ORDER_SUBMISSION_WRONG_EDITOR: % is set through update_order_submission_schedule_terms', v_key
          using errcode = 'P0001';
      end if;
      raise exception
        'ORDER_SUBMISSION_UNKNOWN_FIELD: % is not an editable PI term', v_key
        using errcode = 'P0001';
    end if;
    if jsonb_typeof(p_fields -> v_key) not in ('string', 'null') then
      raise exception
        'ORDER_SUBMISSION_BAD_FIELD_TYPE: % must be text or null', v_key
        using errcode = 'P0001';
    end if;
  end loop;

  -- ── Compute the change set ──
  for v_key in select unnest(c_fields) loop
    continue when not (p_fields ? v_key);

    v_new := nullif(btrim(coalesce(p_fields ->> v_key, '')), '');

    if v_key = 'creation_date' and v_new is not null then
      -- THE SHAPE BEFORE THE CAST. PostgreSQL's date input accepts 'yesterday',
      -- 'today', 'now', 'epoch' and 'infinity', every one of which would store
      -- a RELATIVE date where a fact about a document belongs. The same rule
      -- update_order_submission_schedule_terms applies to its two dates, for
      -- the same reason.
      if v_new !~ '^\d{4}-\d{2}-\d{2}$' then
        raise exception
          'ORDER_SUBMISSION_BAD_DATE: creation_date must be a calendar date in YYYY-MM-DD form'
          using errcode = 'P0001';
      end if;
      begin
        perform v_new::date;
      exception when others then
        raise exception
          'ORDER_SUBMISSION_BAD_DATE: creation_date must be a calendar date in YYYY-MM-DD form'
          using errcode = 'P0001';
      end;
      -- Re-spelled through the type, so a stored date and a submitted one are
      -- compared in one spelling and an identical date cannot read as a change.
      v_new := (v_new::date)::text;
    end if;

    if v_key = 'fabric_responsibility' and v_new is not null
       and v_new not in ('not_selected', 'boe', 'client') then
      -- The CHECK constraint would refuse this anyway; saying it here means the
      -- caller reads what the choices are instead of a catalog identifier.
      raise exception
        'ORDER_SUBMISSION_BAD_FABRIC_RESPONSIBILITY: choose not_selected, boe or client'
        using errcode = 'P0001';
    end if;

    -- The note is allowed to be longer than the other text fields on this
    -- record. It is a paragraph of terms, not a name or a phone number, and a
    -- client agreement that folds in fabric, packing AND transport runs past
    -- 500 characters without being unreasonable.
    if v_new is not null
       and length(v_new) > (case when v_key = 'commercial_terms_note' then 2000 else 500 end) then
      raise exception
        'ORDER_SUBMISSION_FIELD_TOO_LONG: % is longer than this field allows', v_key
        using errcode = 'P0001';
    end if;

    execute format('select ($1).%I::text', v_key) into v_old using v_sub;

    if v_new is distinct from v_old then
      v_changed := v_changed + 1;
      v_changes := v_changes || jsonb_build_object(
        v_key, jsonb_build_object('from', v_old, 'to', v_new));
    end if;
  end loop;

  -- ── ONCE SUBMITTED, THE THREE ARE KEPT ──
  --
  -- They became mandatory at submission; emptying one afterwards would leave a
  -- record standing in a state it could not have reached. A DRAFT may be
  -- emptied freely.
  if v_sub.status not in ('draft', 'needs_changes') then
    if v_changes ? 'creation_date' and (v_changes -> 'creation_date' ->> 'to') is null then
      raise exception
        'ORDER_SUBMISSION_CREATION_DATE_REQUIRED: a PI that has been submitted must keep its date of creation'
        using errcode = 'P0001';
    end if;
    if v_changes ? 'commercial_terms_note'
       and (v_changes -> 'commercial_terms_note' ->> 'to') is null then
      raise exception
        'ORDER_SUBMISSION_TERMS_REQUIRED: a PI that has been submitted must keep its commercial terms'
        using errcode = 'P0001';
    end if;
    if v_changes ? 'fabric_responsibility'
       and (v_changes -> 'fabric_responsibility' ->> 'to') is null then
      raise exception
        'ORDER_SUBMISSION_FABRIC_RESPONSIBILITY_REQUIRED: a PI that has been submitted must keep a fabric responsibility'
        using errcode = 'P0001';
    end if;
  end if;

  -- NOTHING CHANGED: no write, no event, no supersession. A save that changed
  -- nothing is not an amendment and must not read like one in the trail.
  if v_changed = 0 then
    return jsonb_build_object(
      'submission_id', p_submission_id,
      'changed',       false,
      'fields',        0,
      'row_version',   v_sub.row_version,
      'superseded_documents', 0
    );
  end if;

  -- THREE COLUMNS. No fabric figure appears on the left of an assignment here,
  -- and the assertions at the foot of this file prove it.
  update public.order_submissions set
    creation_date = case when p_fields ? 'creation_date'
      then nullif(btrim(coalesce(p_fields ->> 'creation_date', '')), '')::date
      else creation_date end,
    commercial_terms_note = case when p_fields ? 'commercial_terms_note'
      then nullif(btrim(coalesce(p_fields ->> 'commercial_terms_note', '')), '')
      else commercial_terms_note end,
    fabric_responsibility = case when p_fields ? 'fabric_responsibility'
      then nullif(btrim(coalesce(p_fields ->> 'fabric_responsibility', '')), '')
      else fabric_responsibility end,
    row_version = row_version + 1,
    updated_at  = now()
  where id = p_submission_id
  returning row_version into v_version;

  if v_sub.order_id is not null then
    v_superseded := public.supersede_order_documents(v_sub.order_id, 'pi_data_amended');

    insert into public.order_activity_log (order_id, actor_id, event_type, payload)
    values (
      v_sub.order_id, v_actor, 'order_client_details_amended',
      jsonb_build_object(
        'section',  'pi_terms',
        'fields',   v_changed,
        'changed',  v_changes,
        'by_admin', v_is_admin and not v_is_owner,
        'reason',   v_reason
      )
    );
  end if;

  -- BEFORE AND AFTER, per field, on the PI's own trail. The values are a date,
  -- a paragraph of commercial terms and one of three words; no figure, no image
  -- and no secret can reach here, because the allow-list admits three named
  -- columns and refuses everything else.
  --
  -- The two action names are ones 20261001000000 already admits. A new KIND of
  -- event would need the activity CHECK extended in its own migration, and this
  -- is not a new kind of event — it is a section edit, and `section` says which.
  perform public.log_order_submission_activity(
    p_submission_id,
    v_actor,
    case when v_after_sub and not v_is_owner
         then 'client_details_amended_by_admin'
         else 'client_details_updated' end,
    v_sub.status,
    v_sub.status,
    v_reason,
    jsonb_build_object(
      'section',               'pi_terms',
      'fields',                v_changed,
      'changed',               v_changes,
      'stage',                 v_sub.status,
      'after_submission',      v_after_sub,
      'superseded_documents',  v_superseded
    )
  );

  return jsonb_build_object(
    'submission_id',        p_submission_id,
    'changed',              true,
    'fields',               v_changed,
    'row_version',          v_version,
    'superseded_documents', v_superseded
  );
end;
$$;

comment on function public.update_order_submission_pi_terms(uuid, jsonb, integer, text) is
  'Edits what a PI says about itself as a commercial document: its date of creation, its commercial terms note, and who provides the fabric. Those three and nothing else — a fabric COST aimed here is refused by name. Owner in draft/needs_changes; active admin at any stage with a reason after submission. row_version concurrency. Writes no figure, no status and no column of public.orders; a change supersedes the linked Order''s ready documents, because all three are printed.';

revoke all    on function public.update_order_submission_pi_terms(uuid, jsonb, integer, text) from public, anon;
grant  execute on function public.update_order_submission_pi_terms(uuid, jsonb, integer, text) to authenticated;


-- ═══ 3b. Seeding the two from the workbook — SERVICE ROLE ONLY ══════════════
--
-- WHY THIS IS NOT PART OF replace_order_submission_parse.
--
-- Every other parsed value is REPLACED on every upload, and must be: the
-- workbook is the record of what the client was sent, so a re-import restates
-- it. These two are different in kind, because a person may legitimately know
-- better than the sheet — the fabric answer may have been settled on a call
-- after the workbook was written, and the terms may have been negotiated. A
-- re-upload that restated the sheet's version would undo that silently, which
-- is precisely what the owner decision forbids.
--
-- So they are SEEDED, not replaced, and the rule is one line: FILL A HOLE,
-- NEVER OVERWRITE AN ANSWER.
--
--   fabric_responsibility  written only while it is NULL — that is, only while
--                          nobody has answered at all.
--   commercial_terms_note  written only while it is NULL or still EXACTLY the
--                          standard BOE wording. The standard wording is what
--                          the column default puts there, so "still standard"
--                          and "nobody has touched it" are the same state. Any
--                          other text is somebody's edit and is left alone.
--
-- IDEMPOTENT AND SILENT. It writes no activity entry, does not move
-- row_version and supersedes no document, because this is not an edit somebody
-- made — it is part of reading the workbook. The parse it belongs to logs that.
--
-- NOT CALLABLE FROM A BROWSER, and must never become so, for the same reason
-- replace_order_submission_parse is not: it writes a submission without asking
-- who the caller is. The service role reaches it from the import route, which
-- has already established authority, holds the processing lease, and parsed
-- the workbook itself.

create or replace function public.seed_order_submission_pi_terms(
  p_submission_id uuid,
  p_fabric_responsibility text default null,
  p_commercial_terms_note text default null,
  p_client_city           text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c_standard constant text :=
    'Given prices are ex-factory. Fabric, packaging and GST, if not quoted, will be extra as applicable.';
  v_fabric text := nullif(btrim(coalesce(p_fabric_responsibility, '')), '');
  v_terms  text := nullif(btrim(coalesce(p_commercial_terms_note, '')), '');
  v_city   text := nullif(btrim(coalesce(p_client_city, '')), '');
  v_seeded jsonb := '{}'::jsonb;
  v_before public.order_submissions%rowtype;
begin
  if v_fabric is not null and v_fabric not in ('not_selected', 'boe', 'client') then
    raise exception
      'ORDER_SUBMISSION_BAD_FABRIC_RESPONSIBILITY: choose not_selected, boe or client'
      using errcode = 'P0001';
  end if;

  if v_terms is not null and length(v_terms) > 2000 then
    -- Truncating a client's terms would be worse than refusing them.
    raise exception
      'ORDER_SUBMISSION_FIELD_TOO_LONG: commercial_terms_note is longer than this field allows'
      using errcode = 'P0001';
  end if;

  select * into v_before
  from public.order_submissions
  where id = p_submission_id
  for update;

  if not found then
    raise exception 'ORDER_SUBMISSION_NOT_FOUND: submission % not found', p_submission_id
      using errcode = 'P0002';
  end if;

  update public.order_submissions set
    fabric_responsibility = case
      when v_fabric is not null and fabric_responsibility is null then v_fabric
      else fabric_responsibility end,
    commercial_terms_note = case
      when v_terms is not null
       and (commercial_terms_note is null or btrim(commercial_terms_note) = c_standard)
      then v_terms
      else commercial_terms_note end,
    -- Read out of the billing address, and only ever into an EMPTY field: a
    -- city somebody corrected by hand outranks anything a guess produces.
    client_city = case
      when v_city is not null and client_city is null then v_city
      else client_city end
  where id = p_submission_id;

  -- What actually landed, so the caller can say so rather than assume.
  if v_fabric is not null and v_before.fabric_responsibility is null then
    v_seeded := v_seeded || jsonb_build_object('fabric_responsibility', v_fabric);
  end if;
  if v_terms is not null
     and (v_before.commercial_terms_note is null
          or btrim(v_before.commercial_terms_note) = c_standard) then
    v_seeded := v_seeded || jsonb_build_object('commercial_terms_note', true);
  end if;
  if v_city is not null and v_before.client_city is null then
    v_seeded := v_seeded || jsonb_build_object('client_city', v_city);
  end if;

  return jsonb_build_object('submission_id', p_submission_id, 'seeded', v_seeded);
end;
$$;

comment on function public.seed_order_submission_pi_terms(uuid, text, text, text) is
  'Fills a PI''s fabric responsibility and commercial terms from the uploaded workbook, and ONLY where nobody has answered: the fabric answer while it is NULL, the terms while they are NULL or still exactly the standard BOE wording. Never overwrites an edit, writes no activity entry, does not move row_version and supersedes no document. SERVICE ROLE ONLY — it establishes no authority of its own and is reached from the import route, which has.';

revoke all on function public.seed_order_submission_pi_terms(uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.seed_order_submission_pi_terms(uuid, text, text, text)
  to service_role;

-- ═══ 4. The finalization gate ═══════════════════════════════════════════════
--
-- WHAT A PI MUST SAY BEFORE IT LEAVES THE EMPLOYEE'S HANDS, asked once so the
-- screen, the door and the tests cannot word it three ways.
--
-- READS AND RAISES; DECIDES NOTHING ELSE. No lock of its own — its one caller
-- runs inside submit_pi_for_review, and submit_pi_for_review_internal takes the
-- row lock immediately after. The window between them cannot be worked into an
-- inconsistent record: the worst case is a field emptied by a concurrent editor
-- in that instant, which the NEXT submission attempt catches. Making this a
-- locking function would mean two locks on one row in one transaction for no
-- gain.

create or replace function public.assert_order_submission_finalizable(p_submission_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_sub public.order_submissions%rowtype;
begin
  select * into v_sub from public.order_submissions where id = p_submission_id;
  if not found then
    raise exception 'ORDER_SUBMISSION_NOT_FOUND: submission % not found', p_submission_id
      using errcode = 'P0002';
  end if;

  -- ONE FIELD PER MESSAGE, each naming itself. "Please complete the required
  -- fields" makes the reader hunt; these say which one, and the screen focuses
  -- it. The order is the order the form shows them in, so somebody clearing
  -- them one refusal at a time moves down the page rather than around it.
  if v_sub.creation_date is null then
    raise exception 'ORDER_SUBMISSION_INCOMPLETE: a date of creation is required'
      using errcode = 'P0001';
  end if;

  if coalesce(btrim(v_sub.source_created_by), '') = '' then
    raise exception 'ORDER_SUBMISSION_INCOMPLETE: a salesperson is required'
      using errcode = 'P0001';
  end if;

  -- THE SALESPERSON'S NUMBER, not the client's. contact_number is the BOE-side
  -- contact the workbook carries at G22, beside the BOE GST at B22; the
  -- client's numbers are bill_to_phone and ship_to_phone and stay optional.
  if coalesce(btrim(v_sub.contact_number), '') = '' then
    raise exception 'ORDER_SUBMISSION_INCOMPLETE: a salesperson contact number is required'
      using errcode = 'P0001';
  end if;

  if coalesce(btrim(v_sub.client_name), '') = '' then
    raise exception 'ORDER_SUBMISSION_INCOMPLETE: a client name is required'
      using errcode = 'P0001';
  end if;

  if coalesce(btrim(v_sub.client_city), '') = '' then
    raise exception 'ORDER_SUBMISSION_INCOMPLETE: a client city is required'
      using errcode = 'P0001';
  end if;

  -- NULL IS THE ONLY REFUSAL. 'not_selected' is a deliberate answer — "we have
  -- not decided yet, and the PI should say so" — and the document states it in
  -- words. What is refused is nobody having been asked.
  if v_sub.fabric_responsibility is null then
    raise exception
      'ORDER_SUBMISSION_INCOMPLETE: choose who provides the fabric before submitting this PI'
      using errcode = 'P0001';
  end if;

  if coalesce(btrim(v_sub.commercial_terms_note), '') = '' then
    raise exception 'ORDER_SUBMISSION_INCOMPLETE: the commercial terms note is required'
      using errcode = 'P0001';
  end if;
end;
$$;

comment on function public.assert_order_submission_finalizable(uuid) is
  'Raises ORDER_SUBMISSION_INCOMPLETE, naming one field, when a PI is missing anything a finalized PI must say: date of creation, salesperson, salesperson contact number, client name, client city, fabric responsibility, commercial terms note. Reads only. A NULL fabric responsibility is refused; all three explicit values — ''not_selected'' included — pass, because choosing "not decided yet" is a decision about what the document says.';

revoke all    on function public.assert_order_submission_finalizable(uuid) from public, anon;
grant  execute on function public.assert_order_submission_finalizable(uuid) to authenticated;


-- ── AND NOTHING CALLS IT YET ────────────────────────────────────────────────
--
-- THE GATE IS DEFINED HERE AND WIRED UP IN A SEPARATE MIGRATION, after the new
-- Draft PI screen is live in production and verified. That ordering is the
-- whole reason this file is split, and it is not caution for its own sake.
--
-- THE RELEASE HAZARD IT AVOIDS. The currently deployed application has no way
-- to set client_city or fabric_responsibility — the fields do not exist on its
-- screens. If this migration also put the seven-field assertion in front of the
-- submission doors, then between applying it and deploying the new code EVERY
-- PI SUBMISSION WOULD BE REFUSED, for a value nobody could supply. A failed or
-- delayed deploy would leave the Orders module unable to submit anything, and
-- the only way out would be a second emergency migration.
--
-- So the two halves are ordered so that each is safe alone:
--
--   PHASE 1 (this file)  purely additive. Three nullable columns with no
--                        backfill, one editor extended by one field, one new
--                        editor, one service-role seed, and this gate sitting
--                        inert. The deployed application cannot tell it ran.
--
--   PHASE 2 (later)      five wrappers, one `perform` each. Nothing else.
--                        Applied once the new UI is confirmed to populate the
--                        seven fields, at which point the assertion refuses
--                        only what the screen already refuses.
--
-- BETWEEN THE TWO, THE RULE IS THE SCREEN'S ALONE. piReadiness lists every
-- missing field and the submit control is refused without them, so an ordinary
-- user cannot submit an incomplete PI. What is NOT closed in that window is a
-- direct PostgREST call to one of the five granted doors — the bypass this
-- feature exists to shut. It is a KNOWN, TIME-BOXED GAP, open only between the
-- deploy and Phase 2, and it is no wider than the gap that exists today.

-- ═══ 5. What this migration promises, checked here ══════════════════════════

do $$
declare
  v_def   text;
  v_col   text;
  v_inner text;
  v_cfg   text[];
  v_rows  bigint;
begin
  -- ── The columns exist, with the intended defaults ──
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'order_submissions'
                   and column_name = 'client_city') then
    raise exception 'ASSERTION FAILED: order_submissions.client_city was not added';
  end if;

  select column_default into v_def from information_schema.columns
   where table_schema = 'public' and table_name = 'order_submissions'
     and column_name = 'commercial_terms_note';
  if v_def is null or v_def not like '%ex-factory%' then
    raise exception
      'ASSERTION FAILED: commercial_terms_note must default to the standard BOE wording (found %)',
      coalesce(v_def, 'no default');
  end if;

  -- FABRIC RESPONSIBILITY HAS NO DEFAULT, and that is the whole design.
  select column_default into v_def from information_schema.columns
   where table_schema = 'public' and table_name = 'order_submissions'
     and column_name = 'fabric_responsibility';
  if v_def is not null then
    raise exception
      'ASSERTION FAILED: fabric_responsibility must have NO default — a default would assume an answer (found %)',
      v_def;
  end if;

  -- NO ROW WAS REWRITTEN. The three columns are new and every one of them must
  -- still be NULL on every record that existed before this file ran: a PI
  -- approved months ago did not state these things, and saying it did would
  -- misrepresent a finalized document.
  select count(*) into v_rows from public.order_submissions
   where fabric_responsibility is not null;
  if v_rows > 0 then
    raise exception
      'ASSERTION FAILED: this migration set a fabric responsibility on % row(s)', v_rows;
  end if;

  select count(*) into v_rows from public.order_submissions
   where commercial_terms_note is not null;
  if v_rows > 0 then
    raise exception
      'ASSERTION FAILED: the commercial terms default backfilled % existing row(s). Historical PIs must keep saying nothing, because they stated nothing.', v_rows;
  end if;

  select count(*) into v_rows from public.order_submissions where client_city is not null;
  if v_rows > 0 then
    raise exception 'ASSERTION FAILED: this migration set a client city on % row(s)', v_rows;
  end if;

  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.order_submissions'::regclass
                   and conname  = 'order_submissions_fabric_responsibility_valid') then
    raise exception 'ASSERTION FAILED: the fabric responsibility CHECK was not added';
  end if;

  -- ── The terms editor writes THREE columns and no figure ──
  v_def := pg_get_functiondef('public.update_order_submission_pi_terms(uuid, jsonb, integer, text)'::regprocedure);

  foreach v_col in array array[
    'fabric_cost', 'fabric_cost_meaning', 'fabric_cost_text',
    'packing_cost', 'transportation_amount', 'total_before_gst', 'gst_amount',
    'grand_total', 'subtotal_after_discount', 'gross_product_amount',
    'discount_amount', 'billing_percentage', 'status', 'order_id',
    'client_name', 'source_created_by', 'contact_number'
  ] loop
    if v_def ~ ('\m' || v_col || '\M\s*=') then
      raise exception
        'ASSERTION FAILED: the PI terms editor assigns %, which it does not own', v_col;
    end if;
  end loop;

  if v_def !~ '\mcreation_date\M\s*='
     or v_def !~ '\mcommercial_terms_note\M\s*='
     or v_def !~ '\mfabric_responsibility\M\s*=' then
    raise exception 'ASSERTION FAILED: the PI terms editor does not write its own three columns';
  end if;

  if v_def ~ 'update public\.orders' then
    raise exception 'ASSERTION FAILED: the PI terms editor writes public.orders; it owns no Order column';
  end if;

  if v_def not like '%can_admin_edit_order_submission%'
     or v_def not like '%can_edit_order_submission%'
     or v_def not like '%auth.uid()%'
     or v_def not like '%for update%' then
    raise exception 'ASSERTION FAILED: the PI terms editor is missing an authority check or its row lock';
  end if;

  -- ── The client editor gained the city and kept everything else ──
  v_def := pg_get_functiondef('public.update_order_submission_client_details(uuid, jsonb, integer, text)'::regprocedure);
  if v_def not like '%client_city%' then
    raise exception 'ASSERTION FAILED: the client editor cannot set the city';
  end if;
  foreach v_col in array array[
    'client_name', 'contact_number', 'bill_to_name', 'bill_to_phone', 'bill_to_gst',
    'billing_address', 'ship_to_name', 'ship_to_phone', 'ship_to_gst', 'shipping_address'
  ] loop
    if v_def !~ ('\m' || v_col || '\M\s*=') then
      raise exception 'ASSERTION FAILED: the client editor lost %', v_col;
    end if;
  end loop;
  foreach v_col in array array[
    'total_before_gst', 'gst_amount', 'grand_total', 'subtotal_after_discount',
    'gross_product_amount', 'billing_percentage'
  ] loop
    if v_def ~ ('\m' || v_col || '\M\s*=') then
      raise exception 'ASSERTION FAILED: the client editor assigns %, which is derived', v_col;
    end if;
  end loop;

  -- ── The gate names all seven, and the door runs it BEFORE the work ──
  v_def := pg_get_functiondef('public.assert_order_submission_finalizable(uuid)'::regprocedure);
  foreach v_col in array array[
    'creation_date', 'source_created_by', 'contact_number',
    'client_name', 'client_city', 'fabric_responsibility', 'commercial_terms_note'
  ] loop
    if v_def not like ('%' || v_col || '%') then
      raise exception 'ASSERTION FAILED: the finalization gate does not check %', v_col;
    end if;
  end loop;

  -- It must refuse an UNANSWERED fabric question and must NOT refuse a chosen
  -- 'not_selected'. Written as a property of the source, because that
  -- distinction is the one thing about this gate that is easy to get wrong.
  if v_def !~ 'fabric_responsibility is null' then
    raise exception 'ASSERTION FAILED: the gate must refuse a NULL fabric responsibility';
  end if;
  if v_def ~ 'v_sub\.fabric_responsibility\s*=\s*''not_selected''' then
    raise exception
      'ASSERTION FAILED: the gate refuses a deliberate ''not_selected'', which is one of the three offered answers';
  end if;

  -- ── NO SUBMISSION DOOR WAS TOUCHED, AND THE GATE IS NOT WIRED IN ──
  --
  -- The property Phase 1 has to prove is the OPPOSITE of the one Phase 2 will:
  -- that applying this file changes nothing the deployed application does. So
  -- every door is checked to be exactly what it was, and the gate is checked
  -- to be called by none of them.
  for v_col in
    select unnest(array[
      'public.submit_pi_for_review(uuid, text, text, text, text)',
      'public.submit_order_submission(uuid)',
      'public.submit_order_submission_with_note(uuid, text)',
      'public.submit_order_submission_with_advance(uuid, text, text, numeric, text)',
      'public.submit_order_submission_with_advance_amount(uuid, text, text, numeric, text)'
    ])
  loop
    v_def := pg_get_functiondef(v_col::regprocedure);
    if v_def like '%assert_order_submission_finalizable%' then
      raise exception
        'ASSERTION FAILED: % runs the finalization gate. Phase 1 must leave every submission door alone — the deployed UI cannot supply the fields it would demand.', v_col;
    end if;
    -- And each is still reachable by exactly whom it was.
    if not has_function_privilege('authenticated', v_col, 'execute') then
      raise exception 'ASSERTION FAILED: % is no longer callable by authenticated', v_col;
    end if;
  end loop;

  -- THE GATE EXISTS, ready for Phase 2, and is called by nothing.
  if to_regprocedure('public.assert_order_submission_finalizable(uuid)') is null then
    raise exception 'ASSERTION FAILED: the finalization gate was not created';
  end if;

  -- APPROVAL IS UNTOUCHED, in this phase and the next.
  v_def := pg_get_functiondef('public.approve_order_submission(uuid)'::regprocedure);
  if v_def like '%assert_order_submission_finalizable%' then
    raise exception 'ASSERTION FAILED: approval runs the finalization gate';
  end if;

  -- ── THE IMPLEMENTATION IS UNTOUCHED ──
  v_def := pg_get_functiondef('public.submit_pi_for_review_internal(uuid, text, text, text, text)'::regprocedure);
  if v_def not like '%ORDER_SUBMISSION_BLOCKED%'
     or v_def not like '%ORDER_SUBMISSION_INCOMPLETE%'
     or v_def not like '%advance_exception_status%' then
    raise exception 'ASSERTION FAILED: submit_pi_for_review_internal lost a rule it had';
  end if;

  -- ── Grants and search paths on everything this file emitted ──
  foreach v_col in array array[
    'public.update_order_submission_pi_terms(uuid, jsonb, integer, text)',
    'public.assert_order_submission_finalizable(uuid)',
    'public.submit_pi_for_review(uuid, text, text, text, text)',
    'public.update_order_submission_client_details(uuid, jsonb, integer, text)'
  ] loop
    if not (select prosecdef from pg_proc where oid = v_col::regprocedure) then
      raise exception 'ASSERTION FAILED: % must stay SECURITY DEFINER', v_col;
    end if;
    select coalesce(proconfig, '{}') into v_cfg from pg_proc where oid = v_col::regprocedure;
    if not ('search_path=public, pg_temp' = any (v_cfg)) then
      raise exception 'ASSERTION FAILED: % must pin search_path', v_col;
    end if;
    if not has_function_privilege('authenticated', v_col, 'execute') then
      raise exception 'ASSERTION FAILED: authenticated cannot call %', v_col;
    end if;
    if has_function_privilege('anon', v_col, 'execute') then
      raise exception 'ASSERTION FAILED: anon can call %', v_col;
    end if;
  end loop;

  -- ── The seed fills holes and nothing else ──
  v_def := pg_get_functiondef('public.seed_order_submission_pi_terms(uuid, text, text, text)'::regprocedure);
  if v_def !~ 'fabric_responsibility is null' then
    raise exception 'ASSERTION FAILED: the seed must write the fabric answer only while nobody has answered';
  end if;
  if v_def !~ 'client_city is null' then
    raise exception 'ASSERTION FAILED: the seed must write the city only into an empty field';
  end if;
  if v_def not like '%ex-factory%' then
    raise exception 'ASSERTION FAILED: the seed must recognise the standard wording it is allowed to replace';
  end if;
  if v_def ~ '\mrow_version\M\s*=' or v_def like '%log_order_submission_activity%'
     or v_def like '%supersede_order_documents%' then
    raise exception 'ASSERTION FAILED: the seed is part of the parse, not an edit; it logs and supersedes nothing';
  end if;
  if has_function_privilege('authenticated', 'public.seed_order_submission_pi_terms(uuid, text, text, text)', 'execute')
     or has_function_privilege('anon', 'public.seed_order_submission_pi_terms(uuid, text, text, text)', 'execute') then
    raise exception 'ASSERTION FAILED: the seed must be reachable by the service role alone';
  end if;

  raise notice '20261225000000 applied: PI client city, commercial terms note and fabric responsibility; finalization refuses a PI missing any of the seven.';
end $$;
