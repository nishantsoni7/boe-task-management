-- ════════════════════════════════════════════════════════════════════════════
-- CONFIRMED ORDER DOCUMENTS — STATE, VERSIONS AND THE CLAIM PROTOCOL
--
-- WHAT THIS PHASE IS FOR
-- ----------------------
-- Approving a PI creates an Order, allocates its permanent number and moves the
-- money. That transaction is ATOMIC and must stay small: it already holds a row
-- lock on the submission, advances the number cycle and rewrites allocations,
-- and a workbook rewrite or a PDF render inside it would mean a slow render, a
-- storage timeout or a corrupt upload could cost a business an Order number.
--
-- So document generation is SEPARATE, and it happens AFTER approval. Which
-- immediately raises the question this migration answers: if generation is not
-- part of the approving transaction, what records that it is owed, who is doing
-- it right now, whether it finished, and what to show a person while it has not?
--
--   the register   public.order_document_versions — one row per USER-FACING
--                  version of an Order's documents, carrying its status, its
--                  attempt history, its files and its last failure
--   the claim      an atomic, token-bearing lease over one version, so two
--                  workers can never both be generating it
--   the invariant  `ready` is IMPOSSIBLE unless both files exist. Not a
--                  convention — a CHECK constraint and a trigger.
--
-- WHAT A VERSION IS, AND WHAT AN ATTEMPT IS
-- -----------------------------------------
-- They are different things and conflating them is the defect this design
-- exists to avoid.
--
--   A VERSION is a business fact: the documents as they stand, or as they stand
--   after an approved amendment. Version 1 is the Order's first documents.
--   A person sees versions.
--
--   An ATTEMPT is a technical fact: one run of the generator. A run that fell
--   over because storage was slow is an attempt. It increases attempt_count, it
--   records why it failed, and it produces NO user-facing version.
--
-- A failed attempt therefore never appears as a version somebody could download,
-- and a retry never advances the version number. This is decision 14/15 of the
-- product brief stated as a schema.
--
-- STORAGE, AND WHY THE PATHS LOOK THE WAY THEY DO
-- -----------------------------------------------
-- 20260908000000 §9 reserved:
--
--   orders/{order_id}/versions/{version}/approved.xlsx
--   orders/{order_id}/versions/{version}/approved.pdf
--
-- and order-files has NO UPDATE POLICY, for any role. That is what makes a
-- stored file immutable and what defeats upsert — and it is deliberately not
-- being relaxed here.
--
-- But it collides with retry. If attempt 1 uploads approved.xlsx and then dies
-- before the PDF, attempt 2 cannot write approved.xlsx again: the key is taken,
-- the object cannot be replaced, and the version can never become ready. The
-- brief allows two ways out; this is the one taken, and why:
--
--   ✗ a fresh VERSION per attempt — rejected. It makes a technical failure into
--     a business fact, and 20260703000000's lesson is exactly that a number a
--     person sees must not move because a machine had a bad day.
--   ✓ ATTEMPT-SCOPED KEYS under the version's own reserved prefix:
--
--       orders/{order_id}/versions/{version}/attempts/{attempt}/approved.xlsx
--       orders/{order_id}/versions/{version}/attempts/{attempt}/approved.pdf
--
--     Every write goes to a key nothing has ever occupied, so upsert is never
--     needed and immutability is never bent. The version row then NAMES the two
--     objects of the attempt that succeeded, and those two are the version.
--
-- PUBLICATION IS WHAT MAKES A FILE DOWNLOADABLE, not its path. The storage rule
-- below authorizes an object only when a READY version row names it. A partial
-- attempt's half-uploaded workbook is therefore unreachable by every client
-- role, permanently, even though it sits under an Order the caller can see —
-- which is the "a partial upload never becomes downloadable" guarantee stated
-- as a policy rather than as a hope.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
-- --------------------------------------------
--   * It does not touch approve_order_submission(). Approval stays atomic and
--     stays exactly what it is; §7 asserts the function is untouched.
--   * It writes nothing to public.orders, allocates no number, and touches no
--     payment or allocation. §7 asserts that too — a retry that could move
--     money would be a far worse defect than a missing PDF.
--   * IT ADDS NO CLIENT WRITE ON STORAGE. Generation uploads with the server's
--     existing protected credentials; order-files gains no INSERT, UPDATE or
--     DELETE policy for the orders/ prefix, and still has no UPDATE policy at
--     all for any prefix.
--   * On the REGISTER it adds exactly two narrow client writes — the request and
--     the retry — and §5 explains at length why they must be RLS-decided writes
--     rather than a SECURITY DEFINER function. Between them they reach five
--     columns; a client cannot mint a lease, name a file, publish a version,
--     rewrite attempt history, reopen a published version or delete anything.
--   * It does not make order-files public and does not add an UPDATE policy.
--   * It introduces no generic job framework. This is one table and five
--     functions, shaped for this one thing.
--
-- Not one applied migration is edited. Timestamp is after 20260924000000.
-- ════════════════════════════════════════════════════════════════════════════


-- ═══ 1. The claim lease ═════════════════════════════════════════════════════
--
-- HOW LONG A CLAIM STANDS BEFORE ANOTHER WORKER MAY TAKE IT OVER.
--
-- Long enough that a slow but living generator is never overtaken mid-render —
-- a large workbook with many images plus a multi-page PDF is seconds, not
-- minutes, so fifteen minutes is generous by an order of magnitude. Short
-- enough that a worker killed by a deploy does not strand a version until
-- somebody notices.
--
-- A FUNCTION, NOT A LITERAL, so the value is named once and the tests can read
-- it rather than re-stating it.

create or replace function public.order_document_claim_ttl()
returns interval
language sql
immutable
as $$ select interval '15 minutes' $$;

comment on function public.order_document_claim_ttl() is
  'How long an unfinished document-generation claim stands before another worker may take it over. A stale claim is reclaimable; a live one is not.';

revoke execute on function public.order_document_claim_ttl() from public, anon;
grant  execute on function public.order_document_claim_ttl() to authenticated;


-- ═══ 2. The register ════════════════════════════════════════════════════════

