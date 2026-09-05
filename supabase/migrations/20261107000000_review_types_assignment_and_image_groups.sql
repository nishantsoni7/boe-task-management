-- ═════════════════════════════════════════════════════════════════════════════
-- Review Workflow — two review types, batches owned by one employee, and a
-- project image library that image reviews draw from.
-- ═════════════════════════════════════════════════════════════════════════════
--
-- FIVE CHANGES, ONE FILE, because they are one change to the workflow and any
-- subset of them leaves a database nobody wants:
--
--   1. A review IS a text review or an image review, stored on the row. A
--      generated batch is exactly eight text and four image, and the DATABASE
--      counts them — not the model, and not the route.
--   2. A batch is ASSIGNED to one employee, all twelve at once. The company-wide
--      unbooked pool stops existing: a candidate sees the reviews assigned to
--      them and nothing else, decided by the SELECT policy rather than by a
--      screen.
--   3. A PROJECT IMAGE GROUP is one project's photographs. Each image review
--      carries one group, chosen once when the batch is assigned and persisted,
--      so it does not move under a candidate between page loads.
--   4. READINESS IS NOT A STATUS. An image review whose group is missing or
--      empty is `available` like any other; it simply cannot be booked, and the
--      screens read that from image_group_id rather than from a sixth status.
--   5. The reward depends on the TYPE. boe_credit_settings gains an image
--      reward; review_reward_credits keeps its name, its history and its value
--      and becomes the TEXT reward.
--
-- ── WHAT DOES NOT CHANGE, RE-STATED BECAUSE IT WOULD BE EASY TO LOSE ────────
--
--   * The five statuses. No sixth is added, here or anywhere.
--   * No client role gains INSERT, UPDATE or DELETE on customer_review_test_cards.
--     Everything below still writes through SECURITY DEFINER functions whose
--     actor is auth.uid() and whose permissions come from the engine.
--   * Verification is still the one credit-awarding event, still atomic, still
--     exactly one review_reward row per review, still paid to booked_by.
--   * No role is read anywhere. `use` and `verify` are resolved.
--   * The ledger stays append-only and post_boe_credit_transaction() stays
--     unreachable from a browser.
--
-- ── THE STATE OF THE PRODUCTION DATABASE THIS WAS WRITTEN AGAINST ───────────
--
-- Read before the file was written, and it is why the defaults below are safe
-- rather than merely plausible:
--
--   28 cards, 12 live: 11 pending_approval and 1 available. NONE booked, NONE
--   submitted, NONE verified. 0 review_image rows. 3 batches. And — the one
--   that settles the reward question — 0 review_reward rows have EVER been
--   posted to the ledger.
--
-- So `review_type default 'text'` re-prices nothing and rewrites no history:
-- there is no verified review to re-price and no reward to restate. The single
-- existing available review becomes verifier-only until somebody assigns it,
-- which is the deliberate consequence of removing the pool and is called out
-- here rather than discovered later.
--
-- ── ASSUMPTIONS CHECKED BEFORE THIS IS APPLIED ─────────────────────────────
--   1. 20261031000000 (twelve drafts, editing, review images) is applied.
--   2. 20261104000000 (BOE Credits Phase 1D) is applied, so
--      post_boe_credit_review_reward() and the review-month tables exist.
--
-- ── PRODUCTION SAFETY ──────────────────────────────────────────────────────
-- Additive. Every column is added with a default that every existing row
-- already satisfies; every constraint that could refuse an existing row is
-- added NOT VALID or scoped so that it cannot. Re-runnable.
--
-- ── ROLLBACK ───────────────────────────────────────────────────────────────
-- Re-apply 20261031000000 § 1 and § 4, 20261030000000 § book, 20261017000000
-- § 7 (the cards SELECT policy) and 20261104000000 § 8 and § 10; then drop the
-- functions and the two tables this file creates. Columns and the settings
-- column are left in place: dropping a column a released build may still
-- select is a worse outage than an unread column.

-- ═══ 1. WHAT KIND OF REVIEW THIS IS ════════════════════════════════════════
--
-- A STORED FACT, not a derivation from whether images happen to be attached.
-- The reward depends on it, so it has to be a thing the database can be held to
-- rather than a thing a screen infers.
--
-- DEFAULT 'text' IS THE HONEST VALUE FOR EVERY EXISTING ROW. Every review this
-- module has ever produced was written to be sent as text; the review_image
-- feature added in 20261031000000 attaches photographs to a review, it does not
-- make one an image review, and no production row uses it. Since
-- review_reward_credits becomes the TEXT reward with its value unchanged, a
-- legacy row's reward is identical before and after this file.

alter table public.customer_review_test_cards
  add column if not exists review_type text not null default 'text';

alter table public.customer_review_test_cards
  drop constraint if exists customer_review_test_cards_review_type_check;

alter table public.customer_review_test_cards
  add constraint customer_review_test_cards_review_type_check
  check (review_type in ('text', 'image'));

comment on column public.customer_review_test_cards.review_type is
  'text or image. THE FACT THE REWARD IS PRICED FROM: transition_customer_review_test_card() reads it off the locked row and never from a parameter, so a browser cannot choose which reward it earns. Correctable by a verifier only while the draft is pending_approval.';

create index if not exists customer_review_test_cards_review_type_idx
  on public.customer_review_test_cards (review_type, status);

-- ═══ 2. WHO THE REVIEW BELONGS TO ══════════════════════════════════════════
--
-- ASSIGNMENT IS NOT BOOKING, and the two columns are kept apart for the same
-- reason approval and status are kept apart: they answer different questions
-- and move at different times. `assigned_to` is who may work on this review at
-- all; `booked_by` is who has actually picked it up. A candidate books only
-- within what they were assigned, and unbooking returns the review to them
-- rather than to a pool.

alter table public.customer_review_test_cards
  add column if not exists assigned_to uuid references public.users(id),
  add column if not exists assigned_at timestamptz,
  add column if not exists assigned_by uuid references public.users(id);

-- The actor travels with the timestamp and with the target, the shape every
-- other trio on this table already has. A half-written assignment is not
-- expressible even by the definer functions.
alter table public.customer_review_test_cards
  drop constraint if exists customer_review_test_cards_assignment_consistent;

alter table public.customer_review_test_cards
  add constraint customer_review_test_cards_assignment_consistent
  check (
    (assigned_to is null and assigned_at is null and assigned_by is null)
    or (assigned_to is not null and assigned_at is not null and assigned_by is not null)
  );

-- A PENDING DRAFT IS NOT ASSIGNED TO ANYBODY. Assignment happens to approved
-- reviews; assigning an unapproved one would hand a candidate a row they cannot
-- see and would contradict customer_review_test_cards_pending_is_untouched,
-- which already says a pending row holds nothing.
alter table public.customer_review_test_cards
  drop constraint if exists customer_review_test_cards_pending_is_unassigned;

alter table public.customer_review_test_cards
  add constraint customer_review_test_cards_pending_is_unassigned
  check (status <> 'pending_approval' or assigned_to is null);

-- THE HOLDER IS THE ASSIGNEE. A booked review's holder is the person it was
-- assigned to and can be nobody else — book_customer_review_test_card() refuses
-- otherwise, and this is the table saying the same thing so that no future
-- function can quietly disagree with it.
--
-- NOT VALID: a review booked before this file existed carries a null
-- assigned_to. There are none in production today, but this file must also be
-- correct for a database where there are; enforcing forwards asks nothing of
-- them, and the `assigned_to is null` disjunct means they stay legal.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.customer_review_test_cards'::regclass
       and conname  = 'customer_review_test_cards_holder_is_assignee'
  ) then
    alter table public.customer_review_test_cards
      add constraint customer_review_test_cards_holder_is_assignee
      check (booked_by is null or assigned_to is null or booked_by = assigned_to)
      not valid;
  end if;
end $$;

create index if not exists customer_review_test_cards_assigned_idx
  on public.customer_review_test_cards (assigned_to, status)
  where deleted_at is null;

comment on column public.customer_review_test_cards.assigned_to is
  'The one employee this review belongs to. Written only by assign_customer_review_batch(), twelve rows at a time, and never cleared. THE SELECT POLICY READS IT: a candidate sees an available review only when it is assigned to them, which is what replaced the company-wide pool.';

-- ═══ 3. THE PROJECT IMAGE LIBRARY ══════════════════════════════════════════
--
-- ONE GROUP IS ONE PROJECT. Its images are the photographs of that project and
-- nothing else, which is the whole point: an image review carries a GROUP, so
-- the pictures a candidate posts are guaranteed to be of one project without
-- anybody having to remember not to mix them. There is no path in this file
-- that puts an image into a review; a review points at a group, and the group
-- owns its images.
--
-- WHY GROUP-LEVEL AND NOT IMAGE-LEVEL. Selecting four individual images at
-- random from a library is exactly the thing that would mix two projects into
-- one post. Selecting a group cannot.

create table if not exists public.customer_review_image_groups (
  id          uuid primary key default gen_random_uuid(),
  -- AN INTERNAL LABEL. It names the project for the people managing the
  -- library; no candidate-facing screen shows it and no message carries it.
  -- Bounded, and unique so two groups cannot be told apart only by their id.
  label       text not null check (btrim(label) <> '' and length(label) <= 120),
  created_by  uuid not null references public.users(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- ARCHIVED, NOT DELETED. A group a review points at must keep existing —
  -- the review is a record of what a candidate was asked to post. Archiving
  -- takes a group out of future random selection and leaves every existing
  -- reference intact.
  archived_at timestamptz,
  archived_by uuid references public.users(id),
  constraint customer_review_image_groups_archive_consistent check (
    (archived_at is null and archived_by is null)
    or (archived_at is not null and archived_by is not null)
  ),
  constraint customer_review_image_groups_label_unique unique (label)
);

comment on table public.customer_review_image_groups is
  'One project image group for the Review Workflow. Holds a label and nothing else; the images hang off it. A group is archived, never deleted, because an image review points at the group it was assigned.';

create table if not exists public.customer_review_group_images (
  id         uuid primary key default gen_random_uuid(),
  group_id   uuid not null references public.customer_review_image_groups(id) on delete restrict,

  -- The object key inside 'customer-review-project-images'. UNIQUE so one
  -- object can never be claimed by two rows. The FIRST PATH SEGMENT IS ALWAYS
  -- THE GROUP ID — the storage policy reads ownership out of it, which is why
  -- the path must contain a separator and must not start with one.
  storage_path text not null unique check (
    position('/' in storage_path) > 1 and length(storage_path) <= 400
  ),

  -- Display only. Never used to build a path.
  file_name  text not null check (btrim(file_name) <> '' and length(file_name) <= 200),
  mime_type  text not null check (mime_type in ('image/jpeg', 'image/png', 'image/webp')),
  byte_size  integer not null check (byte_size > 0 and byte_size <= 5242880),
  -- Over the STORED bytes, so two uploads of the same photograph collapse.
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),

  uploaded_by uuid not null references public.users(id),
  uploaded_at timestamptz not null default now(),

  -- Non-null while a removal is in flight, exactly as the screenshots table
  -- does it: the row is marked, the object is deleted, then the row is. Every
  -- read filters these out.
  removal_started_at timestamptz,

  constraint customer_review_group_image_path_matches_group check (
    split_part(storage_path, '/', 1) = group_id::text
  )
);

