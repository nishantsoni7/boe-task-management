-- ═══════════════════════════════════════════════════════════════════════════
-- Order PI submissions, phase 3B: normalized product images, and commercial
-- meaning that survives persistence.
--
-- 20260908000000 built the submission record on two assumptions that the real
-- workbooks disproved:
--
--   1. ONE IMAGE PER PRODUCT. The representative photograph lives in three
--      columns on order_submission_items, keyed by a flat path
--      submissions/{sid}/images/{item_id}.{ext}. A production PI also anchors
--      CUSTOMIZATION images over column K — pictures of what should differ from
--      the representative one — and a product may carry any number of them,
--      including none. Three columns cannot hold "zero or more", and a path
--      with no role in it cannot distinguish them.
--
--   2. A COST IS A NUMBER. fabric_cost and packing_cost are plain numerics, so
--      four different commercial facts collapse into one value: a real charge,
--      no such charge (a dash), a charge already inside another figure
--      ("Inclusive"), and an unresolved note. Storing 0 for the middle two
--      makes the record say the client was not charged when sometimes they
--      were.
--
-- This migration fixes both, ADDITIVELY. Nothing 20260908000000 created is
-- dropped: the three image columns on order_submission_items stay as
-- compatibility fields and keep being written, while the normalized child table
-- becomes the authority for new writes and for submission validation.
--
-- WHAT DOES NOT CHANGE
--   * No client role gains a write anywhere. The normalized table is SELECT-only
--     for authenticated, exactly like its parents.
--   * replace_order_submission_parse stays SERVICE ROLE ONLY.
--   * No approval, no rejection, no order numbering, no payment. The status
--     transition trigger from 20260908000000 is untouched and still refuses
--     every move into approved/rejected.
--   * The order-files bucket, its privacy, its 10 MiB ceiling and its three
--     policies are untouched — see section 5 for why nested image keys need no
--     policy change and must not get one.
--
-- Two functions are RESTATED with create or replace, and both are restated in
-- full because Postgres has no partial redefinition:
--   replace_order_submission_parse  writes the new columns and the new table
--   submit_order_submission         validates against the new table
-- Their authorization models are unchanged; submissionSchema.test.ts and
-- submissionImages.test.ts assert that.
-- ═══════════════════════════════════════════════════════════════════════════

-- ═══ 1. The item identity a child row can point at ══════════════════════════
--
-- order_submission_items.id is already unique on its own. This composite is
-- added so a child table can carry BOTH ids and have the database prove they
-- agree — see the foreign key in section 2. Without it Postgres refuses the
-- composite reference, and the "this image belongs to an item of this
-- submission" rule would live only in RPC code.

alter table public.order_submission_items
  add constraint order_submission_items_id_submission_key unique (id, submission_id);

-- ═══ 2. order_submission_item_images ════════════════════════════════════════
--
-- One row per stored picture, per product line.
--
--   representative  The product. At most one per item here, exactly one to
--                   submit, always position 0.
--   customization   What should differ from it. Zero or more, positions
--                   0,1,2… in the workbook's own anchor order, so
--                   "customization image 2 of 3" means the same thing to a
--                   reviewer as it does to the file.
--
-- WHY THE PATH IS A CHECK CONSTRAINT AND NOT A CONVENTION. storage_path is
-- required to be exactly
--   submissions/{submission_id}/images/{item_id}/{role}/{position}-{sha256}.{ext}
-- built from THIS ROW'S OWN columns. A row therefore cannot name another
-- submission, another item, another role, another position or other bytes — not
-- through an RPC bug, not through a service-role mistake, not through a crafted
-- payload. The database refuses to store the association at all. Traversal,
-- absolute and backslash keys cannot satisfy the anchored pattern either.
--
-- WHY THE HASH IS IN THE KEY: THE OBJECT IS IMMUTABLE.
--
-- Without it the key is a function of (item, role, position) alone, so
-- re-processing a draft whose picture CHANGED writes new bytes over the object
-- the CURRENT rows point at. If the database replacement then fails, the old
-- rows survive describing bytes that are no longer there — a silently wrong
-- commercial record, and the one failure mode that cannot be recovered by
-- retrying.
--
-- Content-addressing removes the case entirely. Different bytes are a different
-- key, so a new attempt only ever CREATES objects; it never replaces one that
-- something still references. Identical bytes are the same key, so an honest
-- retry converges on the object that is already there instead of duplicating
-- it. Cleanup of the old key becomes safe precisely because it happens after
-- the rows that pointed at it are gone.
--
-- MATERIAL, CUSTOMIZATION TEXT AND CUSTOMIZATION IMAGES REMAIN THREE THINGS.
-- Material is what the piece is made of, the customization column is what the
-- client asked to change in words, and these rows are pictures of that change.
-- The factory needs all three separately.

