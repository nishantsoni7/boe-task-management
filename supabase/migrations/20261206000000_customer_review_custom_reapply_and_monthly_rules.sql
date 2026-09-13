-- ═══════════════════════════════════════════════════════════════════════════
-- Review Workflow — the Custom Review phase: reapplication, the monthly
-- submission rules, reviewer notifications, and the generated-review pause.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT THIS ADDS
-- --------------
--   notification_type values  customer_review_submitted, customer_review_reapplied
--   boe_credit_settings       max_monthly_review_submissions (10),
--                             minimum_monthly_image_reviews (3), and ONE new active
--                             row carrying the approved phase values
--   customer_review_custom_submissions
--                             reapplication_count, last_reapplied_at, candidate_note;
--                             the published-date CHECK reads the latest submission;
--                             the guard admits rejected → pending_verification
--   customer_review_custom_submission_events
--                             append-only history: submitted, rejected, reapplied,
--                             approved — written by a trigger, backfilled once
--   customer_review_custom_month_usage()          SERVICE ROLE: a month's slot count
--   check_customer_review_custom_month_rules()    SERVICE ROLE: the cap and the image mix
--   customer_review_custom_reviewer_ids()         SERVICE ROLE: who is notified
--   reapply_customer_review_custom_submission()   SERVICE ROLE: the reapply route's write
--   create_customer_review_custom_submission()    RE-CREATED: + the monthly rules
--   approve_customer_review_custom_submission()   RE-CREATED: + the closed-month guard
--   customer_review_generated_booking_enabled()   false: generated reviews are paused
--   trigger customer_review_generated_booking_paused  refuses a non-verifier's booking
--
-- THE RULES, STATED ONCE
-- ----------------------
--   * THE SLOT. A submission takes one of the employee's monthly slots in the
--     Asia/Kolkata month of submitted_at — the FIRST submission. submitted_at
--     is never overwritten, so a reapplication takes no second slot and stays in
--     the month it was first submitted in. That month is also the month its
--     credit is attributed to (post_boe_credit_custom_review_reward reads
--     submitted_at), so a slot and its credit can never be in two months.
--   * NOTHING IS STORED BEFORE SUBMIT, so a draft cannot take a slot.
--   * THE CAP. At most max_monthly_review_submissions rows per employee per
--     month. A rejected row still holds its slot.
--   * THE IMAGE MIX. A TEXT submission is refused when, after it, the slots left
--     would be fewer than the image reviews still required:
--         remaining_after = max − (submitted + 1)
--         required        = max(0, minimum_images − images)
--         refuse when remaining_after < required
--     A reapplication is checked against the mix only when it turns an image
--     review into a text review; it is never checked against the cap.
--   * UNDER A LOCK. Both checks run under a per-employee advisory lock taken
--     before the count, so two requests racing for the last slot are serialized
--     and the second counts the first.
--   * REAPPLY. Only the submitter, only from rejected, the SAME row. The
--     rejection's who/when/why leave the row (the decision CHECK requires it)
--     and stay in the history. A retry that finds the row already pending
--     changes nothing and notifies nobody.
--   * A CLOSED MONTH EARNS NOTHING NEW. A review whose month was finalized as
--     lapsed can no longer be reapplied or approved: a reward posted into a
--     lapsed month would be spendable at once (only OPEN months are
--     provisional), which is exactly what the lapse took away.
--   * NOTIFICATIONS. On a submission and on a reapplication, one in-app row per
--     active user who resolves customer_review_requests.verify — never the
--     submitter. Written by the same trigger as the history, in the same
--     transaction as the change: a failed submission writes none, and a retry
--     that changes nothing writes none.
--   * NO PENALTY. Nothing here posts a negative ledger row. A month below its
--     minimum keeps its rewards provisional until an administrator closes it;
--     the existing lapse removes exactly those provisional rewards and nothing
--     the employee already held.
--   * GENERATED REVIEWS ARE PAUSED FOR CANDIDATES. A non-verifier cannot book.
--     Nothing is deleted; flipping customer_review_generated_booking_enabled()
--     to true restores booking.
--
-- ASSUMPTIONS TO CHECK BEFORE THIS IS APPLIED
--   1. 20261205000000 is applied (the submissions table and its functions).
--   2. notification_type exists and public.notifications has user_id, task_id,
--      entity_id, type, title, body, is_push_sent.
--   3. public.resolve_permission(uuid, text, text) and public.users(full_name).
--
-- PRODUCTION SAFETY. Additive columns with constant defaults (no row rewrite),
-- one table, one index, one CHECK replaced by a wider one, functions
-- re-created with identical signatures, one trigger on the test cards that
-- fires only on available → booked. No existing row is updated or deleted.
-- One settings row and one history row per existing submission are inserted.
-- Re-runnable.
--
-- DEPLOYMENT ORDER. Apply BEFORE the application code: the screens select the
-- new columns and the new table, and the reapply route calls the new function.
--
-- ROLLBACK (the enum values cannot be dropped; unused labels are inert)
--   drop trigger  if exists customer_review_generated_booking_paused on public.customer_review_test_cards;
--   drop function if exists public.customer_review_generated_booking_guard();
--   drop function if exists public.customer_review_generated_booking_enabled();
--   drop function if exists public.reapply_customer_review_custom_submission(uuid, uuid, text, date, text, text, text, text, text, integer, text);
--   drop trigger  if exists customer_review_custom_submissions_trail on public.customer_review_custom_submissions;
--   drop function if exists public.customer_review_custom_submissions_trail();
--   drop function if exists public.check_customer_review_custom_month_rules(uuid, date, text, uuid, text);
--   drop function if exists public.customer_review_custom_month_usage(uuid, date, uuid);
--   drop function if exists public.customer_review_custom_reviewer_ids(uuid);
--   drop table    if exists public.customer_review_custom_submission_events;
--   then re-apply 20261205000000 §2 (guard, CHECK), §4 (create) and §6 (approve).
--   The settings row stays as history; save a new row to change the values.