-- The same-content guard, live rows only, so a removal in flight does not block
-- the replacement it exists to allow.
create unique index if not exists customer_review_group_image_unique_live_content
  on public.customer_review_group_images (group_id, content_sha256)
  where removal_started_at is null;

create index if not exists customer_review_group_images_group_idx
  on public.customer_review_group_images (group_id)
  where removal_started_at is null;

comment on table public.customer_review_group_images is
  'Images belonging to ONE project image group. Metadata for objects in the private customer-review-project-images bucket; no client role holds INSERT, UPDATE or DELETE.';

drop trigger if exists customer_review_image_groups_set_updated_at on public.customer_review_image_groups;
create trigger customer_review_image_groups_set_updated_at
  before update on public.customer_review_image_groups
  for each row execute function public.set_updated_at();

-- ── Which group an image review draws from ──────────────────────────────────
--
-- PERSISTED ON THE REVIEW, and that is the requirement rather than an
-- implementation detail: a group chosen afresh on every page load would show a
-- candidate different photographs each time they opened the same review.
alter table public.customer_review_test_cards
  add column if not exists image_group_id uuid references public.customer_review_image_groups(id);

alter table public.customer_review_test_cards
  drop constraint if exists customer_review_test_cards_group_only_for_image;

-- A TEXT REVIEW HAS NO GROUP. Not "usually has none" — cannot have one.
alter table public.customer_review_test_cards
  add constraint customer_review_test_cards_group_only_for_image
  check (image_group_id is null or review_type = 'image');

create index if not exists customer_review_test_cards_image_group_idx
  on public.customer_review_test_cards (image_group_id)
  where image_group_id is not null;

comment on column public.customer_review_test_cards.image_group_id is
  'The project image group an image review posts photographs from. Chosen once — by assign_customer_review_batch(), or later by set_customer_review_image_group() when no group was free at assignment — and then stable. Null on an image review means WAITING FOR ADMIN IMAGES, which is a readiness fact and deliberately NOT a status.';

-- ── The private bucket ──────────────────────────────────────────────────────
--
-- A SECOND BUCKET, AND THE REASON IS NOT TIDINESS. The screenshots bucket's
-- storage SELECT policy resolves ownership by reading split_part(name, '/', 1)
-- as a CARD id. A project image is not owned by a card — it is owned by a group
-- that several cards may point at — so putting one in that bucket would mean
-- either a path whose first segment is a lie or a policy widened to accept two
-- meanings for one segment. Both are worse than a second bucket with the same
-- shape: private, 5 MB, three still-image types.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'customer-review-project-images',
  'customer-review-project-images',
  false,     -- private: no anonymous or public read, ever
  5242880,   -- 5 MB per file — must equal GROUP_IMAGE_MAX_BYTES
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update set
  public             = excluded.public,
  file_size_limit    = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- ── Who may see a project image ─────────────────────────────────────────────
--
-- TWO ANSWERS, AND NO THIRD. A verifier, because they manage the library; and
-- the candidate holding an image review that points at THIS group, because the
-- photographs are what they were asked to post. Nobody else — not another
-- candidate, not a candidate whose reviews point at other groups.
--
-- SECURITY DEFINER, taking the group id as a VALUE, for the reason
-- can_view_customer_review_test_card_row() gives: a policy body runs as the
-- caller, so an inline read of public.users would be subject to whatever
-- privileges that table carries later.
create or replace function public.can_view_customer_review_image_group(
  p_group_id uuid
)
returns boolean
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select auth.uid() is not null and exists (
    select 1
    from public.users u
    where u.id = auth.uid()
      and u.is_active
      and (
        public.resolve_permission(auth.uid(), 'customer_review_requests', 'verify')
        or exists (
          select 1
          from public.customer_review_test_cards c
          where c.image_group_id = p_group_id
            and c.assigned_to = auth.uid()
            and c.deleted_at is null
            and public.resolve_permission(auth.uid(), 'customer_review_requests', 'use')
        )
      )
  );
$$;

revoke execute on function public.can_view_customer_review_image_group(uuid) from public, anon;
grant  execute on function public.can_view_customer_review_image_group(uuid) to authenticated;

comment on function public.can_view_customer_review_image_group(uuid) is
  'May this caller see one project image group and its images? A verifier, or a `use` holder who has been assigned a live image review pointing at that group. Nobody else.';

alter table public.customer_review_image_groups  enable row level security;
alter table public.customer_review_group_images  enable row level security;

drop policy if exists "customer_review_image_groups_select" on public.customer_review_image_groups;
create policy "customer_review_image_groups_select"
  on public.customer_review_image_groups
  for select to authenticated
  using (public.can_view_customer_review_image_group(customer_review_image_groups.id));

drop policy if exists "customer_review_group_images_select" on public.customer_review_group_images;
create policy "customer_review_group_images_select"
  on public.customer_review_group_images
  for select to authenticated
  using (public.can_view_customer_review_image_group(customer_review_group_images.group_id));

-- READ-ONLY TO EVERY CLIENT ROLE. The SELECT policies decide who reads; these
-- revokes decide that nobody writes. A new table in `public` arrives with
-- INSERT/UPDATE/DELETE already granted to authenticated by Supabase's default
-- privileges, and an absent policy is the only thing in the way — so take the
-- privilege as well, and a policy added back by mistake later still cannot write.
revoke insert, update, delete, truncate, references, trigger
  on public.customer_review_image_groups from authenticated, anon;
revoke insert, update, delete, truncate, references, trigger
  on public.customer_review_group_images from authenticated, anon;
revoke select on public.customer_review_image_groups from anon;
revoke select on public.customer_review_group_images from anon;
grant  select on public.customer_review_image_groups to authenticated;
grant  select on public.customer_review_group_images to authenticated;

-- THERE IS NO INSERT AND NO DELETE POLICY ON storage.objects FOR THIS BUCKET,
-- the same posture the screenshots bucket carries. The bytes arrive only
-- through /api/customer-reviews/image-groups on the service role, after that
-- route has read and re-encoded them; a client that could put an object here
-- would make the validation advisory.
drop policy if exists "customer_review_project_images_storage_select" on storage.objects;
create policy "customer_review_project_images_storage_select"
  on storage.objects
  for select to authenticated
  using (
    bucket_id = 'customer-review-project-images'
    and exists (
      select 1 from public.customer_review_image_groups g
      where g.id::text = split_part(storage.objects.name, '/', 1)
        and public.can_view_customer_review_image_group(g.id)
    )
  );

-- ── Managing the library ────────────────────────────────────────────────────
--
-- FOUR VERIFIER ACTIONS, and the actor of every one is auth.uid(). None takes a
-- user id, so none can be aimed at somebody else. The two removal halves are
-- service-role only, because removing an image spans the bucket and this table
-- and no client may perform half of one — the same split the screenshots use.

create or replace function public.create_customer_review_image_group(p_label text)
returns public.customer_review_image_groups
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  g      public.customer_review_image_groups%rowtype;
  v_uid  uuid := auth.uid();
  v_lab  text := btrim(coalesce(p_label, ''));
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
    raise exception 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED: Managing the image library needs the Verify permission'
      using errcode = '42501';
  end if;

  if v_lab = '' or length(v_lab) > 120 then
    raise exception 'CUSTOMER_REVIEW_GROUP_BAD_LABEL: Give the project group a name of up to 120 characters'
      using errcode = '23514';
  end if;

  insert into public.customer_review_image_groups (label, created_by)
  values (v_lab, v_uid)
  returning * into g;

  return g;
exception
  when unique_violation then
    raise exception 'CUSTOMER_REVIEW_GROUP_DUPLICATE: A project group with that name already exists'
      using errcode = '23505';
end;
$$;

revoke execute on function public.create_customer_review_image_group(text) from public, anon;
grant  execute on function public.create_customer_review_image_group(text) to authenticated;

create or replace function public.rename_customer_review_image_group(
  p_group_id uuid,
  p_label    text
)
returns public.customer_review_image_groups
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  g     public.customer_review_image_groups%rowtype;
  v_uid uuid := auth.uid();
  v_lab text := btrim(coalesce(p_label, ''));
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
    raise exception 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED: Managing the image library needs the Verify permission'
      using errcode = '42501';
  end if;

  if v_lab = '' or length(v_lab) > 120 then
    raise exception 'CUSTOMER_REVIEW_GROUP_BAD_LABEL: Give the project group a name of up to 120 characters'
      using errcode = '23514';
  end if;

  update public.customer_review_image_groups
     set label = v_lab
   where id = p_group_id
  returning * into g;

  if not found then
    raise exception 'CUSTOMER_REVIEW_GROUP_NOT_FOUND: That project group no longer exists'
      using errcode = 'P0002';
  end if;

  return g;
exception
  when unique_violation then
    raise exception 'CUSTOMER_REVIEW_GROUP_DUPLICATE: A project group with that name already exists'
      using errcode = '23505';
end;
$$;

revoke execute on function public.rename_customer_review_image_group(uuid, text) from public, anon;
grant  execute on function public.rename_customer_review_image_group(uuid, text) to authenticated;

