-- ═══════════════════════════════════════════════════════════════════════════
-- Review Workflow — Custom Review Submissions.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT THIS IS. An employee submits proof that a review THEY arranged — not one
-- generated, assigned and booked in the Review Workflow — was published. A
-- verifier checks the screenshot and approves it (BOE Credits are awarded) or
-- rejects it with a reason (nothing is awarded). It is an ADDITIONAL path: no
-- generated review, batch, booking, share, submission or verification changes.
--
-- WHAT THIS ADDS
-- --------------
--   storage bucket customer-review-custom-proofs          private, 5 MB, JPG/PNG/WEBP, SELECT-only
--   public.customer_review_custom_submissions            one row per submission; the audit record
--   public.can_view_customer_review_custom_submission()  own rows, or a verifier
--   public.create_customer_review_custom_submission()    SERVICE ROLE ONLY: the upload route's registration
--   public.post_boe_credit_custom_review_reward()        SERVICE ROLE ONLY: the ledger row + its review month
--   public.approve_customer_review_custom_submission()   browser RPC: verifier, credits, exactly once
--   public.reject_customer_review_custom_submission()    browser RPC: verifier, reason, no credits
--
-- THE RULES, STATED ONCE
-- ----------------------
--   * SUBMITTING needs customer_review_requests.use — the permission that lets
--     an employee do review work at all. The actor comes from the session the
--     route authenticated, never from a form field.
--   * The published date is the employee's claim, required, and never after
--     today (Asia/Kolkata). The approval date is the system's, set on approval.
--   * DECIDING needs customer_review_requests.verify — the same authority that
--     verifies a generated review and awards its credit — and NOBODY decides
--     their own submission, administrators included.
--   * The credit amount defaults to the configured reward for the review type
--     (boe_credit_settings.review_reward_credits for text,
--     image_review_reward_credits for image). A verifier CONFIRMS that amount;
--     only a BOE Credits manager (can_manage_boe_credits(): an active admin)
--     may award a different one. Nothing about who may move credits widens.
--   * An approval posts ONE standard ledger row: transaction_type
--     'review_reward', source_type 'customer_review_custom_submission',
--     source_id = the submission. It is recorded in boe_credit_review_rewards
--     for the Asia/Kolkata month of submitted_at, so — by the owner's decision —
--     an approved custom review counts toward the monthly minimum exactly like
--     a verified generated review: provisional while the month is open, lapsed
--     if the month closes below target, reversible by an administrator from
--     BOE Credits history. No exception is carved out for it.
--   * A rejection needs a reason, awards nothing, and is kept.
--   * NOTHING IS DELETED. A decided submission is final; the row is the audit
--     record (who, when, how much, why not).
--
-- EXACTLY ONCE. Three independent guarantees that an approval pays once:
--   1. the submission row is locked FOR UPDATE and an already-approved one is
--      returned as it is — a double click, a retry or a second tab posts nothing;
--   2. the ledger's one-row-per-source unique index (employee, review_reward,
--      customer_review_custom_submission, submission id);
--   3. credit_transaction_id is UNIQUE on the submission, and
--      boe_credit_review_rewards is unique per (employee, card_id).
--
-- ASSUMPTIONS TO CHECK BEFORE THIS IS APPLIED
--   1. 20261204000000 is applied (post_boe_credit_transaction takes numeric;
--      the reward columns are numeric(12,2)).
--   2. public.resolve_permission(uuid, text, text) and the
--      customer_review_requests module with `use` and `verify` exist (20261017000000).
--   3. public.users(id, is_active, is_deleted, role) exists.
--
-- PRODUCTION SAFETY. Additive: one bucket, one sequence, one table, five
-- functions, two policies. Nothing existing is altered. Re-runnable.
--
-- DEPLOYMENT ORDER. Apply BEFORE the application code: the screens read the
-- table and call the RPCs, and PostgREST answers an unknown table with 42P01.
--
-- ROLLBACK (lossless only while no submission exists)
--   drop function if exists public.reject_customer_review_custom_submission(uuid, text);
--   drop function if exists public.approve_customer_review_custom_submission(uuid, numeric);
--   drop function if exists public.post_boe_credit_custom_review_reward(uuid, uuid, text, numeric, timestamptz, uuid);
--   drop function if exists public.create_customer_review_custom_submission(uuid, uuid, text, date, text, text, text, text, integer, text);
--   drop policy   if exists "customer_review_custom_proofs_storage_select" on storage.objects;
--   drop table    if exists public.customer_review_custom_submissions;
--   drop function if exists public.customer_review_custom_submissions_guard();
--   drop function if exists public.can_view_customer_review_custom_submission(uuid);
--   drop sequence if exists public.customer_review_custom_submission_ref_seq;
--   delete from storage.buckets where id = 'customer-review-custom-proofs';  -- only when empty

