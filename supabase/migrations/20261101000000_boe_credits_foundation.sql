-- ═══════════════════════════════════════════════════════════════════════════
-- BOE Credits — Phase 1A: the credit foundation.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT THIS ADDS
-- --------------
--   public.boe_credit_transactions   the append-only credit ledger — the source of truth
--   public.boe_credit_balances       a view: available credits per employee, derived
--   public.boe_credit_settings       append-only settings; the newest row is active
--   public.can_manage_boe_credits()  the management predicate (an active admin)
--   public.boe_credit_balance(uuid)  one employee's available credits, as SQL
--   public.post_boe_credit_transaction(...)     the ONLY write path — service role only
--   public.reverse_boe_credit_transaction(...)  a compensating entry — service role only
--
-- WHAT IT DOES NOT DO, ON PURPOSE
-- -------------------------------
-- Nothing here awards a credit for a verified review (Phase 1B), spends one
-- against an attendance deduction (Phase 1C) or changes a payroll figure
-- (Phase 1D). No Attendance, Payroll or Review Workflow table is altered. The
-- ledger references payroll_periods only through a NULLABLE foreign key, so a
-- later redemption can say which month it belonged to without a new column.
--
-- THE BALANCE IS DERIVED, NEVER STORED
-- ------------------------------------
--   available credits = SUM(credits) over the employee's ledger rows
--
-- There is no credit_balance column anywhere. The view and boe_credit_balance()
-- both compute the sum on read, so the ledger cannot disagree with a cached
-- number because there is no cached number. Corrections are new rows that add
-- to the sum: a reversal is the original's amount negated, an admin adjustment
-- is whatever the administrator entered, with the reason they gave.
--
-- SIGNED AMOUNTS, DELIBERATELY. Payroll adjustments store a positive amount and
-- a direction column; this ledger stores the sign in the amount instead,
-- because its one job is to be summed. A reader adds the column and is done —
-- there is no direction to apply first and therefore no direction to apply
-- wrongly. Each type still fixes its own sign (review_reward > 0, redemption
-- < 0) in a CHECK below, so the two conventions cannot be confused on a row.
--
-- THE UNIQUENESS RULE, STATED EXACTLY
-- -----------------------------------
--   UNIQUE (employee_id, transaction_type, source_type, source_id)
--     WHERE source_id IS NOT NULL
--
-- One source event produces at most one row of a given type for a given
-- employee. So a verified review can be rewarded once (review_reward from
-- customer_review X); that reward can be reversed once (reversal from
-- boe_credit_transaction Y); and an administrator can still correct the same
-- employee any number of times, because admin_adjustment rows carry
-- source_type 'manual' and NO source_id, which the partial index never sees.
-- Re-awarding the same review after a reversal is deliberately NOT possible
-- through review_reward — the correction for that case is an admin adjustment,
-- which records why.
--
-- The rule is enforced twice: as a pre-check inside post_boe_credit_transaction()
-- under a per-employee advisory lock, so two concurrent posts for the same
-- employee are serialised and the second sees the first; and by the index
-- itself, which is the guarantee that survives any path the function did not
-- anticipate.
--
-- NEGATIVE BALANCES
-- -----------------
-- A redemption is the only kind that is checked against the balance: an
-- employee cannot spend more than they have, and while the balance is below
-- zero they cannot spend at all. A reversal is NOT checked, deliberately. If a
-- reward is invalidated after its credits were already redeemed, the reversal
-- must still be posted — history is never rewritten to avoid it — and the
-- balance it produces is negative until later credits bring it back up. An
-- admin adjustment is not checked either: it is an administrator's correction,
-- not an employee's spending.
--
-- WHY THE WRITE PATH IS SERVICE ROLE ONLY
-- ---------------------------------------
-- No client role holds INSERT, UPDATE or DELETE on the ledger, and EXECUTE on
-- the two posting functions is revoked from public, anon and authenticated.
-- The application's /api/boe-credits routes authenticate the caller from the
-- bearer token, refuse a non-admin (requireAdmin in
-- src/lib/security/attendancePayrollApiAuth.ts) and only then call these
-- functions with a service-role client, passing the caller's id as the actor —
-- which the function re-verifies rather than trusts. That is the posture every
-- Attendance and Payroll write already has: the route is the boundary, and the
-- database refuses everybody who did not come through it. An employee cannot
-- award themselves a credit from a browser because there is nothing a browser
-- can call that inserts one.
--
-- MANAGEMENT AUTHORITY REUSES THE ADMIN ROLE. Credits are read alongside
-- Attendance and spent inside Payroll, and both of those management surfaces
-- are admin-only by an explicit product decision (SELF_SERVICE_MODULE_KEYS in
-- src/lib/moduleAccess.ts). No new permission key is registered. If a named
-- non-admin ever needs to see or adjust credits, can_manage_boe_credits() is
-- the one place to widen: every policy and function here reads it.
--
-- IMMUTABILITY
-- ------------
-- A BEFORE UPDATE OR DELETE trigger refuses both, for every role including the
-- service role — the same shape as payroll_settings (20260828000000). The
-- absent policies and revoked privileges refuse them one layer earlier for
-- everybody else. History is corrected by counter-entry only.
--
-- ASSUMPTIONS TO CHECK BEFORE THIS IS APPLIED
--   1. public.users(id, role, is_active, is_deleted) exists; users.id IS auth.uid().
--   2. public.payroll_periods(id uuid) exists (20260611).
--   3. auth.uid() exists.
--
-- PRODUCTION SAFETY
-- -----------------
-- Purely additive: two new tables, one view, five functions, one seed row. No
-- existing row, column, policy or function is touched. Every statement is
-- guarded, so re-running is safe.
--
-- DEPLOYMENT ORDER
-- ----------------
-- Apply before the application code that reads these objects. PostgREST
-- answers an unknown table with 42P01 rather than an empty result, so the
-- credits line on /my-payroll and the /payroll/credits page would both fail
-- until this lands.
--
-- ROLLBACK
-- --------
--   drop function if exists public.reverse_boe_credit_transaction(uuid, uuid, text);
--   drop function if exists public.post_boe_credit_transaction(uuid, text, integer, text, uuid, text, uuid, uuid);
--   drop function if exists public.boe_credit_balance(uuid);
--   drop view     if exists public.boe_credit_balances;
--   drop table    if exists public.boe_credit_transactions;
--   drop table    if exists public.boe_credit_settings;
--   drop function if exists public.can_manage_boe_credits();
--   drop function if exists public.boe_credits_append_only();
-- Lossless for every other module: nothing else reads these objects yet.

