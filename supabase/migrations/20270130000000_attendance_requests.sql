-- ═══════════════════════════════════════════════════════════════════════════
-- 20270130000000  Attendance requests → approval → payroll review
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT THIS ADDS
-- --------------
--   public.attendance_requests        an employee's own late arrival, early
--                                     departure, time out, half day or leave
--                                     request, and the admin's decision on it
--   public.attendance_request_events  append-only audit trail, written by
--                                     trigger in the same statement as the
--                                     change it records
--   public.attendance_day_reviews     the payroll reviewer's excuse and
--                                     salary-treatment decision for one
--                                     attendance event, versioned
--
-- WHAT THIS DOES NOT DO
-- ---------------------
-- Nothing here changes a punch, a classification, a deduction, a salary or an
-- adjustment. attendance_records (the raw machine data) and
-- attendance_day_corrections (the one admin path that changes pay) are not
-- referenced. A request, an approval and a review decision are all RECORDS;
-- the payroll engine does not read any of these tables. Applying a pay
-- decision still happens through the existing attendance-correction waiver,
-- so the same minutes can never be deducted, or waived, by two paths.
--
-- ACCESS
-- ------
-- Reads: an employee reads their own rows; an active admin reads everything.
-- Writes: none for any client. Every insert and update goes through the
-- service-role routes under src/app/api/attendance-requests, which take the
-- caller's identity from the bearer token — the same model as
-- attendance_day_corrections (20260807000000). No UPDATE or DELETE policy
-- exists for anybody, and triggers refuse edits to a request's submitted
-- content even from the service role: a correction is a NEW row.
--
-- PRODUCTION SAFETY
-- -----------------
-- Purely additive: three new tables, their triggers, indexes and policies.
-- No existing table, policy, grant or row is touched. Re-running is safe.
--
-- ROLLBACK
-- --------
--   drop table if exists public.attendance_day_reviews;
--   drop table if exists public.attendance_request_events;
--   drop table if exists public.attendance_requests;
--   drop function if exists public.attendance_requests_guard();
--   drop function if exists public.attendance_requests_audit();
--   drop function if exists public.attendance_request_events_guard();
--   drop function if exists public.attendance_day_reviews_supersede();
--   drop function if exists public.attendance_day_reviews_guard();
-- Lossless for payroll: nothing that calculates pay reads these tables.

-- ─── 1. Requests ─────────────────────────────────────────────────────────────

create table if not exists public.attendance_requests (
  id                    uuid        not null default gen_random_uuid() primary key,
  employee_id           uuid        not null references public.users(id) on delete cascade,

  request_type          text        not null check (request_type in (
                          'late_arrival', 'early_departure', 'time_out', 'half_day', 'full_day_leave')),

  -- Single-day types store start_date = end_date.
  start_date            date        not null,
  end_date              date        not null,

  -- IST wall-clock times, as the employee stated them.
  expected_arrival_time time,          -- late_arrival, optional
  departure_time        time,          -- early_departure, time_out
  return_time           time,          -- time_out
  half_session          text        check (half_session is null or half_session in ('first_half', 'second_half')),
  work_kind             text        check (work_kind is null or work_kind in ('personal', 'company')),

  reason_code           text        not null check (reason_code in (
                          'company_vehicle', 'company_work', 'personal', 'medical',
                          'family_emergency', 'traffic', 'other')),
  reason_note           text        check (reason_note is null or char_length(reason_note) <= 500),

  -- The server's clock at insert, never the browser's. original_submitted_at
  -- is the first submission in a correction chain, so correcting a typo in an
  -- on-time request does not turn it into a late one.
  submitted_at          timestamptz not null default now(),
  original_submitted_at timestamptz not null default now(),
  -- Scheduled shift start of start_date (company schedule, IST), as used for
  -- the informed-on-time decision, and that decision. Computed by the route.
  shift_start_at        timestamptz not null,
  informed_before_shift boolean     not null,

  status                text        not null default 'pending'
                                    check (status in ('pending', 'approved', 'rejected', 'cancelled')),

  decided_by            uuid        references public.users(id),
  decided_at            timestamptz,
  decision_note         text,

  cancelled_at          timestamptz,
  cancel_reason         text,

  -- A correction is a new row pointing at the one it replaces.
  replaces_request_id   uuid        references public.attendance_requests(id),

  -- Who made the latest change — read by the audit trigger. Set by the route.
  updated_by            uuid        references public.users(id),
  updated_at            timestamptz not null default now(),

  constraint attendance_requests_date_order check (end_date >= start_date),
  constraint attendance_requests_single_day check (
    request_type = 'full_day_leave' or end_date = start_date
  ),
  constraint attendance_requests_shape check (
    case request_type
      when 'late_arrival'    then departure_time is null and return_time is null and half_session is null
      when 'early_departure' then departure_time is not null and return_time is null and half_session is null
                                  and expected_arrival_time is null
      when 'time_out'        then departure_time is not null and return_time is not null
                                  and return_time > departure_time and work_kind is not null
                                  and half_session is null and expected_arrival_time is null
      when 'half_day'        then half_session is not null and departure_time is null
                                  and return_time is null and expected_arrival_time is null
      when 'full_day_leave'  then departure_time is null and return_time is null
                                  and half_session is null and expected_arrival_time is null
    end
  ),
  constraint attendance_requests_other_needs_note check (
    reason_code <> 'other' or btrim(coalesce(reason_note, '')) <> ''
  ),
  constraint attendance_requests_rejection_needs_note check (
    status <> 'rejected' or btrim(coalesce(decision_note, '')) <> ''
  ),
  constraint attendance_requests_decision_consistent check (
    (status in ('approved', 'rejected')) = (decided_by is not null and decided_at is not null)
    or status = 'cancelled'
  ),
  constraint attendance_requests_cancel_consistent check (
    (status = 'cancelled') = (cancelled_at is not null)
  )
);