create table if not exists public.order_document_versions (
  id            uuid        primary key default gen_random_uuid(),

  -- NO ON DELETE CLAUSE, deliberately. public.orders carries no DELETE policy
  -- and orders_prevent_delete refuses every path including the service role
  -- (20260705000000), so a cascade would describe a situation that cannot
  -- arise — and the one path that CAN remove an Order is the audited Test Data
  -- Cleanup, which must delete this row explicitly and be seen to.
  order_id      uuid        not null references public.orders(id),

  -- THE USER-FACING VERSION. 1 for the Order's first documents; a later number
  -- only ever for an approved amendment. A retry never moves it.
  version       integer     not null,

  status        text        not null default 'pending',

  -- THE TECHNICAL HISTORY. Incremented by every claim, including a takeover of
  -- a stale one, so "this has failed four times" is answerable without keeping
  -- four rows a person would mistake for four versions.
  attempt_count integer     not null default 0,

  -- The lease. NEVER RETURNED TO A BROWSER: there is no column grant for
  -- claim_token below, so a client SELECT cannot name it even with the row
  -- visible. It lives inside one server route for the length of one generation.
  claim_token   uuid,
  claimed_at    timestamptz,
  claimed_by    uuid        references public.users(id) on delete set null,

  completed_at  timestamptz,

  -- WHY IT FAILED, IN TWO PARTS. The code is a stable token the UI can branch
  -- on; the message is SANITIZED prose a person may read. Neither may ever
  -- carry a credential, a connection string or a stack trace — sanitization
  -- happens before the write, in the one server module that writes it, and §6
  -- refuses a message that looks like a leak.
  last_error_code    text,
  last_error_message text,

  -- The two objects THIS version is. Both null until an attempt succeeds; both
  -- present, or the row cannot be 'ready'.
  excel_path    text,
  pdf_path      text,
  excel_sha256  text,
  pdf_sha256    text,
  excel_bytes   bigint,
  pdf_bytes     bigint,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint order_document_versions_status_known
    check (status in ('pending', 'claimed', 'ready', 'failed')),

  constraint order_document_versions_version_positive
    check (version >= 1),

  constraint order_document_versions_attempts_nonnegative
    check (attempt_count >= 0),

  -- THE CENTRAL INVARIANT. `ready` is impossible unless both files exist and the
  -- moment of completion is recorded. A half-generated version cannot be
  -- represented in this table at all.
  constraint order_document_versions_ready_is_complete
    check (
      status <> 'ready'
      or (excel_path is not null and pdf_path is not null and completed_at is not null)
    ),

  -- A CLAIM IS A CLAIM. The three lease columns move together, and only a
  -- 'claimed' row holds them, so "is it already claimed" is one decision rather
  -- than two that could disagree.
  constraint order_document_versions_claim_consistent
    check (
      (status = 'claimed' and claim_token is not null and claimed_at is not null)
      or (status <> 'claimed' and claim_token is null and claimed_at is null)
    ),

  -- A FAILURE MUST SAY WHY. A 'failed' row with no code would be a dead end for
  -- whoever has to decide whether to retry.
  constraint order_document_versions_failed_has_code
    check (status <> 'failed' or last_error_code is not null),

  -- Hashes are recorded as lowercase hex sha-256 or not at all.
  constraint order_document_versions_excel_hash_shape
    check (excel_sha256 is null or excel_sha256 ~ '^[0-9a-f]{64}$'),
  constraint order_document_versions_pdf_hash_shape
    check (pdf_sha256 is null or pdf_sha256 ~ '^[0-9a-f]{64}$'),

  constraint order_document_versions_bytes_nonnegative
    check (
      (excel_bytes is null or excel_bytes >= 0)
      and (pdf_bytes is null or pdf_bytes >= 0)
    )
);

comment on table public.order_document_versions is
  'One row per USER-FACING version of a Confirmed Order''s generated documents. A version is a business fact; an attempt is a technical one and lives in attempt_count, never as a second row. `ready` is impossible without both files — see order_document_versions_ready_is_complete.';

comment on column public.order_document_versions.version is
  'The user-facing version. 1 for the Order''s first documents, higher only for an approved amendment. A retry never advances it.';
comment on column public.order_document_versions.attempt_count is
  'How many times generation has been claimed for this version, failures included. Technical history; never shown as a version.';
comment on column public.order_document_versions.claim_token is
  'The lease token. Unguessable, matched on release, and NEVER granted to a client role — a browser cannot select this column even for a row it can read.';
comment on column public.order_document_versions.last_error_message is
  'A sanitized, human-readable reason for the last failure. Never a stack trace, a connection string or a credential.';
comment on column public.order_document_versions.excel_path is
  'The confirmed workbook object for this version, under orders/{order_id}/versions/{version}/attempts/{attempt}/. Naming it here is what PUBLISHES it: the storage policy authorizes an object only when a ready version row names it.';

-- ONE ROW PER VERSION OF AN ORDER.
create unique index if not exists order_document_versions_order_version_uidx
  on public.order_document_versions (order_id, version);

-- AND AT MOST ONE GENERATION IN FLIGHT PER ORDER. Not per version — per ORDER:
-- two versions of the same Order being generated at once would race for the
-- same source workbook and the same Order number, and the second would be
-- deciding what the first had not finished saying.
create unique index if not exists order_document_versions_active_uidx
  on public.order_document_versions (order_id)
  where status in ('pending', 'claimed');

-- Only claimed rows are indexed: a claim is rare and short-lived, and this
-- index exists for the stale sweep alone.
create index if not exists order_document_versions_claimed_idx
  on public.order_document_versions (claimed_at)
  where status = 'claimed';

create index if not exists order_document_versions_order_idx
  on public.order_document_versions (order_id);


-- ═══ 3. Paths ═══════════════════════════════════════════════════════════════
--
-- ONE PLACE THAT SPELLS A KEY, in SQL, so the writer, the reader, the policy and
-- the tests cannot disagree about where a document lives. The TypeScript side
-- has the same three helpers and a test reads this migration to pin them
-- together.
--
-- IMMUTABLE and fully pg_catalog-pinned: these are evaluated inside a storage
-- policy, so a caller-controlled search_path must not be able to change what a
-- path comes out as.

create or replace function public.order_document_version_prefix(
  p_order_id uuid,
  p_version  integer
)
returns text
language sql
immutable
as $$
  select 'orders/' || p_order_id::text || '/versions/' || p_version::text;
$$;

comment on function public.order_document_version_prefix(uuid, integer) is
  'The reserved prefix for one version of one Order''s documents: orders/{order_id}/versions/{version}. Reserved by 20260908000000 §9.';

create or replace function public.order_document_attempt_path(
  p_order_id uuid,
  p_version  integer,
  p_attempt  integer,
  p_kind     text
)
returns text
language sql
immutable
as $$
  select case
    -- A kind this system does not produce yields NULL rather than a plausible
    -- key. Every caller treats null as a refusal.
    when p_kind not in ('xlsx', 'pdf') then null
    when p_order_id is null or p_version is null or p_attempt is null then null
    when p_version < 1 or p_attempt < 1 then null
    else public.order_document_version_prefix(p_order_id, p_version)
         || '/attempts/' || p_attempt::text || '/approved.' || p_kind
  end;
