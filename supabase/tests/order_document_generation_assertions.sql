-- Confirmed Order document generation assertions
-- ===========================================================================
-- Covers 20260924000000_order_submission_confirmed_order_handoff.sql and
-- 20260925000000_order_document_generation.sql:
--
--   A. can_view_order — the ONE Order-visibility predicate, per audience
--   B. the Order door onto an approved PI, and what it refuses
--   C. request_order_document_generation — authority, idempotence, versioning
--   D. the claim — atomicity, the stale takeover, and the token
--   E. complete / fail — the token rule and the `ready` invariant
--   F. retry — it moves no Order, no number and no money
--   G. storage — PUBLICATION, not location, is what makes a file downloadable
--   H. privileges — the worker half is unreachable from a browser
--
-- Runs entirely inside ONE transaction that ends in ROLLBACK, so every fixture
-- is discarded. It does consume Order numbers if public.orders_display_number_seq
-- is a SEQUENCE, because nextval() is NOT transactional. That is the only trace
-- this script leaves.
--
-- PREREQUISITES (controlled environment, migrations already applied):
--   * Run with psql as a role that may SET ROLE and set session GUCs (standard
--     Supabase `postgres`).
--   * Replace the SIX real user UUIDs below; all must exist, be active and be
--     distinct:
--       test.owner       a NON-admin who will own the fixture PI
--       test.other       a different NON-admin who owns nothing and is granted
--                        nothing. Every denial is proved against this person.
--       test.viewall     a NON-admin, granted orders.view_all by this script
--       test.reviewer    a NON-admin, granted orders.approve_order by this
--                        script. THE PI REVIEWER WITH NO ORDER STANDING.
--       test.operations  a NON-admin whose users.team is 'operations'
--       test.admin       an administrator
--
-- WHICH ROLE EACH SECTION RUNS AS MATTERS HERE MORE THAN USUAL.
--
-- A, B, C, G and I are things a PERSON does, and every one of them is decided by
-- row-level security, so they SET LOCAL ROLE authenticated — `postgres` bypasses
-- row security and would prove the opposite of what they claim. In particular
-- request_order_document_generation is SECURITY INVOKER on purpose; run it as
-- `postgres` and its Order-visibility check passes for every Order in the
-- business.
--
-- D, E and F drive the WORKER half — claim, complete, fail — which is revoked
-- from every client role and reachable only by the server's protected
-- credentials. Those run as `postgres`, which is what the server is.
--
-- Identity throughout is simulated with request.jwt.claims, the idiom the other
-- scripts in this directory use.
--
-- NOTHING HERE APPROVES A PI, ALLOCATES A NUMBER OR TOUCHES A PAYMENT. The
-- fixture Order and PI are inserted directly, and section F proves that the
-- generation functions cannot reach any of those things even if asked to.
--
-- On success it prints NOTICE 'ALL ASSERTIONS PASSED' and rolls back.

\set ON_ERROR_STOP on

begin;

-- ── Config: the ONLY lines a tester edits ────────────────────────────────────
do $$
begin
  perform set_config('test.owner',      '11111111-1111-1111-1111-111111111111', true); -- REPLACE
  perform set_config('test.other',      '22222222-2222-2222-2222-222222222222', true); -- REPLACE
  perform set_config('test.viewall',    '33333333-3333-3333-3333-333333333333', true); -- REPLACE
  perform set_config('test.reviewer',   '44444444-4444-4444-4444-444444444444', true); -- REPLACE
  perform set_config('test.operations', '55555555-5555-5555-5555-555555555555', true); -- REPLACE
  perform set_config('test.admin',      '66666666-6666-6666-6666-666666666666', true); -- REPLACE
end $$;

do $$
declare
  v_ids uuid[] := array[
    current_setting('test.owner')::uuid,
    current_setting('test.other')::uuid,
    current_setting('test.viewall')::uuid,
    current_setting('test.reviewer')::uuid,
    current_setting('test.operations')::uuid,
    current_setting('test.admin')::uuid
  ];
begin
  assert (select count(distinct id) from public.users
           where id = any (v_ids) and is_active
             and coalesce(is_deleted, false) = false) = 6,
    'the six configured user ids must all exist, be active and be distinct — replace the placeholders';
  assert (select role = 'admin' from public.users where id = current_setting('test.admin')::uuid),
    'test.admin must be an administrator';
  assert (select bool_and(role <> 'admin') from public.users
           where id = any (v_ids) and id <> current_setting('test.admin')::uuid),
    'the other five must NOT be administrators, or the denials prove nothing';
  assert (select team = 'operations' from public.users where id = current_setting('test.operations')::uuid),
    'test.operations must be on the operations team';
end $$;

-- ── Helpers ──────────────────────────────────────────────────────────────────

