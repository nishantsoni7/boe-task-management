-- ════════════════════════════════════════════════════════════════════════════
-- CONFIRMED ORDER → APPROVED PI HANDOFF
--
-- WHAT THIS PHASE IS FOR
-- ----------------------
-- A Confirmed Order created by approving a PI carries almost nothing about the
-- document it came from. `orders` holds the client name, the two dates, the
-- grand total, the gross product amount and the declared billing percentage —
-- and that is deliberate: 20260921000000 §13 copies exactly those and nothing
-- else, because the PI remains the authority for its own commercial detail.
--
-- The consequence is that /orders/[id] cannot show the operations team what
-- they need to actually run the order: who to bill, where to ship, what the
-- pre-GST total was, which products, what they look like, or the workbook the
-- whole thing was agreed on. Every one of those facts already exists, on the
-- linked order_submissions row and in the order-files bucket. What is missing
-- is PERMISSION: a person who may read the Order may not read the PI.
--
-- WHY IT IS MISSING, AND WHY THAT IS NOT A BUG TO PATCH IN REACT
-- --------------------------------------------------------------
-- PI visibility (can_view_order_submission, 20260908000000 §6, widened by
-- 20260915000000 §9) is REVIEW visibility: the owner, the named reviewer, an
-- orders.approve_order holder, an admin, or a finance verifier looking at a
-- submitted/approved record. It answers "may this person take part in
-- reviewing this PI".
--
-- ORDER visibility is a different question with a different answer: the admin
-- branch, the operations-team branch, the requester/assignee branch
-- (20260655), and orders.view_all (20260903000000 §2). An operations lead who
-- runs every Order in the building is in the second set and not the first.
--
-- Those two sets must stay different. Widening can_view_order_submission to
-- admit Order viewers would hand PI REVIEW sight — drafts, returned records,
-- rejected ones, the review notes — to people who are entitled to none of it.
-- So this migration adds a SECOND, NARROWER door instead, and the door only
-- opens onto a submission that has already BECOME an Order.
--
-- WHAT THIS MIGRATION DOES
-- ------------------------
--   1. can_view_order(uuid)                  the ONE predicate for "this viewer
--                                            may view this Order"
--   2. confirmed_order_id_for_submission()   the LINK, resolved without
--                                            authorizing anything
--   3. can_view_order_submission_via_order() 1 ∘ 2 — the new door
--   4. order_file_order_id(text)             decodes the reserved orders/ key
--   5. four additive SELECT policies         order_submissions, its items, its
--                                            item images, and order-files
--   6. assertions
--
-- WHAT IT DELIBERATELY DOES NOT DO
-- --------------------------------
--   * It does not touch can_view_order_submission, order_submissions_select,
--     or any policy 20260908/20260909/20260915 created. Every existing reader
--     keeps exactly what they have.
--   * It adds NO INSERT, UPDATE or DELETE policy anywhere. order-files still
--     has no UPDATE policy at all, which is what makes a stored file immutable
--     and what defeats upsert (20260908000000 §9).
--   * It does not make the bucket public and does not create a public URL.
--     Reads stay signed, short-lived and per-object.
--   * It copies no commercial value onto `orders`. The PI stays the authority
--     for total_before_gst, GST and every product line; the Order borrows sight
--     of them rather than a stale copy.
--   * It opens nothing onto a DRAFT. A submission with no Order attached is
--     unreachable through this door, by construction: the link is the Order.
--
-- Not one applied migration is edited. Timestamp is after 20260923000000.
-- ════════════════════════════════════════════════════════════════════════════


