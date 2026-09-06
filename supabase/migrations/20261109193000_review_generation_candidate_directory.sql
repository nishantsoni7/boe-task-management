create or replace function public.customer_review_generation_candidates()
returns table (id uuid, full_name text, role_title text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'CUSTOMER_REVIEW_UNAUTHORIZED: Sign in to continue' using errcode = '42501';
  end if;

  if not exists (
    select 1
      from public.users u
     where u.id = v_uid
       and u.is_active
       and coalesce(u.is_deleted, false) = false
       and public.resolve_permission(v_uid, 'customer_review_requests', 'verify')
  ) then
    raise exception 'CUSTOMER_REVIEW_UNAUTHORIZED: Listing generation candidates needs the Verify permission'
      using errcode = '42501';
  end if;

  return query
    select u.id, u.full_name, u.position as role_title
      from public.users u
     where u.is_active
       and coalesce(u.is_deleted, false) = false
       and nullif(btrim(coalesce(u.full_name, '')), '') is not null
     order by u.full_name;
end;
$$;

revoke execute on function public.customer_review_generation_candidates() from public, anon;
grant execute on function public.customer_review_generation_candidates() to authenticated;

comment on function public.customer_review_generation_candidates() is
  'Verify-gated display directory for the Review Workflow generation form. Returns every active, non-deleted named employee. Does not grant Review Workflow use/assignment permission; assign_customer_review_batch remains authoritative.';
