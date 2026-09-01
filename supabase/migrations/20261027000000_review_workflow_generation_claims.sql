-- ═════════════════════════════════════════════════════════════════════════════
-- Review Workflow — one provider call per request, across server instances
-- ═════════════════════════════════════════════════════════════════════════════
--
-- THE DEFECT THIS CLOSES. 20261026000000 made a repeated request idempotent at
-- the WRITE: `request_key` is unique on customer_review_draft_batches, so two
-- taps of one button create one batch. The route also looked the key up before
-- calling the provider, which stops the ordinary repeat — a second tap a moment
-- later, a refreshed tab.
--
-- It does not stop the SIMULTANEOUS one, and the gap costs real money:
--
--     request A  reads the key   → nothing
--     request B  reads the key   → nothing
--     request A  calls Anthropic ─┐
--     request B  calls Anthropic ─┴─ BOE is billed twice
--     request A  inserts a batch
--     request B  is refused by the unique index
--
-- One batch is created and two calls are paid for. The database was never the
-- problem; the unguarded window is the network call, which happens OUTSIDE any
-- transaction and may happen on a different Vercel instance from its twin. An
-- in-memory map cannot see across instances, and a lock or an open transaction
-- must not be held across a network call that can take a minute.
--
-- WHAT REPLACES IT: A DURABLE CLAIM, TAKEN BEFORE THE CALL AND COMMITTED.
--
--     claim(key)  ──▶ 'claimed'      you, and only you, may call the provider
--                 ──▶ 'in_progress'  somebody else holds it and has not finished
--                 ──▶ 'completed'    it is already done; here is the result
--
-- The claim is one short transaction that commits immediately. The provider
-- call happens with nothing held. finish(key, …) then records the outcome.
--
-- WHY A SEPARATE TABLE RATHER THAN A COLUMN ON THE BATCH.
-- A batch row means eight cards exist: card_count = 8 is a CHECK, and the
-- module's stated property is that a failed generation writes NO batch row. A
-- 'pending' batch row would break both, and would make "did this batch
-- succeed?" a question a reader has to ask a status column instead of reading
-- off the row's existence. The claim is a different fact with a different
-- lifetime, so it is a different table.

create table if not exists public.customer_review_generation_claims (
  -- The key the BROWSER minted when the verifier pressed the confirmation.
  -- Every retry of THAT submission carries it; two deliberate submissions carry
  -- two different ones. It is the primary key because it is the identity of the
  -- request, not an attribute of it.
  request_key   uuid primary key,

  -- Which provider-backed operation this is. Generation and revision share the
  -- claim mechanism because they share the hazard; they are told apart here so
  -- a claim can never be answered with the other one's result.
  kind          text not null check (kind in ('generate', 'revise')),

  -- The batch a revision is revising. Null for a generation, which has no batch
  -- until it succeeds.
  batch_id      uuid references public.customer_review_draft_batches(id) on delete cascade,

  claimed_by    uuid not null references public.users(id),
  claimed_at    timestamptz not null default now(),

  -- WHEN AN ABANDONED CLAIM STOPS BLOCKING. A server that crashes between the
  -- claim and the finish leaves a 'running' row nobody will ever complete;
  -- without an expiry that key is dead forever. After this moment a new caller
  -- may take the claim over.
  --
  -- IT IS DELIBERATELY LONGER THAN THE PROVIDER CALL CAN TAKE. Expiring while a
  -- healthy call is still in flight would let a second caller in and reintroduce
  -- the double charge this table exists to prevent, which is the worse failure:
  -- an over-long expiry costs a verifier a wait, an over-short one costs money.
  expires_at    timestamptz not null,

  state         text not null default 'running' check (state in ('running', 'completed')),

  -- How many times THIS ROW has been claimed, which is not the same as how many
  -- times the key has been used — and the difference is worth stating, because
  -- it is easy to read this column as an attempt history and it is not one.
  --
  -- IT COUNTS TAKEOVERS OF AN ABANDONED CLAIM, and nothing else: the upsert
  -- below increments it when a caller takes over a claim whose expiry has
  -- passed, so `attempts = 2` says "somebody's server went away mid-run and a
  -- second caller picked this up".
  --
  -- IT RESETS AFTER A FAILURE, deliberately. A failed run DELETES its row (see
  -- finish_customer_review_generation), so the retry inserts a fresh row at 1.
  -- Nothing depends on the older count: what this table has to guarantee is
  -- that one key never produces two provider calls, and that a failure never
  -- blocks a legitimate retry. Neither needs history, and keeping it would mean
  -- keeping a tombstone the retry then has to reason about — a second rule to
  -- get wrong for no benefit.
  attempts      integer not null default 1 check (attempts >= 1),

  -- What the completed run produced, so a repeat is answered rather than re-run.
  result_batch_id     uuid references public.customer_review_draft_batches(id) on delete cascade,
  result_count        integer check (result_count is null or result_count between 1 and 8),
  completed_at        timestamptz,

  constraint customer_review_generation_claims_completed_shape check (
    (state = 'running'   and completed_at is null and result_batch_id is null and result_count is null)
    or (state = 'completed' and completed_at is not null and result_batch_id is not null)
  ),
  -- A revision names the batch it revised; a generation discovers one.
  constraint customer_review_generation_claims_revise_has_batch check (
    kind <> 'revise' or batch_id is not null
  )
);