-- ═══ 1. The one predicate: may this viewer view this Order? ═════════════════
--
-- SECURITY INVOKER, AND THAT IS THE WHOLE DESIGN.
--
-- The question "may this person see this Order" already has an answer, and it
-- is not written down in any one place that could be copied: it is the OR of
-- every permissive SELECT policy on public.orders — orders_admin_select,
-- orders_operations_select, orders_sales_select (20260655) and
-- orders_permission_engine_select (20260903000000). Re-stating that expression
-- here would create a second answer that drifts the first time a policy moves,
-- and the drift would be silent and in the permissive direction.
--
-- So this does not re-state it. It ASKS it. Running as the invoker, the `select`
-- below is filtered by exactly those policies, so `can_view_order` returns true
-- if and only if the caller could have read the row themselves. A policy added
-- to public.orders tomorrow is honoured here the same day, and a policy narrowed
-- tomorrow narrows this the same day.
--
-- FAILS CLOSED ON NULL. `where o.id = null` matches nothing, so an unresolvable
-- Order — a malformed storage key, a submission with no Order — is a refusal
-- rather than an error. Every caller below relies on that.
--
-- NOT USABLE IN A POLICY ON public.orders ITSELF. It reads that table, so a
-- policy on it would recurse. Nothing here does; the callers are
-- order_submissions, its two child tables and storage.objects, none of which
-- public.orders' own policies consult.

create or replace function public.can_view_order(p_order_id uuid)
returns boolean
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.orders o where o.id = p_order_id
  );
$$;

comment on function public.can_view_order(uuid) is
  'True when the CALLER may read this Order under the existing orders SELECT policies — admin, operations, requester, assignee, or orders.view_all. SECURITY INVOKER on purpose: it asks RLS rather than re-stating it, so it can never drift from the policies it stands for. Null or unknown id is false.';

revoke execute on function public.can_view_order(uuid) from public, anon;
grant  execute on function public.can_view_order(uuid) to authenticated;


-- ═══ 2. The link, resolved without authorizing anything ═════════════════════
--
-- WHY THIS IS A SEPARATE FUNCTION, AND WHY IT IS A DEFINER.
--
-- The new door is "this submission became an Order the caller may see". To ask
-- that, the link has to be resolved FIRST — and the link lives on public.orders,
-- whose RLS is the very thing being tested. Resolving it as the invoker would
-- make the two questions one, and the answer would still be correct, but the
-- authorization decision would then be spread across a join rather than made by
-- a single named predicate. Section 1 is meant to be the only place that
-- decides, and this is what keeps it so.
--
-- IT AUTHORIZES NOTHING. It returns an id. Every caller passes that id straight
-- into can_view_order, which is what decides. Learning that submission X became
-- order Y is not sight of order Y, of the PI, or of any file.
--
-- AT MOST ONE ROW, guaranteed by orders_source_order_submission_id_uidx
-- (20260915000000) — one submission, one Order, in both directions.