create table public.order_submission_item_images (
  id            uuid        primary key default gen_random_uuid(),

  submission_id uuid        not null,
  item_id       uuid        not null,

  role          text        not null check (role in ('representative', 'customization')),
  position      integer     not null check (position >= 0),

  storage_path  text        not null unique,
  mime_type     text        not null
                  check (mime_type in ('image/png', 'image/jpeg', 'image/webp')),
  sha256        text        not null check (sha256 ~ '^[0-9a-f]{64}$'),

  -- The xl/media/… part the bytes came from. Provenance only: several rows may
  -- share it when one photograph illustrates several products or several
  -- changes, and it is never used to identify or deduplicate a RELATIONSHIP.
  source_media_path text,

  -- 1-based worksheet row the picture was anchored to, so any image can be
  -- traced back to the cell it came from.
  anchor_row    integer     not null check (anchor_row > 0),

  created_at    timestamptz not null default now(),

  -- The representative image is the product's own photograph; there is only one
  -- of it, so it is always slot zero. Customization positions are free.
  constraint order_submission_item_images_representative_is_slot_zero check (
    role <> 'representative' or position = 0
  ),

  -- The path is derived, not asserted. See the note above.
  --
  -- sha256 is interpolated literally, which is safe because the column check
  -- above admits only 64 lowercase hex characters — no regex metacharacter can
  -- reach this pattern. A row whose key names a DIFFERENT hash than the row
  -- records is refused, so the key and the bytes it claims cannot drift apart.
  constraint order_submission_item_images_path_shape check (
    storage_path ~ (
      '^submissions/' || submission_id::text
      || '/images/'   || item_id::text
      || '/'          || role
      || '/'          || position::text
      || '-'          || sha256
      || '\.(png|jpg|jpeg|webp)$'
    )
  ),

  -- One picture per slot. Re-uploading a role/position replaces it rather than
  -- accumulating duplicates.
  constraint order_submission_item_images_slot_key unique (item_id, role, position),

  constraint order_submission_item_images_submission_fk
    foreign key (submission_id) references public.order_submissions(id) on delete cascade,

  -- THE COMPOSITE FOREIGN KEY, and the reason section 1 exists. Referencing
  -- (id, submission_id) rather than (id) alone means the database itself
  -- refuses an image whose item belongs to a different submission. Relying on
  -- the RPC to check that would make one bug enough to attach a product's
  -- photograph to somebody else's order.
  constraint order_submission_item_images_item_fk
    foreign key (item_id, submission_id)
    references public.order_submission_items(id, submission_id) on delete cascade
);

comment on table public.order_submission_item_images is
  'Stored pictures of a PI submission product line, one row per picture. role separates the required representative photograph from zero or more customization images. storage_path is constrained to be derived from submission_id, item_id, role and position, so a row cannot name another submission or another item.';
comment on column public.order_submission_item_images.source_media_path is
  'The xl/media/... part the bytes came from. Provenance only — several rows legitimately share it when one photograph is reused, and it never identifies a relationship.';
comment on column public.order_submission_item_images.position is
  'Slot within the role. Always 0 for representative. For customization, the workbook''s own anchor order, so "image 2 of 3" is stable across re-parses.';

-- At most one representative image per item, enforced by the database rather
-- than by the writer. "Exactly one" is a SUBMIT-time rule, not a table rule: a
-- draft must be able to hold a product whose photograph has not been read yet,
-- which is the same reasoning that leaves item_sequence nullable.
create unique index order_submission_item_images_one_representative
  on public.order_submission_item_images (item_id)
  where role = 'representative';

create index order_submission_item_images_item_idx
  on public.order_submission_item_images (item_id, role, position);

create index order_submission_item_images_submission_idx
  on public.order_submission_item_images (submission_id);

-- ═══ 3. Commercial meaning ══════════════════════════════════════════════════
--
-- Only the two "as per actual" rows. Discount, subtotal, total-before-GST, GST
-- and the grand total have no worded-zero convention and are deliberately left
-- numeric-or-nothing; transportation already has its own amount/text pair from
-- 20260908000000 and is untouched.
--
-- The four meanings mirror src/lib/pi/types.ts exactly:
--
--   numeric         a real charge. Amount is the figure — or NULL before the
--                   workbook has been parsed at all, which is the state a fresh
--                   draft is in.
--   not_applicable  a dash or a blank. There is NO such charge. Amount 0.
--   included        "Inclusive" / "Included". There IS such a charge and it is
--                   already inside another figure. Amount 0, and the wording
--                   the workbook used is kept.
--   text            anything else. No amount could be inferred; the words are
--                   kept verbatim and the parser has warned about them.
--
-- INCLUDED IS NOT NOT_APPLICABLE. Both add zero to the total and they are
-- opposite answers to "was the client charged for packing?".

-- ═══ 3a. Retry identity ═════════════════════════════════════════════════════
--
-- A hash of the exact trusted payload the server last wrote. Its only job is to
-- tell a genuine change from a replayed attempt.
--
-- Processing is idempotent by construction — deterministic item ids and
-- content-addressed image keys — so a retry rewrites the same rows with the
-- same values and is harmless. What it must NOT do is manufacture audit
-- history: an employee pressing Retry three times after a network timeout has
-- not made three submissions, and an activity trail that says otherwise is a
-- false business record. When the fingerprint is unchanged the replacement
-- still happens (it is a no-op) and no activity row is written.