-- ═══ 1. Notification types ════════════════════════════════════════════════
--
-- Neither value is used inside this migration (only named in function bodies,
-- which are not executed here), so Postgres never needs them committed
-- mid-transaction.

alter type notification_type add value if not exists 'customer_review_submitted';
alter type notification_type add value if not exists 'customer_review_reapplied';

-- ═══ 2. Settings: the two monthly submission rules ═════════════════════════

alter table public.boe_credit_settings
  add column if not exists max_monthly_review_submissions integer not null default 10
    check (max_monthly_review_submissions > 0 and max_monthly_review_submissions <= 1000),
  add column if not exists minimum_monthly_image_reviews integer not null default 3
    check (minimum_monthly_image_reviews >= 0 and minimum_monthly_image_reviews <= 1000);

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.boe_credit_settings'::regclass
       and conname  = 'boe_credit_settings_image_minimum_within_maximum'
  ) then
    alter table public.boe_credit_settings
      add constraint boe_credit_settings_image_minimum_within_maximum
      check (minimum_monthly_image_reviews <= max_monthly_review_submissions);
  end if;
end $$;

comment on column public.boe_credit_settings.max_monthly_review_submissions is
  'Custom reviews one employee may submit for approval in one Asia/Kolkata month. A reapplication of a rejected review takes no second slot. Read when a review is submitted.';

comment on column public.boe_credit_settings.minimum_monthly_image_reviews is
  'Of the monthly submissions, how many must be Image Reviews. A Text submission is refused when it would leave fewer slots than image reviews still required. 0 turns the rule off.';

-- The approved values for the Custom Review phase, once: ₹50 a credit, a text
-- review 1 credit, an image review 1.5, 3 approved reviews to qualify a month,
-- 10 submissions a month, 3 of them images. The attendance prices are carried
-- over from the row in force. Skipped when the newest row already says exactly
-- this, so re-running adds nothing. Every row already posted keeps its numbers.
do $$
declare
  v_newest public.boe_credit_settings%rowtype;
begin
  select * into v_newest from public.boe_credit_settings order by created_at desc limit 1;
  if not found
     or v_newest.credit_value                   is distinct from 50.00
     or v_newest.review_reward_credits          is distinct from 1.00
     or v_newest.image_review_reward_credits    is distinct from 1.50
     or v_newest.minimum_monthly_reviews        is distinct from 3
     or v_newest.max_monthly_review_submissions is distinct from 10
     or v_newest.minimum_monthly_image_reviews  is distinct from 3 then
    insert into public.boe_credit_settings (
      review_reward_credits, image_review_reward_credits, credit_value,
      half_day_redemption_credits, full_day_redemption_credits,
      minimum_monthly_reviews, max_monthly_review_submissions, minimum_monthly_image_reviews,
      created_by, note
    ) values (
      1.00, 1.50, 50.00,
      coalesce(v_newest.half_day_redemption_credits, 8), coalesce(v_newest.full_day_redemption_credits, 15),
      3, 10, 3,
      null, 'Review Workflow custom review phase'
    );
  end if;
end $$;

-- ═══ 3. The submission: what a reapplication needs ═════════════════════════

alter table public.customer_review_custom_submissions
  add column if not exists reapplication_count integer not null default 0
    check (reapplication_count >= 0),
  add column if not exists last_reapplied_at timestamptz,
  add column if not exists candidate_note text
    check (candidate_note is null or (btrim(candidate_note) <> '' and length(candidate_note) <= 500));

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.customer_review_custom_submissions'::regclass
       and conname  = 'custom_review_submission_reapplication_consistent'
  ) then
    alter table public.customer_review_custom_submissions
      add constraint custom_review_submission_reapplication_consistent
      check ((reapplication_count = 0) = (last_reapplied_at is null));
  end if;
end $$;

-- A corrected review may carry a published date after its FIRST submission —
-- the review that was actually published — but never after the submission
-- being made now.
alter table public.customer_review_custom_submissions
  drop constraint if exists custom_review_submission_published_not_after_submission;
alter table public.customer_review_custom_submissions
  add constraint custom_review_submission_published_not_after_submission
  check (published_on <= (coalesce(last_reapplied_at, submitted_at) at time zone 'Asia/Kolkata')::date);

comment on column public.customer_review_custom_submissions.submitted_at is
  'The FIRST submission. Never overwritten: it decides the monthly slot and the month the credit counts for. A reapplication is recorded in last_reapplied_at.';