create or replace function public.confirmed_order_id_for_submission(p_submission_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select o.id
  from public.orders o
  where o.source_order_submission_id = p_submission_id
  limit 1;
$$;

comment on function public.confirmed_order_id_for_submission(uuid) is
  'The Confirmed Order a PI submission became, or null. Resolves the LINK only and grants nothing: callers hand the result to can_view_order, which is what decides. SECURITY DEFINER so the link resolves independently of the Order visibility being tested.';

revoke execute on function public.confirmed_order_id_for_submission(uuid) from public, anon;
grant  execute on function public.confirmed_order_id_for_submission(uuid) to authenticated;


-- ═══ 3. The new door ════════════════════════════════════════════════════════
--
-- "This submission has become an Order, and the caller may see that Order."
--
-- A DRAFT CANNOT COME THROUGH IT. The predicate is the existence of the Order,
-- and only approve_order_submission() creates one. There is no state of a draft,
-- a returned record or a rejected one in which this returns true, so no Order
-- viewer gains sight of a PI that was never approved.
--
-- AND IT IS NOT THE REVIEW DOOR. can_view_order_submission is untouched and
-- still means what it meant. A person who holds only PI-review access reaches
-- this predicate's `false` branch for every Order they are not otherwise
-- entitled to — which is section 6's negative assertion and the point of
-- keeping the two doors separate.

create or replace function public.can_view_order_submission_via_order(p_submission_id uuid)
returns boolean
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select public.can_view_order(
    public.confirmed_order_id_for_submission(p_submission_id)
  );
$$;

comment on function public.can_view_order_submission_via_order(uuid) is
  'True when this PI submission has become a Confirmed Order the CALLER may view. The Order-visibility door onto an approved PI, deliberately separate from can_view_order_submission, which is PI-REVIEW visibility. False for every draft, returned or rejected submission, because none of them has an Order.';

revoke execute on function public.can_view_order_submission_via_order(uuid) from public, anon;
grant  execute on function public.can_view_order_submission_via_order(uuid) to authenticated;


-- ═══ 4. Decoding the reserved orders/ key ═══════════════════════════════════
--
-- 20260908000000 §9 reserved two key shapes and authorized neither:
--
--   orders/{order_id}/versions/{version}/approved.xlsx
--   orders/{order_id}/versions/{version}/approved.pdf
--
-- This decodes the {order_id} out of such a key, so section 5 can authorize
-- READING them by the Order they belong to. Writing them stays service-role
-- territory: no client INSERT or UPDATE policy is added, here or ever, for this
-- prefix.
--
-- THE SAME FAIL-CLOSED RULES AS order_file_submission_id, deliberately copied
-- rather than generalised — the two prefixes are authorized by different
-- predicates, and a shared decoder is one edit away from letting a key
-- authorized for one prefix resolve into the other. A traversal segment, a
-- backslash or a leading slash yields null, and null is a refusal.
--
-- Every built-in is pinned to pg_catalog. The function is not SECURITY DEFINER
-- — it is pure string arithmetic — but it is evaluated inside a storage policy,
-- so pinning what it resolves means a caller-controlled search_path can never
-- change what a path decodes to.

create or replace function public.order_file_order_id(p_object_name text)
returns uuid
language sql
immutable
as $$
  select case
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
    when pg_catalog.split_part(p_object_name, '/', 1) <> 'orders' then null
    -- Segment 3 must be the literal 'versions'. Without it, `orders/{id}/x`
    -- would decode, and the reserved shape is the only shape this authorizes.
    when pg_catalog.split_part(p_object_name, '/', 3) <> 'versions' then null
    when pg_catalog.split_part(p_object_name, '/', 2) !~
         '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then null
    else pg_catalog.split_part(p_object_name, '/', 2)::uuid
  end;
$$;

comment on function public.order_file_order_id(text) is
  'The Order id encoded in an order-files key of the reserved shape orders/{order_id}/versions/..., or null when the key is not one. Returns null rather than raising on a malformed key, so storage policies fail closed.';

revoke execute on function public.order_file_order_id(text) from public, anon;
grant  execute on function public.order_file_order_id(text) to authenticated;


-- ═══ 5. Four additive SELECT policies ═══════════════════════════════════════
--
-- ADDITIVE, EVERY ONE. PERMISSIVE policies OR together, so nobody loses a row
-- they can see today and no existing policy is dropped, renamed or narrowed.
-- The RESTRICTIVE module_entry_open('orders') gates on all three tables
-- (20260908000000 §6, 20260909000000 §4) are untouched and still AND with these:
-- an employee whose Order Management access is switched off reaches nothing
-- here, whatever Order they can otherwise see.
--
-- SELECT ONLY. Reading the PI a Confirmed Order came from confers no ability to
-- change it, to change the Order, or to replace a file. There is still no
-- client INSERT, UPDATE or DELETE policy on any of the three tables, for any
-- role, and section 6 asserts it.
--
-- order_submission_activity IS DELIBERATELY NOT INCLUDED. It is the PI's REVIEW
-- trail — who returned it, who rejected it, what management asked for — and it
-- belongs to the review audience. The Order has its own activity log, with its
-- own visibility, and that is what /orders/[id] shows.

create policy "order_submissions_confirmed_order_select" on public.order_submissions
  for select to authenticated
  using (public.can_view_order_submission_via_order(id));

comment on policy "order_submissions_confirmed_order_select" on public.order_submissions is
  'Order-side sight of the approved PI a Confirmed Order came from. Additive to order_submissions_select, which remains PI-review visibility and is untouched. Never reaches a draft, returned or rejected record — those have no Order.';

create policy "order_submission_items_confirmed_order_select" on public.order_submission_items
  for select to authenticated
  using (public.can_view_order_submission_via_order(submission_id));

comment on policy "order_submission_items_confirmed_order_select" on public.order_submission_items is
  'The product lines of the approved PI a Confirmed Order came from, for viewers of that Order. Additive; SELECT only.';

create policy "order_submission_item_images_confirmed_order_select" on public.order_submission_item_images
  for select to authenticated
  using (public.can_view_order_submission_via_order(submission_id));

comment on policy "order_submission_item_images_confirmed_order_select" on public.order_submission_item_images is
  'The product photographs of the approved PI a Confirmed Order came from, for viewers of that Order. Additive; SELECT only.';

-- ── The storage door ────────────────────────────────────────────────────────
--
-- A SECOND POLICY, not an edit to order_files_select. That one still authorizes
-- by can_view_order_submission and still means PI-review sight of PI files; this
-- one authorizes by the ORDER, and covers two key shapes:
--
--   submissions/{id}/...                        the approved PI's own files —
--                                               the original workbook and the
--                                               product photographs — reachable
--                                               only once the PI has an Order
--   orders/{order_id}/versions/{version}/...    the Order's own generated
--                                               documents (reserved shape)
--
-- The two decoders are mutually exclusive by construction: a key whose first
-- segment is `submissions` decodes to null through order_file_order_id, and one
-- whose first segment is `orders` decodes to null through
-- order_file_submission_id. Neither can resolve into the other's prefix, and
-- both refuse a traversal, a backslash or a leading slash outright.
--
-- STILL NO UPDATE POLICY ON order-files, and still no INSERT or DELETE for this
-- prefix. Generated documents are written with the server's existing protected
-- credentials, never from a browser.

create policy "order_files_confirmed_order_select" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'order-files'
    and public.module_entry_open('orders')
    and (
      public.can_view_order_submission_via_order(public.order_file_submission_id(name))
      or public.can_view_order(public.order_file_order_id(name))
    )
  );