-- ARCHIVE, WHICH IS NOT DELETE. An archived group keeps every image and every
-- reference; it simply stops being offered to the random selection below.
create or replace function public.archive_customer_review_image_group(
  p_group_id uuid,
  p_archived boolean
)
returns public.customer_review_image_groups
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  g     public.customer_review_image_groups%rowtype;
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
    raise exception 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED: Managing the image library needs the Verify permission'
      using errcode = '42501';
  end if;

  if p_archived is null then
    raise exception 'CUSTOMER_REVIEW_GROUP_BAD_LABEL: say whether the group is being archived or restored'
      using errcode = '23514';
  end if;

  update public.customer_review_image_groups
     set archived_at = case when p_archived then now()  else null end,
         archived_by = case when p_archived then v_uid else null end
   where id = p_group_id
  returning * into g;

  if not found then
    raise exception 'CUSTOMER_REVIEW_GROUP_NOT_FOUND: That project group no longer exists'
      using errcode = 'P0002';
  end if;

  return g;
end;
$$;

revoke execute on function public.archive_customer_review_image_group(uuid, boolean) from public, anon;
grant  execute on function public.archive_customer_review_image_group(uuid, boolean) to authenticated;

-- ── Removing one image, in two halves ───────────────────────────────────────
--
-- Mirrors begin_/finish_customer_review_image_removal() step for step. The
-- route marks the row, deletes the object, then deletes the row, so a crash
-- between the two leaves a marked row rather than a live row pointing at
-- nothing.
--
-- PRODUCTION SAFETY IS A CONDITION, NOT A COURTESY. An image cannot be removed
-- from a group that a LIVE, ALREADY-BOOKED image review points at: the
-- candidate has been told to post those photographs, and taking one away
-- underneath them changes what they were asked to do. Removing from a group
-- that is only referenced by unbooked reviews is allowed, and so is removing
-- from a group nothing references.

create or replace function public.begin_customer_review_group_image_removal(
  p_image_id uuid,
  p_actor_id uuid
)
returns public.customer_review_group_images
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  i public.customer_review_group_images%rowtype;
begin
  select * into i from public.customer_review_group_images
   where id = p_image_id for update;
  if not found then
    raise exception 'CUSTOMER_REVIEW_GROUP_IMAGE_NOT_FOUND: That image is no longer in the group'
      using errcode = 'P0002';
  end if;

  if not exists (
    select 1 from public.users u
     where u.id = p_actor_id
       and u.is_active
       and public.resolve_permission(p_actor_id, 'customer_review_requests', 'verify')
  ) then
    raise exception 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED: Managing the image library needs the Verify permission'
      using errcode = '42501';
  end if;

  if exists (
    select 1 from public.customer_review_test_cards c
     where c.image_group_id = i.group_id
       and c.deleted_at is null
       and c.booked_by is not null
  ) then
    raise exception 'CUSTOMER_REVIEW_GROUP_IN_USE: A candidate has already picked up a review using this project, so its images can no longer be changed'
      using errcode = '42501';
  end if;

  if i.removal_started_at is null then
    update public.customer_review_group_images
       set removal_started_at = now()
     where id = p_image_id;
    select * into i from public.customer_review_group_images where id = p_image_id;
  end if;

  return i;
end;
$$;

revoke execute on function public.begin_customer_review_group_image_removal(uuid, uuid)
  from public, anon, authenticated;
grant  execute on function public.begin_customer_review_group_image_removal(uuid, uuid)
  to service_role;

create or replace function public.finish_customer_review_group_image_removal(p_image_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  i public.customer_review_group_images%rowtype;
begin
  select * into i from public.customer_review_group_images
   where id = p_image_id for update;
  if not found then return; end if;

  if i.removal_started_at is null then
    raise exception 'CUSTOMER_REVIEW_GROUP_BAD_REMOVAL: This image was not marked for removal'
      using errcode = '23514';
  end if;

  delete from public.customer_review_group_images where id = p_image_id;
end;
$$;

revoke execute on function public.finish_customer_review_group_image_removal(uuid)
  from public, anon, authenticated;
grant  execute on function public.finish_customer_review_group_image_removal(uuid)
  to service_role;

-- ═══ 4. EIGHT TEXT AND FOUR IMAGE, COUNTED BY THE DATABASE ═════════════════
--
-- Identical to 20261031000000's definition except that each draft now carries a
-- `type` and the composition is CHECKED before anything is inserted. Repeated
-- in full rather than patched because plpgsql has no partial redefinition.
--
-- WHY THE COUNT IS HERE AND NOT ONLY IN THE ROUTE. The route builds the request
-- and assigns the types, and it is right that it does. But the route is one
-- deployment away from a bug, and a batch with the wrong mix would be a batch
-- an employee is paid the wrong amount for. The database refusing it means the
-- worst case is a failed generation rather than a silently wrong batch.
--
-- IT IS NOT THE MODEL'S CHOICE. The model is told what to write; it is not
-- asked how many of each to produce, and a `type` it invented would be one of
-- the two allowed values or the insert fails. See buildUserPrompt() and
-- assignReviewTypes() in src/lib/customerReviews/draftGeneration.ts.

create or replace function public.create_customer_review_draft_batch(
  p_guidance    text,
  p_model       text,
  p_drafts      jsonb,
  p_actor_id    uuid,
  p_request_key uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_batch_id uuid;
  v_n        integer;
  v_next     integer;
  v_item     jsonb;
  v_title    text;
  v_body     text;
  v_type     text;
  v_text_n   integer;
  v_image_n  integer;
begin
  if p_request_key is null then
    raise exception 'CUSTOMER_REVIEW_TEST_BAD_BATCH: a generation request needs a request key'
      using errcode = '23514';
  end if;

  if not exists (select 1 from public.users u where u.id = p_actor_id and u.is_active) then
    raise exception 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED: Your account is not active'
      using errcode = '42501';
  end if;

  if not public.resolve_permission(p_actor_id, 'customer_review_requests', 'verify') then
    raise exception 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED: Generating drafts needs the Verify permission'
      using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtext('customer_review_draft_batch'));

  select id into v_batch_id
    from public.customer_review_draft_batches
   where request_key = p_request_key;
  if v_batch_id is not null then
    return v_batch_id;
  end if;

  -- ── Exactly twelve, all valid ────────────────────────────────────────────
  if jsonb_typeof(p_drafts) <> 'array' then
    raise exception 'CUSTOMER_REVIEW_TEST_BAD_BATCH: the drafts payload is not an array'
      using errcode = '23514';
  end if;

  v_n := jsonb_array_length(p_drafts);
  if v_n <> 12 then
    raise exception 'CUSTOMER_REVIEW_TEST_BAD_BATCH: the batch holds % draft(s), expected exactly 12', v_n
      using errcode = '23514';
  end if;

  -- ── EIGHT TEXT, FOUR IMAGE, AND NOTHING ELSE ─────────────────────────────
  --
  -- Counted before the loop, so a batch with the wrong composition writes no
  -- row at all rather than eleven rows and a failure.
  select count(*) filter (where coalesce(d->>'type', 'text') = 'text'),
         count(*) filter (where coalesce(d->>'type', 'text') = 'image')
    into v_text_n, v_image_n
    from jsonb_array_elements(p_drafts) d;

  if v_text_n <> 8 or v_image_n <> 4 then
    raise exception 'CUSTOMER_REVIEW_TEST_BAD_BATCH: a batch is 8 text and 4 image reviews; this one is % text and % image', v_text_n, v_image_n
      using errcode = '23514';
  end if;

  insert into public.customer_review_draft_batches
    (generated_by, guidance, model, card_count, expected_count, request_key)
  values (p_actor_id, p_guidance, p_model, 12, 12, p_request_key)
  returning id into v_batch_id;

  -- References continue from the highest RW- already used, so a reference is
  -- never reused even after cards are deleted, and stays stable once assigned.
  select coalesce(max(substring(card_ref from 4)::integer), 0)
    into v_next
    from public.customer_review_test_cards
   where card_ref ~ '^RW-[0-9]{6}$';

  for v_item in select * from jsonb_array_elements(p_drafts)
  loop
    v_title := btrim(coalesce(v_item->>'title', ''));
    v_body  := btrim(coalesce(v_item->>'body', ''));
    v_type  := coalesce(v_item->>'type', 'text');

    if v_title = '' or v_body = '' then
      raise exception 'CUSTOMER_REVIEW_TEST_BAD_BATCH: a draft has an empty title or body'
        using errcode = '23514';
    end if;

    -- THE DATABASE REFUSES A CONTACT DETAIL TOO, rather than trusting that the
    -- route checked. Title as well as body: a title is displayed on the card.
    if public.customer_review_contains_phone(v_title)
    or public.customer_review_contains_phone(v_body) then
      raise exception 'CUSTOMER_REVIEW_TEST_BAD_BATCH: a draft contains a telephone number'
        using errcode = '23514';
    end if;

    v_next := v_next + 1;

    -- pending_approval, NOT available. This one word is the whole of the
    -- workflow's safety property: a model's output is never a thing a candidate
    -- can pick up.
    insert into public.customer_review_test_cards
      (card_ref, test_category, test_title, test_body, batch_id, status, review_type)
    values ('RW-' || lpad(v_next::text, 6, '0'),
            coalesce(v_item->>'category', 'service_test')::text,
            v_title, v_body, v_batch_id, 'pending_approval', v_type);

    insert into public.customer_review_test_card_events
      (card_id, event_type, previous_status, new_status, detail, actor_id)
    select c.id, 'generated', null, 'pending_approval',
           case when v_type = 'image'
                then 'Image review drafted from batch guidance. Awaiting approval.'
                else 'Text review drafted from batch guidance. Awaiting approval.' end,
           p_actor_id
      from public.customer_review_test_cards c
     where c.card_ref = 'RW-' || lpad(v_next::text, 6, '0');
  end loop;

  return v_batch_id;
end;
$$;

comment on function public.create_customer_review_draft_batch(text, text, jsonb, uuid, uuid) is
  'Creates one batch of exactly twelve pending drafts — EIGHT text and FOUR image, counted here rather than trusted from the caller — atomically, keyed by request_key so a repeated request returns the batch that already exists. Requires the resolved verify permission.';

revoke execute on function public.create_customer_review_draft_batch(text, text, jsonb, uuid, uuid) from public, anon, authenticated;
grant  execute on function public.create_customer_review_draft_batch(text, text, jsonb, uuid, uuid) to service_role;

-- ═══ 5. CORRECTING THE TYPE, WHILE IT IS STILL A DRAFT ═════════════════════
--
-- THE SAME WINDOW AS EDITING THE WORDS, and for a stronger reason. Once a
-- review is approved and assigned, a candidate may have read it, booked it or
-- posted it — and the type decides what they were asked to do AND what they are
-- paid. Changing it afterwards would rewrite the price of work already done.
-- There is no safe path for that, so this function refuses rather than
-- inventing a weaker one.

create or replace function public.set_customer_review_draft_type(
  p_card_id     uuid,
  p_review_type text
)
returns public.customer_review_test_cards
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c     public.customer_review_test_cards%rowtype;
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED: Sign in to continue' using errcode = '42501';
  end if;

  if p_review_type is null or p_review_type not in ('text', 'image') then
    raise exception 'CUSTOMER_REVIEW_TEST_BAD_TYPE: A review is either a text review or an image review'
      using errcode = '23514';
  end if;

  select * into c from public.customer_review_test_cards where id = p_card_id for update;
  if not found then
    raise exception 'CUSTOMER_REVIEW_TEST_NOT_FOUND: That review no longer exists' using errcode = 'P0002';
  end if;

  if c.deleted_at is not null then
    raise exception 'CUSTOMER_REVIEW_TEST_DELETED: A verifier deleted this review, so it can no longer be changed'
      using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.users u
     where u.id = v_uid
       and u.is_active
       and public.resolve_permission(v_uid, 'customer_review_requests', 'verify')
  ) then
    raise exception 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED: Changing a review type needs the Verify permission'
      using errcode = '42501';
  end if;

  if c.status <> 'pending_approval' then
    raise exception 'CUSTOMER_REVIEW_TEST_LOCKED: This review has been approved; its type can no longer be changed'
      using errcode = '42501';
  end if;

  if c.review_type = p_review_type then
    return c;
  end if;

  update public.customer_review_test_cards
     set review_type    = p_review_type,
         -- A review that stops being an image review keeps no group. The CHECK
         -- would refuse the row otherwise, and clearing it here is what makes
         -- the correction expressible rather than an error a verifier has to
         -- decode.
         image_group_id = case when p_review_type = 'image' then image_group_id else null end,
         updated_at     = now()
   where id = p_card_id
  returning * into c;

  insert into public.customer_review_test_card_events
    (card_id, event_type, previous_status, new_status, detail, actor_id)
  values (p_card_id, 'draft_edited', null, null,
          case when p_review_type = 'image'
               then 'Corrected to an image review before approval.'
               else 'Corrected to a text review before approval.' end,
          v_uid);

  return c;