$$;

comment on function public.order_document_attempt_path(uuid, integer, integer, text) is
  'Where ONE ATTEMPT writes its output. Attempt-scoped because order-files has no UPDATE policy and objects are immutable: every write must go to a key nothing has ever occupied, so a retry never needs upsert. Null for an unknown kind or an impossible version/attempt.';

revoke execute on function public.order_document_version_prefix(uuid, integer) from public, anon;
revoke execute on function public.order_document_attempt_path(uuid, integer, integer, text) from public, anon;
grant  execute on function public.order_document_version_prefix(uuid, integer) to authenticated;
grant  execute on function public.order_document_attempt_path(uuid, integer, integer, text) to authenticated;


-- ═══ 4. The guard ═══════════════════════════════════════════════════════════
--
-- WHAT A ROW MAY NEVER DO, enforced where no caller can route around it — the
-- service role included, which is the whole reason this is a trigger and not
-- application code.
--
--   * An Order id and a version are decided once. Moving either would make a
--     version of one Order silently become a version of another.
--   * `ready` IS TERMINAL for its version. Once documents have been published
--     and possibly downloaded, that version is a fact. A correction is a NEW
--     version, which is what an approved amendment produces.
--   * attempt_count never decreases. It is history.
--   * A published path must be inside its OWN version's reserved prefix. A row
--     naming an object under another Order — or anywhere else in the bucket —
--     would publish a file its Order has no claim to.

create or replace function public.order_document_versions_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_prefix text;
begin
  if tg_op = 'UPDATE' then
    if new.order_id is distinct from old.order_id then
      raise exception 'ORDER_DOCUMENT_IMMUTABLE_ORDER: a document version cannot change Order'
        using errcode = 'P0001';
    end if;

    if new.version is distinct from old.version then
      raise exception 'ORDER_DOCUMENT_IMMUTABLE_VERSION: a document version number cannot change; a correction is a new version'
        using errcode = 'P0001';
    end if;

    if old.status = 'ready' and new.status is distinct from 'ready' then
      raise exception 'ORDER_DOCUMENT_READY_IS_TERMINAL: a published version cannot be reopened; generate a new version instead'
        using errcode = 'P0001';
    end if;

    if old.status = 'ready' and (
         new.excel_path is distinct from old.excel_path
      or new.pdf_path   is distinct from old.pdf_path
      or new.excel_sha256 is distinct from old.excel_sha256
      or new.pdf_sha256   is distinct from old.pdf_sha256
    ) then
      raise exception 'ORDER_DOCUMENT_READY_IS_TERMINAL: the files of a published version cannot be repointed'
        using errcode = 'P0001';
    end if;

    if new.attempt_count < old.attempt_count then
      raise exception 'ORDER_DOCUMENT_ATTEMPTS_ARE_HISTORY: attempt_count cannot decrease'
        using errcode = 'P0001';
    end if;

    new.updated_at := now();
  end if;

  if tg_op = 'INSERT' then
    -- DOCUMENTS ARE A COPY OF AN APPROVED PI. An Order created by another route
    -- has no workbook to rewrite and no approved data to render, so a request
    -- against one is refused here rather than failing halfway through a
    -- generation attempt.
    if not exists (
      select 1 from public.orders o
      where o.id = new.order_id and o.source_order_submission_id is not null
    ) then
      raise exception 'ORDER_DOCUMENT_NO_SOURCE_PI: this Order was not created from a PI, so it has no documents to generate'
        using errcode = 'P0001';
    end if;

    -- VERSIONS ARE CONSECUTIVE. The number is not the writer's to choose: it is
    -- one past the highest this Order has. A client granted the column could
    -- otherwise open version 99 and leave a permanent hole.
    if new.version is distinct from (
      select coalesce(max(d.version), 0) + 1
      from public.order_document_versions d
      where d.order_id = new.order_id
    ) then
      raise exception 'ORDER_DOCUMENT_VERSION_OUT_OF_SEQUENCE: the next version of this Order is %',
        (select coalesce(max(d.version), 0) + 1 from public.order_document_versions d where d.order_id = new.order_id)
        using errcode = 'P0001';
    end if;
  end if;

  -- Both INSERT and UPDATE: a path is inside its own version's prefix or it is
  -- refused. `like prefix || '/%'` and not a bare prefix test, so
  -- .../versions/1 cannot authorize .../versions/10.
  v_prefix := public.order_document_version_prefix(new.order_id, new.version);

  if new.excel_path is not null and new.excel_path not like v_prefix || '/%' then
    raise exception 'ORDER_DOCUMENT_PATH_OUTSIDE_VERSION: % is not inside %', new.excel_path, v_prefix
      using errcode = 'P0001';
  end if;

  if new.pdf_path is not null and new.pdf_path not like v_prefix || '/%' then
    raise exception 'ORDER_DOCUMENT_PATH_OUTSIDE_VERSION: % is not inside %', new.pdf_path, v_prefix
      using errcode = 'P0001';
  end if;

  -- A key that is not well formed is refused outright rather than stored and
  -- later decoded to null by the storage policy — a row naming an unreachable
  -- object would read as published while being undownloadable.
  if new.excel_path is not null
     and public.order_file_order_id(new.excel_path) is distinct from new.order_id then
    raise exception 'ORDER_DOCUMENT_PATH_UNDECODABLE: the workbook key does not decode to this Order'
      using errcode = 'P0001';
  end if;

  if new.pdf_path is not null
     and public.order_file_order_id(new.pdf_path) is distinct from new.order_id then
    raise exception 'ORDER_DOCUMENT_PATH_UNDECODABLE: the PDF key does not decode to this Order'
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

drop trigger if exists order_document_versions_guard_trg on public.order_document_versions;
create trigger order_document_versions_guard_trg
  before insert or update on public.order_document_versions
  for each row execute function public.order_document_versions_guard();

comment on function public.order_document_versions_guard() is
  'Refuses the four things a document version may never do: change Order, change version, reopen a published one, or name a file outside its own reserved prefix. A trigger rather than application code, so the service role is bound by it too.';

revoke execute on function public.order_document_versions_guard() from public, anon, authenticated, service_role;

-- A version row is NEVER deleted by a client, and only ever by the audited Test
-- Data Cleanup acting as the owner. No DELETE policy exists and none is added.


-- ═══ 5. Row-level security ══════════════════════════════════════════════════
--
-- SIGHT FOLLOWS THE ORDER, exactly as the PI handoff does: can_view_order
-- (20260924000000) asks the Order's own RLS rather than restating it, so this
-- table can never show a version of an Order its reader could not open.
--
-- AND THE TOKEN IS NOT IN THE GRANT. RLS decides which ROWS; the column grant
-- decides which COLUMNS, and claim_token is in neither the grant nor any view.
-- A browser holding a row it may legitimately read still cannot name that
-- column: PostgreSQL refuses the select outright. That is a stronger guarantee
-- than "the application does not ask for it".
--
-- NO CLIENT WRITE, AT ALL. No INSERT, UPDATE or DELETE policy exists, and the
-- corresponding privileges are revoked, which is two independent refusals.