comment on policy "order_files_confirmed_order_select" on storage.objects is
  'Order-side read access to order-files: the approved PI files a Confirmed Order came from, and the Order''s own generated documents under orders/{order_id}/versions/. Additive to order_files_select, which stays PI-review access. SELECT only — the bucket is private, has no UPDATE policy, and gains no client write here.';


-- ═══ 6. Assertions ══════════════════════════════════════════════════════════
--
-- These fail the migration rather than let a partial apply look successful.

do $$
begin
  -- 6a. The predicate chain exists, with the security modes this design needs.
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'can_view_order' and p.prosecdef = false
  ) then
    raise exception 'can_view_order must exist and must be SECURITY INVOKER — a definer would re-state orders RLS instead of asking it';
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'confirmed_order_id_for_submission' and p.prosecdef
  ) then
    raise exception 'confirmed_order_id_for_submission must exist and must be SECURITY DEFINER';
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'can_view_order_submission_via_order' and p.prosecdef = false
  ) then
    raise exception 'can_view_order_submission_via_order must exist and must be SECURITY INVOKER';
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'order_file_order_id'
  ) then
    raise exception 'order_file_order_id was not created';
  end if;

  -- 6b. The PI-REVIEW door is unchanged. If a later edit ever folded the Order
  -- branch into it, PI review access and Order access would become one
  -- authority — which is the exact outcome this migration exists to avoid.
  if pg_get_functiondef(
       (select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'can_view_order_submission')
     ) ilike '%can_view_order_submission_via_order%'
  then
    raise exception 'can_view_order_submission must not consult the Order door: PI-review visibility and Order visibility are separate authorities';
  end if;

  -- 6c. The four new policies are SELECT and nothing else.
  if exists (
    select 1 from pg_policies
    where policyname in (
      'order_submissions_confirmed_order_select',
      'order_submission_items_confirmed_order_select',
      'order_submission_item_images_confirmed_order_select',
      'order_files_confirmed_order_select'
    )
      and cmd <> 'SELECT'
  ) then
    raise exception 'a confirmed-order policy was created for something other than SELECT';
  end if;

  if (
    select count(*) from pg_policies
    where policyname in (
      'order_submissions_confirmed_order_select',
      'order_submission_items_confirmed_order_select',
      'order_submission_item_images_confirmed_order_select',
      'order_files_confirmed_order_select'
    )
  ) <> 4 then
    raise exception 'expected exactly four new confirmed-order SELECT policies';
  end if;

  -- 6d. No client write policy has appeared on any of the three PI tables.
  if exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename in ('order_submissions', 'order_submission_items', 'order_submission_item_images')
      and cmd in ('INSERT', 'UPDATE', 'DELETE')
  ) then
    raise exception 'a client write policy exists on a PI table; the submission record must stay read-only to every client role';
  end if;

  -- 6e. order-files still has NO UPDATE policy. This is 20260908000000's
  -- guarantee and the reason a stored workbook cannot be swapped by upsert.
  -- The same shape 20260908000000 asserts, so the two checks cannot disagree
  -- about what counts as an order-files policy.
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

  -- 6f. The bucket is still private at its product limit.
  if not exists (
    select 1 from storage.buckets
    where id = 'order-files' and public = false and file_size_limit = 10485760
  ) then
    raise exception 'order-files is not private at the 10 MiB limit';
  end if;