-- ═══ 1. The private bucket ════════════════════════════════════════════════
--
-- A bucket of its own, for the reason 20261107000000 gave the project images
-- one: the screenshots bucket's SELECT policy reads the first path segment as a
-- CARD id. A submission is not a card, so its proof lives where the first
-- segment means a submission id.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'customer-review-custom-proofs',
  'customer-review-custom-proofs',
  false,     -- private: no anonymous or public read, ever
  5242880,   -- 5 MB per file — must equal TEST_SCREENSHOT_MAX_BYTES, the limit the route enforces
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update set
  public             = excluded.public,
  file_size_limit    = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- ═══ 2. The submission ════════════════════════════════════════════════════

create sequence if not exists public.customer_review_custom_submission_ref_seq;
revoke all on sequence public.customer_review_custom_submission_ref_seq from public, anon, authenticated;

create table if not exists public.customer_review_custom_submissions (
  id                    uuid          primary key default gen_random_uuid(),
  -- The human reference, "CR-000001". Written on the ledger row's description
  -- and on the review-month reward record.
  submission_ref        text          not null unique
                          default ('CR-' || lpad(nextval('public.customer_review_custom_submission_ref_seq')::text, 6, '0')),

  submitted_by          uuid          not null references public.users(id),
  review_type           text          not null check (review_type in ('text', 'image')),
  -- The employee's claim: the date the review was published. Never the approval date.
  published_on          date          not null,
  remark                text          check (remark is null or (btrim(remark) <> '' and length(remark) <= 300)),

  -- THE PROOF: the re-encoded screenshot the route stored. The first path
  -- segment is this row's id (checked below) — the storage policy reads it.
  proof_storage_path    text          not null unique check (position('/' in proof_storage_path) > 1 and length(proof_storage_path) <= 400),
  proof_file_name       text          not null check (btrim(proof_file_name) <> '' and length(proof_file_name) <= 120),
  proof_mime_type       text          not null check (proof_mime_type in ('image/jpeg', 'image/png', 'image/webp')),
  proof_byte_size       integer       not null check (proof_byte_size > 0 and proof_byte_size <= 5242880),
  proof_content_sha256  text          not null check (proof_content_sha256 ~ '^[0-9a-f]{64}$'),

  status                text          not null default 'pending_verification'
                          check (status in ('pending_verification', 'approved', 'rejected')),
  submitted_at          timestamptz   not null default now(),

  approved_by           uuid          references public.users(id),
  approved_at           timestamptz,
  credits_awarded       numeric(12,2),
  credit_transaction_id uuid          unique references public.boe_credit_transactions(id),

  rejected_by           uuid          references public.users(id),
  rejected_at           timestamptz,
  rejection_reason      text,

  updated_at            timestamptz   not null default now(),

  constraint custom_review_submission_proof_path_is_own
    check (split_part(proof_storage_path, '/', 1) = id::text),
  constraint custom_review_submission_published_not_after_submission
    check (published_on <= (submitted_at at time zone 'Asia/Kolkata')::date),
  constraint custom_review_submission_decision_consistent check (
    case status
      when 'pending_verification' then
        approved_by is null and approved_at is null and credits_awarded is null and credit_transaction_id is null
        and rejected_by is null and rejected_at is null and rejection_reason is null
      when 'approved' then
        approved_by is not null and approved_at is not null and credits_awarded > 0 and credit_transaction_id is not null
        and rejected_by is null and rejected_at is null and rejection_reason is null
      when 'rejected' then
        rejected_by is not null and rejected_at is not null
        and rejection_reason is not null and btrim(rejection_reason) <> '' and length(rejection_reason) <= 300
        and approved_by is null and approved_at is null and credits_awarded is null and credit_transaction_id is null
    end
  ),
  constraint custom_review_submission_no_self_decision check (
    (approved_by is null or approved_by <> submitted_by)
    and (rejected_by is null or rejected_by <> submitted_by)
  )
);