create index if not exists customer_review_generation_claims_sweep
  on public.customer_review_generation_claims (state, expires_at);

comment on table public.customer_review_generation_claims is
  'One row per provider-backed request key. Claimed atomically BEFORE the model is called and committed immediately, so two simultaneous requests carrying one key produce exactly one provider call — including on two different server instances. Holds no credential, no prompt and no model output.';

alter table public.customer_review_generation_claims enable row level security;

-- NOT READABLE BY ANY CLIENT ROLE, and there is no policy at all.
--
-- Every other table in this module has a SELECT policy because a screen reads
-- it. Nothing reads this one: it is server bookkeeping between a route and its
-- own retry, and a browser that could enumerate in-flight claims would learn
-- who is generating what and when, which is not information any screen offers.
-- RLS is enabled with no policy, which denies everything, and the privileges
-- are revoked as well so a policy added by mistake later still cannot read.
revoke select, insert, update, delete, truncate, references, trigger
  on public.customer_review_generation_claims from authenticated, anon;

-- ── THE CLAIM ───────────────────────────────────────────────────────────────
--
-- One statement decides it. `insert … on conflict (request_key) do update …
-- where` is atomic against every other session: the loser of a race blocks on
-- the unique index, then re-evaluates its DO UPDATE against the winner's
-- committed row. There is no read-then-write window for two callers to fall
-- through, which is exactly what the route's old pre-check had.
--
-- THE TRANSACTION IS THE FUNCTION. It commits when the function returns, before
-- the caller goes near the network — nothing is held across the provider call.
create or replace function public.claim_customer_review_generation(
  p_request_key uuid,
  p_kind        text,
  p_batch_id    uuid,
  p_actor_id    uuid,
  p_ttl_seconds integer default 300
)
returns table (
  outcome      text,
  batch_id     uuid,
  result_count integer,
  attempts     integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_claimed record;
  v_existing record;
begin
  if p_request_key is null then
    raise exception 'CUSTOMER_REVIEW_TEST_BAD_BATCH: a request needs a request key'
      using errcode = '23514';
  end if;
  if p_kind not in ('generate', 'revise') then
    raise exception 'CUSTOMER_REVIEW_TEST_BAD_BATCH: unknown request kind %', p_kind
      using errcode = '23514';
  end if;
  if p_ttl_seconds is null or p_ttl_seconds < 30 or p_ttl_seconds > 3600 then
    raise exception 'CUSTOMER_REVIEW_TEST_BAD_BATCH: the claim lifetime must be between 30 and 3600 seconds'
      using errcode = '23514';
  end if;

  -- ── THE SAME PERMISSION AS THE WRITE ─────────────────────────────────────
  --
  -- Asked HERE as well as in create_/revise_, because this is what authorises
  -- spending a credential and the write happens a minute later. A caller whose
  -- `verify` is revoked must not be able to make BOE pay for a model call and
  -- only be refused afterwards.
  if not exists (select 1 from public.users u where u.id = p_actor_id and u.is_active) then
    raise exception 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED: Your account is not active'
      using errcode = '42501';
  end if;
  if not public.resolve_permission(p_actor_id, 'customer_review_requests', 'verify') then
    raise exception 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED: This needs the Verify permission'
      using errcode = '42501';
  end if;

  -- Opportunistic housekeeping, bounded and cheap: a completed claim older than
  -- a day has already answered every repeat anybody will make of it, and the
  -- batch and revision tables keep their own `request_key` unique index as the
  -- long-term answer. Nothing depends on this running.
  delete from public.customer_review_generation_claims
   where state = 'completed' and completed_at < now() - interval '1 day';

  -- ── THE ONE STATEMENT ────────────────────────────────────────────────────
  --
  -- Insert if the key is new. If it is not, TAKE IT OVER only when the previous
  -- holder's claim has expired — which is the crashed-server case and nothing
  -- else. A live claim matches no branch, the statement writes nothing, and the
  -- caller falls through to the read below.
  insert into public.customer_review_generation_claims
    (request_key, kind, batch_id, claimed_by, expires_at)
  values
    (p_request_key, p_kind, p_batch_id, p_actor_id,
     now() + make_interval(secs => p_ttl_seconds))
  on conflict (request_key) do update
     set claimed_by = excluded.claimed_by,
         claimed_at = now(),
         expires_at = excluded.expires_at,
         attempts   = public.customer_review_generation_claims.attempts + 1
   where public.customer_review_generation_claims.state = 'running'
     and public.customer_review_generation_claims.expires_at < now()
  returning * into v_claimed;

  if v_claimed.request_key is not null then
    outcome      := 'claimed';
    batch_id     := v_claimed.batch_id;
    result_count := null;
    attempts     := v_claimed.attempts;
    return next;
    return;
  end if;

  -- ── SOMEBODY ELSE HAS IT ─────────────────────────────────────────────────
  --
  -- Read AFTER the statement above, which took a row lock on the conflicting
  -- row before deciding not to update it — so by the time this runs, a
  -- concurrent claimant has committed and this sees its committed state rather
  -- than a stale snapshot.
  select * into v_existing
    from public.customer_review_generation_claims
   where request_key = p_request_key;

  if v_existing.request_key is null then
    -- Vanishingly unlikely: the row was deleted between the conflict and this
    -- read. Answering "in progress" is the safe direction — it never starts a
    -- second provider call, and the caller may retry.
    outcome := 'in_progress'; batch_id := null; result_count := null; attempts := null;
    return next; return;
  end if;

  if v_existing.kind <> p_kind then
    raise exception 'CUSTOMER_REVIEW_TEST_BAD_BATCH: that request key was used for a % request', v_existing.kind
      using errcode = '23514';
  end if;

  if v_existing.state = 'completed' then
    outcome      := 'completed';
    batch_id     := v_existing.result_batch_id;
    result_count := v_existing.result_count;
    attempts     := v_existing.attempts;
  else
    outcome      := 'in_progress';
    batch_id     := v_existing.batch_id;
    result_count := null;
    attempts     := v_existing.attempts;
  end if;
  return next;
end;
$$;

comment on function public.claim_customer_review_generation(uuid, text, uuid, uuid, integer) is
  'Atomically claims a request key before a provider call. Returns claimed (you may call the model), in_progress (somebody else holds it) or completed (here is the result). Commits immediately so nothing is held across the network call. Requires the resolved verify permission, because this is what authorises spending a credential.';

revoke execute on function public.claim_customer_review_generation(uuid, text, uuid, uuid, integer)
  from public, anon, authenticated;
grant  execute on function public.claim_customer_review_generation(uuid, text, uuid, uuid, integer)
  to service_role;

-- ── FINISHING, EITHER WAY ───────────────────────────────────────────────────
--
-- TWO OUTCOMES AND THEY ARE NOT SYMMETRICAL.
--
--   completed  the claim is KEPT, carrying the result, so a repeat of the same
--              key is answered instead of re-run.
--
--   failed     the claim is DELETED. This is the deliberate retry semantics:
--              a failed attempt produced NO output, so there is nothing to
--              reuse and nothing stale to hand back — and releasing the key
--              means the verifier's next press is a fresh attempt rather than
--              a permanent refusal. THE ATTEMPT COUNT RESETS with it — the row
--              is gone, so the retry inserts a fresh one at 1. That is not a
--              loss: nothing about duplicate-charge protection or retry depends
--              on knowing how many times a key failed, and `attempts` only ever
--              meant "how many times this row was taken over after expiring".
--
-- The alternative — keeping a 'failed' row — was rejected: it would make a
-- legitimate retry either impossible or dependent on a second expiry rule,
-- which is a second thing to get wrong for no benefit.
create or replace function public.finish_customer_review_generation(
  p_request_key uuid,
  p_state       text,
  p_batch_id    uuid,
  p_count       integer default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_state not in ('completed', 'failed') then
    raise exception 'CUSTOMER_REVIEW_TEST_BAD_BATCH: unknown finish state %', p_state
      using errcode = '23514';
  end if;

  if p_state = 'failed' then
    delete from public.customer_review_generation_claims
     where request_key = p_request_key and state = 'running';
    return;
  end if;

  if p_batch_id is null then
    raise exception 'CUSTOMER_REVIEW_TEST_BAD_BATCH: a completed run must name its batch'
      using errcode = '23514';
  end if;

  update public.customer_review_generation_claims
     set state           = 'completed',
         completed_at    = now(),
         result_batch_id = p_batch_id,
         result_count    = p_count
   where request_key = p_request_key
     and state = 'running';
end;
$$;

comment on function public.finish_customer_review_generation(uuid, text, uuid, integer) is
  'Records the outcome of a claimed provider run. A completed run KEEPS its claim so a repeat is answered from it; a failed run DELETES the claim, because a failure produced nothing to reuse and a legitimate retry must not be blocked.';

revoke execute on function public.finish_customer_review_generation(uuid, text, uuid, integer)
  from public, anon, authenticated;
grant  execute on function public.finish_customer_review_generation(uuid, text, uuid, integer)
  to service_role;

-- ── WHAT THIS FILE PROMISED, ASSERTED ───────────────────────────────────────
do $$
begin
  -- No client role reads or writes the claim table, and no policy admits one.
  if has_table_privilege('authenticated', 'public.customer_review_generation_claims', 'SELECT')
  or has_table_privilege('authenticated', 'public.customer_review_generation_claims', 'INSERT')
  or has_table_privilege('authenticated', 'public.customer_review_generation_claims', 'UPDATE')
  or has_table_privilege('authenticated', 'public.customer_review_generation_claims', 'DELETE') then
    raise exception 'a browser role can reach the claim table';
  end if;
  if exists (select 1 from pg_policies
              where schemaname = 'public'
                and tablename = 'customer_review_generation_claims') then
    raise exception 'the claim table has a policy; it is meant to be unreadable to clients';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.customer_review_generation_claims'::regclass) then
    raise exception 'row level security is off on the claim table';
  end if;

  -- Both functions take an actor id, so neither may be browser-callable.
  if has_function_privilege('authenticated',
       'public.claim_customer_review_generation(uuid, text, uuid, uuid, integer)', 'EXECUTE')
  or has_function_privilege('authenticated',
       'public.finish_customer_review_generation(uuid, text, uuid, integer)', 'EXECUTE') then
    raise exception 'a browser role can call a claim function';
  end if;

  -- The claim is decided by ONE statement. A separate read-then-write would
  -- reintroduce the window this whole file exists to close.
  if (select count(*) from regexp_matches(
        pg_get_functiondef('public.claim_customer_review_generation(uuid, text, uuid, uuid, integer)'::regprocedure),
        'on conflict \(request_key\) do update', 'g')) <> 1 then
    raise exception 'the claim is not a single upsert';
  end if;

  -- And no role is consulted, like everything else in this module.
  if regexp_replace(
       pg_get_functiondef('public.claim_customer_review_generation(uuid, text, uuid, uuid, integer)'::regprocedure),
       '--[^' || chr(10) || ']*', '', 'g') ~* '(u\.role|users\.role|''admin'')' then
    raise exception 'the claim function consults a role';
  end if;

  raise notice 'PASS  review-workflow generation claims: one provider call per request key, claim locked down';
end $$;