-- ═══ 1. The management predicate ═══════════════════════════════════════════
--
-- An active, non-deleted admin — not merely role = 'admin'. Deactivating an
-- account does not end its Supabase session, and a soft-deleted admin must not
-- keep reading the ledger through a token that outlived them.

create or replace function public.can_manage_boe_credits()
returns boolean
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select exists (
    select 1
      from public.users
     where id = auth.uid()
       and role = 'admin'
       and is_active = true
       and coalesce(is_deleted, false) = false
  );
$$;

revoke execute on function public.can_manage_boe_credits() from public, anon;
grant  execute on function public.can_manage_boe_credits() to authenticated;

comment on function public.can_manage_boe_credits() is
  'BOE Credits management authority: an active, non-deleted admin. The one place to widen if credits are ever delegated to a named non-admin.';

-- ═══ 2. The append-only guard, shared by both tables ═══════════════════════

create or replace function public.boe_credits_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception
    'BOE_CREDITS_APPEND_ONLY: % is append-only — post a compensating row instead of a %',
    tg_table_name, tg_op
    using errcode = '42501';
end;
$$;

revoke execute on function public.boe_credits_append_only() from public, anon, authenticated;

-- ═══ 3. The ledger ═════════════════════════════════════════════════════════

create table if not exists public.boe_credit_transactions (
  id                uuid        primary key default gen_random_uuid(),

  -- The employee whose balance this row moves. users.id IS auth.uid().
  employee_id       uuid        not null references public.users(id),

  -- Four kinds, a CHECK rather than an enum, matching every other module here.
  -- Phase 1A creates admin_adjustment and reversal rows; review_reward (1B)
  -- and redemption (1C) are supported by the shape now so those phases add no
  -- column.
  transaction_type  text        not null check (transaction_type in (
    'review_reward',
    'redemption',
    'reversal',
    'admin_adjustment'
  )),

  -- SIGNED whole credits. Positive earns, negative spends. Never zero: a row
  -- that moves nothing is not a transaction, it is noise in an audit trail.
  credits           integer     not null check (credits <> 0),

  -- WHERE THIS CAME FROM. A type/id pair rather than a foreign key, so the
  -- ledger is not coupled to the Review Workflow's tables — the same pattern
  -- notifications use for entity_type/entity_id. Known values:
  --   customer_review          a verified review (Phase 1B)
  --   payroll_period           a payroll-time redemption (Phase 1C/1D)
  --   boe_credit_transaction   the row a reversal compensates
  --   manual                   an admin adjustment; carries no source_id
  -- The pattern check keeps a typo from quietly becoming a fifth source.
  source_type       text        not null check (source_type ~ '^[a-z][a-z0-9_]{0,63}$'),
  source_id         uuid,

  -- For a future redemption: which payroll month it belonged to. Nullable and
  -- unused by Phase 1A; here so Phase 1C/1D add no column.
  payroll_period_id uuid        references public.payroll_periods(id),

  -- Context a person can read. MANDATORY for an admin adjustment — the reason
  -- is the audit record — optional elsewhere.
  description       text        check (description is null or (btrim(description) <> '' and length(description) <= 500)),

  -- Who posted it. NULL means the system did (a future automatic reward); a
  -- non-null value is the administrator whose request the route authenticated.
  created_by        uuid        references public.users(id),
  created_at        timestamptz not null default now(),

  -- Each kind has one shape and the database holds it to that shape, so a row
  -- written by any path — this migration's functions, a later one, a manual
  -- fix — reads the same way.
  constraint boe_credit_transactions_shape_check check (
    case transaction_type
      when 'review_reward'    then credits > 0 and source_type <> 'manual'
      when 'redemption'       then credits < 0 and source_type <> 'manual'
      when 'reversal'         then source_type = 'boe_credit_transaction'
      when 'admin_adjustment' then source_type = 'manual' and description is not null
    end
  ),

  -- 'manual' is exactly the sourceless kind: a manual row has no source_id and
  -- every other kind has one.
  constraint boe_credit_transactions_source_id_check check (
    (source_type = 'manual') = (source_id is null)
  )
);

