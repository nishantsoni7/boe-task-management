-- ═══════════════════════════════════════════════════════════════════════════
-- 20261228000000 — a personal order for the module launcher
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ONE TABLE, ONE ROW PER PERSON, ONE COLUMN OF SUBSTANCE.
--
-- /modules renders the cards somebody may open in the order the launcher's array
-- is written in. That order is the application's default and it stays the
-- default; this table lets each person say which of THEIR cards they want first.
--
-- ── WHAT IS STORED, AND WHAT DELIBERATELY IS NOT ───────────────────────────
--
-- A list of launcher card KEYS — 'orders', 'finance', 'tasks' — and nothing
-- else. No titles: a title is a sentence somebody will rewrite. No routes: a
-- route is a fact about the app that a rename changes. No icons, no colours, no
-- module rows. The key is the one part of a card meant to be stable, and it is
-- already what the grid is keyed by in React.
--
-- ── THIS TABLE GRANTS NOTHING ──────────────────────────────────────────────
--
-- The distinction that matters most about this feature: A STORED KEY IS NOT
-- ACCESS. The launcher builds the cards from the permission engine first
-- (canAccessManagementModule, the same function ModuleGuard calls) and only then
-- sorts that array by this list. A row naming 'finance' for somebody with no
-- Finance permission produces NO Finance card, because there is no card in the
-- array for the key to select — see applyPersonalModuleOrder in
-- src/lib/modules/moduleOrder.ts, which returns a permutation of its input and
-- cannot return anything else.
--
-- So this table needs no relationship to app_modules, to permission_modules or
-- to employee_permission_overrides, and it deliberately has none. Nothing here
-- is consulted by any route guard, any RPC or any other policy. Revoking
-- somebody's Finance permission removes their Finance card whatever this table
-- says, and a key left behind afterwards is inert.
--
-- ── WHY ONE ROW WITH AN ARRAY, NOT A ROW PER CARD ──────────────────────────
--
-- public.user_top_tasks — the repository's existing personal-preference table —
-- stores one row per pinned task with a display_order, and reordering it costs a
-- read, a DELETE and an INSERT that the dashboard has to be able to UNDO by hand
-- when the insert fails (src/app/dashboard/page.tsx). That shape is right there:
-- each row references a task and cascades when the task is deleted.
--
-- A module key references nothing. There is no modules table to cascade from —
-- the cards are declared in TypeScript — so the row-per-item shape would buy
-- nothing and cost the same non-atomic rewrite. One row per person, replaced
-- whole by a single upsert, is atomic: a save either happens or does not, and a
-- failure leaves the previous order intact with no compensation logic to get
-- wrong.
--
-- The naming, the auth.users reference, the ON DELETE CASCADE and the
-- auth.uid() = user_id policy shape are all taken from user_top_tasks
-- (20260628000100) unchanged.
--
-- ── RLS: YOUR OWN ROW, AND ONLY EVER YOUR OWN ──────────────────────────────
--
-- Three policies, all `to authenticated`, all `auth.uid() = user_id`:
--
--   select   you read your order. Nobody reads anybody else's.
--   insert   with check (auth.uid() = user_id) — you cannot create a row
--            against somebody else's id, so you cannot rearrange their
--            launcher.
--   update   using AND with check, both on auth.uid() = user_id. `using` alone
--            would let a row be updated to carry a DIFFERENT user_id — handing
--            your row to somebody else — which is why the pair is spelled out.
--
-- NO DELETE POLICY. "Reset to default" writes the canonical list and is an
-- ordinary update; nothing in the product deletes a preference, so RLS
-- default-denies DELETE to every client and the table has no destructive door at
-- all. An account's row goes when the account goes, through the cascade.
--
-- anon gets nothing: the bootstrap grant is revoked by name, the way
-- 20261219000000 and 20261018000000 do it, because `revoke ... from public`
-- alone does not reach Supabase's explicit per-role grants.
--
-- ── WHAT THIS DOES NOT TOUCH ───────────────────────────────────────────────
--
-- No existing table, column, policy, function, trigger, index or grant is
-- altered. There is no DML: not one business record is read or written. Nothing
-- about Orders, PI, payments, expenses, Finance, attendance, payroll or the
-- permission engine appears in this file.
--
-- DEPENDENCIES: none beyond auth.users. This table stands alone by design.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── What a valid list is, as one immutable function ────────────────────────
--
-- A CHECK constraint may not contain a subquery, and "every element matches a
-- pattern" and "no element appears twice" both need one over unnest(). So the
-- whole rule lives in one IMMUTABLE function, which a check constraint may call,
-- and reads as the four things it actually says rather than as four expressions
-- contorted to avoid unnest.
--
-- Deliberately NOT security definer and deliberately without `set search_path`:
-- it touches no table and calls only pg_catalog built-ins, and leaving it
-- inlinable keeps the constraint cheap. Nothing else in the schema calls it.
--
-- CAVEAT, stated because it is the known weakness of a function in a CHECK:
-- Postgres does not re-validate existing rows if this function is later
-- redefined. Redefining it is therefore a schema change that needs its own
-- migration and its own backfill check, not an edit to this file.
create or replace function public.user_module_order_keys_valid(p_keys text[])
returns boolean
language sql
immutable
as $$
  select
    p_keys is not null
    -- ONE DIMENSION. A text[][] would store as an array of text and is not a
    -- list of keys. An empty array reports no dimensions at all, hence coalesce.
    and coalesce(array_ndims(p_keys), 1) = 1
    -- BOUNDED. The launcher has thirteen cards; sixty-four is room for a decade
    -- of new modules and still a bound, so no row can hand the grid an
    -- unbounded list to walk.
    and coalesce(array_length(p_keys, 1), 0) <= 64
    -- NO NULLS. array_position returns the first null's index, or null if there
    -- is none.
    and array_position(p_keys, null) is null
    -- EVERY ELEMENT IS A MODULE KEY, AND NO KEY APPEARS TWICE — both, in one
    -- comparison. The count of DISTINCT WELL-FORMED elements can only equal the
    -- length when every element is well formed and all of them differ. The
    -- pattern is the shape every ModuleDef.key in the launcher has, which also
    -- rules out the empty string.
    and coalesce(array_length(p_keys, 1), 0) = (
      select count(distinct k) from unnest(p_keys) as k
       where k ~ '^[a-z][a-z0-9_]{0,63}$'
    )