create or replace function pg_temp.fails_with(p_sql text)
returns text
language plpgsql
as $$
begin
  execute p_sql;
  return 'NO ERROR';
exception when others then
  return sqlstate || '|' || sqlerrm;
end $$;

create or replace function pg_temp.act_as(p_user text)
returns void
language plpgsql
as $$
declare
  v_id text := current_setting('test.' || p_user, true);
begin
  if coalesce(v_id, '') = '' then
    raise exception 'test.% is not configured', p_user;
  end if;
  perform set_config('test.uid', v_id, true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_id, 'role', 'authenticated')::text, true);
end $$;

create or replace function pg_temp.ok(p_condition boolean, p_what text)
returns void
language plpgsql
as $$
begin
  if not p_condition then
    raise exception 'ASSERTION FAILED: %', p_what;
  end if;
end $$;

-- ── Fixtures ─────────────────────────────────────────────────────────────────
--
-- One approved PI and the Order it became. Inserted directly rather than through
-- approve_order_submission(): this script must not allocate a real Order number
-- or move money, and what is under test here is what happens AFTER approval.

create temporary table t_fix (k text primary key, v uuid) on commit drop;

do $$
declare
  v_sub uuid;
  v_ord uuid;
begin
  insert into public.order_submissions (status, client_name, created_by, submitted_by)
  values ('approved', '[TEST] Document Generation', current_setting('test.owner')::uuid,
          current_setting('test.owner')::uuid)
  returning id into v_sub;

  insert into public.orders (
    client_name, requested_by, assigned_to, created_by, status,
    total_value, total_product_value, source_order_submission_id
  ) values (
    '[TEST] Document Generation',
    current_setting('test.owner')::uuid,
    current_setting('test.other')::uuid,   -- deliberately: the ASSIGNEE is
                                           -- test.other, so section A can prove
                                           -- assignment alone grants sight, and
                                           -- section B can then take it away.
    current_setting('test.admin')::uuid,
    'running', 100000, 90000, v_sub
  ) returning id into v_ord;

  update public.order_submissions set order_id = v_ord where id = v_sub;

  insert into t_fix values ('submission', v_sub), ('order', v_ord);
end $$;

-- Grants, made here and rolled back with everything else.
create or replace function pg_temp.grant_action(p_user text, p_module text, p_action text)
returns void
language plpgsql
as $$
declare
  v_action uuid;
  v_module uuid;
begin
  select id into v_action from public.permission_actions where action_key = p_action;
  select id into v_module from public.permission_modules where module_key = p_module;
  if v_action is null or v_module is null then
    raise exception 'no such permission %.%', p_module, p_action;
  end if;
  insert into public.employee_permission_overrides (user_id, module_id, action_id, allowed)
  values (current_setting('test.' || p_user)::uuid, v_module, v_action, true)
  on conflict (user_id, module_id, action_id) do update set allowed = true;
end $$;

do $$
begin
  -- Everybody needs Order Management entry, or the RESTRICTIVE gate refuses
  -- them for reasons that have nothing to do with what is under test.
  perform pg_temp.grant_action('owner',      'orders', 'view');
  perform pg_temp.grant_action('other',      'orders', 'view');
  perform pg_temp.grant_action('viewall',    'orders', 'view');
  perform pg_temp.grant_action('reviewer',   'orders', 'view');
  perform pg_temp.grant_action('operations', 'orders', 'view');

  perform pg_temp.grant_action('viewall',  'orders', 'view_all');
  perform pg_temp.grant_action('reviewer', 'orders', 'approve_order');
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- A. can_view_order — the ONE predicate, per audience
-- ═══════════════════════════════════════════════════════════════════════════
--
-- It is SECURITY INVOKER, so it answers with the caller's own RLS. Under
-- `postgres` that is "everything", which would prove nothing — hence SET ROLE.

do $$
declare v_ord uuid := (select v from t_fix where k = 'order');
begin
  perform pg_temp.act_as('admin');
  set local role authenticated;
  perform pg_temp.ok(public.can_view_order(v_ord), 'an admin may view the Order');
  reset role;

  perform pg_temp.act_as('owner');
  set local role authenticated;
  perform pg_temp.ok(public.can_view_order(v_ord), 'the requester may view the Order');
  reset role;

  perform pg_temp.act_as('other');
  set local role authenticated;
  perform pg_temp.ok(public.can_view_order(v_ord), 'the assigned user may view the Order');
  reset role;

  perform pg_temp.act_as('viewall');
  set local role authenticated;
  perform pg_temp.ok(public.can_view_order(v_ord), 'an orders.view_all holder may view the Order');
  reset role;

  perform pg_temp.act_as('operations');
  set local role authenticated;
  perform pg_temp.ok(public.can_view_order(v_ord), 'the operations team may view the Order');
  reset role;

  -- THE PI REVIEWER. orders.approve_order makes somebody a PI reviewer and
  -- nothing else; it confers no Order standing whatever.
  perform pg_temp.act_as('reviewer');
  set local role authenticated;
  perform pg_temp.ok(not public.can_view_order(v_ord),
    'orders.approve_order alone must NOT confer Order visibility');
  reset role;

  -- And an unknown Order is a refusal, never an error.
  perform pg_temp.act_as('admin');
  set local role authenticated;
  perform pg_temp.ok(not public.can_view_order('00000000-0000-0000-0000-000000000000'),
    'an Order that does not exist is not viewable');
  perform pg_temp.ok(not public.can_view_order(null), 'a null Order id fails closed');
  reset role;
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- B. The Order door onto the approved PI
-- ═══════════════════════════════════════════════════════════════════════════