comment on table public.attendance_requests is
  'Employee attendance requests (late arrival, early departure, time out, half day, leave) and the admin decision. A record only: payroll never reads it.';

create index if not exists attendance_requests_employee_dates
  on public.attendance_requests (employee_id, start_date, end_date);
create index if not exists attendance_requests_status_submitted
  on public.attendance_requests (status, submitted_at desc);
create index if not exists attendance_requests_dates
  on public.attendance_requests (start_date, end_date);
-- A request can be replaced once; a second correction replaces the newest row.
create unique index if not exists attendance_requests_replaced_once
  on public.attendance_requests (replaces_request_id)
  where replaces_request_id is not null;

-- ─── 2. Audit events ─────────────────────────────────────────────────────────

create table if not exists public.attendance_request_events (
  id           uuid        not null default gen_random_uuid() primary key,
  request_id   uuid        not null references public.attendance_requests(id) on delete cascade,
  employee_id  uuid        not null references public.users(id) on delete cascade,
  action       text        not null,
  actor_id     uuid        references public.users(id),
  status_from  text,
  status_to    text        not null,
  note         text,
  snapshot     jsonb       not null,
  created_at   timestamptz not null default now(),

  constraint attendance_request_events_action_known check (action in (
    'submitted', 'corrected', 'replaced', 'cancelled',
    'approved', 'rejected', 'decision_revised'))
);

create index if not exists attendance_request_events_request
  on public.attendance_request_events (request_id, created_at);

-- ─── 3. Guard: what may change on a request ──────────────────────────────────