end $$;

-- ── 6g. The decoders refuse what they must refuse ───────────────────────────
--
-- Behavioural, not structural: the fail-closed rules are the whole security of
-- the storage policy, and a regression in them would not change any catalog row.

do $$
begin
  if public.order_file_order_id('orders/11111111-1111-1111-1111-111111111111/versions/1/approved.xlsx')
     is distinct from '11111111-1111-1111-1111-111111111111'::uuid then
    raise exception 'order_file_order_id does not decode the reserved key shape';
  end if;

  if public.order_file_order_id('submissions/11111111-1111-1111-1111-111111111111/original/a.xlsx')
     is not null then
    raise exception 'order_file_order_id decoded a submissions key; the two prefixes must not cross';
  end if;

  if public.order_file_submission_id('orders/11111111-1111-1111-1111-111111111111/versions/1/approved.xlsx')
     is not null then
    raise exception 'order_file_submission_id decoded an orders key; the two prefixes must not cross';
  end if;

  if public.order_file_order_id('orders/11111111-1111-1111-1111-111111111111/notversions/1/x.xlsx')
     is not null then
    raise exception 'order_file_order_id decoded a key outside the reserved versions/ shape';
  end if;

  if public.order_file_order_id('/orders/11111111-1111-1111-1111-111111111111/versions/1/a.xlsx')
     is not null
     or public.order_file_order_id('orders/../11111111-1111-1111-1111-111111111111/versions/1/a.xlsx')
     is not null
     or public.order_file_order_id('orders/11111111-1111-1111-1111-111111111111/versions/1/..')
     is not null
     or public.order_file_order_id(E'orders\\x/versions/1/a.xlsx')
     is not null then
    raise exception 'order_file_order_id did not fail closed on an unsafe key';
  end if;

  if public.order_file_order_id('orders/not-a-uuid/versions/1/a.xlsx') is not null then
    raise exception 'order_file_order_id decoded a non-uuid second segment';
  end if;

  if public.order_file_order_id(null) is not null then
    raise exception 'order_file_order_id did not fail closed on null';
  end if;

  -- The whole chain refuses an unknown submission without raising.
  if public.can_view_order_submission_via_order(null) then
    raise exception 'can_view_order_submission_via_order must be false for a null submission';
  end if;

  if public.can_view_order(null) then
    raise exception 'can_view_order must be false for a null Order';
  end if;
end $$;