comment on table public.boe_credit_transactions is
  'BOE Credits ledger. Append-only and the only source of truth: available credits = SUM(credits) per employee. Never UPDATE or DELETE a row — post a reversal or an admin adjustment. Written only by post_boe_credit_transaction() on the service role.';

comment on column public.boe_credit_transactions.credits is
  'Signed whole credits. Positive earns, negative spends. Never zero.';

comment on column public.boe_credit_transactions.source_type is
  'What produced this row: customer_review, payroll_period, boe_credit_transaction (for a reversal) or manual (an admin adjustment, which has no source_id).';

-- THE IDEMPOTENCY RULE. See the header.
create unique index if not exists boe_credit_transactions_one_per_source_idx
  on public.boe_credit_transactions (employee_id, transaction_type, source_type, source_id)
  where source_id is not null;

-- The two reads: one employee's history newest first, and the balance sum.
create index if not exists boe_credit_transactions_employee_created_idx
  on public.boe_credit_transactions (employee_id, created_at desc);

drop trigger if exists boe_credit_transactions_append_only on public.boe_credit_transactions;
create trigger boe_credit_transactions_append_only
  before update or delete on public.boe_credit_transactions
  for each row execute function public.boe_credits_append_only();

-- ─── 3a. Authorization on the ledger ─────────────────────────────────────────
--
-- SELECT: an employee reads their own rows; management reads everyone's.
-- INSERT / UPDATE / DELETE: no policy for any client role, and the privileges
-- are revoked as well, so the answer is 42501 before RLS is even consulted. A
-- new table in `public` arrives with those privileges already granted to
-- authenticated by Supabase's default privileges; taking them away means a
-- policy added back by mistake later still cannot write.