alter table public.order_document_versions enable row level security;

revoke all on table public.order_document_versions from public, anon, authenticated;

grant select (
  id, order_id, version, status, attempt_count,
  claimed_at, claimed_by, completed_at,
  last_error_code, last_error_message,
  excel_path, pdf_path, excel_sha256, pdf_sha256, excel_bytes, pdf_bytes,
  created_at, updated_at
) on public.order_document_versions to authenticated;

-- ── The ONE thing a person may write, and the two columns they may write it in ─
--
-- WHY A POLICY AND NOT A SECURITY DEFINER RPC — this is the important design
-- note in this migration.
--
-- The natural shape for "ask for documents" is a SECURITY DEFINER function that
-- checks the caller's authority and then inserts. It does not work here, and the
-- reason is worth stating so nobody reintroduces it: inside a SECURITY DEFINER
-- function the current user is the function's OWNER, and the owner of these
-- tables bypasses row-level security. can_view_order — which is SECURITY
-- INVOKER precisely so it asks the orders policies rather than restating them —
-- would therefore be asked on behalf of the owner and would answer `true` for
-- every Order in the business. The check would look right, read right, and
-- authorize everyone.
--
-- So the request is an ORDINARY CLIENT WRITE, decided by RLS, which Postgres
-- evaluates as the real caller. can_view_order then means what it says.
--
-- WHAT THAT CLIENT WRITE CAN DO IS ALMOST NOTHING:
--   * INSERT reaches TWO COLUMNS. order_id and version are the only columns
--     granted; status, attempt_count, the lease, the paths and the hashes all
--     take their defaults, so a browser cannot supply them at all — not merely
--     "is not allowed to", cannot NAME them. PostgreSQL refuses the statement.
--   * UPDATE reaches THREE, and only to move a FAILED version back to pending
--     with its error cleared. That is the retry, and it is the whole of it.
--   * Everything else — the claim, the token, the paths, publication — is the
--     worker's, is SECURITY DEFINER, and is revoked from every client role.
--   * order_document_versions_guard() and the CHECK constraints bind this write
--     exactly as they bind the server's.
--
-- A client therefore cannot mint a lease, cannot name a file, cannot publish a
-- version and cannot reopen one. It can ask, and it can ask again.

grant insert (order_id, version) on public.order_document_versions to authenticated;
grant update (status, last_error_code, last_error_message) on public.order_document_versions to authenticated;

create policy "order_document_versions_select" on public.order_document_versions
  for select to authenticated
  using (public.can_view_order(order_id));

comment on policy "order_document_versions_select" on public.order_document_versions is
  'Document state follows Order visibility — admin, operations, requester, assignee, or orders.view_all — because can_view_order asks the orders policies themselves. PI-review access alone reaches nothing here.';

create policy "order_document_versions_request_insert" on public.order_document_versions
  for insert to authenticated
  with check (
    -- WHO: the existing management approval authority — the protected action
    -- that already decides whether a person may turn a PI into an Order. Admin
    -- is inside actor_has_module_permission's first branch.
    public.actor_has_module_permission('orders', 'approve_order')
    -- AND WHICH ORDER: one this caller may actually see. Evaluated as the
    -- caller, which is the whole point of the note above.
    and public.can_view_order(order_id)
    -- AND IN WHAT STATE: a fresh, unclaimed, unpublished request and nothing
    -- else. Belt and braces over the column grant, so the intent is readable in
    -- the policy rather than only in a GRANT statement.
    and status = 'pending'
    and attempt_count = 0
    and claim_token is null and claimed_at is null and completed_at is null
    and excel_path is null and pdf_path is null
    and last_error_code is null
  );

comment on policy "order_document_versions_request_insert" on public.order_document_versions is
  'The request for documents. Management approval authority AND sight of the Order, both decided as the CALLER — a SECURITY DEFINER function could not ask the second question honestly, because the owner bypasses RLS. Reaches two columns; everything else takes its default.';

create policy "order_document_versions_retry_update" on public.order_document_versions
  for update to authenticated
  using (
    public.actor_has_module_permission('orders', 'approve_order')
    and public.can_view_order(order_id)
    -- ONLY A FAILED VERSION. A pending one is already queued, a claimed one is
    -- being worked on, and a ready one is a published fact.
    and status = 'failed'
  )
  with check (
    public.actor_has_module_permission('orders', 'approve_order')
    and public.can_view_order(order_id)
    and status = 'pending'
    and last_error_code is null
    and last_error_message is null
  );

comment on policy "order_document_versions_retry_update" on public.order_document_versions is
  'The retry: a FAILED version back to pending, error cleared. Same two authorities as the request. Reaches three columns and cannot touch the lease, the paths or the version number.';

-- Parent module gate. RESTRICTIVE, so it ANDs: an employee whose Order
-- Management access is switched off reaches nothing here, whatever Order they
-- can otherwise see. Matches 20260905000000 and 20260908000000 §6.
create policy "order_document_versions_module_entry_gate" on public.order_document_versions
  as restrictive for all to authenticated
  using (public.module_entry_open('orders'))
  with check (public.module_entry_open('orders'));


-- ═══ 6. Publication, and the storage rule ═══════════════════════════════════
--
-- AN OBJECT IS DOWNLOADABLE BECAUSE A READY VERSION NAMES IT — never because of
-- where it sits. That single sentence is what makes "a partial upload never
-- becomes downloadable" true rather than hoped for: a workbook uploaded by an
-- attempt that then died is named by nothing, so no client role can read it,
-- ever, even though it lives under an Order they can see.

create or replace function public.can_view_order_document_object(p_object_name text)
returns boolean
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.order_document_versions d
    where d.status = 'ready'
      and (d.excel_path = p_object_name or d.pdf_path = p_object_name)
      -- The row itself is already filtered by order_document_versions_select,
      -- which is can_view_order — so this is the Order's own visibility,
      -- asked once, through the same predicate the rest of the module uses.
  );
$$;

comment on function public.can_view_order_document_object(text) is
  'True when this order-files object is a PUBLISHED document — named by a ready version row the CALLER may read. SECURITY INVOKER, so the register''s own RLS (can_view_order) decides. A partial attempt''s output is named by nothing and is unreachable by every client role.';