alter table public.order_submissions
  add column parse_fingerprint text
    check (parse_fingerprint is null or parse_fingerprint ~ '^[0-9a-f]{64}$');

comment on column public.order_submissions.parse_fingerprint is
  'SHA-256 of the trusted parse payload last written by the server. Used only to tell a real re-parse from a replayed retry, so a retry adds no false audit entry.';

-- ═══ 3b. The processing lease ═══════════════════════════════════════════════
--
-- ONE PROCESSOR AT A TIME, PER SUBMISSION.
--
-- Storage and Postgres cannot share a transaction, so the server necessarily
-- does "upload objects, then commit rows, then delete what is now obsolete" as
-- three separate steps. Two attempts interleaving across those steps is a
-- genuine TOCTOU: A checks that an object is unreferenced, B commits rows that
-- reference it, A deletes it, and B's committed record now points at nothing.
-- A reference re-check narrows the window; it cannot close it, because the
-- check and the delete are themselves two statements.
--
-- The lease closes it. A processor takes the submission, does all three steps,
-- and only then releases. A second processor is refused outright rather than
-- being allowed to interleave, and the refusal is retryable — the employee is
-- told to try again shortly, not that anything failed.
--
-- EXPIRY, AND WHY IT IS GENEROUS. A crashed process cannot release its own
-- lease, so a stale one must eventually be takeable or the draft is stuck
-- forever. Fifteen minutes is far longer than any real processing run (parse,
-- a dozen small uploads, one RPC) and short enough that a person retrying after
-- a crash is not blocked for a working day. Taking over is the ONLY way a lease
-- moves without its token.
--
-- The token is a server-side random value. It is never sent to a browser and
-- never logged; it exists so that a release, and a parse replacement, can prove
-- they are the processor that acquired the lease rather than a late arrival
-- from an abandoned attempt.

alter table public.order_submissions
  add column processing_token      uuid,
  add column processing_started_at timestamptz;

comment on column public.order_submissions.processing_token is
  'Server-side lease token held while a trusted processing run is in flight. Never disclosed to a client. A parse replacement and a lease release must both present it.';

alter table public.order_submissions
  add constraint order_submissions_processing_lease_consistent check (
    (processing_token is null and processing_started_at is null)
    or (processing_token is not null and processing_started_at is not null)
  );

alter table public.order_submissions
  add column fabric_cost_meaning  text not null default 'numeric'
    check (fabric_cost_meaning in ('numeric', 'not_applicable', 'included', 'text')),
  add column fabric_cost_text     text,
  add column packing_cost_meaning text not null default 'numeric'
    check (packing_cost_meaning in ('numeric', 'not_applicable', 'included', 'text')),
  add column packing_cost_text    text;

comment on column public.order_submissions.fabric_cost_meaning is
  'What Master!I117 meant: numeric, not_applicable (dash/blank), included ("Inclusive"), or text. fabric_cost alone cannot distinguish a nil charge from a charge folded into another line.';
comment on column public.order_submissions.packing_cost_meaning is
  'What Master!I118 meant. Same four values as fabric_cost_meaning, and the same reason for existing.';

-- The number, the meaning and the text cannot contradict one another.
alter table public.order_submissions
  add constraint order_submissions_fabric_cost_meaning_consistent check (
    case fabric_cost_meaning
      when 'numeric'        then fabric_cost_text is null
      when 'not_applicable' then fabric_cost = 0 and fabric_cost_text is null
      when 'included'       then fabric_cost = 0 and coalesce(btrim(fabric_cost_text), '') <> ''
      when 'text'           then fabric_cost is null and coalesce(btrim(fabric_cost_text), '') <> ''
    end
  ),
  add constraint order_submissions_packing_cost_meaning_consistent check (
    case packing_cost_meaning
      when 'numeric'        then packing_cost_text is null
      when 'not_applicable' then packing_cost = 0 and packing_cost_text is null
      when 'included'       then packing_cost = 0 and coalesce(btrim(packing_cost_text), '') <> ''
      when 'text'           then packing_cost is null and coalesce(btrim(packing_cost_text), '') <> ''
    end
  );

-- ═══ 4. Privileges and RLS on the new table ═════════════════════════════════
--
-- Identical model to its parents: the client may READ what it may already see,
-- and may write nothing at all. Two independent refusals — revoked privileges
-- and no write policy — so adding a policy later still does not open the table.

alter table public.order_submission_item_images enable row level security;

revoke insert, update, delete, truncate, references, trigger
  on public.order_submission_item_images from authenticated, anon;

grant select on public.order_submission_item_images to authenticated;

-- Visibility follows the submission, exactly as the items do: owner, assigned
-- reviewer, an orders.approve_order holder, or an active admin.
create policy "order_submission_item_images_select" on public.order_submission_item_images
  for select to authenticated
  using (public.can_view_order_submission(submission_id));