alter table public.boe_credit_transactions enable row level security;

revoke insert, update, delete, truncate, references, trigger
  on public.boe_credit_transactions from authenticated, anon;
revoke select on public.boe_credit_transactions from anon;
grant  select on public.boe_credit_transactions to authenticated;

drop policy if exists "boe_credit_transactions_read_own_or_manage" on public.boe_credit_transactions;
create policy "boe_credit_transactions_read_own_or_manage"
  on public.boe_credit_transactions
  for select
  to authenticated
  using (employee_id = auth.uid() or public.can_manage_boe_credits());

-- ═══ 4. The balance, derived ═══════════════════════════════════════════════
--
-- security_invoker so the view answers under the caller's own RLS: an employee
-- sees one row (theirs), management sees every employee who has a ledger row.
-- An employee with no rows has no row here and therefore zero credits; the
-- application treats absence as 0 rather than seeding empty rows.

drop view if exists public.boe_credit_balances;
create view public.boe_credit_balances
with (security_invoker = true) as
select
  employee_id,
  coalesce(sum(credits), 0)::integer as available_credits,
  count(*)::integer                  as transaction_count,
  max(created_at)                    as last_transaction_at
from public.boe_credit_transactions
group by employee_id;

revoke all on public.boe_credit_balances from anon;
grant  select on public.boe_credit_balances to authenticated;

comment on view public.boe_credit_balances is
  'Available BOE Credits per employee, derived as SUM(credits) from the ledger on every read. Employees with no ledger rows are absent and have zero.';

-- The same sum as a function, for a later RPC that must check a balance inside
-- the transaction that spends it. SECURITY INVOKER, so it too reads under RLS.
create or replace function public.boe_credit_balance(p_employee_id uuid)
returns integer
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(sum(credits), 0)::integer
    from public.boe_credit_transactions
   where employee_id = p_employee_id;
$$;

revoke execute on function public.boe_credit_balance(uuid) from public, anon;
grant  execute on function public.boe_credit_balance(uuid) to authenticated;

comment on function public.boe_credit_balance(uuid) is
  'SUM(credits) for one employee, read under the caller''s own RLS. Zero when there are no rows.';

-- ═══ 5. The one write path ═════════════════════════════════════════════════
--
-- THIS FUNCTION IS NOT CALLABLE FROM A BROWSER, AND MUST NEVER BECOME SO.
-- EXECUTE is revoked from public, anon and authenticated and granted to
-- service_role alone. The server route that calls it has already authenticated
-- the caller and decided they may post; p_actor_id is that caller, re-verified
-- here against public.users rather than trusted.
--
-- Two independent gates, because either one alone is a single point of
-- failure: EXECUTE is revoked, so no browser session reaches this through
-- PostgREST however the request is shaped; and for the two kinds a person
-- posts by hand — admin_adjustment and reversal — the actor is checked against
-- users.role = 'admin' here as well. The actor is a parameter rather than
-- auth.uid() because a service-role call has no auth.uid() to read.
--
-- What it guarantees, in order:
--   1. the employee exists and is not deleted;
--   2. the actor, if given, exists — and for an adjustment or reversal, is an
--      active admin;
--   3. the amount is a non-zero whole number and the type is one of the four;
--   4. the row's shape matches its type (the CHECKs above restate this);
--   5. under a per-employee advisory lock: the source has not already produced
--      this kind of row for this employee, and a redemption never overdraws;
--   6. the row is inserted and its id returned.
--
-- Reversals are posted through reverse_boe_credit_transaction() below, which
-- derives the amount from the original rather than accepting one.