comment on table public.customer_review_custom_submissions is
  'Review Workflow: a review an employee arranged independently, submitted with a screenshot proving it was published. pending_verification until a verifier (customer_review_requests.verify, never the submitter) approves it — posting one review_reward ledger row, recorded for the month of submitted_at — or rejects it with a reason. Never deleted; a decided row is final. No client role can write it: the upload route registers it on the service role, and the decisions are definer functions.';

-- One live submission per screenshot per employee: a double-clicked Submit, or
-- the same proof sent twice, is refused. A rejected one does not block a retry.
create unique index if not exists customer_review_custom_submissions_live_proof_unique
  on public.customer_review_custom_submissions (submitted_by, proof_content_sha256)
  where status <> 'rejected';

create index if not exists customer_review_custom_submissions_status_idx
  on public.customer_review_custom_submissions (status, submitted_at desc);

create index if not exists customer_review_custom_submissions_submitter_idx
  on public.customer_review_custom_submissions (submitted_by, submitted_at desc);

-- A pending row may be decided once; a decided row never changes; nothing is deleted.
create or replace function public.customer_review_custom_submissions_guard()
returns trigger
language plpgsql
as $$
declare
  v_decision text[] := array[
    'status', 'approved_by', 'approved_at', 'credits_awarded', 'credit_transaction_id',
    'rejected_by', 'rejected_at', 'rejection_reason', 'updated_at'
  ];
begin
  if tg_op = 'DELETE' then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_APPEND_ONLY: a custom review submission is never deleted — it is the audit record'
      using errcode = '42501';
  end if;
  if old.status <> 'pending_verification' then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_APPEND_ONLY: a decided custom review submission is final'
      using errcode = '42501';
  end if;
  if (to_jsonb(new) - v_decision) <> (to_jsonb(old) - v_decision) then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_APPEND_ONLY: only the decision on a custom review submission may change'
      using errcode = '42501';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

revoke execute on function public.customer_review_custom_submissions_guard() from public, anon, authenticated;

drop trigger if exists customer_review_custom_submissions_guard on public.customer_review_custom_submissions;
create trigger customer_review_custom_submissions_guard
  before update or delete on public.customer_review_custom_submissions
  for each row execute function public.customer_review_custom_submissions_guard();

-- ═══ 3. Who may read one ══════════════════════════════════════════════════
--
-- The submitter, while their account is active; and a verifier, who reviews
-- every submission. Same shape as can_view_customer_review_test_card(): a
-- definer function, so the policy and the storage policy ask one question.

create or replace function public.can_view_customer_review_custom_submission(
  p_submitted_by uuid
)
returns boolean
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select auth.uid() is not null
    and exists (select 1 from public.users u where u.id = auth.uid() and u.is_active)
    and (
      p_submitted_by = auth.uid()
      or public.resolve_permission(auth.uid(), 'customer_review_requests', 'verify')
    );
$$;

revoke execute on function public.can_view_customer_review_custom_submission(uuid) from public, anon;
grant  execute on function public.can_view_customer_review_custom_submission(uuid) to authenticated;

comment on function public.can_view_customer_review_custom_submission(uuid) is
  'May this caller see a custom review submission made by p_submitted_by? Their own (active account), or any, for a holder of customer_review_requests.verify. Used by the table policy and the proof bucket policy.';

alter table public.customer_review_custom_submissions enable row level security;

revoke insert, update, delete, truncate, references, trigger
  on public.customer_review_custom_submissions from authenticated, anon;