do $$
declare
  v_sub uuid := (select v from t_fix where k = 'submission');
  v_draft uuid;
begin
  -- A DRAFT NEVER COMES THROUGH. It has no Order, so the door has nothing to
  -- open — for anybody, including an admin.
  insert into public.order_submissions (status, client_name, created_by, submitted_by)
  values ('draft', '[TEST] Never Approved', current_setting('test.owner')::uuid,
          current_setting('test.owner')::uuid)
  returning id into v_draft;

  perform pg_temp.act_as('admin');
  set local role authenticated;
  perform pg_temp.ok(public.can_view_order_submission_via_order(v_sub),
    'an admin reaches the approved PI through the Order');
  perform pg_temp.ok(not public.can_view_order_submission_via_order(v_draft),
    'a PI that never became an Order is unreachable through the Order door');
  perform pg_temp.ok(not public.can_view_order_submission_via_order(null),
    'a null submission fails closed');
  reset role;

  -- The operations lead: the audience the PI-REVIEW door does not contain, and
  -- the reason the Order door exists at all.
  perform pg_temp.act_as('operations');
  set local role authenticated;
  perform pg_temp.ok(public.can_view_order_submission_via_order(v_sub),
    'the operations team reaches the approved PI through the Order');
  perform pg_temp.ok(not public.can_view_order_submission(v_sub),
    'and does NOT hold PI-review visibility — the two doors stay separate');
  perform pg_temp.ok(
    (select count(*) from public.order_submissions where id = v_sub) = 1,
    'and the row is actually selectable, not merely predicated true');
  reset role;

  -- The PI reviewer holds the OTHER door, and only that one.
  perform pg_temp.act_as('reviewer');
  set local role authenticated;
  perform pg_temp.ok(public.can_view_order_submission(v_sub),
    'orders.approve_order is PI-review visibility');
  perform pg_temp.ok(not public.can_view_order_submission_via_order(v_sub),
    'but confers nothing through the ORDER door');
  reset role;

  -- Somebody with Order Management entry and nothing else reaches neither.
  perform pg_temp.act_as('viewall');
  set local role authenticated;
  perform pg_temp.ok(public.can_view_order_submission_via_order(v_sub),
    'orders.view_all reaches the approved PI through the Order');
  perform pg_temp.ok(not public.can_view_order_submission(v_sub),
    'and still holds no PI-review visibility');
  reset role;
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- C. request_order_document_generation
-- ═══════════════════════════════════════════════════════════════════════════

-- EVERY CALL IN THIS SECTION RUNS AS `authenticated`. request_... is SECURITY
-- INVOKER precisely so RLS decides as the caller; run as `postgres` it would
-- bypass row security and prove the opposite of what it claims.
do $$
declare
  v_ord uuid := (select v from t_fix where k = 'order');
  v_res jsonb;
  v_err text;