end;
$$;

revoke execute on function public.set_customer_review_draft_type(uuid, text) from public, anon;
grant  execute on function public.set_customer_review_draft_type(uuid, text) to authenticated;

comment on function public.set_customer_review_draft_type(uuid, text) is
  'Corrects one draft between text and image while it is still pending_approval, and never afterwards. Requires the resolved verify permission. Clearing the type to text clears the project group with it.';

-- ═══ 6. THE TRAIL LEARNS TWO MORE WORDS ════════════════════════════════════

alter table public.customer_review_test_card_events
  drop constraint if exists customer_review_test_card_events_event_type_check;

alter table public.customer_review_test_card_events
  add constraint customer_review_test_card_events_event_type_check
  check (event_type in (
    'generated',
    'revised',
    'draft_edited',
    'approved',
    'assigned',            -- a verifier gave this review to one employee
    'image_group_set',     -- a project image group was attached to it
    'booked',
    'unbooked',
    'whatsapp_opened',
    'sent_confirmed',
    'submitted',
    'verified',
    'returned',
    'screenshot_removed',
    'image_removed',
    'deleted',
    'replaced'
  ));

-- Both join the arm for events that MERELY HAPPENED. Assigning a review does
-- not move it — it stays `available` until the candidate books it — so naming a
-- status either side would be inventing one.
alter table public.customer_review_test_card_events
  drop constraint if exists customer_review_test_events_status_matches_type;

alter table public.customer_review_test_card_events
  add constraint customer_review_test_events_status_matches_type
  check (
    (event_type in ('generated', 'approved', 'booked', 'unbooked',
                    'submitted', 'verified', 'returned')
     and new_status is not null)
    or (event_type in ('revised', 'draft_edited', 'whatsapp_opened',
                       'sent_confirmed', 'screenshot_removed', 'image_removed',
                       'assigned', 'image_group_set')
        and new_status is null and previous_status is null)
    or (event_type in ('deleted', 'replaced')
        and previous_status is not null and new_status is null)
  );

-- ═══ 7. CHOOSING A PROJECT GROUP ═══════════════════════════════════════════
--
-- LEAST RECENTLY USED, THEN RANDOM, AND NOTHING CLEVERER.
--
-- "Least recently used" is read from the reviews themselves — the latest
-- assigned_at among the reviews pointing at a group — so there is no counter to
-- keep in step with reality and no column that can drift. A group nothing has
-- ever used sorts first, which is what makes a newly added project get used.
-- Ties break randomly, so two batches assigned in the same second do not both
-- take the same four.
--
-- ONLY GROUPS THAT ARE READY ARE OFFERED. A group with no live images would
-- produce an image review that is assigned and still not ready, which is the
-- state this selection exists to avoid rather than create.
--
-- IT RETURNS WHAT IT HAS, WHICH MAY BE FEWER THAN ASKED FOR. Three ready groups
-- and four image reviews means three get a group and one waits for images —
-- deliberately, because inventing a fourth by reusing one would put the same
-- project in two of one employee's four posts.
create or replace function public.pick_customer_review_image_groups(p_wanted integer)
returns uuid[]
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(array_agg(g.id order by g.rn), '{}'::uuid[])
    from (
      select gr.id,
             row_number() over (
               order by (
                 select max(c.assigned_at)
                   from public.customer_review_test_cards c
                  where c.image_group_id = gr.id
               ) asc nulls first,
               random()
             ) as rn
        from public.customer_review_image_groups gr
       where gr.archived_at is null
         and exists (
           select 1 from public.customer_review_group_images i
            where i.group_id = gr.id and i.removal_started_at is null
         )
    ) g
   where g.rn <= greatest(coalesce(p_wanted, 0), 0);
$$;

revoke execute on function public.pick_customer_review_image_groups(integer)
  from public, anon, authenticated;

comment on function public.pick_customer_review_image_groups(integer) is
  'Internal helper. Up to p_wanted DISTINCT ready project groups — not archived, at least one live image — least-recently-used first, ties random. Granted to nobody; the assignment functions call it as the definer.';