revoke select on public.customer_review_custom_submissions from anon;
grant  select on public.customer_review_custom_submissions to authenticated;

drop policy if exists "customer_review_custom_submissions_select" on public.customer_review_custom_submissions;
create policy "customer_review_custom_submissions_select"
  on public.customer_review_custom_submissions
  for select
  to authenticated
  using (public.can_view_customer_review_custom_submission(submitted_by));

-- THERE IS NO INSERT AND NO DELETE POLICY ON storage.objects FOR THIS BUCKET.
-- The bytes arrive only through /api/customer-reviews/custom-submissions on the
-- service role, after the route has read and re-encoded them.
drop policy if exists "customer_review_custom_proofs_storage_select" on storage.objects;
create policy "customer_review_custom_proofs_storage_select"
  on storage.objects
  for select to authenticated
  using (
    bucket_id = 'customer-review-custom-proofs'
    and exists (
      select 1 from public.customer_review_custom_submissions s
      where s.id::text = split_part(storage.objects.name, '/', 1)
        and public.can_view_customer_review_custom_submission(s.submitted_by)
    )
  );

-- ═══ 4. Registration — the upload route, on the service role ══════════════
--
-- SERVICE ROLE ONLY. The route has authenticated the caller from their session,
-- decoded and re-encoded the screenshot and stored it under a path it generated
-- from p_submission_id. This re-verifies everything a database can: the actor
-- is active and holds `use`, the type, the date, the remark, and that the proof
-- path belongs to this submission. Returns the row as jsonb.