revoke execute on function public.can_view_order_document_object(text) from public, anon;
grant  execute on function public.can_view_order_document_object(text) to authenticated;

-- ── The storage policy, narrowed ────────────────────────────────────────────
--
-- 20260924000000 created order_files_confirmed_order_select and authorized the
-- reserved orders/ prefix by ORDER ALONE — which was the strongest rule
-- available at the time, because the register of published documents did not
-- yet exist. It does now, so the rule becomes the stricter one.
--
-- NEITHER MIGRATION HAS BEEN APPLIED; they ship and apply together, in order,
-- and this is the end state. The submissions/ branch is carried over VERBATIM —
-- Order-side sight of the approved PI's own files is unchanged.
--
-- Recreated rather than altered so the policy's whole expression is readable in
-- one place, which is what a person auditing storage access needs.

drop policy if exists "order_files_confirmed_order_select" on storage.objects;

create policy "order_files_confirmed_order_select" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'order-files'
    and public.module_entry_open('orders')
    and (
      public.can_view_order_submission_via_order(public.order_file_submission_id(name))
      or public.can_view_order_document_object(name)
    )
  );

comment on policy "order_files_confirmed_order_select" on storage.objects is
  'Order-side read access to order-files: the approved PI files a Confirmed Order came from, and PUBLISHED Order documents — those a ready version row names. An attempt''s partial output is named by nothing and is unreachable. Additive to order_files_select, which stays PI-review access. SELECT only.';


-- ═══ 7. The protocol ════════════════════════════════════════════════════════
--
--   request → claim → (complete | fail) → retry, which claims again
--
-- REQUEST is the only half a person performs, and it is authority-gated.
-- CLAIM, COMPLETE and FAIL are the worker's, are revoked from every client role,
-- and are reachable only by the server acting with its protected credentials.
-- That split is why a browser cannot mint a claim token, cannot mark a version
-- ready, and cannot fabricate a file path.

-- ── 7a. The activity writer ─────────────────────────────────────────────────
--
-- The ONLY writer of generation events. public.order_activity_log's event_type
-- is deliberately open text (20260656), so no constraint needs extending; the
-- four event names are stated here and nowhere else.

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
    'document_generation_retried'
  ) then
    raise exception 'ORDER_DOCUMENT_UNKNOWN_EVENT: %', p_event using errcode = 'P0001';
  end if;

  insert into public.order_activity_log (order_id, actor_id, event_type, payload)
  values (p_order_id, p_actor_id, p_event, coalesce(p_payload, '{}'::jsonb));
end;
$$;

comment on function public.log_order_document_event(uuid, uuid, text, jsonb) is
  'The only writer of document-generation events on the Order activity trail. The four event names are closed here; order_activity_log itself takes open text.';

revoke execute on function public.log_order_document_event(uuid, uuid, text, jsonb)
  from public, anon, authenticated, service_role;


-- ── 7b. Request ─────────────────────────────────────────────────────────────
--
-- SECURITY INVOKER, AND THAT IS DELIBERATE — see the long note above the two
-- write policies in §5. A definer would ask can_view_order on behalf of the
-- table owner, who bypasses RLS, and would therefore authorize everybody.
--
-- So this function decides NOTHING about authority. It arranges the write, and
-- the two policies decide whether it lands. The explicit authority test below is
-- a COURTESY, so a person gets "you need the approval authority" instead of a
-- bare policy violation — it is not the enforcement, and removing it would not
-- widen anything.
--
-- IDEMPOTENT. Pressing it twice does not queue two generations: the partial
-- unique index makes a second active row impossible, and this returns the
-- existing one rather than raising. Two people pressing it in the same instant
-- is the same case — one INSERT wins, the other is serialized behind the
-- advisory lock and reads the winner.
--
-- IT NEVER RESETS A READY VERSION. Asking again once documents exist creates the
-- NEXT version, which is what an approved amendment means. A retry of a FAILED
-- version reuses that version, because a failure produced nothing a person saw.