begin
  -- ── Authority ──
  perform pg_temp.act_as('owner');
  set local role authenticated;
  v_err := pg_temp.fails_with(format(
    'select public.request_order_document_generation(%L::uuid)', v_ord));
  reset role;
  perform pg_temp.ok(v_err like '42501|%' and v_err like '%ORDER_DOCUMENT_FORBIDDEN%',
    'the Order requester may NOT generate documents: ' || v_err);

  perform pg_temp.act_as('operations');
  set local role authenticated;
  v_err := pg_temp.fails_with(format(
    'select public.request_order_document_generation(%L::uuid)', v_ord));
  reset role;
  perform pg_temp.ok(v_err like '42501|%',
    'the operations team may see an Order but not generate its documents: ' || v_err);

  -- The PI reviewer holds the management approval authority but cannot SEE this
  -- Order — so the request is refused on the Order, not on the authority. Both
  -- gates are required, and this proves the second one independently.
  perform pg_temp.act_as('reviewer');
  set local role authenticated;
  v_err := pg_temp.fails_with(format(
    'select public.request_order_document_generation(%L::uuid)', v_ord));
  reset role;
  perform pg_temp.ok(v_err like '42501|%' and v_err like '%NO_SUCH_ORDER%',
    'the approval authority alone is not enough — the Order must be visible: ' || v_err);

  -- ── The admin holds both ──
  perform pg_temp.act_as('admin');
  set local role authenticated;
  v_res := public.request_order_document_generation(v_ord);
  reset role;
  perform pg_temp.ok((v_res ->> 'created')::boolean, 'the admin may request generation');
  perform pg_temp.ok((v_res ->> 'version')::int = 1, 'the first request is version 1');
  perform pg_temp.ok(v_res ->> 'status' = 'pending', 'and it starts pending');

  -- ── Idempotence ──
  set local role authenticated;
  v_res := public.request_order_document_generation(v_ord);
  reset role;
  perform pg_temp.ok(not (v_res ->> 'created')::boolean,
    'pressing it again does not queue a second generation');
  perform pg_temp.ok((v_res ->> 'version')::int = 1, 'and does not advance the version');
  perform pg_temp.ok(
    (select count(*) from public.order_document_versions where order_id = v_ord) = 1,
    'exactly one version row exists');

  -- ── The activity trail ──
  perform pg_temp.ok(
    (select count(*) from public.order_activity_log
      where order_id = v_ord and event_type = 'document_generation_started') = 1,
    'the request is on the Order activity trail, once');
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- D. The claim
-- ═══════════════════════════════════════════════════════════════════════════

do $$
declare
  v_ord   uuid := (select v from t_fix where k = 'order');
  v_first jsonb;
  v_again jsonb;
  v_vid   uuid;
begin
  perform pg_temp.act_as('admin');

  v_first := public.claim_order_document_generation(v_ord);
  perform pg_temp.ok((v_first ->> 'claimed')::boolean, 'a pending version can be claimed');
  perform pg_temp.ok((v_first ->> 'attempt')::int = 1, 'the first claim is attempt 1');
  perform pg_temp.ok((v_first ->> 'claim_token') is not null, 'a claim carries a token');
  v_vid := (v_first ->> 'version_id')::uuid;

  -- THE KEYS THIS RUN MUST WRITE TO — attempt-scoped, under the version's own
  -- reserved prefix, so nothing it writes can ever collide with an earlier run.
  perform pg_temp.ok(
    v_first ->> 'excel_path' =
      'orders/' || v_ord::text || '/versions/1/attempts/1/approved.xlsx',
    'the workbook key is attempt-scoped: ' || (v_first ->> 'excel_path'));
  perform pg_temp.ok(
    v_first ->> 'pdf_path' =
      'orders/' || v_ord::text || '/versions/1/attempts/1/approved.pdf',
    'and so is the PDF key');

  -- ── ONLY ONE WORKER MAY OWN A LIVE CLAIM ──
  v_again := public.claim_order_document_generation(v_ord);
  perform pg_temp.ok(not (v_again ->> 'claimed')::boolean,
    'a second worker cannot take a live claim');
  perform pg_temp.ok(
    (select attempt_count from public.order_document_versions where id = v_vid) = 1,
    'and a refused claim does not count as an attempt');

  -- ── A STALE CLAIM MAY BE TAKEN OVER, AND ONLY A STALE ONE ──
  update public.order_document_versions
     set claimed_at = now() - public.order_document_claim_ttl() - interval '1 second'
   where id = v_vid;

  v_again := public.claim_order_document_generation(v_ord);
  perform pg_temp.ok((v_again ->> 'claimed')::boolean,
    'a claim older than the ttl may be taken over');
  perform pg_temp.ok((v_again ->> 'attempt')::int = 2,
    'a takeover IS an attempt and counts as one');
  perform pg_temp.ok(
    (v_again ->> 'claim_token')::uuid <> (v_first ->> 'claim_token')::uuid,
    'the takeover mints a NEW token, so the old worker is locked out');
  perform pg_temp.ok(
    v_again ->> 'excel_path' =
      'orders/' || v_ord::text || '/versions/1/attempts/2/approved.xlsx',
    'and writes to a key nothing has ever occupied');

  -- ── THE OLD WORKER CANNOT PUBLISH ──
  perform pg_temp.ok(
    not (public.complete_order_document_generation(
      v_vid, (v_first ->> 'claim_token')::uuid,
      v_again ->> 'excel_path', v_again ->> 'pdf_path',
      null, null, null, null) ->> 'completed')::boolean,
    'a superseded worker''s completion is refused');
  perform pg_temp.ok(
    not (public.fail_order_document_generation(
      v_vid, (v_first ->> 'claim_token')::uuid, 'X', 'x') ->> 'failed')::boolean,
    'and so is its failure');
  perform pg_temp.ok(
    (select status from public.order_document_versions where id = v_vid) = 'claimed',
    'the live claim is untouched by either');

  -- ── A MISSING TOKEN IS AN ERROR, NOT A SILENT NO-OP ──
  perform pg_temp.ok(
    pg_temp.fails_with(format(
      'select public.complete_order_document_generation(%L::uuid, null, ''a'', ''b'', null, null, null, null)', v_vid))
      like '42501|%',
    'completing with no token at all is refused outright');
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- E. complete / fail, and the `ready` invariant
-- ═══════════════════════════════════════════════════════════════════════════

