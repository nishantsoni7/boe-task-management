-- ═══════════════════════════════════════════════════════════════════════════
-- 20270502000000 — An administrator may give a Confirmed Order a different,
--                  unused Order number, and the number it gave up goes back to
--                  the next Order when it was the newest.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHY (owner, 2026-10-29): an Order that was uploaded recently took the next
-- number from the cycle (0541), but it is really an older Order and must carry
-- that older number. "The only condition is that the order number should be
-- unique." The number it gave up must be free for the next Order.
--
-- WHAT CHANGES
--
--   1. change_confirmed_order_number(order, new number) — the ONE door. An
--      active administrator only. It takes digits only, 1-9999, and stores the
--      four-digit form (format_confirmed_order_number). It refuses:
--        * a number another Order already has (orders_display_number_key is the
--          real guarantee; the check makes the refusal readable);
--        * a number a PI Draft ever reserved (order_reserved_number_ledger, and
--          any reserved_order_number still on a draft);
--        * a number at or above the cycle's next number — the cycle would later
--          try to issue it and every approval would fail ORDER_NUMBER_IN_USE.
--      Under the cycle row lock (the same lock allocation takes, so no approval
--      can interleave) it renames the Order, re-stamps the number its PI PDFs
--      print, records an Activity row, and, when the old number was the newest
--      one issued (cycle next = old + 1, nothing at or above it, nothing
--      reserved at or above it), steps the cycle back so the NEXT Order is given
--      the old number. Any other old number is simply left unused: the cycle
--      never goes backwards past a surviving Order.
--
--   2. prevent_order_display_number_change() — re-emitted from 20260703000000
--      §8 with ONE added condition: a change is allowed inside the rename
--      transaction for that one Order (transaction-local setting
--      boe.order_number_rename = the Order's id). Everything else is refused
--      exactly as before, including the service role and direct SQL.
--
--   3. order_pi_versions_pdf_order_number() — re-emitted from 20270201000000
--      with the INSERT branch verbatim and ONE added condition on UPDATE: the
--      printed number may change inside the rename transaction for that
--      version's Order. Owner decision 2026-10-29: the renamed Order's PI PDF
--      prints the new number, so no two Orders' PDFs ever show the same number.
--      A version keeps the FORM it printed: a version that printed the stored
--      four digits ("0541") prints the new four digits; one that printed the
--      operational form ("541") prints the new operational form.
--
-- NOTHING ELSE MOVES. Product codes (<number>-BE0001) are built from the Order
-- number at display time and follow it. Historical rows that copied the number
-- as text (activity payloads, amendment snapshots, notification titles, the
-- deleted-Order audit) are history and keep what they said. Meetings match
-- Orders by number text and are not rewritten. Finance allocations to an OLD
-- (pre-BOE One) order number (legacy_order_no) are not moved onto the Order.
--
-- ROLLBACK: rename the Order back with the same function first if wanted; then
-- a later migration re-emits the two trigger functions as they were (20260703
-- §8 and 20270201) and drops change_confirmed_order_number(uuid, text). No
-- data is written by this file.

-- ─── 0. Preconditions ──────────────────────────────────────────────────────

do $$
begin
  if to_regclass('public.order_number_cycle') is null
     or to_regclass('public.order_reserved_number_ledger') is null
     or to_regclass('public.order_pi_versions') is null
     or to_regclass('public.order_activity_log') is null then
    raise exception 'PRECONDITION FAILED: the Order numbering tables this migration relies on are not all present';
  end if;
  if to_regprocedure('public.format_confirmed_order_number(bigint)') is null
     or to_regprocedure('public.order_operational_number(text)') is null
     or to_regprocedure('public.prevent_order_display_number_change()') is null
     or to_regprocedure('public.order_pi_versions_pdf_order_number()') is null then
    raise exception 'PRECONDITION FAILED: the Order numbering functions this migration replaces are not all present';
  end if;
end $$;


-- ─── 1. The Order number lock, with the one sanctioned exception ───────────

create or replace function public.prevent_order_display_number_change()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if old.display_number is not null
     and new.display_number is distinct from old.display_number
     -- (20270502000000) change_confirmed_order_number(), for this Order only.
     and coalesce(current_setting('boe.order_number_rename', true), '') <> old.id::text then
    raise exception 'ORDER_NUMBER_IMMUTABLE: An Order number cannot be changed once the Order exists'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

revoke execute on function public.prevent_order_display_number_change() from public, anon, authenticated;


-- ─── 2. The number a PI version prints, with the same exception ────────────

create or replace function public.order_pi_versions_pdf_order_number()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_number text;
begin
  if tg_op = 'INSERT' then
    select nullif(btrim(coalesce(o.display_number, '')), '') into v_number
      from public.orders o where o.id = new.order_id;
    if v_number is null then
      raise exception 'ORDER_PI_VERSION_ORDER_NUMBER_MISSING: the Order of this PI version has no Order number'
        using errcode = 'P0001';
    end if;
    -- Whatever the caller passed, the version prints what the live route
    -- prints for this Order today (staged; 20270202000000 switches to v_number).
    new.pdf_order_number := coalesce(public.order_operational_number(v_number), v_number);
    return new;
  end if;

  if new.pdf_order_number is distinct from old.pdf_order_number
     -- (20270502000000) change_confirmed_order_number(), for this version's Order only.
     and coalesce(current_setting('boe.order_number_rename', true), '') <> old.order_id::text then
    raise exception 'PI_PDF_ORDER_NUMBER_IMMUTABLE: the Order number printed on PI version % cannot be changed', old.id
      using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke execute on function public.order_pi_versions_pdf_order_number() from public, anon, authenticated, service_role;

comment on function public.order_pi_versions_pdf_order_number() is
  'BEFORE INSERT: sets pdf_order_number to what the live PDF route prints for the Order — order_operational_number(display_number), "526" (staged; 20270202000000 switches new versions to the stored "0526") — refusing an Order with no number. BEFORE UPDATE: refuses any change to it, except inside change_confirmed_order_number() for that Order (20270502000000). 20270201000000.';


-- ─── 3. The door ───────────────────────────────────────────────────────────

create or replace function public.change_confirmed_order_number(
  p_order_id uuid, p_new_number text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor    uuid := auth.uid();
  v_input    text := btrim(coalesce(p_new_number, ''));
  v_new_n    bigint;
  v_new      text;
  v_old      text;
  v_old_n    bigint;
  v_next     bigint;
  v_freed    boolean := false;
  v_versions integer := 0;
begin
  if v_actor is null or not exists (
    select 1 from public.users u
    where u.id = v_actor and u.role = 'admin'
      and u.is_active is true and u.is_deleted is false
  ) then
    raise exception 'ORDER_NUMBER_CHANGE_DENIED: Only an active administrator can change an Order number'
      using errcode = '42501';
  end if;

  if v_input !~ '^[0-9]{1,4}$' then
    raise exception 'ORDER_NUMBER_CHANGE_INVALID: An Order number is 1 to 4 digits'
      using errcode = '22023';
  end if;
  v_new_n := v_input::bigint;
  v_new := public.format_confirmed_order_number(v_new_n);
  if v_new is null then
    raise exception 'ORDER_NUMBER_CHANGE_INVALID: An Order number is a whole number from 1 to 9999'
      using errcode = '22023';
  end if;

  -- The cycle row first, the Order second: the same order allocation takes
  -- them, so a rename and an approval serialize instead of deadlocking.
  select c.next_number into v_next
    from public.order_number_cycle c where c.id = true for update;
  if not found then
    raise exception 'ORDER_NUMBER_CYCLE_MISSING: Confirmed Order numbering is not configured'
      using errcode = 'P0001';
  end if;

  select o.display_number into v_old
    from public.orders o where o.id = p_order_id for update;
  if not found then
    raise exception 'ORDER_NUMBER_CHANGE_MISSING: This Order does not exist'
      using errcode = 'P0002';
  end if;

  if v_old = v_new then
    raise exception 'ORDER_NUMBER_CHANGE_SAME: This Order already has number %', v_new
      using errcode = '22023';
  end if;

  if exists (select 1 from public.orders o where o.display_number = v_new) then
    raise exception 'ORDER_NUMBER_CHANGE_IN_USE: Order number % already belongs to another Order', v_new
      using errcode = '23505';
  end if;

  if exists (select 1 from public.order_reserved_number_ledger l
              where l.number::bigint = v_new_n)
     or exists (select 1 from public.order_submissions s
                 where s.reserved_order_number ~ '^[0-9]+$'
                   and s.reserved_order_number::bigint = v_new_n) then
    raise exception 'ORDER_NUMBER_CHANGE_RESERVED: Order number % was reserved for a PI Draft', v_new
      using errcode = '23505';
  end if;

  if v_new_n >= v_next then
    raise exception 'ORDER_NUMBER_CHANGE_TOO_HIGH: The new number must be below %, the number the next Order will be given',
      public.format_confirmed_order_number(v_next)
      using errcode = '22023';
  end if;

  perform set_config('boe.order_number_rename', p_order_id::text, true);

  update public.orders set display_number = v_new where id = p_order_id;

  update public.order_pi_versions v
     set pdf_order_number = case
           when v.pdf_order_number = v_old then v_new
           else coalesce(public.order_operational_number(v_new), v_new)
         end
   where v.order_id = p_order_id;
  get diagnostics v_versions = row_count;

  perform set_config('boe.order_number_rename', '', true);

  -- The old number goes to the next Order only when it was the newest number
  -- issued and nothing at or above it survives or was ever reserved — the
  -- same proof Test Data Cleanup's "reuse" choice makes (20270217000000).
  if v_old ~ '^[0-9]+$' then
    v_old_n := v_old::bigint;
    if v_next = v_old_n + 1
       and not exists (select 1 from public.orders o
                        where o.display_number ~ '^[0-9]+$'
                          and o.display_number::bigint >= v_old_n)
       and not exists (select 1 from public.order_reserved_number_ledger l
                        where l.number::bigint >= v_old_n)
       and not exists (select 1 from public.order_submissions s
                        where s.reserved_order_number ~ '^[0-9]+$'
                          and s.reserved_order_number::bigint >= v_old_n) then
      update public.order_number_cycle set next_number = v_old_n where id = true;
      v_next := v_old_n;
      v_freed := true;
    end if;
  end if;

  insert into public.order_activity_log (order_id, actor_id, event_type, payload)
  values (p_order_id, v_actor, 'order_number_changed',
          jsonb_build_object('from', v_old, 'to', v_new,
                             'old_number_is_next', v_freed,
                             'next_number', public.format_confirmed_order_number(v_next)));

  return jsonb_build_object(
    'order_id',           p_order_id,
    'previous_number',    v_old,
    'display_number',     v_new,
    'next_number',        public.format_confirmed_order_number(v_next),
    'old_number_is_next', v_freed,
    'pi_versions',        v_versions
  );
end;
$$;

revoke execute on function public.change_confirmed_order_number(uuid, text)
  from public, anon, service_role;
grant execute on function public.change_confirmed_order_number(uuid, text)
  to authenticated;

comment on function public.change_confirmed_order_number(uuid, text) is
  'Active administrators only. Gives a Confirmed Order a different number: unused by any Order, never reserved by a PI Draft, and below the cycle''s next number. Re-stamps the number its PI versions print, records order_number_changed, and steps the cycle back to the old number when it was the newest issued. 20270502000000.';


-- ─── 4. Self-assertions (executed on apply) ────────────────────────────────

do $$
declare
  v_def text;
begin
  if not exists (
    select 1 from pg_proc p
     where p.oid = to_regprocedure('public.change_confirmed_order_number(uuid, text)')
       and p.prosecdef
  ) then
    raise exception 'ASSERTION FAILED: change_confirmed_order_number(uuid, text) is missing or not SECURITY DEFINER';
  end if;
  if has_function_privilege('anon', 'public.change_confirmed_order_number(uuid, text)', 'execute') then
    raise exception 'ASSERTION FAILED: anon can execute change_confirmed_order_number';
  end if;
  if not has_function_privilege('authenticated', 'public.change_confirmed_order_number(uuid, text)', 'execute') then
    raise exception 'ASSERTION FAILED: authenticated cannot execute change_confirmed_order_number';
  end if;

  v_def := pg_get_functiondef(to_regprocedure('public.prevent_order_display_number_change()'));
  if position('ORDER_NUMBER_IMMUTABLE' in v_def) = 0
     or position('boe.order_number_rename' in v_def) = 0 then
    raise exception 'ASSERTION FAILED: prevent_order_display_number_change() was not re-emitted with the rename exception';
  end if;
  v_def := pg_get_functiondef(to_regprocedure('public.order_pi_versions_pdf_order_number()'));
  if position('PI_PDF_ORDER_NUMBER_IMMUTABLE' in v_def) = 0
     or position('boe.order_number_rename' in v_def) = 0 then
    raise exception 'ASSERTION FAILED: order_pi_versions_pdf_order_number() was not re-emitted with the rename exception';
  end if;

  if not exists (select 1 from pg_trigger where tgrelid = 'public.orders'::regclass
                    and tgname = 'orders_protect_display_number' and not tgisinternal and tgenabled <> 'D') then
    raise exception 'ASSERTION FAILED: orders_protect_display_number is not enabled';
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.order_pi_versions'::regclass
                    and tgname = 'order_pi_versions_pdf_order_number' and not tgisinternal and tgenabled <> 'D') then
    raise exception 'ASSERTION FAILED: order_pi_versions_pdf_order_number trigger is not enabled';
  end if;
end $$;