-- ═══ 8. ASSIGNING A BATCH ══════════════════════════════════════════════════
--
-- ONE BATCH, ONE EMPLOYEE, ALL TWELVE, ATOMICALLY.
--
-- THE SET IS CHOSEN INSIDE THE TRANSACTION, under a row lock, rather than sent
-- by the browser. "Assign this batch" therefore means the twelve reviews that
-- are in it now, not the twelve a page saw five minutes ago — the same property
-- approve_customer_review_draft_batch() has and for the same reason.
--
-- IT REFUSES A PARTIAL BATCH. Every live review in the batch must be
-- `available` and unassigned. A batch where somebody has already deleted three
-- is not a twelve-review batch, and assigning nine of them under a name that
-- promises twelve would be the wrong kind of helpful.
--
-- THE EMPLOYEE MUST BE ABLE TO DO THE WORK. Active, and resolving `use`.
-- Assigning to somebody without the permission produces reviews nobody can see
-- and nobody can book — silently, until a person asks why their list is empty.
--
-- p_employee_id IS A TARGET, NOT AN ACTOR. The actor is auth.uid(), as
-- everywhere else in this module; the employee is who the work is for. That
-- distinction is the reason this function can safely take a user id at all.
create or replace function public.assign_customer_review_batch(
  p_batch_id    uuid,
  p_employee_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid       uuid := auth.uid();
  v_ids       uuid[];
  v_n         integer;
  v_bad       text;
  v_assigned  integer;
  v_image_ids uuid[];
  v_groups    uuid[];
  v_i         integer;
  v_with      integer := 0;
  v_now       timestamptz := now();
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
    raise exception 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED: Assigning a batch needs the Verify permission'
      using errcode = '42501';
  end if;

  if p_employee_id is null then
    raise exception 'CUSTOMER_REVIEW_TEST_BAD_ASSIGNMENT: Choose the employee this batch is for'
      using errcode = '23514';
  end if;

  if not exists (
    select 1 from public.users u
     where u.id = p_employee_id
       and u.is_active
       and coalesce(u.is_deleted, false) = false
       and public.resolve_permission(p_employee_id, 'customer_review_requests', 'use')
  ) then
    raise exception 'CUSTOMER_REVIEW_TEST_BAD_ASSIGNMENT: That employee cannot use the Review Workflow, so a batch assigned to them would be invisible'
      using errcode = '23514';
  end if;

  -- Lock every live review in the batch, in id order so two verifiers assigning
  -- overlapping work queue rather than deadlock.
  select array_agg(c.id order by c.id) into v_ids
    from (
      select id from public.customer_review_test_cards
       where batch_id = p_batch_id
         and deleted_at is null
       order by id
         for update
    ) c;

  v_n := coalesce(array_length(v_ids, 1), 0);
  if v_n = 0 then
    raise exception 'CUSTOMER_REVIEW_TEST_NOT_FOUND: That batch has no reviews left to assign'
      using errcode = 'P0002';
  end if;
  if v_n <> 12 then
    raise exception 'CUSTOMER_REVIEW_TEST_BAD_ASSIGNMENT: A batch is assigned whole; this one holds % of its twelve reviews', v_n
      using errcode = '23514';
  end if;

  -- RECHECKED AFTER THE LOCK, which is the only place a check means anything.
  select string_agg(card_ref, ', ' order by card_ref) into v_bad
    from public.customer_review_test_cards
   where id = any(v_ids)
     and (status <> 'available' or assigned_to is not null);

  if v_bad is not null then
    raise exception 'CUSTOMER_REVIEW_TEST_BAD_ASSIGNMENT: % is not an unassigned approved review; nothing was assigned', v_bad
      using errcode = '23514';
  end if;

  update public.customer_review_test_cards
     set assigned_to = p_employee_id,
         assigned_at = v_now,
         assigned_by = v_uid,
         updated_at  = v_now
   where id = any(v_ids);

  get diagnostics v_assigned = row_count;

  insert into public.customer_review_test_card_events
    (card_id, event_type, previous_status, new_status, detail, actor_id)
  select unnest(v_ids), 'assigned', null, null,
         'Assigned to one employee with the rest of the batch.', v_uid;

  -- ── The four image reviews get four different projects ───────────────────
  --
  -- Ordered by card_ref so the pairing is stable and reproducible rather than
  -- whatever order the planner felt like.
  select array_agg(c.id order by c.card_ref) into v_image_ids
    from public.customer_review_test_cards c
   where c.id = any(v_ids) and c.review_type = 'image';

  if coalesce(array_length(v_image_ids, 1), 0) > 0 then
    v_groups := public.pick_customer_review_image_groups(array_length(v_image_ids, 1));

    for v_i in 1 .. array_length(v_image_ids, 1) loop
      exit when v_i > coalesce(array_length(v_groups, 1), 0);

      update public.customer_review_test_cards
         set image_group_id = v_groups[v_i],
             updated_at     = v_now
       where id = v_image_ids[v_i];

      insert into public.customer_review_test_card_events
        (card_id, event_type, previous_status, new_status, detail, actor_id)
      select v_image_ids[v_i], 'image_group_set', null, null,
             'Project images attached: ' || g.label, v_uid
        from public.customer_review_image_groups g
       where g.id = v_groups[v_i];

      v_with := v_with + 1;
    end loop;
  end if;

  return jsonb_build_object(
    'assigned',        v_assigned,
    'image_reviews',   coalesce(array_length(v_image_ids, 1), 0),
    -- HOW MANY ARE STILL WAITING FOR IMAGES, so the verifier is told at the
    -- moment they assign rather than finding out from a candidate.
    'with_images',     v_with,
    'awaiting_images', coalesce(array_length(v_image_ids, 1), 0) - v_with
  );
end;
$$;

revoke execute on function public.assign_customer_review_batch(uuid, uuid) from public, anon;
grant  execute on function public.assign_customer_review_batch(uuid, uuid) to authenticated;

comment on function public.assign_customer_review_batch(uuid, uuid) is
  'Assigns one whole batch of twelve approved reviews to one employee, and gives its four image reviews up to four DIFFERENT ready project groups, atomically. The set is locked and rechecked inside the transaction. Actor is auth.uid(); the employee is a target and must resolve `use`.';

-- ── Attaching a project group afterwards ────────────────────────────────────
--
-- The path for an image review that was assigned before its project was ready.
-- Setting a group is what makes it READY; there is no separate flag to raise
-- and nothing else to remember.
--
-- IT DOES NOT MOVE A REVIEW A CANDIDATE IS ALREADY WORKING ON. Once a review is
-- booked, the photographs are what the candidate was told to post, so the group
-- is only settable while the review is still `available`.
create or replace function public.set_customer_review_image_group(
  p_card_id  uuid,
  p_group_id uuid
)
returns public.customer_review_test_cards
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c     public.customer_review_test_cards%rowtype;
  v_uid uuid := auth.uid();
  v_lab text;
begin
  if v_uid is null then
    raise exception 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED: Sign in to continue' using errcode = '42501';
  end if;

  select * into c from public.customer_review_test_cards where id = p_card_id for update;
  if not found then
    raise exception 'CUSTOMER_REVIEW_TEST_NOT_FOUND: That review no longer exists' using errcode = 'P0002';
  end if;

  if c.deleted_at is not null then
    raise exception 'CUSTOMER_REVIEW_TEST_DELETED: A verifier deleted this review, so it can no longer be changed'
      using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.users u
     where u.id = v_uid
       and u.is_active
       and public.resolve_permission(v_uid, 'customer_review_requests', 'verify')
  ) then
    raise exception 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED: Attaching project images needs the Verify permission'
      using errcode = '42501';
  end if;

  if c.review_type <> 'image' then
    raise exception 'CUSTOMER_REVIEW_TEST_BAD_TYPE: Only an image review posts project photographs'
      using errcode = '23514';
  end if;

  if c.status not in ('pending_approval', 'available') then
    raise exception 'CUSTOMER_REVIEW_TEST_LOCKED: A candidate has already picked this review up, so its project can no longer be changed'
      using errcode = '42501';
  end if;

  select g.label into v_lab
    from public.customer_review_image_groups g
   where g.id = p_group_id
     and exists (
       select 1 from public.customer_review_group_images i
        where i.group_id = g.id and i.removal_started_at is null
     );

  if v_lab is null then
    raise exception 'CUSTOMER_REVIEW_GROUP_NOT_READY: That project group does not exist or has no images yet'
      using errcode = '23514';
  end if;

  update public.customer_review_test_cards
     set image_group_id = p_group_id,
         updated_at     = now()
   where id = p_card_id
  returning * into c;

  insert into public.customer_review_test_card_events
    (card_id, event_type, previous_status, new_status, detail, actor_id)
  values (p_card_id, 'image_group_set', null, null,
          'Project images attached: ' || v_lab, v_uid);

  return c;
end;
$$;

revoke execute on function public.set_customer_review_image_group(uuid, uuid) from public, anon;
grant  execute on function public.set_customer_review_image_group(uuid, uuid) to authenticated;

comment on function public.set_customer_review_image_group(uuid, uuid) is
  'Attaches one ready project image group to one image review, which is what makes it Ready. Verify permission; refused once a candidate has booked the review. The group must exist and hold at least one live image.';

-- ═══ 9. THE POOL STOPS EXISTING ════════════════════════════════════════════
--
-- THE ONE CHANGE THAT MATTERS MOST IN THIS FILE, and it is four words long: the
-- available branch now asks about `assigned_to` instead of about module entry.
--
-- Before, an approved unbooked review was readable by EVERY `use` holder — that
-- is what a company-wide pool is. Now it is readable by the person it was
-- assigned to, and by a verifier. A candidate cannot see another employee's
-- assigned reviews through the page, through PostgREST, through a hand-written
-- query or by typing an id, because none of those routes goes anywhere but
-- through this policy.
--
-- can_view_customer_review_test_card_row() IS REUSED RATHER THAN COPIED. It
-- already answers "is this value me, or do I resolve verify", takes its argument
-- as a VALUE so it never re-reads the table being guarded, and reads public.users
-- with definer rights. Passing it assigned_to asks exactly the right question.
--
-- THE CONSEQUENCE, SAID PLAINLY: an approved review with no assignee is visible
-- to verifiers only. There is one such row in production today. It is not lost
-- and nothing about it changed — it is waiting to be assigned, which is now the
-- only way a review reaches a candidate.
drop policy if exists "customer_review_test_cards_select" on public.customer_review_test_cards;

create policy "customer_review_test_cards_select" on public.customer_review_test_cards
  for select to authenticated
  using (
    (
      customer_review_test_cards.status = 'available'
      and customer_review_test_cards.deleted_at is null
      and customer_review_test_cards.assigned_to is not null
      and public.can_view_customer_review_test_card_row(customer_review_test_cards.assigned_to)
    )
    or (
      customer_review_test_cards.deleted_at is null
      and public.can_view_customer_review_test_card_row(customer_review_test_cards.booked_by)
    )
    or (
      customer_review_test_cards.deleted_at is not null
      and public.can_verify_customer_review_test_cards()
    )
  );

-- The card-id predicate says the same thing, for the child tables and the
-- screenshot bucket that resolve a card by id.
--
-- STRUCTURALLY IDENTICAL TO 20261030000000, AND DELIBERATELY SO. Exactly one
-- clause differs: the pool branch — `c.status = 'available' and
-- resolve_permission(use)` — gains `and c.assigned_to = auth.uid()`. Every
-- other line, and above all the SHAPE of the disjunction, is carried forward.
--
-- WHY THE SHAPE MATTERS, and it is the whole reason this comment is here. The
-- verify branch sits OUTSIDE the `deleted_at is null` guard, so a verifier
-- reads a card whether it is live or a tombstone; everybody else reads live
-- rows only. That is 20261030000000's explicit decision, and it is what keeps a
-- deleted review's SCREENSHOTS and its ACTIVITY TRAIL readable to the people the
-- audit record exists for — the three policies that resolve a card by id
-- (customer_review_test_screenshots_select, customer_review_test_events_select
-- and the storage SELECT policy) all defer to this function.
--
-- An earlier draft of this migration hoisted `and c.deleted_at is null` to the
-- top of the WHERE clause, which reads tidier and quietly revoked exactly that:
-- the card row stayed readable through the policy's own verify-only branch, but
-- its evidence and its trail became invisible to everyone. Nothing in this
-- work needed that, and an audit record you cannot open is not an audit record.
create or replace function public.can_view_customer_review_test_card(
  p_card_id uuid
)
returns boolean
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select auth.uid() is not null and exists (
    select 1
    from public.customer_review_test_cards c
    join public.users u on u.id = auth.uid() and u.is_active
    where c.id = p_card_id
      and (
        -- A VERIFIER READS IT WHETHER IT IS LIVE OR A TOMBSTONE. Everybody
        -- else reads live rows only.
        public.resolve_permission(auth.uid(), 'customer_review_requests', 'verify')
        or (
          c.deleted_at is null
          and (
            c.booked_by = auth.uid()
            or (
              -- AN UNBOOKED REVIEW BELONGS TO THE PERSON IT WAS ASSIGNED TO,
              -- and to nobody else. THE ONE CLAUSE THIS FILE CHANGES: it read
              -- `c.status = 'available' and resolve_permission(use)`, which is
              -- what made every approved review readable by every `use` holder.
              c.status = 'available'
              and c.assigned_to = auth.uid()
              and public.resolve_permission(auth.uid(), 'customer_review_requests', 'use')
            )
          )
        )
      )
  );
$$;

revoke execute on function public.can_view_customer_review_test_card(uuid) from public, anon;
grant  execute on function public.can_view_customer_review_test_card(uuid) to authenticated;

comment on function public.can_view_customer_review_test_card(uuid) is
  'May this caller see one review, named by id? A verifier, live or tombstoned, because the audit record exists for them; otherwise a LIVE review''s holder, or — while it is unbooked — the employee it was ASSIGNED to. Used by the child tables and the screenshot bucket, which resolve a card by id.';