comment on column public.customer_review_custom_submissions.candidate_note is
  'What the employee said they changed, on their latest reapplication. Each reapplication''s note is also kept in customer_review_custom_submission_events.';

-- The guard, re-created. A pending row may be decided once; a rejected row may
-- be REAPPLIED (back to pending, the candidate's corrections only, counted once);
-- an approved row never changes; nothing is deleted.
create or replace function public.customer_review_custom_submissions_guard()
returns trigger
language plpgsql
as $$
declare
  v_decision text[] := array[
    'status', 'approved_by', 'approved_at', 'credits_awarded', 'credit_transaction_id',
    'rejected_by', 'rejected_at', 'rejection_reason', 'updated_at'
  ];
  v_reapply text[] := array[
    'status', 'approved_by', 'approved_at', 'credits_awarded', 'credit_transaction_id',
    'rejected_by', 'rejected_at', 'rejection_reason', 'updated_at',
    'review_type', 'published_on', 'remark',
    'proof_storage_path', 'proof_file_name', 'proof_mime_type', 'proof_byte_size', 'proof_content_sha256',
    'candidate_note', 'reapplication_count', 'last_reapplied_at'
  ];
begin
  if tg_op = 'DELETE' then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_APPEND_ONLY: a custom review submission is never deleted — it is the audit record'
      using errcode = '42501';
  end if;

  -- REAPPLICATION: rejected → pending, the same row.
  if old.status = 'rejected' and new.status = 'pending_verification' then
    if (to_jsonb(new) - v_reapply) <> (to_jsonb(old) - v_reapply) then
      raise exception 'CUSTOMER_REVIEW_CUSTOM_APPEND_ONLY: a reapplication may change only the candidate''s corrections'
        using errcode = '42501';
    end if;
    if new.reapplication_count <> old.reapplication_count + 1
       or new.last_reapplied_at is null
       or new.last_reapplied_at is not distinct from old.last_reapplied_at then
      raise exception 'CUSTOMER_REVIEW_CUSTOM_APPEND_ONLY: a reapplication is counted exactly once'
        using errcode = '42501';
    end if;
    new.updated_at := now();
    return new;
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

-- ═══ 4. The history ═══════════════════════════════════════════════════════

create table if not exists public.customer_review_custom_submission_events (
  id             uuid        primary key default gen_random_uuid(),
  submission_id  uuid        not null references public.customer_review_custom_submissions(id),
  event_type     text        not null check (event_type in ('submitted', 'rejected', 'reapplied', 'approved')),
  actor_id       uuid        references public.users(id),
  -- The rejection reason, on a 'rejected' event.
  reason         text,
  -- The employee's response note, on a 'reapplied' event.
  note           text,
  -- What changed: the values before and after a reapplication, the credits on
  -- an approval.
  details        jsonb       not null default '{}'::jsonb,
  created_at     timestamptz not null default now()
);

comment on table public.customer_review_custom_submission_events is
  'Review Workflow: the append-only history of one custom review submission — submitted, rejected (with the reason), reapplied (with the employee''s note and the values before and after), approved (with the credits). Written only by the trigger on customer_review_custom_submissions. Never updated or deleted.';

create index if not exists customer_review_custom_submission_events_submission_idx
  on public.customer_review_custom_submission_events (submission_id, created_at);

create or replace function public.customer_review_custom_submission_events_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception 'CUSTOMER_REVIEW_CUSTOM_APPEND_ONLY: the custom review history is never changed or deleted'
    using errcode = '42501';
end;
$$;

revoke execute on function public.customer_review_custom_submission_events_append_only() from public, anon, authenticated;

drop trigger if exists customer_review_custom_submission_events_append_only on public.customer_review_custom_submission_events;
create trigger customer_review_custom_submission_events_append_only
  before update or delete on public.customer_review_custom_submission_events
  for each row execute function public.customer_review_custom_submission_events_append_only();

alter table public.customer_review_custom_submission_events enable row level security;

revoke insert, update, delete, truncate, references, trigger
  on public.customer_review_custom_submission_events from authenticated, anon;
revoke select on public.customer_review_custom_submission_events from anon;
grant  select on public.customer_review_custom_submission_events to authenticated;

-- Whoever may read the submission may read its history, and nobody else.
drop policy if exists "customer_review_custom_submission_events_select" on public.customer_review_custom_submission_events;
create policy "customer_review_custom_submission_events_select"
  on public.customer_review_custom_submission_events
  for select
  to authenticated
  using (
    exists (
      select 1 from public.customer_review_custom_submissions s
       where s.id = submission_id
         and public.can_view_customer_review_custom_submission(s.submitted_by)
    )
  );

-- Backfill: the submissions that already exist get the events they would have
-- had. Idempotent — an event already present is not written twice.
insert into public.customer_review_custom_submission_events (submission_id, event_type, actor_id, details, created_at)
select s.id, 'submitted', s.submitted_by,
       jsonb_build_object('review_type', s.review_type, 'published_on', s.published_on),
       s.submitted_at
  from public.customer_review_custom_submissions s
 where not exists (
   select 1 from public.customer_review_custom_submission_events e
    where e.submission_id = s.id and e.event_type = 'submitted'
 );

insert into public.customer_review_custom_submission_events (submission_id, event_type, actor_id, details, created_at)
select s.id, 'approved', s.approved_by,
       jsonb_build_object('credits_awarded', s.credits_awarded, 'credit_transaction_id', s.credit_transaction_id),
       s.approved_at
  from public.customer_review_custom_submissions s
 where s.status = 'approved'
   and not exists (
     select 1 from public.customer_review_custom_submission_events e
      where e.submission_id = s.id and e.event_type = 'approved'
   );

insert into public.customer_review_custom_submission_events (submission_id, event_type, actor_id, reason, created_at)
select s.id, 'rejected', s.rejected_by, s.rejection_reason, s.rejected_at
  from public.customer_review_custom_submissions s
 where s.status = 'rejected'
   and not exists (
     select 1 from public.customer_review_custom_submission_events e
      where e.submission_id = s.id and e.event_type = 'rejected'
   );

-- ═══ 5. Who is notified ═══════════════════════════════════════════════════
--
-- SERVICE ROLE ONLY. Every active user who resolves `verify` — the authority
-- approve and reject require — except the submitter. The permission engine is
-- asked for every user; no role name is read, so a verifier whose `verify` was
-- revoked in Control Center is not notified, administrator or not.

create or replace function public.customer_review_custom_reviewer_ids(p_exclude uuid)
returns table (user_id uuid)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select u.id
    from public.users u
   where u.is_active = true
     and coalesce(u.is_deleted, false) = false
     and u.id is distinct from p_exclude
     and public.resolve_permission(u.id, 'customer_review_requests', 'verify');
$$;

revoke execute on function public.customer_review_custom_reviewer_ids(uuid) from public, anon, authenticated;
grant  execute on function public.customer_review_custom_reviewer_ids(uuid) to service_role;

-- ═══ 6. The trail and the notification: one trigger ═══════════════════════
--
-- AFTER INSERT and AFTER a status change. Every path that moves a submission —
-- the registration, a decision, a reapplication — is recorded by the same code,
-- in the same transaction, so the history cannot miss a move and a notification
-- cannot exist for a change that rolled back.

create or replace function public.customer_review_custom_submissions_trail()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_kind  text;
  v_name  text;
  v_type  text;
  v_title text;
  v_body  text;
begin
  if tg_op = 'INSERT' then
    insert into public.customer_review_custom_submission_events (submission_id, event_type, actor_id, details, created_at)
    values (new.id, 'submitted', new.submitted_by,
            jsonb_build_object('review_type', new.review_type, 'published_on', new.published_on),
            new.submitted_at);
    v_kind := 'customer_review_submitted';

  elsif old.status = 'pending_verification' and new.status = 'approved' then
    insert into public.customer_review_custom_submission_events (submission_id, event_type, actor_id, details, created_at)
    values (new.id, 'approved', new.approved_by,
            jsonb_build_object('credits_awarded', new.credits_awarded, 'credit_transaction_id', new.credit_transaction_id),
            coalesce(new.approved_at, now()));
    return null;

  elsif old.status = 'pending_verification' and new.status = 'rejected' then
    insert into public.customer_review_custom_submission_events (submission_id, event_type, actor_id, reason, created_at)
    values (new.id, 'rejected', new.rejected_by, new.rejection_reason, coalesce(new.rejected_at, now()));
    return null;

  elsif old.status = 'rejected' and new.status = 'pending_verification' then
    insert into public.customer_review_custom_submission_events (submission_id, event_type, actor_id, note, details, created_at)
    values (new.id, 'reapplied', new.submitted_by, new.candidate_note,
            jsonb_build_object(
              'attempt', new.reapplication_count + 1,
              'previous', jsonb_build_object(
                'review_type', old.review_type, 'published_on', old.published_on, 'remark', old.remark,
                'proof_storage_path', old.proof_storage_path, 'proof_file_name', old.proof_file_name,
                'rejection_reason', old.rejection_reason, 'rejected_by', old.rejected_by, 'rejected_at', old.rejected_at
              ),
              'current', jsonb_build_object(
                'review_type', new.review_type, 'published_on', new.published_on, 'remark', new.remark,
                'proof_storage_path', new.proof_storage_path, 'proof_file_name', new.proof_file_name
              ),
              'proof_replaced', old.proof_storage_path is distinct from new.proof_storage_path
            ),
            coalesce(new.last_reapplied_at, now()));
    v_kind := 'customer_review_reapplied';

  else
    return null;
  end if;

  -- The notification: who, which type, that it needs a decision. No review
  -- content and no note — those are on the submission, for the people who may
  -- read it.
  select full_name into v_name from public.users where id = new.submitted_by;
  v_type := case new.review_type when 'image' then 'Image' else 'Text' end;
  if v_kind = 'customer_review_submitted' then
    v_title := format('%s submitted a custom %s Review for approval.', coalesce(nullif(btrim(v_name), ''), 'An employee'), v_type);
    v_body  := new.submission_ref;
  else
    v_title := format('%s reapplied a rejected custom %s Review for approval.', coalesce(nullif(btrim(v_name), ''), 'An employee'), v_type);
    v_body  := format('%s · reapplication %s', new.submission_ref, new.reapplication_count);
  end if;

  insert into public.notifications (user_id, task_id, entity_id, type, title, body, is_push_sent)
  select r.user_id, null, new.id, v_kind::notification_type, v_title, v_body, true
    from public.customer_review_custom_reviewer_ids(new.submitted_by) r;

  return null;
end;
$$;

revoke execute on function public.customer_review_custom_submissions_trail() from public, anon, authenticated;

drop trigger if exists customer_review_custom_submissions_trail on public.customer_review_custom_submissions;
create trigger customer_review_custom_submissions_trail
  after insert or update of status on public.customer_review_custom_submissions
  for each row execute function public.customer_review_custom_submissions_trail();

-- ═══ 7. The monthly rules ═════════════════════════════════════════════════

-- SERVICE ROLE ONLY. How many slots an employee's month holds, and how many of
-- them are image reviews. Every row counts — pending, approved and rejected all
-- took their slot when submitted. p_excluding leaves one row out (the one being
-- reapplied, whose slot is already its own).
create or replace function public.customer_review_custom_month_usage(
  p_employee_id  uuid,
  p_review_month date,
  p_excluding    uuid default null
)
returns table (submitted integer, image_reviews integer)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select count(*)::integer,
         (count(*) filter (where s.review_type = 'image'))::integer
    from public.customer_review_custom_submissions s
   where s.submitted_by = p_employee_id
     and s.submitted_at >= (p_review_month::timestamp at time zone 'Asia/Kolkata')
     and s.submitted_at <  ((p_review_month + interval '1 month')::timestamp at time zone 'Asia/Kolkata')
     and (p_excluding is null or s.id <> p_excluding);
$$;

revoke execute on function public.customer_review_custom_month_usage(uuid, date, uuid) from public, anon, authenticated;
grant  execute on function public.customer_review_custom_month_usage(uuid, date, uuid) to service_role;

-- SERVICE ROLE ONLY; the caller holds the per-employee month lock. Raises when
-- the submission (p_reapplying_id null) or the reapplication would break a rule.
create or replace function public.check_customer_review_custom_month_rules(
  p_employee_id    uuid,
  p_review_month   date,
  p_review_type    text,
  p_reapplying_id  uuid default null,
  p_previous_type  text default null
)
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_settings  public.boe_credit_settings%rowtype;
  v_submitted integer;
  v_images    integer;
  v_after     integer;
  v_remaining integer;
  v_required  integer;
begin
  select * into v_settings from public.boe_credit_settings order by created_at desc limit 1;
  if not found then
    raise exception 'BOE_CREDITS_SETTINGS: no active credit settings row'
      using errcode = 'P0002';
  end if;

  select u.submitted, u.image_reviews into v_submitted, v_images
    from public.customer_review_custom_month_usage(p_employee_id, p_review_month, p_reapplying_id) u;

  -- THE CAP: a new submission only. A reapplication already holds its slot.
  if p_reapplying_id is null and v_submitted + 1 > v_settings.max_monthly_review_submissions then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_MONTHLY_LIMIT: You have reached your monthly limit of % review submissions.',
      v_settings.max_monthly_review_submissions
      using errcode = '23514';
  end if;

  -- THE IMAGE MIX: a new text review, or a reapplication that turns an image
  -- review into a text review. Neither changes the image count; both leave one
  -- slot fewer (the reapplied row counts again under its new type).
  if p_review_type = 'text' and (p_reapplying_id is null or p_previous_type = 'image') then
    v_after     := v_submitted + 1;
    v_remaining := v_settings.max_monthly_review_submissions - v_after;
    v_required  := greatest(0, v_settings.minimum_monthly_image_reviews - v_images);
    if v_remaining < v_required then
      if p_reapplying_id is null then
        raise exception 'CUSTOMER_REVIEW_CUSTOM_IMAGE_REQUIRED: %',
          format('You have submitted %s %s this month. Your remaining %s %s to complete the monthly requirement of %s %s.',
            v_submitted, case when v_submitted = 1 then 'review' else 'reviews' end,
            v_remaining + 1,
            case when v_remaining + 1 = 1 then 'review must be an Image Review' else 'reviews must be Image Reviews' end,
            v_settings.minimum_monthly_image_reviews,
            case when v_settings.minimum_monthly_image_reviews = 1 then 'Image Review' else 'Image Reviews' end)
          using errcode = '23514';
      else
        raise exception 'CUSTOMER_REVIEW_CUSTOM_IMAGE_REQUIRED: %',
          format('Changing this review to a Text Review would leave too few slots for the monthly requirement of %s %s. Keep it as an Image Review.',
            v_settings.minimum_monthly_image_reviews,
            case when v_settings.minimum_monthly_image_reviews = 1 then 'Image Review' else 'Image Reviews' end)
          using errcode = '23514';
      end if;
    end if;
  end if;
end;
$$;

revoke execute on function public.check_customer_review_custom_month_rules(uuid, date, text, uuid, text) from public, anon, authenticated;
grant  execute on function public.check_customer_review_custom_month_rules(uuid, date, text, uuid, text) to service_role;

-- ═══ 8. Registration, re-created with the monthly rules ═══════════════════
--
-- The 20261205000000 §4 body; the only addition is the per-employee month lock
-- and the rules check, before the duplicate check and the insert.

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
  v_month  date := date_trunc('month', (now() at time zone 'Asia/Kolkata')::date)::date;
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

  -- THE MONTHLY RULES, under the employee's month lock: two requests racing for
  -- the last slot run one after the other, and the second counts the first.
  perform pg_advisory_xact_lock(hashtext('customer_review_custom_month'), hashtext(p_actor_id::text));
  perform public.check_customer_review_custom_month_rules(p_actor_id, v_month, p_review_type, null, null);

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

-- ═══ 9. Reapply ═══════════════════════════════════════════════════════════
--
-- SERVICE ROLE ONLY. The reapply route has authenticated the caller and, when
-- a new screenshot was sent, re-encoded and stored it under this submission's
-- id. Proof arguments are all null to keep the current screenshot. Returns
--   { submission, already_pending, previous_proof_storage_path }

create or replace function public.reapply_customer_review_custom_submission(
  p_submission_id        uuid,
  p_actor_id             uuid,
  p_review_type          text,
  p_published_on         date,
  p_remark               text,
  p_candidate_note       text,
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
  v_today    date := (now() at time zone 'Asia/Kolkata')::date;
  v_remark   text := nullif(btrim(coalesce(p_remark, '')), '');
  v_note     text := nullif(btrim(coalesce(p_candidate_note, '')), '');
  v_new_path boolean := p_proof_storage_path is not null;
  v_month    date;
  s          public.customer_review_custom_submissions%rowtype;
  v_previous text;
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
  if v_note is not null and length(v_note) > 500 then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_INVALID: Keep the note under 500 characters'
      using errcode = '22023';
  end if;
  if v_new_path and (
       split_part(p_proof_storage_path, '/', 1) <> p_submission_id::text
       or p_proof_file_name is null or p_proof_mime_type is null
       or p_proof_byte_size is null or p_proof_content_sha256 is null
     ) then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_INVALID: The new screenshot does not belong to this review'
      using errcode = '22023';
  end if;

  -- The same month lock the registration takes, then the row.
  perform pg_advisory_xact_lock(hashtext('customer_review_custom_month'), hashtext(p_actor_id::text));

  select * into s from public.customer_review_custom_submissions where id = p_submission_id for update;
  if not found then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_NOT_FOUND: That submission no longer exists' using errcode = 'P0002';
  end if;

  -- OWNERSHIP: nobody reapplies somebody else's review — administrators included.
  if s.submitted_by <> p_actor_id then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_NOT_OWNER: You can only reapply your own review' using errcode = '42501';
  end if;

  -- A retry of a reapplication that already went through: nothing to do.
  if s.status = 'pending_verification' then
    return jsonb_build_object('submission', to_jsonb(s), 'already_pending', true, 'previous_proof_storage_path', null);
  end if;
  if s.status = 'approved' then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_DECIDED: This review was already approved' using errcode = '55000';
  end if;

  v_month := date_trunc('month', (s.submitted_at at time zone 'Asia/Kolkata')::date)::date;
  if exists (
    select 1 from public.boe_credit_review_months m
     where m.employee_id = s.submitted_by and m.review_month = v_month and m.status = 'lapsed'
  ) then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_MONTH_CLOSED: %',
      format('%s has been closed for BOE Credits, so this review can no longer be reapplied.', trim(to_char(v_month, 'Month')) || ' ' || to_char(v_month, 'YYYY'))
      using errcode = '55000';
  end if;

  if v_new_path and exists (
    select 1 from public.customer_review_custom_submissions
     where submitted_by = p_actor_id
       and proof_content_sha256 = p_proof_content_sha256
       and status <> 'rejected'
       and id <> s.id
  ) then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_DUPLICATE: This screenshot has already been submitted'
      using errcode = '23505';
  end if;

  perform public.check_customer_review_custom_month_rules(p_actor_id, v_month, p_review_type, s.id, s.review_type);

  v_previous := case when v_new_path then s.proof_storage_path else null end;

  begin
    update public.customer_review_custom_submissions
       set status               = 'pending_verification',
           rejected_by          = null,
           rejected_at          = null,
           rejection_reason     = null,
           review_type          = p_review_type,
           published_on         = p_published_on,
           remark               = v_remark,
           candidate_note       = v_note,
           proof_storage_path   = case when v_new_path then p_proof_storage_path   else proof_storage_path   end,
           proof_file_name      = case when v_new_path then p_proof_file_name      else proof_file_name      end,
           proof_mime_type      = case when v_new_path then p_proof_mime_type      else proof_mime_type      end,
           proof_byte_size      = case when v_new_path then p_proof_byte_size      else proof_byte_size      end,
           proof_content_sha256 = case when v_new_path then p_proof_content_sha256 else proof_content_sha256 end,
           reapplication_count  = reapplication_count + 1,
           last_reapplied_at    = now()
     where id = s.id
     returning * into s;
  exception when unique_violation then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_DUPLICATE: This screenshot has already been submitted'
      using errcode = '23505';
  end;

  return jsonb_build_object('submission', to_jsonb(s), 'already_pending', false, 'previous_proof_storage_path', v_previous);
end;
$$;

revoke execute on function public.reapply_customer_review_custom_submission(uuid, uuid, text, date, text, text, text, text, text, integer, text)
  from public, anon, authenticated;
grant  execute on function public.reapply_customer_review_custom_submission(uuid, uuid, text, date, text, text, text, text, text, integer, text)
  to service_role;

comment on function public.reapply_customer_review_custom_submission(uuid, uuid, text, date, text, text, text, text, text, integer, text) is
  'SERVICE ROLE ONLY. Moves the caller''s OWN rejected custom review back to pending_verification on the same row, with their corrections and an optional note. Takes no second monthly slot; re-checks the image mix only when an image review becomes a text review; refuses a review whose month lapsed. A row already pending is returned unchanged. The history row and the reviewer notifications are written by the trail trigger.';

-- ═══ 10. Approve, re-created with the closed-month guard ══════════════════
--
-- The 20261205000000 §6 body; the addition is the employee's credits lock
-- (taken BEFORE the month is read, so a concurrent finalization cannot land
-- between the check and the reward) and the refusal of a lapsed month.

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
  v_month    date;
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

  if p_credits <> v_default and not public.can_manage_boe_credits() then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_CREDITS: Only a BOE Credits administrator can change the amount. The configured reward for this review type is % credits', v_default
      using errcode = '42501';
  end if;

  -- A CLOSED MONTH EARNS NOTHING NEW. Under the employee's credits lock, the
  -- same lock finalization takes, so the month cannot close in between.
  perform pg_advisory_xact_lock(hashtext('boe_credits'), hashtext(s.submitted_by::text));
  v_month := date_trunc('month', (s.submitted_at at time zone 'Asia/Kolkata')::date)::date;
  if exists (
    select 1 from public.boe_credit_review_months m
     where m.employee_id = s.submitted_by and m.review_month = v_month and m.status = 'lapsed'
  ) then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_MONTH_CLOSED: %',
      format('%s was closed below the monthly minimum for this employee, so this review can no longer earn credits. Reject it with that reason instead.',
        trim(to_char(v_month, 'Month')) || ' ' || to_char(v_month, 'YYYY'))
      using errcode = '55000';
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

-- ═══ 11. Generated reviews: paused for candidates ═════════════════════════
--
-- THE SWITCH IS A FUNCTION, so re-enabling is one `create or replace … select
-- true` in a later migration, and nothing about the generated workflow's
-- tables, functions or data changes in between.
--
-- THE TRIGGER FIRES ON THE ONE MOVE THAT STARTS THE FLOW — available → booked —
-- so book_customer_review_test_card() refuses without being re-created. It
-- does not touch a card already booked or submitted: a verifier still verifies
-- a submitted one, and its credit is posted as before. A verifier may still
-- book (audit and rehearsal); a server-side caller with no session is not a
-- browser and is let through.

create or replace function public.customer_review_generated_booking_enabled()
returns boolean
language sql
immutable
as $$
  select false;
$$;

revoke execute on function public.customer_review_generated_booking_enabled() from public, anon;
grant  execute on function public.customer_review_generated_booking_enabled() to authenticated, service_role;

create or replace function public.customer_review_generated_booking_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if public.customer_review_generated_booking_enabled() then
    return new;
  end if;
  if auth.uid() is null then
    return new;
  end if;
  if public.resolve_permission(auth.uid(), 'customer_review_requests', 'verify') then
    return new;
  end if;
  raise exception 'CUSTOMER_REVIEW_GENERATED_PAUSED: Generated reviews are paused for now. Submit a Custom Review instead.'
    using errcode = '55000';
end;
$$;

revoke execute on function public.customer_review_generated_booking_guard() from public, anon, authenticated;

drop trigger if exists customer_review_generated_booking_paused on public.customer_review_test_cards;
create trigger customer_review_generated_booking_paused
  before update of status on public.customer_review_test_cards
  for each row
  when (old.status = 'available' and new.status = 'booked')
  execute function public.customer_review_generated_booking_guard();

-- ═══ 12. Assertions ═══════════════════════════════════════════════════════

do $$
declare
  v_n   integer;
  v_src text;
begin
  -- 12a. the two notification values
  select count(*) into v_n
    from pg_enum e join pg_type t on t.oid = e.enumtypid
   where t.typname = 'notification_type'
     and e.enumlabel in ('customer_review_submitted', 'customer_review_reapplied');
  if v_n <> 2 then
    raise exception 'CUSTOM_REVIEW_PHASE: expected both notification types, found %', v_n;
  end if;

  -- 12b. the settings columns, and an active row that carries them
  select count(*) into v_n from information_schema.columns
   where table_schema = 'public' and table_name = 'boe_credit_settings'
     and column_name in ('max_monthly_review_submissions', 'minimum_monthly_image_reviews');
  if v_n <> 2 then
    raise exception 'CUSTOM_REVIEW_PHASE: the two monthly settings columns are missing';
  end if;

  -- 12c. the history table: RLS on, one SELECT policy, no client write
  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'customer_review_custom_submission_events' and c.relrowsecurity
  ) then
    raise exception 'CUSTOM_REVIEW_PHASE: row security is not enabled on the history';
  end if;
  select count(*) into v_n from pg_policies
   where schemaname = 'public' and tablename = 'customer_review_custom_submission_events';
  if v_n <> 1 or exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'customer_review_custom_submission_events' and cmd <> 'SELECT'
  ) then
    raise exception 'CUSTOM_REVIEW_PHASE: expected exactly one SELECT policy on the history, found %', v_n;
  end if;
  if has_table_privilege('authenticated', 'public.customer_review_custom_submission_events', 'INSERT')
     or has_table_privilege('authenticated', 'public.customer_review_custom_submission_events', 'UPDATE')
     or has_table_privilege('authenticated', 'public.customer_review_custom_submission_events', 'DELETE')
     or has_table_privilege('anon', 'public.customer_review_custom_submission_events', 'SELECT') then
    raise exception 'CUSTOM_REVIEW_PHASE: a client role can write the history (or anon read it)';
  end if;

  -- 12d. every submission has its submitted event
  select count(*) into v_n from public.customer_review_custom_submissions s
   where not exists (
     select 1 from public.customer_review_custom_submission_events e
      where e.submission_id = s.id and e.event_type = 'submitted'
   );
  if v_n <> 0 then
    raise exception 'CUSTOM_REVIEW_PHASE: % submission(s) have no submitted event', v_n;
  end if;

  -- 12e. the server-side functions are service role only; the approval stays a browser RPC
  if has_function_privilege('authenticated', 'public.reapply_customer_review_custom_submission(uuid, uuid, text, date, text, text, text, text, text, integer, text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.reapply_customer_review_custom_submission(uuid, uuid, text, date, text, text, text, text, text, integer, text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.check_customer_review_custom_month_rules(uuid, date, text, uuid, text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.customer_review_custom_month_usage(uuid, date, uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.customer_review_custom_reviewer_ids(uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.create_customer_review_custom_submission(uuid, uuid, text, date, text, text, text, text, integer, text)', 'EXECUTE') then
    raise exception 'CUSTOM_REVIEW_PHASE: a client role can execute a service-role function';
  end if;
  if not has_function_privilege('service_role', 'public.reapply_customer_review_custom_submission(uuid, uuid, text, date, text, text, text, text, text, integer, text)', 'EXECUTE') then
    raise exception 'CUSTOM_REVIEW_PHASE: service_role cannot reapply';
  end if;
  if not has_function_privilege('authenticated', 'public.approve_customer_review_custom_submission(uuid, numeric)', 'EXECUTE')
     or has_function_privilege('anon', 'public.approve_customer_review_custom_submission(uuid, numeric)', 'EXECUTE') then
    raise exception 'CUSTOM_REVIEW_PHASE: the approval grants changed';
  end if;

  -- 12f. the functions carry what this file says they carry
  select prosrc into v_src from pg_proc
   where oid = to_regprocedure('public.create_customer_review_custom_submission(uuid, uuid, text, date, text, text, text, text, integer, text)');
  if v_src is null or position('check_customer_review_custom_month_rules(' in v_src) = 0
     or position('pg_advisory_xact_lock(hashtext(''customer_review_custom_month'')' in v_src) = 0 then
    raise exception 'CUSTOM_REVIEW_PHASE: the registration does not apply the monthly rules under the month lock';
  end if;
  select prosrc into v_src from pg_proc
   where oid = to_regprocedure('public.approve_customer_review_custom_submission(uuid, numeric)');
  if v_src is null or position('CUSTOMER_REVIEW_CUSTOM_MONTH_CLOSED' in v_src) = 0 then
    raise exception 'CUSTOM_REVIEW_PHASE: the approval does not refuse a lapsed month';
  end if;
  select prosrc into v_src from pg_proc
   where oid = to_regprocedure('public.customer_review_custom_submissions_guard()');
  if v_src is null or position('old.status = ''rejected'' and new.status = ''pending_verification''' in v_src) = 0 then
    raise exception 'CUSTOM_REVIEW_PHASE: the guard does not admit a reapplication';
  end if;

  -- 12g. the triggers exist
  if not exists (
    select 1 from pg_trigger
     where tgrelid = 'public.customer_review_custom_submissions'::regclass
       and tgname = 'customer_review_custom_submissions_trail' and not tgisinternal
  ) then
    raise exception 'CUSTOM_REVIEW_PHASE: the trail trigger is missing';
  end if;
  if not exists (
    select 1 from pg_trigger
     where tgrelid = 'public.customer_review_test_cards'::regclass
       and tgname = 'customer_review_generated_booking_paused' and not tgisinternal
  ) then
    raise exception 'CUSTOM_REVIEW_PHASE: the booking pause trigger is missing';
  end if;
  if public.customer_review_generated_booking_enabled() then
    raise exception 'CUSTOM_REVIEW_PHASE: generated booking is supposed to be paused';
  end if;

  -- 12h. NOTHING WAS POSTED TO THE LEDGER
  select count(*) into v_n from public.boe_credit_transactions where created_at >= transaction_timestamp();
  if v_n <> 0 then
    raise exception 'CUSTOM_REVIEW_PHASE: this migration posted % ledger row(s); it must post none', v_n;
  end if;
end $$;