-- Parent module gate. RESTRICTIVE, so it ANDs: an employee whose Order
-- Management access is switched off reaches nothing here.
create policy "order_submission_item_images_module_entry_gate" on public.order_submission_item_images
  as restrictive for all to authenticated
  using (public.module_entry_open('orders'))
  with check (public.module_entry_open('orders'));

-- ═══ 5. Storage: nested keys need no policy change, and must not get one ════
--
-- The three order-files policies from 20260908000000 authorize by
-- order_file_submission_id(name), which reads segments 1 and 2 of the key and
-- nothing else. A nested image key
--
--   submissions/{sid}/images/{item_id}/representative/0.png
--
-- therefore decodes to the same submission id as the flat key it replaces and
-- is already accepted for exactly the same people: the owner may write it while
-- the submission is a draft or has been returned and they hold orders.create;
-- reviewers may read it; nobody may update it.
--
-- Widening ANYTHING here would be a mistake, so nothing here is widened:
--   * another submission's prefix still decodes to another submission id and
--     still matches no policy;
--   * the reserved orders/{order_id}/versions/... prefix still decodes to NULL,
--     because segment 1 is not 'submissions', and remains service-role-only;
--   * traversal, backslash and absolute keys still decode to NULL.
--
-- What DOES change is which keys are ACCEPTABLE TO THE DATABASE, and that is
-- tightened rather than loosened by the path check constraint in section 2.

-- ═══ 5a. The lease functions — SERVICE ROLE ONLY ════════════════════════════
--
-- Both follow the pattern of replace_order_submission_parse: an explicit actor,
-- re-derived from the database rather than trusted, and no client role able to
-- execute them at all. An authenticated caller that could acquire a lease could
-- deny an employee the use of their own draft for fifteen minutes.

/** Fifteen minutes. See the note in section 3b. */
create or replace function public.order_submission_processing_ttl()
returns interval
language sql
immutable
set search_path = public, pg_temp
as $$ select interval '15 minutes' $$;

revoke execute on function public.order_submission_processing_ttl()
  from public, anon, authenticated;
grant  execute on function public.order_submission_processing_ttl() to service_role;