-- ═══ 10. BOOKING, WITHIN WHAT YOU WERE GIVEN ═══════════════════════════════
--
-- Identical to 20261030000000's definition except for the two clauses on the
-- conditional UPDATE, and both are inside it rather than checked beforehand.
-- That is the point: a read-then-write would let two requests both decide a
-- review was bookable. `and assigned_to = v_uid` in the UPDATE means the
-- database refuses somebody else's review however stale the browser is.
--
-- AND AN IMAGE REVIEW WITH NO PROJECT CANNOT BE BOOKED. The `not exists`
-- clause is the whole of "Waiting for admin images" as an enforced rule: the
-- screen greys the button, and this is what would refuse the request anyway.
create or replace function public.book_customer_review_test_card(p_card_id uuid)
returns public.customer_review_test_cards
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c     public.customer_review_test_cards%rowtype;
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED: Sign in to continue' using errcode = '42501';
  end if;

  -- ACTIVE, and holding `use`. `verify` alone is NOT enough to book: a verifier
  -- checks other people's reviews, and letting the checker also be the tester
  -- would remove the only separation the workflow has. There is no role bypass.
  if not exists (
    select 1 from public.users u
    where u.id = v_uid
      and u.is_active
      and public.resolve_permission(v_uid, 'customer_review_requests', 'use')
  ) then
    raise exception 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED: You do not have permission to book a review'
      using errcode = '42501';
  end if;

  update public.customer_review_test_cards c2
     set status    = 'booked',
         booked_by = v_uid,
         booked_at = now()
   where c2.id = p_card_id
     and c2.status = 'available'
     and c2.deleted_at is null
     -- YOURS, AND NOBODY ELSE'S.
     and c2.assigned_to = v_uid
     -- AND READY, if it is an image review. READY IS THREE THINGS, and all
     -- three are conditions on this UPDATE rather than a prior read: the review
     -- names a group, that group is NOT ARCHIVED, and it holds at least one
     -- live image.
     --
     -- ARCHIVED COUNTS AS NOT READY, and that is a decision rather than an
     -- oversight. Archiving a project says "we are not posting about this any
     -- more"; a review still pointing at it should not go out. The consequence
     -- is that archiving a group STRANDS any assigned-but-unbooked review using
     -- it — recoverable, because set_customer_review_image_group() may attach a
     -- different group while the review is still `available`, and invisible to
     -- an already-booked candidate, whose review is past this gate.
     and (
       c2.review_type <> 'image'
       or (
         c2.image_group_id is not null
         and exists (
           select 1
             from public.customer_review_group_images i
             join public.customer_review_image_groups g on g.id = i.group_id
            where i.group_id = c2.image_group_id
              and i.removal_started_at is null
              and g.archived_at is null
         )
       )
     )
  returning * into c;

  if not found then
    -- FOUR DIFFERENT FACTS, AND THE CANDIDATE NEEDS TO TELL THEM APART. None of
    -- the answers names another employee.
    select * into c from public.customer_review_test_cards where id = p_card_id;
    if not found or c.deleted_at is not null then
      raise exception 'CUSTOMER_REVIEW_TEST_NOT_FOUND: That review no longer exists'
        using errcode = 'P0002';
    end if;
    if c.assigned_to is distinct from v_uid then
      raise exception 'CUSTOMER_REVIEW_TEST_NOT_YOURS: That review is not assigned to you'
        using errcode = '42501';
    end if;
    if c.review_type = 'image' and (
      c.image_group_id is null
      or not exists (
        select 1
          from public.customer_review_group_images i
          join public.customer_review_image_groups g on g.id = i.group_id
         where i.group_id = c.image_group_id
           and i.removal_started_at is null
           and g.archived_at is null
      )
    ) then
      raise exception 'CUSTOMER_REVIEW_TEST_AWAITING_IMAGES: This image review is waiting for its project images'
        using errcode = '23514';
    end if;
    raise exception 'CUSTOMER_REVIEW_TEST_ALREADY_BOOKED: That review has already been booked'
      using errcode = '23514';
  end if;

  insert into public.customer_review_test_card_events
    (card_id, event_type, previous_status, new_status, detail, actor_id)
  values
    (p_card_id, 'booked', 'available', 'booked', 'Review booked.', v_uid);

  return c;
end;
$$;

revoke execute on function public.book_customer_review_test_card(uuid) from public, anon;
grant  execute on function public.book_customer_review_test_card(uuid) to authenticated;

comment on function public.book_customer_review_test_card(uuid) is
  'Books one review the caller was ASSIGNED. Requires the resolved use permission; the assignment, the availability and — for an image review — the project images are all conditions on the same conditional UPDATE, so a stale or forged request is refused by the write rather than by a prior read.';

-- ═══ 11. A SECOND REWARD, BESIDE THE ONE THAT ALREADY EXISTS ═══════════════
--
-- THE SAFEST SHAPE, AND IT IS WORTH SAYING WHY IT IS THIS ONE.
--
-- The obvious move is to rename review_reward_credits to text_review_reward_
-- credits and add image_review_reward_credits beside it. It is the wrong move
-- three times over:
--
--   1. boe_credit_settings is APPEND-ONLY and every row is an audit record of
--      what somebody chose. Renaming a column rewrites the meaning of every
--      historical row, silently.
--   2. Six readers in the application select the column by name, and a rename
--      is a deployment window in which the old build reads a column that no
--      longer exists.
--   3. The requirement is that the CURRENT review reward becomes the TEXT
--      reward. Keeping the column is that requirement stated in the schema
--      rather than performed by an UPDATE.
--
-- So review_reward_credits stays, keeps its value, and IS the text reward. One
-- column is added. Nothing is renamed, nothing is copied and no row is rewritten.

alter table public.boe_credit_settings
  add column if not exists image_review_reward_credits integer not null default 1
    check (image_review_reward_credits > 0 and image_review_reward_credits <= 100000);

comment on column public.boe_credit_settings.review_reward_credits is
  'Credits ONE verified TEXT review earns. The column keeps its original name because it keeps its original meaning and its history: before review types existed every review was a text review, and this was its reward. Read at verification time; a later change never re-prices a reward already posted.';

comment on column public.boe_credit_settings.image_review_reward_credits is
  'Credits ONE verified IMAGE review earns. Independent of the text reward — never derived from it. Read at verification time from the newest settings row, chosen by the review''s own stored review_type.';

comment on table public.boe_credit_settings is
  'BOE Credits settings. Append-only: the newest row is active and every earlier row is the history. review_reward_credits / image_review_reward_credits = credits per verified text / image review; credit_value = rupees per credit for a payroll application; half_day_redemption_credits / full_day_redemption_credits = what an attendance day costs; minimum_monthly_reviews = verified reviews a month needs before its rewards become spendable. Every change applies to future actions only. Never UPDATE or DELETE — save a new row.';

-- The first row that names both rewards, once. It carries the CURRENT active
-- values forward unchanged and adds the image reward beside them, so applying
-- this file changes no price that is already in force. Skipped when the newest
-- row already says exactly that, so re-running adds nothing.
do $$
declare
  v_newest public.boe_credit_settings%rowtype;
begin
  select * into v_newest from public.boe_credit_settings order by created_at desc limit 1;
  if not found then
    insert into public.boe_credit_settings (
      review_reward_credits, image_review_reward_credits, credit_value,
      half_day_redemption_credits, full_day_redemption_credits, minimum_monthly_reviews,
      created_by, note
    ) values (1, 1, 100.00, 8, 15, 3, null, 'BOE Credits defaults with review types');
  elsif v_newest.image_review_reward_credits is distinct from 1
     or v_newest.note is distinct from 'Review types: text and image rewards' then
    insert into public.boe_credit_settings (
      review_reward_credits, image_review_reward_credits, credit_value,
      half_day_redemption_credits, full_day_redemption_credits, minimum_monthly_reviews,
      created_by, note
    ) values (
      v_newest.review_reward_credits,
      1,
      v_newest.credit_value,
      v_newest.half_day_redemption_credits,
      v_newest.full_day_redemption_credits,
      v_newest.minimum_monthly_reviews,
      null,
      'Review types: text and image rewards'
    );
  end if;
end $$;

-- ═══ 12. THE REWARD, PRICED BY THE REVIEW'S OWN TYPE ═══════════════════════
--
-- Byte-for-byte 20261104000000 § 8 except that the amount is chosen from
-- p_review_type instead of being one column.
--
-- p_review_type IS NOT A CLIENT PARAMETER. This function is service-role only
-- and its single caller is the verify transition, which passes c.review_type
-- read off the row it has already locked. A browser cannot reach this function
-- and cannot influence the value the transition passes — which is the whole of
-- "a wrong review type cannot be supplied from a browser to manipulate
-- credits", enforced by the shape of the call rather than by validation.
--
-- The old five-argument signature is dropped: leaving it would leave a second,
-- unpriced way to post a review reward.

drop function if exists public.post_boe_credit_review_reward(uuid, uuid, text, timestamptz, uuid);