do $$
declare
  v_ord   uuid := (select v from t_fix where k = 'order');
  v_vid   uuid;
  v_token uuid;
  v_xlsx  text;
  v_pdf   text;
  v_res   jsonb;
begin
  perform pg_temp.act_as('admin');

  select id, claim_token into v_vid, v_token
  from public.order_document_versions where order_id = v_ord and status = 'claimed';

  v_xlsx := public.order_document_attempt_path(v_ord, 1, 2, 'xlsx');
  v_pdf  := public.order_document_attempt_path(v_ord, 1, 2, 'pdf');

  -- ── ONE FILE IS NOT A VERSION ──
  perform pg_temp.ok(
    pg_temp.fails_with(format(
      'select public.complete_order_document_generation(%L::uuid, %L::uuid, %L, null, null, null, null, null)',
      v_vid, v_token, v_xlsx)) like '%ORDER_DOCUMENT_INCOMPLETE%',
    'a version cannot become ready with only the workbook');
  perform pg_temp.ok(
    pg_temp.fails_with(format(
      'select public.complete_order_document_generation(%L::uuid, %L::uuid, %L, %L, null, null, null, null)',
      v_vid, v_token, v_xlsx, '   ')) like '%ORDER_DOCUMENT_INCOMPLETE%',
    'and a blank PDF path is not a PDF');

  -- ── AND THE CONSTRAINT SAYS SO INDEPENDENTLY ──
  -- Even acting as the table owner, `ready` without both files is unrepresentable.
  perform pg_temp.ok(
    pg_temp.fails_with(format(
      'update public.order_document_versions set status = ''ready'', completed_at = now(),
         claim_token = null, claimed_at = null, excel_path = %L where id = %L::uuid',
      v_xlsx, v_vid)) like '23514|%',
    'order_document_versions_ready_is_complete refuses a half-ready row');

  -- ── A PATH OUTSIDE THE VERSION IS REFUSED ──
  perform pg_temp.ok(
    pg_temp.fails_with(format(
      'select public.complete_order_document_generation(%L::uuid, %L::uuid, %L, %L, null, null, null, null)',
      v_vid, v_token,
      'orders/' || gen_random_uuid()::text || '/versions/1/attempts/1/approved.xlsx',
      v_pdf)) like '%ORDER_DOCUMENT_PATH_%',
    'a version cannot publish another Order''s file');
  perform pg_temp.ok(
    pg_temp.fails_with(format(
      'select public.complete_order_document_generation(%L::uuid, %L::uuid, %L, %L, null, null, null, null)',
      v_vid, v_token,
      'submissions/' || gen_random_uuid()::text || '/original/a.xlsx',
      v_pdf)) like '%ORDER_DOCUMENT_PATH_%',
    'nor a PI file');

  -- ── BOTH FILES: PUBLISHED ──
  v_res := public.complete_order_document_generation(
    v_vid, v_token, v_xlsx, v_pdf,
    repeat('a', 64), repeat('b', 64), 12345, 6789);
  perform pg_temp.ok((v_res ->> 'completed')::boolean, 'both files present publishes the version');

  perform pg_temp.ok(
    (select status = 'ready' and completed_at is not null
            and claim_token is null and claimed_at is null
            and excel_sha256 = repeat('a', 64) and pdf_sha256 = repeat('b', 64)
            and excel_bytes = 12345 and pdf_bytes = 6789
       from public.order_document_versions where id = v_vid),
    'the published row records both hashes, both sizes, and releases the lease');

  perform pg_temp.ok(
    (select count(*) from public.order_activity_log
      where order_id = v_ord and event_type = 'document_generation_ready') = 1,
    'and the Order activity trail says so');

  -- ── READY IS TERMINAL ──
  perform pg_temp.ok(
    pg_temp.fails_with(format(
      'update public.order_document_versions set status = ''pending'' where id = %L::uuid', v_vid))
      like '%ORDER_DOCUMENT_READY_IS_TERMINAL%',
    'a published version cannot be reopened');
  perform pg_temp.ok(
    pg_temp.fails_with(format(
      'update public.order_document_versions set excel_path = %L where id = %L::uuid',
      public.order_document_attempt_path(v_ord, 1, 9, 'xlsx'), v_vid))
      like '%ORDER_DOCUMENT_READY_IS_TERMINAL%',
    'and its files cannot be repointed');
  perform pg_temp.ok(
    pg_temp.fails_with(format(
      'update public.order_document_versions set version = 7 where id = %L::uuid', v_vid))
      like '%ORDER_DOCUMENT_IMMUTABLE_VERSION%',
    'and its version number is fixed');
  perform pg_temp.ok(
    pg_temp.fails_with(format(
      'update public.order_document_versions set attempt_count = 0 where id = %L::uuid', v_vid))
      like '%ORDER_DOCUMENT_ATTEMPTS_ARE_HISTORY%',
    'and attempt history cannot be rewritten');
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- F. Retry, and a failure that publishes nothing
-- ═══════════════════════════════════════════════════════════════════════════