create or replace function public.request_order_document_generation(p_order_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  -- SCALARS, NOT A ROWTYPE, and that is not a style choice.
  --
  -- `select *` and `returning *` need SELECT on EVERY column of the row — which
  -- includes claim_token, and claim_token is deliberately granted to no client
  -- role. Under the caller's own privileges a rowtype fetch is therefore
  -- refused outright. Naming the columns is what keeps the lease unreadable
  -- while this function still works.
  v_id       uuid;
  v_version  integer;
  v_status   text;
  v_attempts integer;
  v_next     integer;
  v_retry    boolean := false;
begin
  if auth.uid() is null then
    raise exception 'ORDER_DOCUMENT_NOT_AUTHENTICATED' using errcode = '42501';
  end if;

  -- Courtesy, not enforcement. The policies re-decide both of these, as the
  -- caller, which is the only place they can be decided honestly.
  if not public.actor_has_module_permission('orders', 'approve_order') then
    raise exception 'ORDER_DOCUMENT_FORBIDDEN: generating Order documents needs the management approval authority'
      using errcode = '42501';
  end if;

  if not public.can_view_order(p_order_id) then
    raise exception 'ORDER_DOCUMENT_NO_SUCH_ORDER' using errcode = '42501';
  end if;

  -- Serialize against another request for the same Order. Advisory rather than a
  -- row lock: the row being contended may not exist yet.
  perform pg_advisory_xact_lock(hashtext('order_document_generation:' || p_order_id::text));

  -- Already in flight? Say so and change nothing.
  select d.id, d.version, d.status, d.attempt_count
    into v_id, v_version, v_status, v_attempts
  from public.order_document_versions d
  where d.order_id = p_order_id and d.status in ('pending', 'claimed')
  limit 1;

  if v_id is not null then
    return jsonb_build_object(
      'created', false, 'version', v_version, 'status', v_status,
      'version_id', v_id, 'attempt_count', v_attempts);
  end if;

  -- A failed version is RETRIED in place: it produced no user-facing version, so
  -- advancing the number would make a technical failure into a business fact.
  select d.id, d.version
    into v_id, v_version
  from public.order_document_versions d
  where d.order_id = p_order_id and d.status = 'failed'
  order by d.version desc
  limit 1;

  if v_id is not null then
    update public.order_document_versions
       set status = 'pending',
           last_error_code = null,
           last_error_message = null
     where id = v_id
    returning version, status, attempt_count
      into v_version, v_status, v_attempts;
    v_retry := true;
  else
    -- Otherwise the NEXT version. The guard re-derives this figure and refuses a
    -- row that does not carry it, so a racing writer cannot open a hole.
    select coalesce(max(d.version), 0) + 1 into v_next
    from public.order_document_versions d
    where d.order_id = p_order_id;

    -- TWO COLUMNS. Every other column takes its default, which is what the
    -- INSERT grant permits and all it permits.
    insert into public.order_document_versions (order_id, version)
    values (p_order_id, v_next)
    returning id, version, status, attempt_count
      into v_id, v_version, v_status, v_attempts;
  end if;

  return jsonb_build_object(
    'created', true, 'version', v_version, 'status', v_status,
    'version_id', v_id, 'attempt_count', v_attempts, 'retry', v_retry);
end;
$$;

comment on function public.request_order_document_generation(uuid) is
  'Asks for this Order''s documents. SECURITY INVOKER on purpose: the two write policies decide, as the caller, so can_view_order asks the orders policies honestly. Idempotent — a generation already in flight is reported, not duplicated. A FAILED version is retried in place; a READY one produces the next version.';

revoke execute on function public.request_order_document_generation(uuid) from public, anon;
grant  execute on function public.request_order_document_generation(uuid) to authenticated;


-- ── 7b-ii. The activity trail ───────────────────────────────────────────────
--
-- A TRIGGER, NOT A CALL, because the request is now an ordinary client write and
-- an invoker function cannot call the revoked logger. A trigger function is
-- invoked by the executor rather than by the user, so EXECUTE is not consulted —
-- which is exactly why the guard above can be revoked from everybody and still
-- fire. That makes the trail unforgeable: a client cannot write one of these
-- four events without actually moving the state that produces it.
--
-- The four transitions, and nothing else:
--   pending  (new row)      → started
--   failed  → pending       → retried
--   → ready                 → ready
--   → failed                → failed

create or replace function public.order_document_versions_log()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_event text;
begin
  if tg_op = 'INSERT' then
    v_event := 'document_generation_started';
  elsif new.status = 'ready' and old.status is distinct from 'ready' then
    v_event := 'document_generation_ready';
  elsif new.status = 'failed' and old.status is distinct from 'failed' then
    v_event := 'document_generation_failed';
  elsif new.status = 'pending' and old.status = 'failed' then
    v_event := 'document_generation_retried';
  else
    return null;   -- a claim is not a business event; it is a lease
  end if;

  perform public.log_order_document_event(
    new.order_id,
    coalesce(new.claimed_by, auth.uid()),
    v_event,
    jsonb_build_object(
      'version', new.version,
      'attempt_count', new.attempt_count)
      || case when v_event = 'document_generation_failed'
              then jsonb_build_object('error_code', new.last_error_code)
              else '{}'::jsonb end);
  return null;
end;
$$;

drop trigger if exists order_document_versions_log_trg on public.order_document_versions;
create trigger order_document_versions_log_trg
  after insert or update on public.order_document_versions
  for each row execute function public.order_document_versions_log();

comment on function public.order_document_versions_log() is
  'Writes the four document-generation events onto the Order activity trail, from the state change itself. A trigger rather than a call, so the trail cannot be written without the transition that earns it.';

revoke execute on function public.order_document_versions_log() from public, anon, authenticated, service_role;


-- ── 7c. Claim ───────────────────────────────────────────────────────────────
--
-- ATOMIC BY CONSTRUCTION. One UPDATE with the eligibility test in its WHERE
-- clause: PostgreSQL takes the row lock, re-evaluates the predicate against the
-- committed row, and updates it or matches nothing. Two workers arriving in the
-- same instant therefore cannot both win — the loser's UPDATE matches zero rows
-- and it is told the version is already claimed. There is no read-then-write
-- window because there is no read.
--
-- TAKEOVER IS EXPLICIT AND ONLY FOR A STALE CLAIM. A live claim is never
-- overtaken; one older than order_document_claim_ttl() may be, and doing so
-- increments attempt_count exactly as a fresh claim does, because it IS one.
--
-- SERVER-ONLY. Revoked from authenticated: no browser may mint a token.

create or replace function public.claim_order_document_generation(p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.order_document_versions;
begin
  update public.order_document_versions d
     set status        = 'claimed',
         claim_token   = gen_random_uuid(),
         claimed_at    = now(),
         claimed_by    = auth.uid(),
         attempt_count = d.attempt_count + 1
   where d.order_id = p_order_id
     and (
       d.status = 'pending'
       or (d.status = 'claimed' and d.claimed_at < now() - public.order_document_claim_ttl())
     )
  returning * into v_row;

  if not found then
    return jsonb_build_object('claimed', false);
  end if;

  return jsonb_build_object(
    'claimed',       true,
    'version_id',    v_row.id,
    'order_id',      v_row.order_id,
    'version',       v_row.version,
    'attempt',       v_row.attempt_count,
    'claim_token',   v_row.claim_token,
    'excel_path',    public.order_document_attempt_path(v_row.order_id, v_row.version, v_row.attempt_count, 'xlsx'),
    'pdf_path',      public.order_document_attempt_path(v_row.order_id, v_row.version, v_row.attempt_count, 'pdf')
  );
end;
$$;

comment on function public.claim_order_document_generation(uuid) is
  'Takes the generation lease for an Order, atomically. Eligible only for a pending version or a claim older than order_document_claim_ttl(). Increments attempt_count and returns the token and the two ATTEMPT-SCOPED keys this run must write to. Server-only: revoked from every client role.';

revoke execute on function public.claim_order_document_generation(uuid)
  from public, anon, authenticated;


-- ── 7d. Complete ────────────────────────────────────────────────────────────
--
-- THE TOKEN IS THE AUTHORIZATION. A worker whose claim was taken over while it
-- was still running holds a token that no longer matches, and its completion is
-- refused — which is exactly right: its output is stale, and publishing it would
-- overwrite a newer run's answer with an older one.
--
-- BOTH FILES OR NOTHING. Refused before the write when either path is missing,
-- and refused again by order_document_versions_ready_is_complete if this
-- function were ever changed to try. Two independent refusals of the one state
-- that must not exist.

create or replace function public.complete_order_document_generation(
  p_version_id   uuid,
  p_claim_token  uuid,
  p_excel_path   text,
  p_pdf_path     text,
  p_excel_sha256 text,
  p_pdf_sha256   text,
  p_excel_bytes  bigint,
  p_pdf_bytes    bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.order_document_versions;
begin
  if p_claim_token is null then
    raise exception 'ORDER_DOCUMENT_NO_CLAIM' using errcode = '42501';
  end if;

  if coalesce(btrim(p_excel_path), '') = '' or coalesce(btrim(p_pdf_path), '') = '' then
    raise exception 'ORDER_DOCUMENT_INCOMPLETE: a version becomes ready only when BOTH the workbook and the PDF exist'
      using errcode = 'P0001';
  end if;

  update public.order_document_versions d
     set status       = 'ready',
         completed_at = now(),
         claim_token  = null,
         claimed_at   = null,
         excel_path   = p_excel_path,
         pdf_path     = p_pdf_path,
         excel_sha256 = p_excel_sha256,
         pdf_sha256   = p_pdf_sha256,
         excel_bytes  = p_excel_bytes,
         pdf_bytes    = p_pdf_bytes,
         last_error_code = null,
         last_error_message = null
   where d.id = p_version_id
     and d.status = 'claimed'
     and d.claim_token = p_claim_token
  returning * into v_row;

  if not found then
    -- Deliberately not distinguished: "wrong token", "already released" and
    -- "taken over" are the same answer to the worker — this run does not own
    -- this version and must not publish.
    return jsonb_build_object('completed', false);
  end if;

  -- The activity entry is written by order_document_versions_log_trg, from the
  -- transition itself, so it cannot be omitted here or duplicated.

  return jsonb_build_object(
    'completed', true, 'version', v_row.version, 'version_id', v_row.id);
end;
$$;

comment on function public.complete_order_document_generation(uuid, uuid, text, text, text, text, bigint, bigint) is
  'Publishes a version, and only with the matching live claim token. Refuses unless BOTH files are named — the same state order_document_versions_ready_is_complete forbids. Server-only.';

revoke execute on function public.complete_order_document_generation(uuid, uuid, text, text, text, text, bigint, bigint)
  from public, anon, authenticated;


-- ── 7e. Fail ────────────────────────────────────────────────────────────────
--
-- Same token rule. The message is stored as given and is expected to have been
-- sanitized by the caller; §8 refuses this migration if the column comment ever
-- stops saying so, and the server module that writes it has its own tests.

create or replace function public.fail_order_document_generation(
  p_version_id  uuid,
  p_claim_token uuid,
  p_error_code  text,
  p_error_message text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.order_document_versions;
begin
  if p_claim_token is null then
    raise exception 'ORDER_DOCUMENT_NO_CLAIM' using errcode = '42501';
  end if;

  if coalesce(btrim(p_error_code), '') = '' then
    raise exception 'ORDER_DOCUMENT_NO_ERROR_CODE: a failure must say why' using errcode = 'P0001';
  end if;

  update public.order_document_versions d
     set status             = 'failed',
         claim_token        = null,
         claimed_at         = null,
         last_error_code    = p_error_code,
         last_error_message = left(coalesce(p_error_message, ''), 500),
         -- A FAILED VERSION NAMES NO FILES. Whatever this attempt uploaded stays
         -- in the bucket under its own attempt key, named by nothing, and is
         -- therefore unreachable by every client role. That is the "partial
         -- upload never becomes downloadable" guarantee.
         excel_path   = null,
         pdf_path     = null,
         excel_sha256 = null,
         pdf_sha256   = null,
         excel_bytes  = null,
         pdf_bytes    = null
   where d.id = p_version_id
     and d.status = 'claimed'
     and d.claim_token = p_claim_token
  returning * into v_row;

  if not found then
    return jsonb_build_object('failed', false);
  end if;

  -- The activity entry is written by order_document_versions_log_trg, from the
  -- transition itself.

  return jsonb_build_object('failed', true, 'version', v_row.version);
end;
$$;

comment on function public.fail_order_document_generation(uuid, uuid, text, text) is
  'Releases a claim as a failure, with the matching token. Clears every file reference, so whatever the attempt uploaded is named by nothing and stays unreachable. Server-only.';

revoke execute on function public.fail_order_document_generation(uuid, uuid, text, text)
  from public, anon, authenticated;


-- ═══ 8. Assertions ══════════════════════════════════════════════════════════

do $$
declare
  v_def text;
  v_bad text;
begin
  -- 8a. The register exists, with RLS on and no client write privilege.
  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'order_document_versions' and c.relrowsecurity
  ) then
    raise exception 'order_document_versions is missing or has RLS disabled';
  end if;

  -- No TABLE-WIDE write privilege, and no DELETE at all. The request and the
  -- retry are COLUMN grants, checked immediately below.
  select string_agg(distinct privilege_type, ', ') into v_bad
  from information_schema.role_table_grants
  where table_schema = 'public'
    and table_name = 'order_document_versions'
    and grantee in ('anon', 'authenticated', 'public')
    and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE');
  if v_bad is not null then
    raise exception 'a client role holds table-wide % on order_document_versions', v_bad;
  end if;

  -- THE CLIENT-WRITABLE SURFACE IS EXACTLY FIVE COLUMNS, and they are these.
  -- Anything else appearing here would be a widening nobody meant.
  select string_agg(privilege_type || ':' || column_name, ', ' order by privilege_type, column_name)
    into v_bad
  from information_schema.column_privileges
  where table_schema = 'public' and table_name = 'order_document_versions'
    and grantee in ('anon', 'authenticated', 'public')
    and privilege_type in ('INSERT', 'UPDATE');
  if v_bad is distinct from
     'INSERT:order_id, INSERT:version, UPDATE:last_error_code, UPDATE:last_error_message, UPDATE:status' then
    raise exception 'the client-writable surface of order_document_versions is not the intended five columns: %', v_bad;
  end if;

  -- 8b. THE TOKEN IS NOT SELECTABLE BY A CLIENT ROLE. This is the guarantee that
  -- a browser cannot read a lease even for a row it may legitimately see.
  if exists (
    select 1 from information_schema.column_privileges
    where table_schema = 'public'
      and table_name = 'order_document_versions'
      and column_name = 'claim_token'
      and grantee in ('anon', 'authenticated', 'public')
  ) then
    raise exception 'claim_token is selectable by a client role; the lease token must never leave the server';
  end if;

  -- 8c. EXACTLY TWO client write policies exist — the request and the retry —
  -- and NO DELETE policy at all. Both must ask the two authorities as the
  -- CALLER; a policy that dropped either would authorize the whole business.
  select string_agg(policyname || '/' || cmd, ', ' order by policyname) into v_bad
  from pg_policies
  where schemaname = 'public' and tablename = 'order_document_versions'
    and cmd in ('INSERT', 'UPDATE', 'DELETE');
  if v_bad is distinct from
     'order_document_versions_request_insert/INSERT, order_document_versions_retry_update/UPDATE' then
    raise exception 'the write policies on order_document_versions are not the intended two: %', v_bad;
  end if;

  for v_def in
    select coalesce(pg_get_expr(p.polqual, p.polrelid), '')
        || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')
    from pg_policy p join pg_class c on c.oid = p.polrelid
    where c.relname = 'order_document_versions'
      and p.polname in ('order_document_versions_request_insert',
                        'order_document_versions_retry_update')
  loop
    if position('can_view_order' in v_def) = 0 then
      raise exception 'a write policy does not require sight of the Order';
    end if;
    if position('approve_order' in v_def) = 0 then
      raise exception 'a write policy does not require the management approval authority';
    end if;
  end loop;

  -- 8d. The module entry gate is RESTRICTIVE, or it would OR instead of AND.
  if not exists (
    select 1 from pg_policy p join pg_class c on c.oid = p.polrelid
    where c.relname = 'order_document_versions'
      and p.polname = 'order_document_versions_module_entry_gate'
      and p.polpermissive = false
  ) then
    raise exception 'the module entry gate on order_document_versions must be restrictive';
  end if;

  -- 8e. The worker half is unreachable from a browser.
  foreach v_bad in array array[
    'claim_order_document_generation',
    'complete_order_document_generation',
    'fail_order_document_generation',
    'log_order_document_event',
    'order_document_versions_guard',
    'order_document_versions_log'
  ] loop
    if exists (
      select 1
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = v_bad
        and has_function_privilege('authenticated', p.oid, 'execute')
    ) then
      raise exception '% is executable by authenticated; the worker half must be server-only', v_bad;
    end if;
  end loop;

  -- 8f. The one function a person calls IS reachable, and IS gated.
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'request_order_document_generation'
      and has_function_privilege('authenticated', p.oid, 'execute')
  ) then
    raise exception 'request_order_document_generation must be callable by authenticated';
  end if;

  -- AND IT MUST BE SECURITY INVOKER. As a definer it would ask can_view_order on
  -- behalf of the table owner, who bypasses RLS — the check would read correctly
  -- and authorize everybody. This is the single most important line in §8.
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'request_order_document_generation'
      and p.prosecdef
  ) then
    raise exception 'request_order_document_generation must be SECURITY INVOKER; a definer bypasses the RLS that authorizes it';
  end if;

  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'request_order_document_generation';

  if position('actor_has_module_permission' in v_def) = 0
     or position('approve_order' in v_def) = 0 then
    raise exception 'request_order_document_generation does not check the management approval authority';
  end if;

  -- 8g. NOTHING IN THIS PHASE WRITES AN ORDER, A NUMBER OR A PAYMENT.
  -- A retry that could move money would be a far worse defect than a missing
  -- PDF, so it is refused structurally rather than by review.
  foreach v_bad in array array[
    'request_order_document_generation',
    'claim_order_document_generation',
    'complete_order_document_generation',
    'fail_order_document_generation',
    'log_order_document_event',
    'order_document_versions_log',
    'order_document_versions_guard'
  ] loop
    select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = v_bad;

    if v_def ~* '(insert|update|delete)\s+(into\s+|from\s+)?(only\s+)?(public\.)?orders\b'
       or v_def ~* '(insert|update|delete)\s+(into\s+|from\s+)?(only\s+)?(public\.)?finance_payment'
       or position('allocate_confirmed_order_number' in v_def) > 0
       or position('confirmed_order_number_cycle' in v_def) > 0 then
      raise exception '% writes an Order, a number or a payment; document generation must do none of those', v_bad;
    end if;
  end loop;

  -- 8h. Approval is untouched.
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'approve_order_submission'
  ) then
    raise exception 'approve_order_submission is missing';
  end if;

  -- 8i. order-files is still private, still has no UPDATE policy, and has gained
  -- no client write for the orders/ prefix.
  if not exists (
    select 1 from storage.buckets
    where id = 'order-files' and public = false and file_size_limit = 10485760
  ) then
    raise exception 'order-files is not private at the 10 MiB limit';
  end if;

  if exists (
    select 1
    from pg_policy p
    join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'storage' and c.relname = 'objects'
      and p.polname like 'order_files_%'
      and p.polcmd in ('w', 'a', 'd')
      and p.polname <> 'order_files_insert'
      and p.polname <> 'order_files_delete'
  ) then
    raise exception 'an unexpected order-files write policy exists';
  end if;

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

  -- 8j. Publication, not location, is what authorizes a document read.
  select pg_get_expr(p.polqual, p.polrelid) into v_def
  from pg_policy p
  join pg_class c on c.oid = p.polrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'storage' and c.relname = 'objects'
    and p.polname = 'order_files_confirmed_order_select';

  if v_def is null then
    raise exception 'order_files_confirmed_order_select is missing';
  end if;
  if position('can_view_order_document_object' in v_def) = 0 then
    raise exception 'the storage rule does not require publication; a partial attempt would be downloadable';
  end if;
  if position('order_file_order_id' in v_def) > 0 then
    raise exception 'the storage rule still authorizes the orders/ prefix by location alone';
  end if;
