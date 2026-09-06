-- Review Workflow: project city metadata and complete candidate directory.
--
-- Scope:
--   1. Store one optional city against each project image group.
--   2. Give verifiers a safe RPC to set or clear that city.
--   3. Return every active, non-deleted employee in the candidate picker.
--
-- Assignment itself remains protected by assign_customer_review_batch(), which
-- still resolves customer_review_requests.use for the target employee. Showing
-- a name here never grants module access or makes a review visible.

alter table public.customer_review_image_groups
  add column if not exists city text;

alter table public.customer_review_image_groups
  drop constraint if exists customer_review_image_groups_city_check;

alter table public.customer_review_image_groups
  add constraint customer_review_image_groups_city_check
  check (city is null or (btrim(city) <> '' and length(city) <= 80));

comment on column public.customer_review_image_groups.city is
  'Optional city for the project represented by this image group. Shared by every image in the group and kept separate from the project label so project and city can be referred to independently.';

create or replace function public.set_customer_review_image_group_city(
  p_group_id uuid,
  p_city text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid  uuid := auth.uid();
  v_city text := nullif(btrim(coalesce(p_city, '')), '');
  v_row  public.customer_review_image_groups%rowtype;
begin
  if v_uid is null then
    raise exception 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED: Sign in to continue' using errcode = '42501';
  end if;

  if not exists (
    select 1
      from public.users u
     where u.id = v_uid
       and u.is_active
       and coalesce(u.is_deleted, false) = false
       and public.resolve_permission(v_uid, 'customer_review_requests', 'verify')
  ) then
    raise exception 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED: Editing project details needs the Verify permission'
      using errcode = '42501';
  end if;

  if v_city is not null and length(v_city) > 80 then
    raise exception 'CUSTOMER_REVIEW_IMAGE_GROUP_CITY: City must be 80 characters or fewer'
      using errcode = '22023';
  end if;

  update public.customer_review_image_groups
     set city = v_city,
         updated_at = now()
   where id = p_group_id
   returning * into v_row;

  if not found then
    raise exception 'CUSTOMER_REVIEW_IMAGE_GROUP_NOT_FOUND: That project no longer exists'
      using errcode = 'P0002';
  end if;

  return to_jsonb(v_row);
end;
$$;

revoke execute on function public.set_customer_review_image_group_city(uuid, text) from public, anon;
grant  execute on function public.set_customer_review_image_group_city(uuid, text) to authenticated;

comment on function public.set_customer_review_image_group_city(uuid, text) is
  'Verify-gated project metadata update. Sets or clears the city for one Review Workflow project image group; actor is auth.uid().';

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
    select 1
      from public.users u
     where u.id = v_uid
       and u.is_active
       and coalesce(u.is_deleted, false) = false
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
       and nullif(btrim(coalesce(u.full_name, '')), '') is not null
     order by u.full_name;
end;
$$;

revoke execute on function public.customer_review_assignable_employees() from public, anon;
grant  execute on function public.customer_review_assignable_employees() to authenticated;

comment on function public.customer_review_assignable_employees() is
  'Verify-gated display directory for Review Workflow candidate pickers: every active, non-deleted employee with a display name. This function grants no access; assign_customer_review_batch() remains the authority that decides whether the chosen employee can actually receive a batch.';

-- Migration assertions. Fail the migration instead of leaving a partial state.
do $$
declare
  v_src text;
begin
  if not exists (
    select 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'customer_review_image_groups'
       and column_name = 'city'
  ) then
    raise exception 'REVIEW_GENERATOR_INPUTS: project city column is missing';
  end if;

  select p.prosrc into v_src
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'customer_review_assignable_employees'
   limit 1;

  if v_src is null or v_src like '%resolve_permission(u.id, ''customer_review_requests'', ''use'')%' then
    raise exception 'REVIEW_GENERATOR_INPUTS: candidate directory is still permission-filtered';
  end if;
end $$;