$$;

comment on function public.user_module_order_keys_valid(text[]) is
  'True when a text[] is a well-formed list of launcher card keys: one dimension, at most 64 entries, no nulls, every entry matching ^[a-z][a-z0-9_]{0,63}$ and no entry twice. Used only by the check constraint on public.user_module_order.module_keys. 20261228000000.';

create table if not exists public.user_module_order (
  user_id     uuid        primary key references auth.users(id) on delete cascade,
  -- The launcher card keys, first card first. '{}' is indistinguishable from no
  -- row at all for the reader (both mean "canonical order"), and is the default
  -- so that a row can exist without asserting an order.
  module_keys text[]      not null default '{}',
  updated_at  timestamptz not null default now(),

  -- SHAPE, ENFORCED HERE AS WELL AS IN THE CLIENT. The reader
  -- (normalizeStoredModuleOrder) already drops anything malformed rather than
  -- break the screen somebody signs in to; this constraint stops it being stored
  -- in the first place, so the two cannot drift into "the database holds rubbish
  -- that the client happens to tolerate".
  constraint user_module_order_keys_valid
    check (public.user_module_order_keys_valid(module_keys))
);

comment on table public.user_module_order is
  'One row per person: the order they want their /modules launcher cards in, as a list of launcher card keys. A DISPLAY PREFERENCE ONLY — it grants no access and is consulted by no guard, no RPC and no other policy; the launcher builds the visible cards from the permission engine first and merely sorts that array by this list, so a key naming a module the person cannot open produces no card. 20261228000000.';

comment on column public.user_module_order.module_keys is
  'Launcher card keys (src/app/modules/page.tsx ModuleDef.key), first card first. Never titles, routes, icons or module rows. Keys naming modules that no longer exist or are no longer permitted are ignored on read; permitted cards this list omits are appended in the application''s canonical order.';

alter table public.user_module_order enable row level security;

-- Supabase's bootstrap grants every new public table to anon and authenticated.
-- `from public` alone does not reach those explicit per-role grants, so both are
-- named — then authenticated is given back exactly the three commands the
-- feature uses. No DELETE, and nothing for anon.
revoke all on public.user_module_order from public, anon, authenticated;
grant select, insert, update on public.user_module_order to authenticated;

-- ─── Policies: your own row, and only ever your own ─────────────────────────

-- Each one dropped first, so this file is safe to apply twice — the property
-- supabase/tests/run_personal_module_order_local.sh checks by applying it twice.
-- `create policy` has no IF NOT EXISTS form, and re-running a migration must not
-- be the thing that fails a deployment.

