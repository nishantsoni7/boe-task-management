-- Order Requests: a non-admin may only ever assign a request to THEMSELVES,
-- and may never change the assignee of an existing request.
--
-- Problem this closes
-- -------------------
-- Assignee eligibility (20260697) restricts WHO may be an assignee, but nothing
-- restricted WHICH eligible person a non-admin could choose. The Submit form did
-- a direct client INSERT sending a user-controlled `assigned_to`, and the INSERT
-- policy `order_requests_requester_insert` (20260680) only pinned `created_by`,
-- so a normal salesperson could submit a request and hand it to any OTHER
-- eligible person. Symmetrically, `resubmit_order_request` /
-- `reapply_order_request` (20260696) set `assigned_to = p_assigned_to`
-- unconditionally, so a non-admin requester could change the assignee while
-- resubmitting or reapplying. (`edit_order_request`, 20260708/09, already
-- rejects a non-admin assignee change — this migration makes the rule uniform
-- across every write path.)
--
-- Business rule enforced here
-- ---------------------------
--   * Non-admin INSERT: `assigned_to` MUST equal auth.uid(). Assigning to
--     another person — or leaving it null — is rejected. (Product decision:
--     a non-admin who is not themselves an eligible assignee therefore cannot
--     create a request; that is intended.)
--   * Non-admin UPDATE: `assigned_to` must not change. Any other permitted
--     field may still be edited.
--   * Admin INSERT/UPDATE: may assign or reassign to any ELIGIBLE user, exactly
--     as before. Eligibility (below) is unchanged and still applies to admins.
--
-- Enforcement strategy
-- --------------------
-- The rule lives in the existing BEFORE INSERT OR UPDATE trigger
-- `validate_order_request_assignee`, because that trigger is the ONE point that
-- fires on every path at once: the direct client INSERT, and the UPDATEs inside
-- the SECURITY DEFINER RPCs (resubmit / reapply / edit / convert). The RPC owner
-- bypasses RLS, so an RLS policy alone could never cover the RPC update paths —
-- the trigger can, and does. The INSERT policy is ALSO tightened below as
-- defense-in-depth for the one path RLS does govern (the direct Submit insert).
--
-- No RPC body is changed. resubmit/reapply already pass the caller's value
-- straight through; for a non-admin that value is now the unchanged current
-- assignee (the UI locks the field), so a legitimate resubmit is a no-op on
-- assigned_to and passes the trigger, while a tampered call is rejected.
--
-- Service-role / direct SQL (auth.uid() IS NULL) is exempt from the OWNERSHIP
-- check — matching order_requests_guard_converted (20260699 §4) and
-- finance_payment_requests_guard_approved — so migrations, seeds and admin
-- scripts are never blocked. Eligibility still applies to those writes.

-- ── 1. Trigger function: eligibility (unchanged) + ownership (new) ────────────
-- The eligibility half is byte-for-byte the deployed 20260697 §4 body: only a
-- CHANGED assigned_to is re-validated, so a legacy assignment that would no
-- longer qualify today is preserved untouched. The TG_OP-first branching is kept
-- for the same reason as before — OLD is unassigned during INSERT, so the arm
-- that references OLD must never be reached on an insert.

create or replace function public.validate_order_request_assignee()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor    uuid := auth.uid();
  v_is_admin boolean;
begin
  -- Eligibility: WHO may be an assignee. Applies to every writer, admin included.
  if tg_op = 'INSERT' then
    if new.assigned_to is not null and not public.is_eligible_order_assignee(new.assigned_to) then
      raise exception 'Assignee must be an active Sales team member or an authorised Order Assignee.'
        using errcode = 'P0001';
    end if;
  elsif new.assigned_to is distinct from old.assigned_to then
    if new.assigned_to is not null and not public.is_eligible_order_assignee(new.assigned_to) then
      raise exception 'Assignee must be an active Sales team member or an authorised Order Assignee.'
        using errcode = 'P0001';
    end if;
  end if;

  -- Ownership: WHICH person a non-admin may set. Skipped entirely for
  -- service-role / direct SQL (auth.uid() IS NULL), same convention as the other
  -- order_requests guards, so seeds and admin scripts are never blocked.
  if v_actor is not null then
    v_is_admin := exists (
      select 1 from public.users u
      where u.id = v_actor and u.role = 'admin'
    );

    if not v_is_admin then
      if tg_op = 'INSERT' then
        -- A non-admin may only assign a new request to themselves. This rejects
        -- both another person's id AND a null assignee (null is distinct from a
        -- non-null uuid), which is the strict self-assign rule.
        if new.assigned_to is distinct from v_actor then
          raise exception 'You can only assign an order request to yourself.'
            using errcode = '42501';
        end if;
      elsif new.assigned_to is distinct from old.assigned_to then
        -- A non-admin may never change the assignee of an existing request. An
        -- unchanged value passes (so resubmit / reapply / a self-assignee edit
        -- all still work); any change is rejected.
        raise exception 'Only an admin may change the assignee of an order request.'
          using errcode = '42501';
      end if;
    end if;
  end if;

  return new;
end;
$$;

-- The trigger binding itself is unchanged from 20260697; CREATE OR REPLACE above
-- reuses the existing trigger with no need to drop/recreate it. Grants are
-- likewise unchanged (invoked only by the trigger; no authenticated grant).
revoke execute on function public.validate_order_request_assignee() from public, anon;

-- ── 2. INSERT policy: encode the self-assign rule at the RLS layer too ────────
-- Same four conditions as 20260680, plus: a non-admin's assigned_to must equal
-- auth.uid(); an admin may set any value (the eligibility trigger still runs).
-- `assigned_to = auth.uid()` is NULL when assigned_to is null, so a non-admin
-- null-assignee insert is denied here just as the trigger denies it — the two
-- layers agree exactly.

drop policy if exists "order_requests_requester_insert" on public.order_requests;

create policy "order_requests_requester_insert" on public.order_requests
  for insert to authenticated
  with check (
    created_by = auth.uid()
    and status = 'submitted'
    and converted_order_id is null
    and converted_at is null
    and (
      assigned_to = auth.uid()
      or exists (
        select 1 from public.users u
        where u.id = auth.uid() and u.role = 'admin'
      )
    )
  );