do $$
declare
  v_ord    uuid := (select v from t_fix where k = 'order');
  v_orders bigint;
  v_number text;
  v_res    jsonb;
  v_vid    uuid;
  v_token  uuid;
begin
  perform pg_temp.act_as('admin');

  select count(*), max(display_number) into v_orders, v_number from public.orders;

  -- A READY version means the next request is the NEXT version — that is what an
  -- approved amendment produces, and it is not a retry.
  v_res := public.request_order_document_generation(v_ord);
  perform pg_temp.ok((v_res ->> 'version')::int = 2,
    'asking again once documents exist produces version 2');

  -- Now fail version 2 and prove a retry reuses it.
  v_res  := public.claim_order_document_generation(v_ord);
  v_vid  := (v_res ->> 'version_id')::uuid;
  v_token := (v_res ->> 'claim_token')::uuid;

  perform pg_temp.ok(
    pg_temp.fails_with(format(
      'select public.fail_order_document_generation(%L::uuid, %L::uuid, '''', ''x'')', v_vid, v_token))
      like '%ORDER_DOCUMENT_NO_ERROR_CODE%',
    'a failure must say why');

  perform pg_temp.ok(
    (public.fail_order_document_generation(
       v_vid, v_token, 'WORKBOOK_UNREADABLE',
       'The stored workbook could not be read.') ->> 'failed')::boolean,
    'a claimed version can be failed with its token');

  perform pg_temp.ok(
    (select status = 'failed' and last_error_code = 'WORKBOOK_UNREADABLE'
            and excel_path is null and pdf_path is null
            and excel_sha256 is null and pdf_sha256 is null
            and claim_token is null
       from public.order_document_versions where id = v_vid),
    'a FAILED version names no files at all — whatever it uploaded stays unnamed');

  -- ── THE RETRY REUSES THE VERSION ──
  v_res := public.request_order_document_generation(v_ord);
  perform pg_temp.ok((v_res ->> 'version')::int = 2,
    'a retry does NOT advance the user-facing version');
  perform pg_temp.ok((v_res ->> 'retry')::boolean, 'and is recorded as a retry');
  perform pg_temp.ok(
    (select attempt_count from public.order_document_versions where id = v_vid) = 1,
    'the attempt history survives the retry');
  perform pg_temp.ok(
    (select count(*) from public.order_document_versions where order_id = v_ord) = 2,
    'a failed attempt produced NO extra version row');
  perform pg_temp.ok(
    (select count(*) from public.order_activity_log
      where order_id = v_ord and event_type = 'document_generation_retried') = 1,
    'and the retry is on the activity trail');

  -- ── AND NOTHING ELSE MOVED ──
  perform pg_temp.ok(
    (select count(*) from public.orders) = v_orders,
    'no Order was created by requesting, claiming, failing or retrying');
  perform pg_temp.ok(
    (select max(display_number) from public.orders) is not distinct from v_number,
    'and no Order number was allocated');
  perform pg_temp.ok(
    (select count(*) from public.finance_payment_allocations
      where order_id = v_ord) = 0,
    'and no payment allocation was created or moved');
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- G. Storage — publication, not location
-- ═══════════════════════════════════════════════════════════════════════════
--
-- THE CENTRAL GUARANTEE OF THIS PHASE. A file is downloadable because a READY
-- version names it. An attempt that died having uploaded half its output leaves
-- an object nothing names, and it must be unreachable by every client role —
-- permanently — even though it sits under an Order the caller can see.

do $$
declare
  v_ord     uuid := (select v from t_fix where k = 'order');
  v_sub     uuid := (select v from t_fix where k = 'submission');
  v_published text;
  v_orphan  text;
begin
  select excel_path into v_published
  from public.order_document_versions where order_id = v_ord and status = 'ready';

  -- The half-upload of the attempt that later failed.
  v_orphan := public.order_document_attempt_path(v_ord, 2, 1, 'xlsx');

  insert into storage.objects (bucket_id, name) values
    ('order-files', v_published),
    ('order-files', v_orphan),
    ('order-files', 'submissions/' || v_sub::text || '/original/pi.xlsx');

  -- ── The operations lead: sees the published document and the PI's workbook ──
  perform pg_temp.act_as('operations');
  set local role authenticated;
  perform pg_temp.ok(
    (select count(*) from storage.objects where name = v_published) = 1,
    'a viewer of the Order can read its PUBLISHED document');
  perform pg_temp.ok(
    (select count(*) from storage.objects where name = v_orphan) = 0,
    'and CANNOT read the half-upload of a failed attempt');
  perform pg_temp.ok(
    (select count(*) from storage.objects
      where name = 'submissions/' || v_sub::text || '/original/pi.xlsx') = 1,
    'and can read the approved PI''s original workbook');
  reset role;

  -- ── The PI reviewer: the PI's files, and NOT the Order's documents ──
  perform pg_temp.act_as('reviewer');
  set local role authenticated;
  perform pg_temp.ok(
    (select count(*) from storage.objects
      where name = 'submissions/' || v_sub::text || '/original/pi.xlsx') = 1,
    'a PI reviewer still reads the PI''s own files');
  perform pg_temp.ok(
    (select count(*) from storage.objects where name = v_published) = 0,
    'PI-review access alone must NOT reach a Confirmed Order''s documents');
  reset role;

  -- ── The stranger: nothing ──
  perform pg_temp.act_as('other');
  update public.orders set assigned_to = null where id = v_ord;  -- take away the
                                                                 -- assignment A relied on
  set local role authenticated;
  perform pg_temp.ok(
    (select count(*) from storage.objects
      where bucket_id = 'order-files') = 0,
    'somebody with no standing on the Order and no PI role reads nothing at all');
  perform pg_temp.ok(not public.can_view_order(v_ord),
    'and cannot view the Order either');
  reset role;

  -- ── The register itself follows the same rule ──
  perform pg_temp.act_as('other');
  set local role authenticated;
  perform pg_temp.ok(
    (select count(*) from public.order_document_versions where order_id = v_ord) = 0,
    'and sees no document state');
  reset role;

  perform pg_temp.act_as('viewall');
  set local role authenticated;
  perform pg_temp.ok(
    (select count(*) from public.order_document_versions where order_id = v_ord) = 2,
    'an orders.view_all holder sees both versions');
  reset role;
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- H. Privileges
-- ═══════════════════════════════════════════════════════════════════════════

do $$
declare v_bad text;
begin
  -- The worker half is unreachable from a browser.
  select string_agg(p.proname, ', ') into v_bad
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('claim_order_document_generation',
                      'complete_order_document_generation',
                      'fail_order_document_generation',
                      'log_order_document_event',
                      'order_document_versions_guard')
    and has_function_privilege('authenticated', p.oid, 'execute');
  perform pg_temp.ok(v_bad is null,
    'these must not be callable by authenticated: ' || coalesce(v_bad, ''));

  -- THE LEASE TOKEN IS NOT SELECTABLE, even for a row the caller may read.
  perform pg_temp.ok(
    not exists (
      select 1 from information_schema.column_privileges
      where table_schema = 'public' and table_name = 'order_document_versions'
        and column_name = 'claim_token'
        and grantee in ('anon', 'authenticated', 'public')),
    'claim_token must not be granted to any client role');

  perform pg_temp.act_as('admin');
  set local role authenticated;
  perform pg_temp.ok(
    pg_temp.fails_with('select claim_token from public.order_document_versions') like '42501|%',
    'and PostgreSQL refuses the column outright');
  reset role;

  -- ── THE CLIENT-WRITABLE SURFACE ──
  --
  -- It exists — the request and the retry are ordinary client writes, so that
  -- RLS can decide them as the CALLER (a SECURITY DEFINER function would ask
  -- can_view_order on behalf of the table owner, who bypasses RLS, and would
  -- authorize the whole business). What matters is how small it is.

  perform pg_temp.ok(
    (select string_agg(policyname || '/' || cmd, ', ' order by policyname)
       from pg_policies
      where schemaname = 'public' and tablename = 'order_document_versions'
        and cmd in ('INSERT', 'UPDATE', 'DELETE'))
    = 'order_document_versions_request_insert/INSERT, order_document_versions_retry_update/UPDATE',
    'exactly two client write policies exist, and no DELETE policy at all');

  -- NO TABLE-WIDE write privilege. The two policies are reachable only through
  -- COLUMN grants, which is the second, independent narrowing.
  select string_agg(distinct privilege_type, ', ') into v_bad
  from information_schema.role_table_grants
  where table_schema = 'public' and table_name = 'order_document_versions'
    and grantee in ('anon', 'authenticated', 'public')
    and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE');
  perform pg_temp.ok(v_bad is null,
    'a client role holds table-wide ' || coalesce(v_bad, '') || ' on order_document_versions');

  perform pg_temp.ok(
    (select string_agg(privilege_type || ':' || column_name, ', ' order by privilege_type, column_name)
       from information_schema.column_privileges
      where table_schema = 'public' and table_name = 'order_document_versions'
        and grantee in ('anon', 'authenticated', 'public')
        and privilege_type in ('INSERT', 'UPDATE'))
    = 'INSERT:order_id, INSERT:version, UPDATE:last_error_code, UPDATE:last_error_message, UPDATE:status',
    'the client-writable surface is exactly the intended five columns');

  -- order-files is still private and still has no UPDATE policy.
  perform pg_temp.ok(
    exists (select 1 from storage.buckets
             where id = 'order-files' and public = false and file_size_limit = 10485760),
    'order-files is private at the 10 MiB limit');
  perform pg_temp.ok(
    not exists (
      select 1 from pg_policy p
      join pg_class c on c.oid = p.polrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'storage' and c.relname = 'objects'
        and p.polname like 'order_files_%' and p.polcmd = 'w'),
    'order-files has no UPDATE policy; stored files stay immutable');
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- I. What the client write surface cannot do
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Section H proved the surface is five columns. This proves those five columns
-- are not enough to do anything a person should not — ACTING AS AN ADMIN, who
-- holds every authority this system offers, so nothing here is refused merely
-- for want of permission.

do $$
declare
  v_ord uuid := (select v from t_fix where k = 'order');
  v_vid uuid;
  v_err text;
begin
  perform pg_temp.act_as('admin');
  set local role authenticated;

  select id into v_vid from public.order_document_versions
   where order_id = v_ord and status = 'ready' limit 1;

  -- THE LEASE CANNOT BE MINTED.
  perform pg_temp.ok(
    pg_temp.fails_with(format(
      'update public.order_document_versions set claim_token = gen_random_uuid() where id = %L::uuid', v_vid))
      like '42501|%',
    'a client cannot write claim_token');

  -- A VERSION CANNOT BE PUBLISHED FROM A BROWSER.
  perform pg_temp.ok(
    pg_temp.fails_with(format(
      'update public.order_document_versions set excel_path = ''x'' where id = %L::uuid', v_vid))
      like '42501|%',
    'a client cannot name a file');
  perform pg_temp.ok(
    pg_temp.fails_with(format(
      'update public.order_document_versions set completed_at = now() where id = %L::uuid', v_vid))
      like '42501|%',
    'a client cannot mark a version complete');
  perform pg_temp.ok(
    pg_temp.fails_with(format(
      'update public.order_document_versions set attempt_count = 99 where id = %L::uuid', v_vid))
      like '42501|%',
    'a client cannot rewrite attempt history');

  -- A READY VERSION CANNOT BE REOPENED, even through a granted column: the
  -- retry policy's USING clause admits only a FAILED row.
  perform pg_temp.ok(
    (select count(*) from public.order_document_versions where id = v_vid) = 1,
    'the ready version is visible to this admin');
  perform pg_temp.ok(
    pg_temp.fails_with(format(
      'update public.order_document_versions set status = ''pending'' where id = %L::uuid', v_vid))
      not like '42501|%'
    and (select status from public.order_document_versions where id = v_vid) = 'ready',
    'and an UPDATE that names only granted columns still moves nothing: the policy admits no ready row');

  -- A VERSION CANNOT BE OPENED OUT OF SEQUENCE.
  v_err := pg_temp.fails_with(format(
    'insert into public.order_document_versions (order_id, version) values (%L::uuid, 99)', v_ord));
  perform pg_temp.ok(v_err like '%ORDER_DOCUMENT_VERSION_OUT_OF_SEQUENCE%',
    'a client cannot open version 99 and leave a permanent hole: ' || v_err);

  -- NOR AGAINST AN ORDER THAT NEVER CAME FROM A PI.
  reset role;
  insert into public.orders (client_name, requested_by, created_by, status, total_value)
  values ('[TEST] No PI', current_setting('test.owner')::uuid,
          current_setting('test.admin')::uuid, 'running', 1000)
  returning id into v_vid;
  set local role authenticated;
  v_err := pg_temp.fails_with(format(
    'insert into public.order_document_versions (order_id, version) values (%L::uuid, 1)', v_vid));
  perform pg_temp.ok(v_err like '%ORDER_DOCUMENT_NO_SOURCE_PI%',
    'an Order with no source PI has no documents to generate: ' || v_err);

  -- AND A CLIENT CANNOT DELETE ONE.
  perform pg_temp.ok(
    pg_temp.fails_with('delete from public.order_document_versions') like '42501|%',
    'a client cannot delete a document version');

  reset role;
end $$;

do $$ begin raise notice 'ALL ASSERTIONS PASSED'; end $$;

rollback;