create or replace function public.post_boe_credit_review_reward(
  p_employee_id  uuid,
  p_card_id      uuid,
  p_card_ref     text,
  p_review_type  text,
  p_submitted_at timestamptz,
  p_actor_id     uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_settings public.boe_credit_settings%rowtype;
  v_month    date;
  v_row      public.boe_credit_review_months%rowtype;
  v_tx       uuid;
  v_credits  integer;
begin
  if p_card_id is null or nullif(btrim(coalesce(p_card_ref, '')), '') is null then
    raise exception 'BOE_CREDITS_SOURCE: a review reward must name the review it is for'
      using errcode = '22023';
  end if;
  if p_submitted_at is null then
    raise exception 'BOE_CREDITS_REVIEW_MONTH: the review has no submission to attribute its credit to'
      using errcode = '22023';
  end if;
  -- THE TYPE DECIDES THE PRICE, so an unrecognised one is refused rather than
  -- defaulted. A default here would be a silent mispricing.
  if p_review_type is null or p_review_type not in ('text', 'image') then
    raise exception 'BOE_CREDITS_REVIEW_TYPE: a review reward must name a known review type'
      using errcode = '22023';
  end if;

  select * into v_settings from public.boe_credit_settings order by created_at desc limit 1;
  if not found then
    raise exception 'BOE_CREDITS_SETTINGS: no active credit settings row'
      using errcode = 'P0002';
  end if;

  v_credits := case p_review_type
    when 'image' then v_settings.image_review_reward_credits
    else v_settings.review_reward_credits
  end;

  -- THE REVIEW MONTH: the Asia/Kolkata calendar month of the successful submission.
  v_month := date_trunc('month', (p_submitted_at at time zone 'Asia/Kolkata')::date)::date;

  perform pg_advisory_xact_lock(hashtext('boe_credits'), hashtext(p_employee_id::text));

  v_tx := public.post_boe_credit_transaction(
    p_employee_id,
    'review_reward',
    v_credits,
    'customer_review',
    p_card_id,
    'Review verified · ' || p_card_ref,
    p_actor_id
  );

  insert into public.boe_credit_review_months (employee_id, review_month, minimum_reviews_snapshot)
  values (p_employee_id, v_month, v_settings.minimum_monthly_reviews)
  on conflict (employee_id, review_month) do nothing;

  select * into v_row from public.boe_credit_review_months
   where employee_id = p_employee_id and review_month = v_month;

  insert into public.boe_credit_review_rewards (
    transaction_id, employee_id, card_id, card_ref, submitted_at, review_month, review_month_id
  ) values (
    v_tx, p_employee_id, p_card_id, p_card_ref, p_submitted_at, v_month, v_row.id
  );

  v_row := public.refresh_boe_credit_review_month(p_employee_id, v_month);

  return jsonb_build_object(
    'transaction_id',          v_tx,
    'credits',                 v_credits,
    'review_type',             p_review_type,
    'review_month',            v_month,
    'month_status',            v_row.status,
    'qualifying_review_count', v_row.qualifying_review_count,
    'minimum_reviews',         v_row.minimum_reviews_snapshot,
    'provisional',             v_row.status = 'open'
  );
end;
$$;

revoke execute on function public.post_boe_credit_review_reward(uuid, uuid, text, text, timestamptz, uuid)
  from public, anon, authenticated;
grant  execute on function public.post_boe_credit_review_reward(uuid, uuid, text, text, timestamptz, uuid)
  to service_role;

comment on function public.post_boe_credit_review_reward(uuid, uuid, text, text, timestamptz, uuid) is
  'SERVICE ROLE ONLY (called by the verify transition as its owner). Posts one review_reward for the active reward OF THE REVIEW''S OWN TYPE — review_reward_credits for text, image_review_reward_credits for image — attributes it to the Asia/Kolkata month of the successful submission, snapshots the monthly minimum on first use of that month, and qualifies the month when the count reaches the minimum. Under the per-employee lock.';

-- ═══ 13. THE VERIFY TRANSITION, RE-CREATED ═════════════════════════════════
--
-- Byte-for-byte 20261104000000 § 10 except the reward branch, which now passes
-- c.review_type — read off the row LOCKED at the top of this function, never
-- from a parameter. transition_customer_review_test_card() still takes exactly
-- three arguments and still accepts no field map, so there is nothing a browser
-- could send that would change which reward is posted.

drop function if exists public.transition_customer_review_test_card(uuid, text, text);

create or replace function public.transition_customer_review_test_card(
  p_card_id     uuid,
  p_next_status text,
  p_detail      text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c             public.customer_review_test_cards%rowtype;
  v_uid         uuid := auth.uid();
  v_use         boolean;
  v_verify      boolean;
  v_holder      boolean;
  v_legal       boolean;
  v_detail      text := nullif(btrim(coalesce(p_detail, '')), '');
  v_reward      jsonb;
  v_holder_name text;
begin
  if v_uid is null then
    raise exception 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED: Sign in to continue' using errcode = '42501';
  end if;

  -- Locked for the duration, so two clicks cannot both read 'booked' and both
  -- write 'submitted'. The legality guard below then refuses the second.
  select * into c from public.customer_review_test_cards where id = p_card_id for update;
  if not found then
    raise exception 'CUSTOMER_REVIEW_TEST_NOT_FOUND: That test card no longer exists' using errcode = 'P0002';
  end if;

  -- REFUSED BEFORE ANY OTHER JUDGEMENT. Submitting, verifying and returning are
  -- all workflow actions, and a deleted review has left the workflow. A
  -- verifier can still READ the tombstone; they cannot move it.
  if c.deleted_at is not null then
    raise exception 'CUSTOMER_REVIEW_TEST_DELETED: A verifier deleted this review, so it can no longer be moved'
      using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.users u where u.id = v_uid and u.is_active
  ) then
    raise exception 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED: Your account is not active' using errcode = '42501';
  end if;

  -- RESOLVED FROM THE PERMISSION ENGINE, NOT FROM THE ROLE.
  v_use    := public.resolve_permission(v_uid, 'customer_review_requests', 'use');
  v_verify := public.resolve_permission(v_uid, 'customer_review_requests', 'verify');
  v_holder := (c.booked_by = v_uid);

  if not (v_use or v_verify) then
    raise exception 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED: You do not have access to this module'
      using errcode = '42501';
  end if;

  -- ── Is the move itself legal? ──
  v_legal := case c.status
    when 'booked'    then p_next_status in ('submitted')
    when 'submitted' then p_next_status in ('verified', 'booked')
    else false
  end;

  if not v_legal then
    raise exception 'CUSTOMER_REVIEW_TEST_BAD_TRANSITION: A % card cannot become %', c.status, p_next_status
      using errcode = '23514';
  end if;

  -- ── Is this person allowed to make it? ──
  if p_next_status in ('verified', 'booked') then
    if not v_verify then
      raise exception 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED: Verifying or returning a test needs the Verify permission'
        using errcode = '42501';
    end if;
  else
    -- SUBMITTING IS A TESTER ACTION: the holder, and nobody else.
    if not (v_holder and v_use) then
      raise exception 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED: Only the tester holding this card can submit it'
        using errcode = '42501';
    end if;
  end if;

  if p_next_status = 'submitted' then
    perform public.assert_customer_review_test_card_submittable(p_card_id);
  end if;

  -- A return has to say why.
  if p_next_status = 'booked' and v_detail is null then
    raise exception 'CUSTOMER_REVIEW_TEST_NOT_READY: Give a short reason when returning a test'
      using errcode = '23514';
  end if;

  -- ── Apply ──
  update public.customer_review_test_cards c2
     set status = p_next_status,

         submitted_at = case when p_next_status = 'submitted' then now()  else c2.submitted_at end,
         submitted_by = case when p_next_status = 'submitted' then v_uid  else c2.submitted_by end,

         verified_at = case when p_next_status = 'verified' then now()  else c2.verified_at end,
         verified_by = case when p_next_status = 'verified' then v_uid  else c2.verified_by end,
         verification_note = case
           when p_next_status = 'verified' then v_detail
           else c2.verification_note
         end,

         returned_at   = case when p_next_status = 'booked' then now()    else c2.returned_at end,
         returned_by   = case when p_next_status = 'booked' then v_uid    else c2.returned_by end,
         return_reason = case when p_next_status = 'booked' then v_detail else c2.return_reason end
   -- NOTHING IS CLEARED ON A RETURN, and that is the choice rather than an
   -- omission. The append-only trail keeps every submission and every return.
   where c2.id = p_card_id;

  insert into public.customer_review_test_card_events
    (card_id, event_type, previous_status, new_status, detail, actor_id)
  values
    (p_card_id,
     case p_next_status when 'submitted' then 'submitted'
                        when 'verified'  then 'verified'
                        else 'returned' end,
     c.status, p_next_status, v_detail, v_uid);

  -- ── BOE Credits: the reward, in the same transaction ──
  --
  -- Reached only on submitted -> verified, which the legality guard above
  -- admits exactly once per card. The recipient is the HOLDER, read from the
  -- locked row; the actor recorded on the ledger row is the verifier, whose
  -- decision this is. THE AMOUNT IS THE ACTIVE SETTING FOR THE REVIEW'S OWN
  -- TYPE — c.review_type comes off the locked row, never from a parameter — and
  -- is never a literal. The credit counts for the month of c.submitted_at.
  if p_next_status = 'verified' then
    if c.booked_by is null then
      raise exception 'CUSTOMER_REVIEW_TEST_NOT_READY: This review has no holder to reward'
        using errcode = '23514';
    end if;
    if c.submitted_at is null then
      raise exception 'CUSTOMER_REVIEW_TEST_NOT_READY: This review has no submission to reward'
        using errcode = '23514';
    end if;

    v_reward := public.post_boe_credit_review_reward(
      c.booked_by,
      p_card_id,
      c.card_ref,
      c.review_type,
      c.submitted_at,
      v_uid
    );

    select u.full_name into v_holder_name from public.users u where u.id = c.booked_by;
  end if;

  select * into c from public.customer_review_test_cards where id = p_card_id;

  return jsonb_build_object(
    'card', to_jsonb(c),
    'reward', case
      when v_reward is null then null
      else v_reward || jsonb_build_object(
        'employee_id',   c.booked_by,
        'employee_name', v_holder_name
      )
    end
  );
end;
$$;

-- The grants, restated verbatim from 20261017000000: a browser-callable
-- function, on the same identity signature the allow-list names.
revoke execute on function public.transition_customer_review_test_card(uuid, text, text) from public, anon;
grant  execute on function public.transition_customer_review_test_card(uuid, text, text) to authenticated;

comment on function public.transition_customer_review_test_card(uuid, text, text) is
  'Moves one review between booked, submitted and verified (or back to booked with a reason). Actor is auth.uid(); use/verify are resolved from the permission engine, never a role. On submitted -> verified it posts exactly one review_reward for the holder (booked_by) through post_boe_credit_review_reward(), priced by the review''s OWN stored review_type, attributed to the month of the submission being verified, in the same transaction, and returns {card, reward}.';


-- ═══ 13A. WHO A BATCH MAY BE ASSIGNED TO ═══════════════════════════════════
--
-- THE ANSWER COMES FROM THE PERMISSION ENGINE, ONCE, RATHER THAN FROM THE
-- BROWSER ASKING ABOUT EVERY EMPLOYEE IN TURN.
--
-- The assignment control needs a list of people who can actually do the work.
-- Building it in the browser would mean one resolve_permission() call per
-- employee, and — worse — a list assembled from `users` filtered by a role,
-- which is exactly the shortcut this module removed everywhere else. This asks
-- the engine for each candidate inside one definer call.
--
-- IT IS VERIFY-GATED, because it is a directory of colleagues. A candidate has
-- no reason to enumerate who else works on reviews, and this module has spent a
-- lot of effort making sure they cannot see other people's work.
--
-- IT RETURNS NAMES AND IDS AND NOTHING ELSE. No email, no role, no department,
-- no permission detail — just enough to draw a picker.
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
grant  execute on function public.customer_review_assignable_employees() to authenticated;

comment on function public.customer_review_assignable_employees() is
  'The employees a batch may be assigned to: active, not deleted, and resolving customer_review_requests.use. Verify-gated, and returns ids and display names only.';


-- ═══ 13B. REPLACE STOPS AT SOMEBODY ELSE'S WORK ════════════════════════════
--
-- A DEFECT THIS FILE WOULD OTHERWISE CREATE, fixed in the same file that
-- creates it.
--
-- customer_review_replace_available() (20261030000000) soft-deletes EVERY live
-- available review when a verifier approves a batch with "Replace". That was
-- harmless while `available` meant "in the pool, belonging to nobody": the
-- reviews it discarded were un-owned drafts, and discarding them is the whole
-- point of Replace.
--
-- Assignment changes what those rows are. An available review is now WORK ONE
-- EMPLOYEE HAS BEEN GIVEN AND HAS NOT PICKED UP YET, and there is no reading of
-- "replace the list" under which a verifier approving a new batch should
-- silently destroy four other people's outstanding reviews — including,
-- because an unbooked review is still assigned, everything an employee had left
-- to do.
--
-- SO REPLACE NOW MEANS WHAT IT ALWAYS MEANT: clear the reviews that belong to
-- nobody. One clause, `and assigned_to is null`. An assigned review is removed
-- only by an action that names it — a single deletion, a selection, or Delete
-- all — each of which a verifier chooses deliberately and each of which already
-- says what it is about to do.
--
-- Everything else in the body is carried forward from 20261030000000 unchanged:
-- the row lock in id order, the event written BEFORE the update (the freeze
-- trigger refuses an UPDATE of an already-deleted row), the tombstone naming
-- the batch that displaced it, and the grant to nobody at all.

create or replace function public.customer_review_replace_available(
  p_actor_id uuid,
  p_batch_id uuid
)
returns integer
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_ids uuid[];
  v_n   integer;
begin
  select array_agg(c.id order by c.id) into v_ids
    from (
      select id from public.customer_review_test_cards
       where status = 'available'
         and deleted_at is null
         -- THE ONE NEW CLAUSE. A review somebody has been given is not part of
         -- the pool a replacement clears.
         and assigned_to is null
       order by id
         for update
    ) c;

  v_n := coalesce(array_length(v_ids, 1), 0);
  if v_n = 0 then return 0; end if;

  -- The event first, because the freeze trigger refuses an UPDATE of an
  -- already-deleted row and the trail must name where the review was.
  insert into public.customer_review_test_card_events
    (card_id, event_type, previous_status, new_status, detail, actor_id)
  select id, 'replaced', status, null,
         'Replaced by a newly approved batch of reviews.',
         p_actor_id
    from public.customer_review_test_cards
   where id = any(v_ids);

  update public.customer_review_test_cards
     set deleted_at           = now(),
         deleted_by           = p_actor_id,
         deleted_source       = 'replacement',
         replaced_by_batch_id = p_batch_id,
         updated_at           = now()
   where id = any(v_ids)
     and deleted_at is null;

  return v_n;
end;
$$;

comment on function public.customer_review_replace_available(uuid, uuid) is
  'Internal helper. Soft-deletes every live available review THAT IS NOT ASSIGNED TO ANYBODY, and records a replaced event naming the batch that displaced it. Called only from the approval functions, which resolve verify first; it is granted to nobody. An assigned review is never displaced — it is one employee''s outstanding work, and only an action that names it removes it.';

revoke execute on function public.customer_review_replace_available(uuid, uuid) from public, anon, authenticated;

-- ═══ 14. Assertions ════════════════════════════════════════════════════════
--
-- These fail the migration rather than let a partial apply look successful.

do $$
declare
  v_n   integer;
  v_src text;
  v_pol text;
begin
  -- 14a. the two new tables exist with row security on, one SELECT policy each
  select count(*) into v_n
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname in ('customer_review_image_groups', 'customer_review_group_images')
     and c.relrowsecurity;
  if v_n <> 2 then
    raise exception 'REVIEW_TYPES: expected 2 image-library tables with row security, found %', v_n;
  end if;

  select count(*) into v_n
    from pg_policies
   where schemaname = 'public'
     and tablename in ('customer_review_image_groups', 'customer_review_group_images');
  if v_n <> 2 then
    raise exception 'REVIEW_TYPES: expected exactly 2 policies across the image-library tables, found %', v_n;
  end if;

  -- 14b. no client role may write either of them
  if has_table_privilege('authenticated', 'public.customer_review_image_groups', 'INSERT')
  or has_table_privilege('authenticated', 'public.customer_review_image_groups', 'UPDATE')
  or has_table_privilege('authenticated', 'public.customer_review_image_groups', 'DELETE')
  or has_table_privilege('authenticated', 'public.customer_review_group_images', 'INSERT')
  or has_table_privilege('authenticated', 'public.customer_review_group_images', 'UPDATE')
  or has_table_privilege('authenticated', 'public.customer_review_group_images', 'DELETE') then
    raise exception 'REVIEW_TYPES: a client role can write the image library';
  end if;

  -- 14c. the bucket is private
  if not exists (
    select 1 from storage.buckets
     where id = 'customer-review-project-images' and public = false
  ) then
    raise exception 'REVIEW_TYPES: the project image bucket is missing or is public';
  end if;

  -- 14d. THE POOL IS GONE. The available branch of the cards policy asks about
  --      assigned_to, and no longer about module entry.
  select pg_get_expr(pol.polqual, pol.polrelid) into v_pol
    from pg_policy pol
    join pg_class c on c.oid = pol.polrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname = 'customer_review_test_cards'
     and pol.polname = 'customer_review_test_cards_select';

  if v_pol is null then
    raise exception 'REVIEW_TYPES: customer_review_test_cards_select is missing';
  end if;
  if v_pol not like '%assigned_to%' then
    raise exception 'REVIEW_TYPES: the cards policy does not scope the available branch to the assignee';
  end if;
  if v_pol like '%can_use_customer_review_test_cards%' then
    raise exception 'REVIEW_TYPES: the cards policy still offers a company-wide pool';
  end if;

  -- 14e. STILL NO WRITE POLICY OF ANY KIND on the cards table.
  select count(*) into v_n
    from pg_policies
   where schemaname = 'public'
     and tablename = 'customer_review_test_cards'
     and cmd <> 'SELECT';
  if v_n <> 0 then
    raise exception 'REVIEW_TYPES: a write policy appeared on customer_review_test_cards';
  end if;

  -- 14f. booking is scoped to the assignee and to a ready image review, inside
  --      the conditional UPDATE rather than in a prior read
  select p.prosrc into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'book_customer_review_test_card';
  if v_src is null
     or position('c2.assigned_to = v_uid' in v_src) = 0
     or position('customer_review_group_images' in v_src) = 0 then
    raise exception 'REVIEW_TYPES: booking is not scoped to the assignee and the project images';
  end if;

  -- 14g. the reward is priced from the review's own row, and the browser-facing
  --      transition still takes exactly three arguments
  select p.prosrc into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'transition_customer_review_test_card'
     and pg_get_function_identity_arguments(p.oid) = 'p_card_id uuid, p_next_status text, p_detail text';
  if v_src is null then
    raise exception 'REVIEW_TYPES: the three-argument transition is missing';
  end if;
  if position('c.review_type' in v_src) = 0 then
    raise exception 'REVIEW_TYPES: the transition does not price the reward from the review row';
  end if;
  if v_src ~ 'insert into public\.boe_credit_transactions' then
    raise exception 'REVIEW_TYPES: the transition inserts into the ledger directly';
  end if;

  -- 14h. the old five-argument reward poster is gone, and the new one is
  --      service-role only
  select count(*) into v_n
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'post_boe_credit_review_reward';
  if v_n <> 1 then
    raise exception 'REVIEW_TYPES: expected exactly one post_boe_credit_review_reward, found %', v_n;
  end if;
  if has_function_privilege('authenticated', 'public.post_boe_credit_review_reward(uuid, uuid, text, text, timestamptz, uuid)', 'EXECUTE')
  or has_function_privilege('anon', 'public.post_boe_credit_review_reward(uuid, uuid, text, text, timestamptz, uuid)', 'EXECUTE') then
    raise exception 'REVIEW_TYPES: a client role can execute post_boe_credit_review_reward';
  end if;

  -- 14i. the generator counts the composition itself
  select p.prosrc into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'create_customer_review_draft_batch';
  if v_src is null or position('v_text_n <> 8 or v_image_n <> 4' in v_src) = 0 then
    raise exception 'REVIEW_TYPES: the generator does not enforce eight text and four image';
  end if;

  -- 14j. EVERY EXISTING REVIEW IS A TEXT REVIEW, BY THE COLUMN DEFAULT — and
  --      this file re-types none of them.
  --
  -- ASSERTED AS THE DEFAULT RATHER THAN AS A ROW COUNT, and the difference is
  -- re-runnability. "no row has review_type <> 'text'" is true the first time
  -- this applies and FALSE for ever afterwards, because the generator starts
  -- making image reviews the moment it is applied — so a re-run of a file that
  -- had done nothing wrong would fail on work the file did not do.
  --
  -- The property that actually matters is that legacy rows became `text`
  -- WITHOUT anything being written: ADD COLUMN ... DEFAULT 'text' is what typed
  -- them, and there is no UPDATE of review_type anywhere in this file. The
  -- catalog is where that is checkable, and it stays true on every re-run.
  select count(*) into v_n
    from pg_attrdef d
    join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
   where d.adrelid = 'public.customer_review_test_cards'::regclass
     and a.attname = 'review_type'
     and pg_get_expr(d.adbin, d.adrelid) like '%text%';
  if v_n <> 1 then
    raise exception 'REVIEW_TYPES: review_type does not default to text, so a legacy row is untyped';
  end if;

  if exists (
    select 1 from public.customer_review_test_cards where review_type is null
  ) then
    raise exception 'REVIEW_TYPES: a review carries no type at all';
  end if;

  -- 14k. AND IT AWARDS NOTHING. Time-scoped, so it stays true on a re-run.
  select count(*) into v_n
    from public.boe_credit_transactions
   where transaction_type = 'review_reward'
     and created_at >= transaction_timestamp();
  if v_n <> 0 then
    raise exception 'REVIEW_TYPES: this migration created % review_reward row(s); it must create none', v_n;
  end if;
end $$;