create or replace function public.create_customer_review_custom_submission(
  p_submission_id        uuid,
  p_actor_id             uuid,
  p_review_type          text,
  p_published_on         date,
  p_remark               text,
  p_proof_storage_path   text,
  p_proof_file_name      text,
  p_proof_mime_type      text,
  p_proof_byte_size      integer,
  p_proof_content_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_today  date := (now() at time zone 'Asia/Kolkata')::date;
  v_remark text := nullif(btrim(coalesce(p_remark, '')), '');
  v_row    public.customer_review_custom_submissions%rowtype;
begin
  if p_actor_id is null or not exists (
    select 1 from public.users
     where id = p_actor_id and is_active = true and coalesce(is_deleted, false) = false
  ) then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_UNAUTHORIZED: Your account is not active'
      using errcode = '42501';
  end if;
  if not public.resolve_permission(p_actor_id, 'customer_review_requests', 'use') then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_UNAUTHORIZED: You do not have permission to submit a custom review'
      using errcode = '42501';
  end if;

  if p_submission_id is null then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_INVALID: The submission could not be identified'
      using errcode = '22023';
  end if;
  if p_review_type is null or p_review_type not in ('text', 'image') then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_INVALID: Choose a Text-based or Image-based review'
      using errcode = '22023';
  end if;
  if p_published_on is null then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_INVALID: Enter the date the review was published'
      using errcode = '22023';
  end if;
  if p_published_on > v_today then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_INVALID: The published date cannot be in the future'
      using errcode = '22023';
  end if;
  if v_remark is not null and length(v_remark) > 300 then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_INVALID: Keep the remark under 300 characters'
      using errcode = '22023';
  end if;
  if p_proof_storage_path is null or split_part(p_proof_storage_path, '/', 1) <> p_submission_id::text then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_INVALID: A screenshot of the published review is required'
      using errcode = '22023';
  end if;

  if exists (
    select 1 from public.customer_review_custom_submissions
     where submitted_by = p_actor_id
       and proof_content_sha256 = p_proof_content_sha256
       and status <> 'rejected'
  ) then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_DUPLICATE: This screenshot has already been submitted'
      using errcode = '23505';
  end if;

  begin
    insert into public.customer_review_custom_submissions (
      id, submitted_by, review_type, published_on, remark,
      proof_storage_path, proof_file_name, proof_mime_type, proof_byte_size, proof_content_sha256
    ) values (
      p_submission_id, p_actor_id, p_review_type, p_published_on, v_remark,
      p_proof_storage_path, p_proof_file_name, p_proof_mime_type, p_proof_byte_size, p_proof_content_sha256
    )
    returning * into v_row;
  exception when unique_violation then
    -- The race the pre-check above could not see: a second request with the
    -- same screenshot committed first.
    raise exception 'CUSTOMER_REVIEW_CUSTOM_DUPLICATE: This screenshot has already been submitted'
      using errcode = '23505';
  end;

  return to_jsonb(v_row);
end;
$$;

revoke execute on function public.create_customer_review_custom_submission(uuid, uuid, text, date, text, text, text, text, integer, text)
  from public, anon, authenticated;
grant  execute on function public.create_customer_review_custom_submission(uuid, uuid, text, date, text, text, text, text, integer, text)
  to service_role;

comment on function public.create_customer_review_custom_submission(uuid, uuid, text, date, text, text, text, text, integer, text) is
  'SERVICE ROLE ONLY. Registers one custom review submission after the upload route stored its re-encoded screenshot. Re-verifies: active actor holding customer_review_requests.use, text/image, a published date not after today (Asia/Kolkata), remark length, a proof path under this submission id, and one live submission per screenshot per employee.';

-- ═══ 5. The credit — a standard review reward, attributed to its month ════
--
-- SERVICE ROLE ONLY (the approval calls it as the owner). The 20261204000000
-- post_boe_credit_review_reward() shape with the amount the approval confirmed
-- and a different source: one review_reward row through the one write path,
-- the month row created on first use with the minimum snapshotted, the reward
-- record, and the recount that qualifies the month. Under the employee lock.

create or replace function public.post_boe_credit_custom_review_reward(
  p_employee_id    uuid,
  p_submission_id  uuid,
  p_submission_ref text,
  p_credits        numeric,
  p_submitted_at   timestamptz,
  p_actor_id       uuid
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
begin
  if p_submission_id is null or nullif(btrim(coalesce(p_submission_ref, '')), '') is null then
    raise exception 'BOE_CREDITS_SOURCE: a custom review reward must name the submission it is for'
      using errcode = '22023';
  end if;
  if p_submitted_at is null then
    raise exception 'BOE_CREDITS_REVIEW_MONTH: the submission has no submission time to attribute its credit to'
      using errcode = '22023';
  end if;
  if p_credits is null or p_credits <= 0 then
    raise exception 'BOE_CREDITS_ZERO: a custom review reward must be above zero'
      using errcode = '22023';
  end if;

  select * into v_settings from public.boe_credit_settings order by created_at desc limit 1;
  if not found then
    raise exception 'BOE_CREDITS_SETTINGS: no active credit settings row'
      using errcode = 'P0002';
  end if;

  -- THE REVIEW MONTH: the Asia/Kolkata calendar month the proof was handed over.
  v_month := date_trunc('month', (p_submitted_at at time zone 'Asia/Kolkata')::date)::date;

  perform pg_advisory_xact_lock(hashtext('boe_credits'), hashtext(p_employee_id::text));

  v_tx := public.post_boe_credit_transaction(
    p_employee_id,
    'review_reward',
    p_credits,
    'customer_review_custom_submission',
    p_submission_id,
    'Custom review approved · ' || p_submission_ref,
    p_actor_id
  );

  insert into public.boe_credit_review_months (employee_id, review_month, minimum_reviews_snapshot)
  values (p_employee_id, v_month, v_settings.minimum_monthly_reviews)
  on conflict (employee_id, review_month) do nothing;

  select * into v_row from public.boe_credit_review_months
   where employee_id = p_employee_id and review_month = v_month;

  -- card_id / card_ref carry the SUBMISSION's id and reference: the record is a
  -- type/id pair with no foreign key, so a custom review counts toward the
  -- month through the same table a generated review does.
  insert into public.boe_credit_review_rewards (
    transaction_id, employee_id, card_id, card_ref, submitted_at, review_month, review_month_id
  ) values (
    v_tx, p_employee_id, p_submission_id, p_submission_ref, p_submitted_at, v_month, v_row.id
  );

  v_row := public.refresh_boe_credit_review_month(p_employee_id, v_month);

  return jsonb_build_object(
    'transaction_id',          v_tx,
    'credits',                 p_credits,
    'review_month',            v_month,
    'month_status',            v_row.status,
    'qualifying_review_count', v_row.qualifying_review_count,
    'minimum_reviews',         v_row.minimum_reviews_snapshot,
    'provisional',             v_row.status = 'open'
  );
end;
$$;

revoke execute on function public.post_boe_credit_custom_review_reward(uuid, uuid, text, numeric, timestamptz, uuid)
  from public, anon, authenticated;
grant  execute on function public.post_boe_credit_custom_review_reward(uuid, uuid, text, numeric, timestamptz, uuid)
  to service_role;

comment on function public.post_boe_credit_custom_review_reward(uuid, uuid, text, numeric, timestamptz, uuid) is
  'SERVICE ROLE ONLY (called by approve_customer_review_custom_submission as its owner). Posts one review_reward (source customer_review_custom_submission) for the confirmed amount, records it in boe_credit_review_rewards for the Asia/Kolkata month of the submission, and qualifies the month when the count reaches the minimum. Under the per-employee lock.';

-- ═══ 6. Approve ═══════════════════════════════════════════════════════════
--
-- Browser-callable, like transition_customer_review_test_card(): the actor is
-- auth.uid(), and every authority is resolved here. Returns jsonb
--   { submission, reward, already_decided }

create or replace function public.approve_customer_review_custom_submission(
  p_submission_id uuid,
  p_credits       numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  s          public.customer_review_custom_submissions%rowtype;
  v_uid      uuid := auth.uid();
  v_settings public.boe_credit_settings%rowtype;
  v_default  numeric;
  v_reward   jsonb;
begin
  if v_uid is null then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_UNAUTHORIZED: Sign in to continue' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.users u where u.id = v_uid and u.is_active and coalesce(u.is_deleted, false) = false
  ) then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_UNAUTHORIZED: Your account is not active' using errcode = '42501';
  end if;
  if not public.resolve_permission(v_uid, 'customer_review_requests', 'verify') then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_UNAUTHORIZED: Approving a custom review needs the Verify permission'
      using errcode = '42501';
  end if;

  -- Locked for the duration: two approvals of one submission happen one after
  -- the other, and the second finds it already approved.
  select * into s from public.customer_review_custom_submissions where id = p_submission_id for update;
  if not found then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_NOT_FOUND: That submission no longer exists' using errcode = 'P0002';
  end if;

  if s.submitted_by = v_uid then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_SELF: You cannot approve or reject your own submission'
      using errcode = '42501';
  end if;

  -- EXACTLY ONCE: an approved submission is returned as it is, and nothing is posted.
  if s.status = 'approved' then
    return jsonb_build_object('submission', to_jsonb(s), 'reward', null, 'already_decided', true);
  end if;
  if s.status = 'rejected' then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_DECIDED: This submission was already rejected' using errcode = '55000';
  end if;

  if p_credits is null or p_credits <= 0 then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_CREDITS: Enter a credit amount above 0' using errcode = '22023';
  end if;
  if p_credits <> round(p_credits, 2) then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_CREDITS: Credits have at most two decimal places' using errcode = '22023';
  end if;
  if p_credits > 100000 then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_CREDITS: That is more credits than one review can earn' using errcode = '22023';
  end if;

  select * into v_settings from public.boe_credit_settings order by created_at desc limit 1;
  if not found then
    raise exception 'BOE_CREDITS_SETTINGS: no active credit settings row' using errcode = 'P0002';
  end if;
  v_default := case s.review_type
    when 'image' then v_settings.image_review_reward_credits
    else v_settings.review_reward_credits
  end;

  -- A verifier CONFIRMS the configured amount; changing it is a BOE Credits
  -- management decision, and can_manage_boe_credits() is that authority.
  if p_credits <> v_default and not public.can_manage_boe_credits() then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_CREDITS: Only a BOE Credits administrator can change the amount. The configured reward for this review type is % credits', v_default
      using errcode = '42501';
  end if;

  v_reward := public.post_boe_credit_custom_review_reward(
    s.submitted_by,
    s.id,
    s.submission_ref,
    p_credits,
    s.submitted_at,
    v_uid
  );

  update public.customer_review_custom_submissions
     set status                = 'approved',
         approved_by           = v_uid,
         approved_at           = now(),
         credits_awarded       = p_credits,
         credit_transaction_id = (v_reward ->> 'transaction_id')::uuid
   where id = s.id
   returning * into s;

  return jsonb_build_object('submission', to_jsonb(s), 'reward', v_reward, 'already_decided', false);
end;
$$;

revoke execute on function public.approve_customer_review_custom_submission(uuid, numeric) from public, anon;
grant  execute on function public.approve_customer_review_custom_submission(uuid, numeric) to authenticated;

comment on function public.approve_customer_review_custom_submission(uuid, numeric) is
  'Approves one pending custom review submission. Actor is auth.uid(): active, holding customer_review_requests.verify, and not the submitter. The amount must equal the configured reward for the review type unless the actor can_manage_boe_credits(). Posts exactly one review_reward through post_boe_credit_custom_review_reward() in the same transaction; an already-approved submission is returned unchanged and posts nothing.';

-- ═══ 7. Reject ════════════════════════════════════════════════════════════

create or replace function public.reject_customer_review_custom_submission(
  p_submission_id uuid,
  p_reason        text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  s        public.customer_review_custom_submissions%rowtype;
  v_uid    uuid := auth.uid();
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if v_uid is null then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_UNAUTHORIZED: Sign in to continue' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.users u where u.id = v_uid and u.is_active and coalesce(u.is_deleted, false) = false
  ) then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_UNAUTHORIZED: Your account is not active' using errcode = '42501';
  end if;
  if not public.resolve_permission(v_uid, 'customer_review_requests', 'verify') then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_UNAUTHORIZED: Rejecting a custom review needs the Verify permission'
      using errcode = '42501';
  end if;

  select * into s from public.customer_review_custom_submissions where id = p_submission_id for update;
  if not found then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_NOT_FOUND: That submission no longer exists' using errcode = 'P0002';
  end if;

  if s.submitted_by = v_uid then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_SELF: You cannot approve or reject your own submission'
      using errcode = '42501';
  end if;

  if s.status = 'rejected' then
    return jsonb_build_object('submission', to_jsonb(s), 'already_decided', true);
  end if;
  if s.status = 'approved' then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_DECIDED: This submission was already approved and its credits awarded'
      using errcode = '55000';
  end if;

  if v_reason is null then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_REASON: Give a short reason for rejecting' using errcode = '22023';
  end if;
  if length(v_reason) > 300 then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_REASON: Keep the reason under 300 characters' using errcode = '22023';
  end if;

  update public.customer_review_custom_submissions
     set status           = 'rejected',
         rejected_by      = v_uid,
         rejected_at      = now(),
         rejection_reason = v_reason
   where id = s.id
   returning * into s;

  return jsonb_build_object('submission', to_jsonb(s), 'already_decided', false);
end;
$$;

revoke execute on function public.reject_customer_review_custom_submission(uuid, text) from public, anon;
grant  execute on function public.reject_customer_review_custom_submission(uuid, text) to authenticated;

comment on function public.reject_customer_review_custom_submission(uuid, text) is
  'Rejects one pending custom review submission with a reason. Actor is auth.uid(): active, holding customer_review_requests.verify, and not the submitter. Posts no credit. An already-rejected submission is returned unchanged.';

-- ═══ 8. Assertions ════════════════════════════════════════════════════════

do $$
declare
  v_n integer;
begin
  -- 8a. row security on, exactly one policy, and it reads
  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'customer_review_custom_submissions' and c.relrowsecurity
  ) then
    raise exception 'CUSTOM_REVIEW_SUBMISSIONS: row security is not enabled';
  end if;
  select count(*) into v_n from pg_policies
   where schemaname = 'public' and tablename = 'customer_review_custom_submissions';
  if v_n <> 1 or exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'customer_review_custom_submissions' and cmd <> 'SELECT'
  ) then
    raise exception 'CUSTOM_REVIEW_SUBMISSIONS: expected exactly one SELECT policy, found % policies', v_n;
  end if;

  -- 8b. no client role can write it; anon cannot read it
  if has_table_privilege('authenticated', 'public.customer_review_custom_submissions', 'INSERT')
     or has_table_privilege('authenticated', 'public.customer_review_custom_submissions', 'UPDATE')
     or has_table_privilege('authenticated', 'public.customer_review_custom_submissions', 'DELETE')
     or has_table_privilege('anon', 'public.customer_review_custom_submissions', 'SELECT') then
    raise exception 'CUSTOM_REVIEW_SUBMISSIONS: a client role holds a write (or anon a read)';
  end if;

  -- 8c. the bucket is private, and the only client policy on it reads
  if not exists (select 1 from storage.buckets where id = 'customer-review-custom-proofs' and public = false) then
    raise exception 'CUSTOM_REVIEW_SUBMISSIONS: the proof bucket is missing or public';
  end if;
  if exists (
    select 1 from pg_policies
     where schemaname = 'storage' and tablename = 'objects'
       and (coalesce(qual, '') || coalesce(with_check, '')) like '%customer-review-custom-proofs%'
       and cmd <> 'SELECT'
  ) then
    raise exception 'CUSTOM_REVIEW_SUBMISSIONS: a non-SELECT storage policy names the proof bucket';
  end if;

  -- 8d. registration and the reward are service role only; the decisions are browser RPCs, never anon
  if has_function_privilege('authenticated', 'public.create_customer_review_custom_submission(uuid, uuid, text, date, text, text, text, text, integer, text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.create_customer_review_custom_submission(uuid, uuid, text, date, text, text, text, text, integer, text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.post_boe_credit_custom_review_reward(uuid, uuid, text, numeric, timestamptz, uuid)', 'EXECUTE')
     or has_function_privilege('anon', 'public.post_boe_credit_custom_review_reward(uuid, uuid, text, numeric, timestamptz, uuid)', 'EXECUTE') then
    raise exception 'CUSTOM_REVIEW_SUBMISSIONS: a client role can execute a service-role function';
  end if;
  if not has_function_privilege('service_role', 'public.create_customer_review_custom_submission(uuid, uuid, text, date, text, text, text, text, integer, text)', 'EXECUTE') then
    raise exception 'CUSTOM_REVIEW_SUBMISSIONS: service_role cannot register a submission';
  end if;
  if not has_function_privilege('authenticated', 'public.approve_customer_review_custom_submission(uuid, numeric)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.reject_customer_review_custom_submission(uuid, text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.approve_customer_review_custom_submission(uuid, numeric)', 'EXECUTE')
     or has_function_privilege('anon', 'public.reject_customer_review_custom_submission(uuid, text)', 'EXECUTE') then
    raise exception 'CUSTOM_REVIEW_SUBMISSIONS: the decision RPC grants are wrong';
  end if;

  -- 8e. the ledger write path this depends on takes numeric (20261204000000)
  if to_regprocedure('public.post_boe_credit_transaction(uuid, text, numeric, text, uuid, text, uuid, uuid)') is null then
    raise exception 'CUSTOM_REVIEW_SUBMISSIONS: 20261204000000 (decimal credits) must be applied first';
  end if;

  -- 8f. NOTHING WAS WRITTEN
  select count(*) into v_n from public.customer_review_custom_submissions;
  if v_n <> 0 and exists (
    select 1 from public.customer_review_custom_submissions where submitted_at >= transaction_timestamp()
  ) then
    raise exception 'CUSTOM_REVIEW_SUBMISSIONS: this migration created a submission; it must create none';
  end if;
  select count(*) into v_n from public.boe_credit_transactions
   where source_type = 'customer_review_custom_submission' and created_at >= transaction_timestamp();
  if v_n <> 0 then
    raise exception 'CUSTOM_REVIEW_SUBMISSIONS: this migration posted % ledger row(s); it must post none', v_n;
  end if;
end $$;