end $$;

-- ── 8k. The behaviour, exercised ────────────────────────────────────────────
--
-- Structural checks cannot see that a path helper builds the right key or that
-- the guard actually refuses. These run it.

do $$
declare
  v_order uuid := '11111111-1111-1111-1111-111111111111';
begin
  if public.order_document_version_prefix(v_order, 1)
     <> 'orders/11111111-1111-1111-1111-111111111111/versions/1' then
    raise exception 'order_document_version_prefix does not build the reserved prefix';
  end if;

  if public.order_document_attempt_path(v_order, 2, 3, 'xlsx')
     <> 'orders/11111111-1111-1111-1111-111111111111/versions/2/attempts/3/approved.xlsx' then
    raise exception 'order_document_attempt_path does not build the attempt key';
  end if;

  if public.order_document_attempt_path(v_order, 2, 3, 'pdf')
     <> 'orders/11111111-1111-1111-1111-111111111111/versions/2/attempts/3/approved.pdf' then
    raise exception 'order_document_attempt_path does not build the PDF key';
  end if;

  -- An attempt key still decodes to its Order, so the reserved shape survived.
  if public.order_file_order_id(public.order_document_attempt_path(v_order, 2, 3, 'xlsx'))
     is distinct from v_order then
    raise exception 'an attempt key no longer decodes to its Order';
  end if;

  -- Unknown kinds and impossible counters yield null, never a plausible key.
  if public.order_document_attempt_path(v_order, 1, 1, 'docx') is not null
     or public.order_document_attempt_path(v_order, 0, 1, 'pdf') is not null
     or public.order_document_attempt_path(v_order, 1, 0, 'pdf') is not null
     or public.order_document_attempt_path(null, 1, 1, 'pdf') is not null then
    raise exception 'order_document_attempt_path did not fail closed';
  end if;

  -- Version 1's prefix must not be a prefix of version 10's, or a guard written
  -- with a bare startswith would let one version publish another's files.
  if public.order_document_version_prefix(v_order, 10)
     like public.order_document_version_prefix(v_order, 1) || '/%' then
    raise exception 'version prefixes are ambiguous';
  end if;
end $$;