create or replace function public.attendance_requests_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_old public.attendance_requests;
begin
  if tg_op = 'INSERT' then
    if new.status <> 'pending' then
      raise exception 'ATTENDANCE_REQUEST_INVALID: a request is submitted as pending';
    end if;
    new.submitted_at := now();
    new.updated_at   := now();
    if new.updated_by is null then new.updated_by := new.employee_id; end if;

    -- A correction retires the row it replaces in the same statement, so a
    -- failed insert can never leave the original cancelled.
    if new.replaces_request_id is not null then
      select * into v_old from public.attendance_requests
       where id = new.replaces_request_id for update;
      if not found or v_old.employee_id <> new.employee_id then
        raise exception 'ATTENDANCE_REQUEST_NOT_FOUND: the request being corrected does not exist';
      end if;
      if v_old.status not in ('pending', 'approved') then
        raise exception 'ATTENDANCE_REQUEST_CLOSED: only a pending or approved request can be corrected';
      end if;
      new.original_submitted_at := v_old.original_submitted_at;
      update public.attendance_requests
         set status        = 'cancelled',
             cancelled_at  = now(),
             cancel_reason = 'Replaced by a correction',
             updated_by    = new.updated_by
       where id = v_old.id;
    else
      new.original_submitted_at := new.submitted_at;
    end if;
    return new;
  end if;

  -- UPDATE: the submitted content is immutable. A correction is a new row.
  if (new.employee_id, new.request_type, new.start_date, new.end_date,
      new.expected_arrival_time, new.departure_time, new.return_time,
      new.half_session, new.work_kind, new.reason_code, new.reason_note,
      new.submitted_at, new.original_submitted_at, new.shift_start_at,
      new.informed_before_shift, new.replaces_request_id)
     is distinct from
     (old.employee_id, old.request_type, old.start_date, old.end_date,
      old.expected_arrival_time, old.departure_time, old.return_time,
      old.half_session, old.work_kind, old.reason_code, old.reason_note,
      old.submitted_at, old.original_submitted_at, old.shift_start_at,
      old.informed_before_shift, old.replaces_request_id) then
    raise exception 'ATTENDANCE_REQUEST_IMMUTABLE: a submitted request cannot be edited; submit a correction';
  end if;

  if new.status is distinct from old.status then
    if not (
         (old.status = 'pending'  and new.status in ('approved', 'rejected', 'cancelled'))
      or (old.status = 'approved' and new.status in ('rejected', 'cancelled'))
      or (old.status = 'rejected' and new.status = 'approved')
    ) then
      raise exception 'ATTENDANCE_REQUEST_TRANSITION: % → % is not allowed', old.status, new.status;
    end if;
    -- Revising a decision that was already made needs a stated reason.
    if old.status in ('approved', 'rejected') and new.status in ('approved', 'rejected')
       and btrim(coalesce(new.decision_note, '')) = '' then
      raise exception 'ATTENDANCE_REQUEST_NOTE_REQUIRED: revising a decision needs a reason';
    end if;
  elsif old.status in ('cancelled', 'rejected') then
    raise exception 'ATTENDANCE_REQUEST_CLOSED: this request is closed';
  end if;

  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists attendance_requests_guard on public.attendance_requests;
create trigger attendance_requests_guard
  before insert or update on public.attendance_requests
  for each row execute function public.attendance_requests_guard();

-- ─── 4. Audit: one event per change, in the same statement ───────────────────

create or replace function public.attendance_requests_audit()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_action text;
  v_note   text;
begin
  if tg_op = 'INSERT' then
    v_action := case when new.replaces_request_id is null then 'submitted' else 'corrected' end;
    v_note   := null;
  elsif new.status = old.status then
    return new;   -- nothing an auditor needs (updated_at bookkeeping only)
  elsif new.status = 'cancelled' then
    v_action := case when new.cancel_reason = 'Replaced by a correction' then 'replaced' else 'cancelled' end;
    v_note   := new.cancel_reason;
  elsif old.status in ('approved', 'rejected') then
    v_action := 'decision_revised';
    v_note   := new.decision_note;
  else
    v_action := new.status;   -- approved | rejected
    v_note   := new.decision_note;
  end if;

  insert into public.attendance_request_events
    (request_id, employee_id, action, actor_id, status_from, status_to, note, snapshot)
  values
    (new.id, new.employee_id, v_action, new.updated_by,
     case when tg_op = 'INSERT' then null else old.status end,
     new.status, v_note, to_jsonb(new));
  return new;
end;
$$;

drop trigger if exists attendance_requests_audit on public.attendance_requests;
create trigger attendance_requests_audit
  after insert or update on public.attendance_requests
  for each row execute function public.attendance_requests_audit();

create or replace function public.attendance_request_events_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception 'ATTENDANCE_REQUEST_EVENTS_APPEND_ONLY: the audit trail cannot be changed';
end;
$$;

drop trigger if exists attendance_request_events_guard on public.attendance_request_events;
create trigger attendance_request_events_guard
  before update on public.attendance_request_events
  for each row execute function public.attendance_request_events_guard();

-- ─── 5. Payroll review decisions ─────────────────────────────────────────────
--
-- One CURRENT row per (employee, date, event). Saving again inserts a new row;
-- the trigger retires the previous one in the same statement, so history is
-- never overwritten and there is never a moment with two current rows.
--
-- `attendance_fingerprint` is what the event looked like when it was decided
-- (effective punches, correction and request state). When the underlying
-- attendance later changes, the fingerprint no longer matches and the review
-- screen asks for the event to be reviewed again instead of trusting it.