create or replace function public.post_boe_credit_transaction(
  p_employee_id       uuid,
  p_transaction_type  text,
  p_credits           integer,
  p_source_type       text,
  p_source_id         uuid,
  p_description       text,
  p_actor_id          uuid,
  p_payroll_period_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id          uuid;
  v_description text := nullif(btrim(coalesce(p_description, '')), '');
  v_balance     integer;
  v_original    public.boe_credit_transactions%rowtype;
begin
  -- 1. the employee
  if p_employee_id is null or not exists (
    select 1 from public.users
     where id = p_employee_id and coalesce(is_deleted, false) = false
  ) then
    raise exception 'BOE_CREDITS_EMPLOYEE: the employee does not exist or has been deleted'
      using errcode = 'P0002';
  end if;

  -- 2. the actor
  if p_actor_id is not null and not exists (select 1 from public.users where id = p_actor_id) then
    raise exception 'BOE_CREDITS_ACTOR: the acting user does not exist'
      using errcode = 'P0002';
  end if;

  -- 3. type and amount
  if p_transaction_type is null
     or p_transaction_type not in ('review_reward', 'redemption', 'reversal', 'admin_adjustment') then
    raise exception 'BOE_CREDITS_TYPE: unknown transaction type %', coalesce(p_transaction_type, '<null>')
      using errcode = '22023';
  end if;

  if p_credits is null or p_credits = 0 then
    raise exception 'BOE_CREDITS_ZERO: a credit transaction must move at least one credit'
      using errcode = '22023';
  end if;

  -- 2b. the hand-posted kinds need an administrator behind them
  if p_transaction_type in ('admin_adjustment', 'reversal') then
    if p_actor_id is null or not exists (
      select 1 from public.users
       where id = p_actor_id
         and role = 'admin'
         and is_active = true
         and coalesce(is_deleted, false) = false
    ) then
      raise exception 'BOE_CREDITS_DENIED: only an administrator can post a %', p_transaction_type
        using errcode = '42501';
    end if;
  end if;

  -- 4. the shape, said in words the route can show
  if p_transaction_type = 'admin_adjustment' then
    if v_description is null then
      raise exception 'BOE_CREDITS_REASON: an admin adjustment needs a reason'
        using errcode = '22023';
    end if;
    if p_source_type is distinct from 'manual' or p_source_id is not null then
      raise exception 'BOE_CREDITS_SOURCE: an admin adjustment is a manual entry and carries no source id'
        using errcode = '22023';
    end if;
  else
    if p_source_type is null or p_source_type = 'manual' or p_source_id is null then
      raise exception 'BOE_CREDITS_SOURCE: a % must name the source it came from', p_transaction_type
        using errcode = '22023';
    end if;
  end if;

  if p_transaction_type = 'review_reward' and p_credits < 0 then
    raise exception 'BOE_CREDITS_SIGN: a review reward earns credits — the amount must be positive'
      using errcode = '22023';
  end if;

  if p_transaction_type = 'redemption' and p_credits > 0 then
    raise exception 'BOE_CREDITS_SIGN: a redemption spends credits — the amount must be negative'
      using errcode = '22023';
  end if;

  if p_transaction_type = 'reversal' then
    if p_source_type <> 'boe_credit_transaction' then
      raise exception 'BOE_CREDITS_SOURCE: a reversal must name the transaction it reverses'
        using errcode = '22023';
    end if;
    select * into v_original from public.boe_credit_transactions where id = p_source_id;
    if not found then
      raise exception 'BOE_CREDITS_REVERSAL: the transaction to reverse does not exist'
        using errcode = 'P0002';
    end if;
    if v_original.employee_id <> p_employee_id then
      raise exception 'BOE_CREDITS_REVERSAL: the transaction belongs to a different employee'
        using errcode = '22023';
    end if;
    if v_original.transaction_type = 'reversal' then
      raise exception 'BOE_CREDITS_REVERSAL: a reversal cannot itself be reversed — post an admin adjustment'
        using errcode = '55000';
    end if;
    if p_credits <> -v_original.credits then
      raise exception 'BOE_CREDITS_REVERSAL: a reversal must negate the original amount exactly'
        using errcode = '22023';
    end if;
  end if;

  -- 5. serialise per employee. Two posts for the same person now happen one
  --    after the other, so the duplicate check and the balance check below
  --    cannot race each other. The lock is released with the transaction.
  perform pg_advisory_xact_lock(hashtext('boe_credits'), hashtext(p_employee_id::text));

  if p_source_id is not null and exists (
    select 1 from public.boe_credit_transactions
     where employee_id      = p_employee_id
       and transaction_type = p_transaction_type
       and source_type      = p_source_type
       and source_id        = p_source_id
  ) then
    raise exception 'BOE_CREDITS_DUPLICATE_SOURCE: this % has already been recorded for this source', p_transaction_type
      using errcode = '23505';
  end if;

  if p_transaction_type = 'redemption' then
    select coalesce(sum(credits), 0) into v_balance
      from public.boe_credit_transactions where employee_id = p_employee_id;
    if v_balance + p_credits < 0 then
      raise exception 'BOE_CREDITS_INSUFFICIENT: only % credits are available', v_balance
        using errcode = '23514';
    end if;
  end if;

  -- 6. the row
  insert into public.boe_credit_transactions (
    employee_id, transaction_type, credits, source_type, source_id,
    payroll_period_id, description, created_by
  ) values (
    p_employee_id, p_transaction_type, p_credits, p_source_type, p_source_id,
    p_payroll_period_id, v_description, p_actor_id
  )
  returning id into v_id;

  return v_id;
end;
$$;

-- authenticated is revoked ALONGSIDE public and anon — the whole point of this
-- function. service_role is granted explicitly rather than left to Supabase's
-- default privileges, so the intent is stated in the schema and survives any
-- change to those defaults.
revoke execute on function public.post_boe_credit_transaction(uuid, text, integer, text, uuid, text, uuid, uuid)
  from public, anon, authenticated;
grant  execute on function public.post_boe_credit_transaction(uuid, text, integer, text, uuid, text, uuid, uuid)
  to service_role;

comment on function public.post_boe_credit_transaction(uuid, text, integer, text, uuid, text, uuid, uuid) is
  'SERVICE ROLE ONLY. The one way a BOE Credits ledger row is written. Validates employee, actor (an active admin for adjustments and reversals), non-zero amount, type, shape and the one-row-per-source rule under a per-employee lock. Not callable by anon or authenticated.';

-- ─── 5a. A compensating entry ────────────────────────────────────────────────
--
-- The original row stays exactly as it was. This posts a second row of type
-- 'reversal' for the same employee with the amount negated, naming the original
-- as its source — so the uniqueness rule allows exactly one reversal per row.

create or replace function public.reverse_boe_credit_transaction(
  p_transaction_id uuid,
  p_actor_id       uuid,
  p_reason         text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_original public.boe_credit_transactions%rowtype;
begin
  select * into v_original from public.boe_credit_transactions where id = p_transaction_id;
  if not found then
    raise exception 'BOE_CREDITS_REVERSAL: the transaction to reverse does not exist'
      using errcode = 'P0002';
  end if;

  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'BOE_CREDITS_REASON: a reversal needs a reason'
      using errcode = '22023';
  end if;

  return public.post_boe_credit_transaction(
    v_original.employee_id,
    'reversal',
    -v_original.credits,
    'boe_credit_transaction',
    v_original.id,
    p_reason,
    p_actor_id,
    v_original.payroll_period_id
  );
end;
$$;

revoke execute on function public.reverse_boe_credit_transaction(uuid, uuid, text)
  from public, anon, authenticated;
grant  execute on function public.reverse_boe_credit_transaction(uuid, uuid, text)
  to service_role;

comment on function public.reverse_boe_credit_transaction(uuid, uuid, text) is
  'SERVICE ROLE ONLY. Posts the compensating row for one ledger transaction, by an active admin, with a reason. The original is never touched.';

-- ═══ 6. Settings ═══════════════════════════════════════════════════════════
--
-- Two numbers, and they are two different things:
--   review_reward_credits   how many credits a verified review earns (1B)
--   credit_value            the rupee value of one credit, used by Payroll (1D)
--
-- Append-only, newest row active, same shape and reasoning as payroll_settings
-- (20260828000000): every save is its own audit record. No rule engine, no
-- department rules, no effective dates.

create table if not exists public.boe_credit_settings (
  id                    uuid          primary key default gen_random_uuid(),
  review_reward_credits integer       not null check (review_reward_credits > 0 and review_reward_credits <= 100000),
  credit_value          numeric(12,2) not null check (credit_value >= 0),
  note                  text          check (note is null or length(note) <= 500),
  created_by            uuid          references public.users(id) on delete set null,
  created_at            timestamptz   not null default now()
);

comment on table public.boe_credit_settings is
  'BOE Credits settings. Append-only: the newest row is active and every earlier row is the history. review_reward_credits = credits per verified review; credit_value = rupees per credit for Payroll. Never UPDATE or DELETE — save a new row.';

create index if not exists boe_credit_settings_created_at_idx
  on public.boe_credit_settings (created_at desc);

drop trigger if exists boe_credit_settings_append_only on public.boe_credit_settings;
create trigger boe_credit_settings_append_only
  before update or delete on public.boe_credit_settings
  for each row execute function public.boe_credits_append_only();

-- Every active employee may READ the settings — a later screen will say "a
-- verified review earns 100 credits" — and nobody may write them from a
-- client. Saving goes through the admin route on the service role, like every
-- ledger write; there is deliberately no INSERT policy to be a second door.
alter table public.boe_credit_settings enable row level security;

revoke insert, update, delete, truncate, references, trigger
  on public.boe_credit_settings from authenticated, anon;
revoke select on public.boe_credit_settings from anon;
grant  select on public.boe_credit_settings to authenticated;

drop policy if exists "boe_credit_settings_read" on public.boe_credit_settings;
create policy "boe_credit_settings_read"
  on public.boe_credit_settings
  for select
  to authenticated
  using (
    exists (
      select 1 from public.users
       where id = auth.uid() and is_active = true and coalesce(is_deleted, false) = false
    )
  );

-- The Phase 1A defaults, once, only if the table is empty. Asserted against
-- DEFAULT_BOE_CREDIT_SETTINGS in src/lib/boeCredits/settings.test.ts, so a
-- constant that changes on one side without the other breaks a test.
insert into public.boe_credit_settings (review_reward_credits, credit_value, created_by, note)
select 100, 1.00, null, 'BOE Credits Phase 1A defaults'
where not exists (select 1 from public.boe_credit_settings);

-- ═══ 7. Assertions ═════════════════════════════════════════════════════════
--
-- These fail the migration rather than let a partial apply look successful.

do $$
declare
  v_n      integer;
  v_reward integer;
  v_value  numeric;
begin
  -- 7a. both tables exist with row security on
  select count(*) into v_n
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname in ('boe_credit_transactions', 'boe_credit_settings')
     and c.relrowsecurity;
  if v_n <> 2 then
    raise exception 'BOE_CREDITS: expected 2 tables with row security enabled, found %', v_n;
  end if;

  -- 7b. the uniqueness rule is in place and partial
  if not exists (
    select 1 from pg_indexes
     where schemaname = 'public'
       and indexname  = 'boe_credit_transactions_one_per_source_idx'
       and indexdef ilike '%unique%'
       and indexdef ilike '%where (source_id is not null)%'
  ) then
    raise exception 'BOE_CREDITS: the one-row-per-source unique index is missing or not partial';
  end if;

  -- 7c. both append-only triggers are armed
  select count(*) into v_n
    from pg_trigger
   where tgname in ('boe_credit_transactions_append_only', 'boe_credit_settings_append_only')
     and not tgisinternal;
  if v_n <> 2 then
    raise exception 'BOE_CREDITS: expected 2 append-only triggers, found %', v_n;
  end if;

  -- 7d. each table has exactly one policy, and it is SELECT
  select count(*) into v_n
    from pg_policies
   where schemaname = 'public'
     and tablename in ('boe_credit_transactions', 'boe_credit_settings');
  if v_n <> 2 then
    raise exception 'BOE_CREDITS: expected exactly 2 policies across the credits tables, found %', v_n;
  end if;
  if exists (
    select 1 from pg_policies
     where schemaname = 'public'
       and tablename in ('boe_credit_transactions', 'boe_credit_settings')
       and cmd <> 'SELECT'
  ) then
    raise exception 'BOE_CREDITS: a non-SELECT policy exists on a credits table — client writes must stay impossible';
  end if;

  -- 7e. no client role can write either table, and anon cannot read them
  if has_table_privilege('authenticated', 'public.boe_credit_transactions', 'INSERT')
     or has_table_privilege('authenticated', 'public.boe_credit_transactions', 'UPDATE')
     or has_table_privilege('authenticated', 'public.boe_credit_transactions', 'DELETE')
     or has_table_privilege('anon', 'public.boe_credit_transactions', 'SELECT')
     or has_table_privilege('authenticated', 'public.boe_credit_settings', 'INSERT')
     or has_table_privilege('authenticated', 'public.boe_credit_settings', 'UPDATE')
     or has_table_privilege('authenticated', 'public.boe_credit_settings', 'DELETE')
     or has_table_privilege('anon', 'public.boe_credit_settings', 'SELECT') then
    raise exception 'BOE_CREDITS: a client role holds a write (or anon a read) on a credits table';
  end if;

  -- 7f. the write path is service role only
  if has_function_privilege('authenticated', 'public.post_boe_credit_transaction(uuid, text, integer, text, uuid, text, uuid, uuid)', 'EXECUTE')
     or has_function_privilege('anon', 'public.post_boe_credit_transaction(uuid, text, integer, text, uuid, text, uuid, uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.reverse_boe_credit_transaction(uuid, uuid, text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.reverse_boe_credit_transaction(uuid, uuid, text)', 'EXECUTE') then
    raise exception 'BOE_CREDITS: a client role can execute a posting function';
  end if;
  if not has_function_privilege('service_role', 'public.post_boe_credit_transaction(uuid, text, integer, text, uuid, text, uuid, uuid)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.reverse_boe_credit_transaction(uuid, uuid, text)', 'EXECUTE') then
    raise exception 'BOE_CREDITS: service_role cannot execute a posting function';
  end if;

  -- 7g. the balance view runs as the invoker
  if not exists (
    select 1 from pg_class c
     where c.relname = 'boe_credit_balances'
       and c.relkind = 'v'
       and exists (select 1 from unnest(c.reloptions) o where o = 'security_invoker=true')
  ) then
    raise exception 'BOE_CREDITS: boe_credit_balances is not security_invoker';
  end if;

  -- 7h. the defaults are in force
  select review_reward_credits, credit_value into v_reward, v_value
    from public.boe_credit_settings order by created_at desc limit 1;
  if v_reward is distinct from 100 or v_value is distinct from 1.00 then
    raise exception 'BOE_CREDITS: active settings are (%, %), expected (100, 1.00)', v_reward, v_value;
  end if;
end $$;