drop policy if exists user_module_order_select on public.user_module_order;
create policy user_module_order_select
  on public.user_module_order
  for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists user_module_order_insert on public.user_module_order;
create policy user_module_order_insert
  on public.user_module_order
  for insert to authenticated
  with check (auth.uid() = user_id);

-- BOTH HALVES. `using` decides which row you may update; `with check` decides
-- what it may become. Without the second, an update could rewrite user_id and
-- move your row onto somebody else's account.
drop policy if exists user_module_order_update on public.user_module_order;
create policy user_module_order_update
  on public.user_module_order
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- `updated_at` is maintained by a trigger rather than trusted from the client,
-- so the column says when the order actually changed whatever the browser sent.
create or replace function public.touch_user_module_order()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists user_module_order_touch on public.user_module_order;
create trigger user_module_order_touch
  before insert or update on public.user_module_order
  for each row
  execute function public.touch_user_module_order();

-- ─── Assertions ─────────────────────────────────────────────────────────────
--
-- Read-only. They fail the migration rather than let a partially applied state
-- look successful. Nothing below writes a row.

do $$
declare
  v_policies text[];
begin
  if not exists (
    select 1 from pg_tables
    where schemaname = 'public' and tablename = 'user_module_order' and rowsecurity
  ) then
    raise exception 'personal module order: RLS is not enabled on public.user_module_order';
  end if;

  -- EXACTLY the three commands the feature uses, and no policy that covers
  -- DELETE or ALL. A permissive FOR ALL policy added later would open the
  -- destructive door this table deliberately does not have.
  select array_agg(distinct cmd order by cmd) into v_policies
    from pg_policies
   where schemaname = 'public' and tablename = 'user_module_order';
  if v_policies is distinct from array['INSERT', 'SELECT', 'UPDATE'] then
    raise exception 'personal module order: expected SELECT/INSERT/UPDATE policies, found %', v_policies;
  end if;

  -- Every policy is owner-scoped. A policy on this table whose expression does
  -- not mention auth.uid() would be one that lets somebody read or rewrite
  -- another person's launcher.
  if exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'user_module_order'
      and coalesce(qual, '') || coalesce(with_check, '') not like '%auth.uid()%'
  ) then
    raise exception 'personal module order: a policy is not scoped to auth.uid()';
  end if;

  -- The update policy carries both halves.
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'user_module_order'
      and cmd = 'UPDATE' and qual like '%auth.uid()%' and with_check like '%auth.uid()%'
  ) then
    raise exception 'personal module order: the update policy is missing its with-check half';
  end if;

  -- anon cannot touch it, and authenticated has no DELETE.
  if has_table_privilege('anon', 'public.user_module_order', 'SELECT')
     or has_table_privilege('anon', 'public.user_module_order', 'INSERT')
     or has_table_privilege('anon', 'public.user_module_order', 'UPDATE') then
    raise exception 'personal module order: anon still holds a grant on public.user_module_order';
  end if;
  if has_table_privilege('authenticated', 'public.user_module_order', 'DELETE') then
    raise exception 'personal module order: authenticated can DELETE a preference row';
  end if;
  if not has_table_privilege('authenticated', 'public.user_module_order', 'SELECT')
     or not has_table_privilege('authenticated', 'public.user_module_order', 'UPDATE') then
    raise exception 'personal module order: authenticated LOST a grant — the feature cannot read or save';
  end if;

  -- The shape constraint is present and really does call the validator.
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.user_module_order'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%user_module_order_keys_valid%'
  ) then
    raise exception 'personal module order: the module_keys shape constraint is missing';
  end if;

  -- And the validator actually refuses what it is there to refuse. Pure
  -- expressions over literals: no row is inserted, nothing is written.
  if not public.user_module_order_keys_valid('{}'::text[])
     or not public.user_module_order_keys_valid(array['orders', 'finance'])
     or public.user_module_order_keys_valid(array['orders', 'orders'])
     or public.user_module_order_keys_valid(array['Orders'])
     or public.user_module_order_keys_valid(array['orders', null])
     or public.user_module_order_keys_valid(array[''])
     or public.user_module_order_keys_valid(array['../etc/passwd']) then
    raise exception 'personal module order: the module_keys validator does not hold';
  end if;

  -- The user_id column really does cascade from auth.users, so a deleted
  -- account leaves no preference behind.
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.user_module_order'::regclass
      and contype = 'f' and confdeltype = 'c'
  ) then
    raise exception 'personal module order: user_id does not cascade from auth.users';
  end if;
end $$;