create table if not exists public.attendance_day_reviews (
  id                     uuid        not null default gen_random_uuid() primary key,
  employee_id            uuid        not null references public.users(id) on delete cascade,
  attendance_date        date        not null,
  event_key              text        not null check (event_key ~ '^(late_arrival|early_departure|missing_punch|absent|request:[0-9a-f-]{36})$'),

  -- Late arrivals only: the reviewer accepts the lateness as excused (an
  -- emergency reported late, a company vehicle delay …). An excused late
  -- arrival does not count towards the monthly policy flag.
  excused                boolean     not null default false,
  excuse_reason          text,

  pay_decision           text        check (pay_decision is null or pay_decision in (
                                       'paid_waived', 'use_paid_leave', 'unpaid_actual', 'needs_correction')),
  decision_reason        text,

  attendance_fingerprint text        not null,

  reviewed_by            uuid        not null references public.users(id),
  reviewed_at            timestamptz not null default now(),

  is_current             boolean     not null default true,
  superseded_at          timestamptz,

  constraint attendance_day_reviews_excuse_reason check (
    not excused or btrim(coalesce(excuse_reason, '')) <> ''
  ),
  constraint attendance_day_reviews_decision_reason check (
    pay_decision is null or btrim(coalesce(decision_reason, '')) <> ''
  ),
  constraint attendance_day_reviews_supersede_consistent check (
    (is_current and superseded_at is null) or (not is_current and superseded_at is not null)
  )
);

create unique index if not exists attendance_day_reviews_current_unique
  on public.attendance_day_reviews (employee_id, attendance_date, event_key)
  where is_current;
create index if not exists attendance_day_reviews_date
  on public.attendance_day_reviews (attendance_date);

create or replace function public.attendance_day_reviews_supersede()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.is_current    := true;
  new.superseded_at := null;
  new.reviewed_at   := now();
  update public.attendance_day_reviews
     set is_current = false, superseded_at = now()
   where employee_id = new.employee_id
     and attendance_date = new.attendance_date
     and event_key = new.event_key
     and is_current;
  return new;
end;
$$;

drop trigger if exists attendance_day_reviews_supersede on public.attendance_day_reviews;
create trigger attendance_day_reviews_supersede
  before insert on public.attendance_day_reviews
  for each row execute function public.attendance_day_reviews_supersede();

-- The only update ever allowed is retiring a current row.
create or replace function public.attendance_day_reviews_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if old.is_current and not new.is_current and new.superseded_at is not null
     and (to_jsonb(new) - 'is_current' - 'superseded_at')
       = (to_jsonb(old) - 'is_current' - 'superseded_at') then
    return new;
  end if;
  raise exception 'ATTENDANCE_DAY_REVIEWS_APPEND_ONLY: a review decision cannot be edited; record a new one';
end;
$$;

drop trigger if exists attendance_day_reviews_guard on public.attendance_day_reviews;
create trigger attendance_day_reviews_guard
  before update on public.attendance_day_reviews
  for each row execute function public.attendance_day_reviews_guard();

-- ─── 6. Row level security ───────────────────────────────────────────────────

alter table public.attendance_requests       enable row level security;
alter table public.attendance_request_events enable row level security;
alter table public.attendance_day_reviews    enable row level security;

drop policy if exists "attendance_requests_select" on public.attendance_requests;
create policy "attendance_requests_select" on public.attendance_requests
  for select to authenticated
  using (
    employee_id = auth.uid()
    or exists (select 1 from public.users
                where users.id = auth.uid() and users.is_active and users.role = 'admin')
  );

drop policy if exists "attendance_request_events_select" on public.attendance_request_events;
create policy "attendance_request_events_select" on public.attendance_request_events
  for select to authenticated
  using (
    employee_id = auth.uid()
    or exists (select 1 from public.users
                where users.id = auth.uid() and users.is_active and users.role = 'admin')
  );

-- Payroll review decisions are the reviewer's working notes on salary
-- treatment; the employee sees the outcome on their payslip, not these rows.
drop policy if exists "attendance_day_reviews_admin_select" on public.attendance_day_reviews;
create policy "attendance_day_reviews_admin_select" on public.attendance_day_reviews
  for select to authenticated
  using (
    exists (select 1 from public.users
             where users.id = auth.uid() and users.is_active and users.role = 'admin')
  );

-- RLS decides the rows; these decide the verbs. SELECT only: every write is a
-- service-role route.
revoke all on public.attendance_requests       from anon, authenticated;
revoke all on public.attendance_request_events from anon, authenticated;
revoke all on public.attendance_day_reviews    from anon, authenticated;
grant select on public.attendance_requests       to authenticated;
grant select on public.attendance_request_events to authenticated;
grant select on public.attendance_day_reviews    to authenticated;