-- Take the submission, or refuse.
--
-- The row lock is what makes "no active lease exists" and "the lease is now
-- mine" a single decision: two callers arriving together are serialized by
-- Postgres, the first writes its token, and the second sees it and is refused.
create or replace function public.begin_order_submission_processing(
  p_submission_id uuid,
  p_actor_id      uuid,
  p_token         uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sub      public.order_submissions%rowtype;
  v_took_over boolean := false;
begin
  if p_token is null then
    raise exception 'ORDER_SUBMISSION_PROCESSING_TOKEN_REQUIRED: a processing token is required'
      using errcode = 'P0001';
  end if;

  select * into v_sub from public.order_submissions where id = p_submission_id for update;
  if not found then
    raise exception 'Order submission % not found', p_submission_id using errcode = 'P0002';
  end if;

  -- Active, not deleted, holds orders.create, owns this submission, and the
  -- submission is still editable. Identical to every other write path.
  perform public.assert_order_submission_editor(p_submission_id, p_actor_id);

  if v_sub.processing_token is not null then
    if v_sub.processing_started_at > now() - public.order_submission_processing_ttl() then
      -- 55P03 is lock_not_available: a retryable "busy", not a failure.
      raise exception
        'ORDER_SUBMISSION_PROCESSING_BUSY: this submission is already being processed'
        using errcode = '55P03';
    end if;
    -- Past the expiry the previous processor is presumed dead. Taking over
    -- invalidates its token, so a process that wakes up late can no longer
    -- release this lease or replace the parse behind the new processor's back.
    v_took_over := true;
  end if;

  update public.order_submissions
     set processing_token = p_token,
         processing_started_at = now()
   where id = p_submission_id;

  return jsonb_build_object('acquired', true, 'took_over', v_took_over);
end;
$$;

revoke execute on function public.begin_order_submission_processing(uuid, uuid, uuid)
  from public, anon, authenticated;
grant  execute on function public.begin_order_submission_processing(uuid, uuid, uuid)
  to service_role;

comment on function public.begin_order_submission_processing(uuid, uuid, uuid) is
  'SERVICE ROLE ONLY. Acquires the single processing lease on a submission, or raises 55P03 when another processor holds a live one. A lease older than the TTL may be taken over, which invalidates the previous token.';

-- Release it, and only if this really is the holder.
--
-- Returns rather than raises, because the caller runs it from a `finally`: a
-- release that throws would replace the real error with a cleanup error. A
-- non-owner simply releases nothing, which is the correct outcome for a late
-- arrival whose lease was taken over.
create or replace function public.finish_order_submission_processing(
  p_submission_id uuid,
  p_token         uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sub public.order_submissions%rowtype;
begin
  select * into v_sub from public.order_submissions where id = p_submission_id for update;
  if not found then
    return jsonb_build_object('released', false, 'reason', 'not_found');
  end if;
  if v_sub.processing_token is null then
    return jsonb_build_object('released', false, 'reason', 'not_held');
  end if;
  if p_token is null or v_sub.processing_token <> p_token then
    return jsonb_build_object('released', false, 'reason', 'not_owner');
  end if;

  update public.order_submissions
     set processing_token = null,
         processing_started_at = null
   where id = p_submission_id;

  return jsonb_build_object('released', true);
end;
$$;

revoke execute on function public.finish_order_submission_processing(uuid, uuid)
  from public, anon, authenticated;
grant  execute on function public.finish_order_submission_processing(uuid, uuid)
  to service_role;

comment on function public.finish_order_submission_processing(uuid, uuid) is
  'SERVICE ROLE ONLY. Releases the processing lease when the presented token is the one that holds it. Returns a result rather than raising, so a caller may release from a finally block without masking the real error.';

-- ═══ 6. replace_order_submission_parse — restated ═══════════════════════════
--
-- STILL SERVICE ROLE ONLY, and still the only thing that writes a price, a
-- quantity, a line total, a product line or an image mapping. Everything the
-- 20260908000000 version did, it still does; what is added is the commercial
-- meaning of the two cost cells and the normalized image rows.
--
-- p_payload additions:
--   commercial : fabric_cost_meaning, fabric_cost_text,
--                packing_cost_meaning, packing_cost_text
--   item_images: array of { item_id, role, position, storage_path, mime_type,
--                sha256, source_media_path, anchor_row }
--   fingerprint: SHA-256 of the payload, used only to recognise a replay
--
-- The image rows are inserted AFTER the items, in one transaction with them, so
-- the composite foreign key can prove every item_id belongs to this submission.
-- A payload naming a foreign item aborts the whole replacement.
--
-- The legacy image columns on order_submission_items keep being written from
-- the representative image, so anything still reading them sees the truth.

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
  v_status      text;
  v_header      jsonb := coalesce(p_payload -> 'header', '{}'::jsonb);
  v_commercial  jsonb := coalesce(p_payload -> 'commercial', '{}'::jsonb);
  v_source      jsonb := coalesce(p_payload -> 'source', '{}'::jsonb);
  v_parse       jsonb := coalesce(p_payload -> 'parse', '{}'::jsonb);
  v_items       jsonb := coalesce(p_payload -> 'items', '[]'::jsonb);
  v_images      jsonb := coalesce(p_payload -> 'item_images', '[]'::jsonb);
  v_warnings    jsonb := coalesce(v_parse -> 'warnings', '[]'::jsonb);
  v_blocking    jsonb := coalesce(v_parse -> 'blocking_issues', '[]'::jsonb);
  v_count       integer;
  v_rep_count   integer;
  v_cust_count  integer;
  v_foreign     integer;
  v_fingerprint text := nullif(btrim(lower(coalesce(p_payload ->> 'fingerprint', ''))), '');
  v_previous    text;
  v_unchanged   boolean := false;
  -- Carried in the payload rather than as a fourth argument: `create or
  -- replace` cannot change a signature, and adding one would leave the old
  -- three-argument function in place as a token-free way in. The payload is
  -- built server-side by the same process that holds the lease.
  v_token       uuid := nullif(btrim(coalesce(p_payload ->> 'processing_token', '')), '')::uuid;
  v_held        uuid;
begin
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'ORDER_SUBMISSION_PAYLOAD_INVALID: a JSON object is required'
      using errcode = 'P0001';
  end if;
  if jsonb_typeof(v_items) <> 'array' then
    raise exception 'ORDER_SUBMISSION_PAYLOAD_INVALID: items must be an array'
      using errcode = 'P0001';
  end if;
  if jsonb_typeof(v_images) <> 'array' then
    raise exception 'ORDER_SUBMISSION_PAYLOAD_INVALID: item_images must be an array'
      using errcode = 'P0001';
  end if;
  if jsonb_typeof(v_warnings) <> 'array' or jsonb_typeof(v_blocking) <> 'array' then
    raise exception 'ORDER_SUBMISSION_PAYLOAD_INVALID: parse.warnings and parse.blocking_issues must be arrays'
      using errcode = 'P0001';
  end if;

  -- Serializes two uploads racing on the same submission, so the row the items
  -- are attached to is the row that was checked. The previous fingerprint is
  -- read under the same lock, so two concurrent replays cannot both decide they
  -- are the first.
  select s.status, s.parse_fingerprint, s.processing_token
    into v_status, v_previous, v_held
  from public.order_submissions s
  where s.id = p_submission_id
  for update;

  if not found then
    raise exception 'Order submission % not found', p_submission_id using errcode = 'P0002';
  end if;

  -- NO REPLACEMENT OUTSIDE THE LEASE.
  --
  -- The caller must present the token that currently holds this submission.
  -- That makes the whole three-step run — upload, replace, clean — the property
  -- of one processor, and it makes a late write from an abandoned attempt
  -- impossible: taking over a stale lease changes the token, so the old
  -- processor's replacement is refused rather than landing on top of the new
  -- one's work.
  if v_held is null or v_token is null or v_held <> v_token then
    raise exception
      'ORDER_SUBMISSION_PROCESSING_NOT_HELD: this parse replacement does not hold the processing lease'
      using errcode = '55P03';
  end if;

  -- Re-derives everything about p_actor_id from the database: active, holds
  -- orders.create, owns THIS submission, and the submission is still editable.
  perform public.assert_order_submission_editor(p_submission_id, p_actor_id);

  -- A replay of the payload already stored. The write below still runs and is a
  -- no-op; what is suppressed is the audit entry, because nothing happened.
  v_unchanged := v_fingerprint is not null and v_previous is not null and v_fingerprint = v_previous;

  update public.order_submissions set
    parse_fingerprint       = v_fingerprint,
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

    -- The two cost cells: amount AND meaning AND wording, together, so the
    -- table constraint can prove they agree. A payload that omits the meaning
    -- falls back to 'numeric', which is what a plain figure is.
    fabric_cost             = nullif(v_commercial ->> 'fabric_cost', '')::numeric,
    fabric_cost_meaning     = coalesce(nullif(btrim(coalesce(v_commercial ->> 'fabric_cost_meaning', '')), ''), 'numeric'),
    fabric_cost_text        = nullif(btrim(coalesce(v_commercial ->> 'fabric_cost_text', '')), ''),
    packing_cost            = nullif(v_commercial ->> 'packing_cost', '')::numeric,
    packing_cost_meaning    = coalesce(nullif(btrim(coalesce(v_commercial ->> 'packing_cost_meaning', '')), ''), 'numeric'),
    packing_cost_text       = nullif(btrim(coalesce(v_commercial ->> 'packing_cost_text', '')), ''),

    transportation_amount   = nullif(v_commercial ->> 'transportation_amount', '')::numeric,
    transportation_text     = nullif(btrim(coalesce(v_commercial ->> 'transportation_text', '')), ''),
    total_before_gst        = nullif(v_commercial ->> 'total_before_gst', '')::numeric,
    gst_amount              = nullif(v_commercial ->> 'gst_amount', '')::numeric,
    grand_total             = nullif(v_commercial ->> 'grand_total', '')::numeric
  where id = p_submission_id;

  -- Atomic replacement. Deleting the items cascades their image rows away, so
  -- an obsolete picture from a previous upload cannot survive into the new
  -- reading of the document.
  delete from public.order_submission_items where submission_id = p_submission_id;

  insert into public.order_submission_items (
    id, submission_id, source_row, item_sequence, source_product_code, product_name,
    quantity, dimensions, material, customization, cost_per_piece, total_amount,
    image_storage_path, image_mime_type, image_sha256, image_anchor_row, sort_order
  )
  select
    -- The CLIENT may supply the item id, and now always does: the image keys
    -- contain it and the objects are uploaded BEFORE this function runs.
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
    -- Legacy compatibility fields, written from the representative image.
    nullif(btrim(coalesce(item ->> 'image_storage_path', '')), ''),
    nullif(btrim(coalesce(item ->> 'image_mime_type', '')), ''),
    nullif(btrim(lower(coalesce(item ->> 'image_sha256', ''))), ''),
    nullif(item ->> 'image_anchor_row', '')::integer,
    coalesce(nullif(item ->> 'sort_order', '')::integer, (ordinality - 1)::integer)
  from jsonb_array_elements(v_items) with ordinality as t(item, ordinality);

  -- Every image must name an item of THIS submission. The composite foreign key
  -- below would refuse a foreign one anyway; this check exists so the failure
  -- is a named business error rather than a constraint violation, and so the
  -- count of them can be reported.
  select count(*) into v_foreign
  from jsonb_array_elements(v_images) as img
  where not exists (
    select 1 from public.order_submission_items i
    where i.id = nullif(img.value ->> 'item_id', '')::uuid
      and i.submission_id = p_submission_id
  );

  if v_foreign > 0 then
    raise exception
      'ORDER_SUBMISSION_IMAGE_ITEM_UNKNOWN: % image(s) name a product line that does not belong to this submission',
      v_foreign
      using errcode = 'P0001';
  end if;

  insert into public.order_submission_item_images (
    submission_id, item_id, role, position,
    storage_path, mime_type, sha256, source_media_path, anchor_row
  )
  select
    p_submission_id,
    (img ->> 'item_id')::uuid,
    img ->> 'role',
    (img ->> 'position')::integer,
    btrim(img ->> 'storage_path'),
    btrim(img ->> 'mime_type'),
    lower(btrim(img ->> 'sha256')),
    nullif(btrim(coalesce(img ->> 'source_media_path', '')), ''),
    (img ->> 'anchor_row')::integer
  from jsonb_array_elements(v_images) as t(img);

  select count(*) into v_count
  from public.order_submission_items where submission_id = p_submission_id;

  select
    count(*) filter (where role = 'representative'),
    count(*) filter (where role = 'customization')
  into v_rep_count, v_cust_count
  from public.order_submission_item_images where submission_id = p_submission_id;

  -- NO ENTRY FOR A REPLAY. Pressing Retry after a network timeout is not three
  -- submissions, and an append-only trail that said so would be a false record
  -- of what an employee did. A genuine re-parse — a corrected workbook, a
  -- different file — has a different fingerprint and is logged normally.
  if not v_unchanged then
    perform public.log_order_submission_activity(
      p_submission_id, p_actor_id, 'parse_replaced', v_status, v_status, null,
      jsonb_build_object(
        'item_count',                 v_count,
        'representative_image_count', v_rep_count,
        'customization_image_count',  v_cust_count,
        'warning_count',              jsonb_array_length(v_warnings),
        'blocking_issue_count',       jsonb_array_length(v_blocking)
      )
    );
  end if;

  return jsonb_build_object(
    'id', p_submission_id,
    'status', v_status,
    'item_count', v_count,
    'representative_image_count', v_rep_count,
    'customization_image_count', v_cust_count,
    'blocking_issue_count', jsonb_array_length(v_blocking),
    'unchanged', v_unchanged
  );
end;
$$;

-- Restated with the same privileges it has always had. authenticated is revoked
-- ALONGSIDE public and anon — the whole point of this function.
revoke execute on function public.replace_order_submission_parse(uuid, uuid, jsonb)
  from public, anon, authenticated;
grant  execute on function public.replace_order_submission_parse(uuid, uuid, jsonb)
  to service_role;

comment on function public.replace_order_submission_parse(uuid, uuid, jsonb) is
  'SERVICE ROLE ONLY. Writes the parsed commercial snapshot, every product line and every normalized product image of a PI submission. Not callable by anon or authenticated, because these values must come from parsing the uploaded workbook server-side and never from a browser. p_actor_id is re-validated against the database, not trusted.';

-- ═══ 7. submit_order_submission — restated ══════════════════════════════════
--
-- The normalized child table is now the authority for images. What changed:
--
--   * the per-item "has a representative image" check reads
--     order_submission_item_images, not order_submission_items.image_storage_path;
--   * EXACTLY ONE representative image per item is required — the table already
--     refuses two, so this catches zero;
--   * every image row of either role must have a real stored object of a real
--     image type;
--   * the path is re-derived per row rather than trusted, even though the table
--     constraint already guarantees its shape. Two independent statements of
--     the same rule is the point: a future migration that relaxed the
--     constraint would still be caught here.
--
-- Customization images are NOT required. A product with none is complete.
--
-- Everything else — the workbook checks, the blocking-issue gate, the client
-- name, the item count, the authorization model, the status move — is exactly
-- as 20260908000000 wrote it.

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

  -- The two fields that are optional at rest and required to submit. The
  -- representative image is no longer among them: it is a child row now, and is
  -- checked below.
  select count(*) into v_incomplete
  from public.order_submission_items
  where submission_id = p_submission_id
    and (item_sequence is null or product_name is null);

  if v_incomplete > 0 then
    raise exception
      'ORDER_SUBMISSION_INCOMPLETE: % product line(s) are missing an item sequence or a name',
      v_incomplete
      using errcode = 'P0001';
  end if;

  -- ── Exactly one representative image per product line ──
  select count(*), min(i.source_row) into v_bad, v_bad_row
  from public.order_submission_items i
  where i.submission_id = p_submission_id
    and (
      select count(*) from public.order_submission_item_images m
      where m.item_id = i.id and m.role = 'representative'
    ) <> 1;

  if v_bad > 0 then
    raise exception
      'ORDER_SUBMISSION_INCOMPLETE: % product line(s) do not have exactly one representative image (first at row %)',
      v_bad, v_bad_row
      using errcode = 'P0001';
  end if;

  -- ── Every recorded image: the key must name THIS submission, THIS item, its
  --    own role and its own position ──
  select count(*) into v_bad
  from public.order_submission_item_images m
  where m.submission_id = p_submission_id
    and m.storage_path !~
        ('^submissions/' || p_submission_id::text || '/images/' || m.item_id::text
         || '/' || m.role || '/' || m.position::text || '-' || m.sha256
         || '\.(png|jpg|jpeg|webp)$');

  if v_bad > 0 then
    raise exception
      'ORDER_SUBMISSION_BAD_IMAGE_PATH: % image path(s) do not name this submission and their own product line',
      v_bad
      using errcode = 'P0001';
  end if;

  -- ── Every recorded image: a real object, of a real image type ──
  select count(*), min(m.anchor_row) into v_bad, v_bad_row
  from public.order_submission_item_images m
  where m.submission_id = p_submission_id
    and not exists (
      select 1 from storage.objects o
      where o.bucket_id = 'order-files'
        and o.name = m.storage_path
        and o.metadata ->> 'mimetype' in ('image/png', 'image/jpeg', 'image/webp')
    );

  if v_bad > 0 then
    raise exception
      'ORDER_SUBMISSION_IMAGE_NOT_STORED: % image(s) are missing from storage or are not a PNG, JPEG or WEBP (first anchored at row %)',
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

-- ═══ 8. Assertions ══════════════════════════════════════════════════════════
--
-- These fail the migration rather than let a partial apply look successful.

do $$
declare
  v_bad text;
  v_n   integer;
begin
  -- RLS on the new table.
  if not exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'order_submission_item_images'
      and c.relrowsecurity
  ) then
    raise exception 'RLS is not enabled on order_submission_item_images';
  end if;

  -- Not one write policy for a client role.
  select string_agg(p.polname, ', ') into v_bad
  from pg_policy p
  join pg_class c on c.oid = p.polrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = 'order_submission_item_images'
    and p.polpermissive
    and p.polcmd in ('a', 'w', 'd');
  if v_bad is not null then
    raise exception 'Unexpected client write policies on order_submission_item_images: %', v_bad;
  end if;

  -- The module entry gate must be RESTRICTIVE.
  if not exists (
    select 1 from pg_policy p
    join pg_class c on c.oid = p.polrelid
    where c.relname = 'order_submission_item_images'
      and p.polname = 'order_submission_item_images_module_entry_gate'
      and not p.polpermissive
  ) then
    raise exception 'the module entry gate on order_submission_item_images must be restrictive';
  end if;

  -- No client role may write the table, privileges as well as policies.
  select string_agg(privilege_type, ', ') into v_bad
  from information_schema.role_table_grants
  where table_schema = 'public'
    and table_name = 'order_submission_item_images'
    and grantee in ('authenticated', 'anon')
    and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE');
  if v_bad is not null then
    raise exception 'order_submission_item_images is writable by a client role: %', v_bad;
  end if;

  -- The lease functions are unreachable from a browser.
  select count(*) into v_n
  from information_schema.role_routine_grants
  where routine_schema = 'public'
    and routine_name in ('begin_order_submission_processing', 'finish_order_submission_processing')
    and grantee in ('authenticated', 'anon', 'PUBLIC');
  if v_n > 0 then
    raise exception 'the processing lease functions must not be executable by a client role';
  end if;

  select count(*) into v_n
  from information_schema.role_routine_grants
  where routine_schema = 'public'
    and routine_name in ('begin_order_submission_processing', 'finish_order_submission_processing')
    and grantee = 'service_role';
  if v_n < 2 then
    raise exception 'the processing lease functions must be executable by service_role';
  end if;

  -- Token and timestamp move together or not at all.
  if not exists (
    select 1 from pg_constraint
    where conname = 'order_submissions_processing_lease_consistent'
  ) then
    raise exception 'the processing lease consistency constraint is missing';
  end if;

  -- The composite foreign key exists, so item/submission agreement is proven by
  -- the database and not merely by the RPC.
  if not exists (
    select 1 from pg_constraint
    where conname = 'order_submission_item_images_item_fk'
      and contype = 'f'
      and cardinality(conkey) = 2
  ) then
    raise exception 'the item foreign key must be composite (item_id, submission_id)';
  end if;

  -- At most one representative image per item.
  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public'
      and indexname = 'order_submission_item_images_one_representative'
  ) then
    raise exception 'the single-representative index is missing';
  end if;

  -- replace_order_submission_parse is still unreachable from a browser.
  select count(*) into v_n
  from information_schema.role_routine_grants
  where routine_schema = 'public'
    and routine_name = 'replace_order_submission_parse'
    and grantee in ('authenticated', 'anon', 'PUBLIC');
  if v_n > 0 then
    raise exception 'replace_order_submission_parse must not be executable by a client role';
  end if;

  -- …and IS reachable by the service role.
  if not exists (
    select 1 from information_schema.role_routine_grants
    where routine_schema = 'public'
      and routine_name = 'replace_order_submission_parse'
      and grantee = 'service_role'
  ) then
    raise exception 'replace_order_submission_parse must be executable by service_role';
  end if;

  -- The four commercial meaning columns exist with their constraints.
  select count(*) into v_n
  from information_schema.columns
  where table_schema = 'public' and table_name = 'order_submissions'
    and column_name in ('fabric_cost_meaning', 'fabric_cost_text',
                        'packing_cost_meaning', 'packing_cost_text');
  if v_n <> 4 then
    raise exception 'expected 4 commercial meaning columns, found %', v_n;
  end if;

  select count(*) into v_n
  from pg_constraint
  where conname in ('order_submissions_fabric_cost_meaning_consistent',
                    'order_submissions_packing_cost_meaning_consistent');
  if v_n <> 2 then
    raise exception 'the commercial meaning consistency constraints are missing';
  end if;

  -- Nothing here may create an Order or move a submission to a terminal state.
  if exists (
    select 1 from public.order_submissions where order_id is not null
  ) then
    raise exception 'this migration must not link any submission to an order';
  end if;
end;
$$;
