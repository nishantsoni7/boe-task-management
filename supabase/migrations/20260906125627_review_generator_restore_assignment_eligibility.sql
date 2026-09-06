-- Keep the final Assign Batch picker permission-correct.
--
-- The generation screen may show every active employee as an intended name,
-- but assignment is actual work visibility. This shared RPC therefore remains
-- restricted to employees who resolve customer_review_requests.use.

create or replace function public.customer_review_assignable_employees()
returns table (id uuid, full_name text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED: Sign in to continue' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.users u
     where u.id = v_uid
       and u.is_active
       and public.resolve_permission(v_uid, 'customer_review_requests', 'verify')
  ) then
    raise exception 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED: Listing candidates needs the Verify permission'
      using errcode = '42501';
  end if;

  return query
    select u.id, u.full_name
      from public.users u
     where u.is_active
       and coalesce(u.is_deleted, false) = false
       and public.resolve_permission(u.id, 'customer_review_requests', 'use')
     order by u.full_name;
end;
$$;

revoke execute on function public.customer_review_assignable_employees() from public, anon;
grant execute on function public.customer_review_assignable_employees() to authenticated;

comment on function public.customer_review_assignable_employees() is
  'The employees a batch may actually be assigned to: active, not deleted, and resolving customer_review_requests.use. Verify-gated, and returns ids and display names only.';
