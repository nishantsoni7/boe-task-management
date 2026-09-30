-- ═══════════════════════════════════════════════════════════════════════════
-- Review Workflow — admin reporting and the shared monthly leaderboard.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT THIS ADDS (read-only: no table is changed, no credit moves, no ledger row rewritten)
-- ----------------------------------------------------------------
--   customer_review_report(month, employee, type, status)              verifier: the whole dashboard, one call
--   customer_review_report_list(month, employee, type, status, focus, limit, offset)
--                                                                      verifier: one page of the matching reviews
--   customer_review_leaderboard(month)                                 every signed-in employee
--   customer_review_leader_card()                                      every signed-in employee: the dashboard card
--   customer_review_credits_per_point()                                the one place the conversion lives (10 credits = 1 point)
--   customer_review_report_rows(...)                                   internal: the single definition of a row
--   customer_review_month_standings(month)                             internal: one month's ranking input
--
-- THE DEFINITIONS, STATED ONCE — every card, chart, table and the leaderboard read them
-- --------------------------------------------------------------------------------------
--   MONTH. The Asia/Kolkata calendar month of submitted_at — the FIRST submission,
--   the same date the credit is attributed to (a review edited in October that was
--   first submitted in September stays a September review). Daily bars use the same
--   IST date.
--
--   SUBMITTED. Every custom review submitted in the month that is not deleted:
--   pending, approved and rejected. Deleted reviews are left out of every total
--   and stay in the admin history.
--
--   TYPE. review_type, exactly one of 'text' or 'image', stored on the row and chosen
--   by the employee. A review is one or the other — the form has no "both" — so
--   text + image = submitted, always. Every custom review carries a screenshot, and
--   that does not make it an Image Review: the type is the employee's stated review
--   type, the same one that decides its reward and the monthly image requirement.
--
--   CATEGORY. Custom reviews carry no category beyond their type (the generated-review
--   "test categories" belong to a different workflow). The category breakdown is
--   therefore type by status, and the category filter is the type filter.
--
--   REWARD-ELIGIBLE ("earned"). A submitted review that is APPROVED, has a posted credit,
--   whose credit nothing has reversed (no ledger reversal row: an employee's delete, a
--   rejected edit, a confirmed duplicate or an administrator's reversal all post one),
--   and that is not a confirmed duplicate. It does NOT depend on whether the review
--   month was later closed: a closed month EXPIRES the month's provisional credits (a
--   ledger review_month_lapse row), it does not reject or reverse the reviews, so the
--   historical result stays (see EXPIRED below). Excluded from eligible, and only from
--   eligible: deleted reviews (out of every total), rejected ones, confirmed duplicates,
--   reviews still Pending Approval — including an APPROVED REVIEW EDITED AND WAITING FOR
--   RE-APPROVAL (see HELD) — and reversed credits. Eligible <= submitted, always.
--
--   CREDITS. The credits on the eligible reviews (credits_awarded, the numbers the ledger
--   holds). No rate is invented: Text and Image rewards, caps and approval rules are the
--   existing ones.
--
--   EXPIRED. Of the eligible credits, those whose review month was closed below the
--   monthly minimum (boe_credit_review_months.status = 'lapsed'). Shown as expired, never
--   as rejected, and never subtracted from earned.
--
--   REVERSED. A review that had a credit the ledger has since reversed. It is submitted,
--   not eligible, and counted here so a later reversal is visible. A reversal after the
--   month was reported changes that month's report retroactively: reports always show the
--   ledger as it stands, and a month's qualification (already recorded) is not reopened.
--
--   HELD. An APPROVED review the employee edited: back to Pending Approval, its posted
--   credit still on the ledger untouched (the ledger cannot pay it twice or re-price it),
--   but NOT eligible and NOT ranked while pending. Re-approval posts nothing and makes it
--   eligible again; rejection or deletion reverses the credit once. Reported as held.
--
--   CONFIRMED DUPLICATE. A review with a 'duplicate' decision on its current check. It is
--   rejected and its credit reversed (20270224000000), so it is submitted, shown with its
--   status and a "confirmed duplicate" mark, and excluded from eligible and the leaderboard.
--
--   POINTS. Review-earned points = credits / customer_review_credits_per_point() (10):
--   credits = points x 10. Credits are numeric(12,2), so points are exact to three
--   decimals (round(…, 3) only tidies the trailing zeros of the division; it never changes a value) (1 credit = 0.1 point, 1.5 credits = 0.15, 0.01 credit = 0.001) and are never
--   rounded in SQL. They are recomputed for each month and never carried over. Points are a
--   view of review credits; the performance-module score is neither read nor changed, and
--   no ledger row is rewritten.
--
--   POSSIBLE DUPLICATES AWAITING A DECISION. Reviews of the month whose latest
--   duplicate check has an undecided strong or moderate flag.
--
--   ZERO-SUBMISSION EMPLOYEES. The employee comparison lists every active employee who
--   may use the workflow (resolve_permission 'use') plus anyone with reviews in the
--   filtered set, so the lowest activity is visible.
--
--   LEADERBOARD. Ranked by eligible review count for the month; equal counts SHARE a
--   rank (1, 1, 3). Display order (count, then name) is stable and does not hide a tie.
--   "You need X more reviews to take first place": X = leader count - your count + 1, which
--   is also what a JOINT leader needs to become sole leader (1); with no eligible review
--   anywhere it is 1.
--
-- WHO MAY CALL. The report functions need customer_review_requests.verify (checked in
-- the function; the caller's identity is auth.uid()). The leaderboard functions need only
-- an active signed-in account. All are SECURITY DEFINER with a pinned search_path and
-- return aggregates or one page of rows; none returns a review's text or proof.
--
-- PRODUCTION SAFETY. Functions and one index only. Re-runnable.
-- DEPLOYMENT ORDER. After 20270224000000; before the application code.
-- ROLLBACK
--   drop function if exists public.customer_review_leader_card();
--   drop function if exists public.customer_review_leaderboard(date);
--   drop function if exists public.customer_review_report_list(date, uuid, text, text, text, integer, integer);
--   drop function if exists public.customer_review_report(date, uuid, text, text);
--   drop function if exists public.customer_review_month_standings(date);
--   drop function if exists public.customer_review_report_rows(date, date, uuid, text, text);
--   drop function if exists public.customer_review_credits_per_point();
--   drop index    if exists public.customer_review_custom_submissions_submitted_at_idx;

create index if not exists customer_review_custom_submissions_submitted_at_idx
  on public.customer_review_custom_submissions (submitted_at);

-- ═══ 1. The points multiplier ═════════════════════════════════════════════

create or replace function public.customer_review_credits_per_point()
returns numeric
language sql
immutable
as $$ select 10::numeric $$;

revoke execute on function public.customer_review_credits_per_point() from public, anon;
grant  execute on function public.customer_review_credits_per_point() to authenticated, service_role;

-- ═══ 2. One definition of a review row ════════════════════════════════════
--
-- INTERNAL: revoked from every client role; the report and leaderboard functions
-- (definers) call it. p_from / p_to are Asia/Kolkata calendar dates, [from, to).

create or replace function public.customer_review_report_rows(
  p_from     date,
  p_to       date,
  p_employee uuid default null,
  p_type     text default null,
  p_status   text default null
)
returns table (
  id                   uuid,
  submitted_by         uuid,
  submission_ref       text,
  review_type          text,
  status               text,
  submitted_at         timestamptz,
  published_on         date,
  reward_held          boolean,
  edit_count           integer,
  day                  date,
  month                date,
  eligible             boolean,
  credits              numeric,
  expired              boolean,
  reversed             boolean,
  held                 boolean,
  held_credits         numeric,
  confirmed_duplicate  boolean,
  dup_open             boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select s.id, s.submitted_by, s.submission_ref, s.review_type, s.status, s.submitted_at, s.published_on,
         s.reward_held, s.edit_count,
         (s.submitted_at at time zone 'Asia/Kolkata')::date                                        as day,
         date_trunc('month', (s.submitted_at at time zone 'Asia/Kolkata')::date)::date             as month,
         x.earned                                                                                   as eligible,
         case when x.earned then s.credits_awarded else 0 end                                       as credits,
         (x.earned and x.lapsed)                                                                    as expired,
         x.was_reversed                                                                             as reversed,
         x.is_held                                                                                  as held,
         case when x.is_held then s.credits_awarded else 0 end                                      as held_credits,
         x.confirmed                                                                                as confirmed_duplicate,
         coalesce(d.flags_open, 0) > 0                                                              as dup_open
    from public.customer_review_custom_submissions s
    left join public.customer_review_custom_duplicate_summary d on d.submission_id = s.id
    cross join lateral (
      select
        coalesce(d.decided_duplicate, 0) > 0 as confirmed,
        -- a credit the ledger has reversed (a delete, a rejected edit, a confirmed duplicate, an admin reversal)
        ( s.reward_reversal_transaction_id is not null
          or (s.credit_transaction_id is not null and exists (
                select 1 from public.boe_credit_transactions rv
                 where rv.transaction_type = 'reversal'
                   and rv.source_type = 'boe_credit_transaction'
                   and rv.source_id = s.credit_transaction_id)) ) as was_reversed,
        exists (
          select 1 from public.boe_credit_review_months m
           where m.employee_id = s.submitted_by
             and m.review_month = date_trunc('month', (s.submitted_at at time zone 'Asia/Kolkata')::date)::date
             and m.status = 'lapsed') as lapsed,
        -- earned: approved, credited, not reversed, not a confirmed duplicate
        ( s.status = 'approved'
          and s.credit_transaction_id is not null
          and coalesce(s.credits_awarded, 0) > 0
          and s.reward_reversal_transaction_id is null
          and not exists (
                select 1 from public.boe_credit_transactions rv
                 where rv.transaction_type = 'reversal'
                   and rv.source_type = 'boe_credit_transaction'
                   and rv.source_id = s.credit_transaction_id)
          and coalesce(d.decided_duplicate, 0) = 0 ) as earned,
        -- held: an approved review edited and waiting; its credit is still on the ledger
        ( s.status = 'pending_verification' and s.reward_held
          and s.credit_transaction_id is not null
          and not exists (
                select 1 from public.boe_credit_transactions rv
                 where rv.transaction_type = 'reversal'
                   and rv.source_type = 'boe_credit_transaction'
                   and rv.source_id = s.credit_transaction_id) ) as is_held
    ) x
   where s.deleted_at is null
     and s.submitted_at >= (p_from::timestamp at time zone 'Asia/Kolkata')
     and s.submitted_at <  (p_to::timestamp   at time zone 'Asia/Kolkata')
     and (p_employee is null or s.submitted_by = p_employee)
     and (p_type   is null or s.review_type = p_type)
     and (p_status is null or s.status = p_status);
$$;

revoke execute on function public.customer_review_report_rows(date, date, uuid, text, text) from public, anon, authenticated, service_role;

-- ═══ 3. The admin dashboard ═══════════════════════════════════════════════

create or replace function public.customer_review_report(
  p_month    date default null,
  p_employee uuid default null,
  p_type     text default null,
  p_status   text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid     uuid := auth.uid();
  v_today   date := (now() at time zone 'Asia/Kolkata')::date;
  v_current date := date_trunc('month', (now() at time zone 'Asia/Kolkata')::date)::date;
  v_month   date := coalesce(date_trunc('month', p_month)::date, v_current);
  v_to      date;
  v_hist_from date;
  v_cpp     numeric := public.customer_review_credits_per_point();
  v_result  jsonb;
begin
  if v_uid is null or not exists (
    select 1 from public.users u where u.id = v_uid and u.is_active and coalesce(u.is_deleted, false) = false
  ) then
    raise exception 'CUSTOMER_REVIEW_REPORT_UNAUTHORIZED: Sign in to continue' using errcode = '42501';
  end if;
  if not public.resolve_permission(v_uid, 'customer_review_requests', 'verify') then
    raise exception 'CUSTOMER_REVIEW_REPORT_UNAUTHORIZED: The review report needs the Verify permission' using errcode = '42501';
  end if;
  if p_type is not null and p_type not in ('text', 'image') then
    raise exception 'CUSTOMER_REVIEW_REPORT_INVALID: Choose Text or Image' using errcode = '22023';
  end if;
  if p_status is not null and p_status not in ('pending_verification', 'approved', 'rejected') then
    raise exception 'CUSTOMER_REVIEW_REPORT_INVALID: Choose a review status' using errcode = '22023';
  end if;
  if v_month > v_current then
    raise exception 'CUSTOMER_REVIEW_REPORT_INVALID: That month has not started' using errcode = '22023';
  end if;

  v_to        := (v_month + interval '1 month')::date;
  v_hist_from := (v_month - interval '11 months')::date;

  with r as (
    select * from public.customer_review_report_rows(v_month, v_to, p_employee, p_type, p_status)
  ),
  hist as (
    select * from public.customer_review_report_rows(v_hist_from, v_to, p_employee, p_type, p_status)
  ),
  people as (
    select u.id, u.full_name
      from public.users u
     where u.is_active = true and coalesce(u.is_deleted, false) = false
       and public.resolve_permission(u.id, 'customer_review_requests', 'use')
    union
    select u.id, u.full_name
      from public.users u
     where u.id in (select submitted_by from r)
  ),
  emp as (
    select p.id                                                          as employee_id,
           coalesce(nullif(btrim(p.full_name), ''), 'Unknown')            as name,
           count(r.id)::integer                                           as submitted,
           count(r.id) filter (where r.review_type = 'text')::integer     as text_reviews,
           count(r.id) filter (where r.review_type = 'image')::integer    as image_reviews,
           count(r.id) filter (where r.eligible)::integer                 as eligible,
           count(r.id) filter (where r.eligible and r.review_type = 'text')::integer  as eligible_text,
           count(r.id) filter (where r.eligible and r.review_type = 'image')::integer as eligible_image,
           coalesce(sum(r.credits), 0)                                    as credits
      from people p
      left join r on r.submitted_by = p.id
     where p_employee is null or p.id = p_employee
     group by p.id, p.full_name
  )
  select jsonb_build_object(
    'month', v_month,
    'current_month', v_current,
    'credits_per_point', v_cpp,
    'filters', jsonb_build_object('employee', p_employee, 'type', p_type, 'status', p_status),
    'summary', (
      select jsonb_build_object(
        'submitted',        count(*),
        'text',             count(*) filter (where review_type = 'text'),
        'image',            count(*) filter (where review_type = 'image'),
        'pending',          count(*) filter (where status = 'pending_verification'),
        'approved',         count(*) filter (where status = 'approved'),
        'rejected',         count(*) filter (where status = 'rejected'),
        'eligible',         count(*) filter (where eligible),
        'eligible_text',    count(*) filter (where eligible and review_type = 'text'),
        'eligible_image',   count(*) filter (where eligible and review_type = 'image'),
        'credits',          coalesce(sum(credits), 0),
        'points',           round(coalesce(sum(credits), 0) / v_cpp, 3),
        'expired_reviews',  count(*) filter (where expired),
        'expired_credits',  coalesce(sum(credits) filter (where expired), 0),
        'reversed',         count(*) filter (where reversed),
        'held',             count(*) filter (where held),
        'held_credits',     coalesce(sum(held_credits), 0),
        'confirmed_duplicates', count(*) filter (where confirmed_duplicate),
        'duplicates_open',  count(*) filter (where dup_open)
      ) from r
    ),
    'daily', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'day', d.day,
               'text',  coalesce(x.t, 0),
               'image', coalesce(x.i, 0)
             ) order by d.day), '[]'::jsonb)
        from generate_series(v_month, (v_to - 1), interval '1 day') as g(ts)
        cross join lateral (select g.ts::date as day) d
        left join (
          select day,
                 count(*) filter (where review_type = 'text')  as t,
                 count(*) filter (where review_type = 'image') as i
            from r group by day
        ) x on x.day = d.day
    ),
    'history', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'month', m.month,
               'text',  coalesce(x.t, 0),
               'image', coalesce(x.i, 0),
               'submitted', coalesce(x.t, 0) + coalesce(x.i, 0),
               'eligible', coalesce(x.e, 0),
               'credits', coalesce(x.c, 0)
             ) order by m.month), '[]'::jsonb)
        from generate_series(v_hist_from, v_month, interval '1 month') as g(ts)
        cross join lateral (select g.ts::date as month) m
        left join (
          select month,
                 count(*) filter (where review_type = 'text')  as t,
                 count(*) filter (where review_type = 'image') as i,
                 count(*) filter (where eligible)              as e,
                 coalesce(sum(credits), 0)                      as c
            from hist group by month
        ) x on x.month = m.month
    ),
    'categories', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'type', t.review_type,
               'pending',  coalesce(x.pending, 0),
               'approved', coalesce(x.approved, 0),
               'rejected', coalesce(x.rejected, 0),
               'submitted', coalesce(x.total, 0),
               'eligible', coalesce(x.eligible, 0),
               'credits', coalesce(x.credits, 0)
             ) order by t.ord), '[]'::jsonb)
        from (values ('text', 1), ('image', 2)) as t(review_type, ord)
        left join (
          select review_type,
                 count(*) filter (where status = 'pending_verification') as pending,
                 count(*) filter (where status = 'approved') as approved,
                 count(*) filter (where status = 'rejected') as rejected,
                 count(*) as total,
                 count(*) filter (where eligible) as eligible,
                 coalesce(sum(credits), 0) as credits
            from r group by review_type
        ) x on x.review_type = t.review_type
    ),
    'employees', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'employee_id', e.employee_id,
               'name', e.name,
               'submitted', e.submitted,
               'text', e.text_reviews,
               'image', e.image_reviews,
               'eligible', e.eligible,
               'eligible_text', e.eligible_text,
               'eligible_image', e.eligible_image,
               'credits', e.credits,
               'points', round(e.credits / v_cpp, 3)
             ) order by e.submitted desc, e.name, e.employee_id), '[]'::jsonb)
        from emp e
    )
  ) into v_result;

  return v_result;
end;
$$;

revoke execute on function public.customer_review_report(date, uuid, text, text) from public, anon;
grant  execute on function public.customer_review_report(date, uuid, text, text) to authenticated;

comment on function public.customer_review_report(date, uuid, text, text) is
  'The Review Workflow admin dashboard, one server-side aggregate: summary, daily and monthly text/image splits, type-by-status breakdown and the employee comparison (zero-submission employees included). Asia/Kolkata months, deleted reviews excluded, submitted and reward-eligible kept apart. Needs customer_review_requests.verify. Returns aggregates only.';

-- ═══ 4. One page of the matching reviews ══════════════════════════════════
--
-- p_focus narrows the same filtered set to what a card or a row was clicked for:
--   all | text | image | eligible | duplicates
-- No proof and no review text: the list links to Custom Submissions for those.

create or replace function public.customer_review_report_list(
  p_month    date default null,
  p_employee uuid default null,
  p_type     text default null,
  p_status   text default null,
  p_focus    text default 'all',
  p_limit    integer default 25,
  p_offset   integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid     uuid := auth.uid();
  v_current date := date_trunc('month', (now() at time zone 'Asia/Kolkata')::date)::date;
  v_month   date := coalesce(date_trunc('month', p_month)::date, v_current);
  v_to      date;
  v_type    text := p_type;
  v_limit   integer := greatest(1, least(coalesce(p_limit, 25), 50));
  v_offset  integer := greatest(0, coalesce(p_offset, 0));
  v_total   integer;
  v_rows    jsonb;
begin
  if v_uid is null or not exists (
    select 1 from public.users u where u.id = v_uid and u.is_active and coalesce(u.is_deleted, false) = false
  ) then
    raise exception 'CUSTOMER_REVIEW_REPORT_UNAUTHORIZED: Sign in to continue' using errcode = '42501';
  end if;
  if not public.resolve_permission(v_uid, 'customer_review_requests', 'verify') then
    raise exception 'CUSTOMER_REVIEW_REPORT_UNAUTHORIZED: The review report needs the Verify permission' using errcode = '42501';
  end if;
  if p_type is not null and p_type not in ('text', 'image') then
    raise exception 'CUSTOMER_REVIEW_REPORT_INVALID: Choose Text or Image' using errcode = '22023';
  end if;
  if p_status is not null and p_status not in ('pending_verification', 'approved', 'rejected') then
    raise exception 'CUSTOMER_REVIEW_REPORT_INVALID: Choose a review status' using errcode = '22023';
  end if;
  if p_focus is null or p_focus not in ('all', 'text', 'image', 'eligible', 'duplicates', 'confirmed_duplicates', 'held') then
    raise exception 'CUSTOMER_REVIEW_REPORT_INVALID: Choose what to list' using errcode = '22023';
  end if;
  if v_month > v_current then
    raise exception 'CUSTOMER_REVIEW_REPORT_INVALID: That month has not started' using errcode = '22023';
  end if;
  -- A Text/Image card narrows the type; if a different type filter is active the two cannot both hold.
  if p_focus in ('text', 'image') then
    if p_type is not null and p_type <> p_focus then
      return jsonb_build_object('total', 0, 'limit', v_limit, 'offset', v_offset, 'rows', '[]'::jsonb);
    end if;
    v_type := p_focus;
  end if;

  v_to := (v_month + interval '1 month')::date;

  select count(*) into v_total
    from public.customer_review_report_rows(v_month, v_to, p_employee, v_type, p_status) r
   where (p_focus <> 'eligible' or r.eligible)
     and (p_focus <> 'duplicates' or r.dup_open)
     and (p_focus <> 'confirmed_duplicates' or r.confirmed_duplicate)
     and (p_focus <> 'held' or r.held);

  select coalesce(jsonb_agg(to_jsonb(page) order by page.submitted_at desc, page.id), '[]'::jsonb) into v_rows
    from (
      select r.id, r.submission_ref, r.submitted_by,
             coalesce(nullif(btrim(u.full_name), ''), 'Unknown') as employee_name,
             r.review_type, r.status, r.submitted_at, r.published_on,
             r.eligible, r.credits, round(r.credits / public.customer_review_credits_per_point(), 3) as points,
             r.dup_open as duplicate_open, r.reward_held, r.edit_count,
             r.confirmed_duplicate, r.expired, r.reversed, r.held, r.held_credits
        from public.customer_review_report_rows(v_month, v_to, p_employee, v_type, p_status) r
        left join public.users u on u.id = r.submitted_by
       where (p_focus <> 'eligible' or r.eligible)
         and (p_focus <> 'duplicates' or r.dup_open)
         and (p_focus <> 'confirmed_duplicates' or r.confirmed_duplicate)
         and (p_focus <> 'held' or r.held)
       order by r.submitted_at desc, r.id
       limit v_limit offset v_offset
    ) page;

  return jsonb_build_object('total', v_total, 'limit', v_limit, 'offset', v_offset, 'rows', v_rows);
end;
$$;

revoke execute on function public.customer_review_report_list(date, uuid, text, text, text, integer, integer) from public, anon;
grant  execute on function public.customer_review_report_list(date, uuid, text, text, text, integer, integer) to authenticated;

comment on function public.customer_review_report_list(date, uuid, text, text, text, integer, integer) is
  'One page (at most 50) of the reviews behind a dashboard card or employee row, newest first. References, status, type, dates and credits only — never a review''s text or proof. Needs customer_review_requests.verify.';

-- ═══ 5. The leaderboard ═══════════════════════════════════════════════════

create or replace function public.customer_review_month_standings(p_month date)
returns table (employee_id uuid, name text, reviews integer, credits numeric)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with r as (
    select * from public.customer_review_report_rows(p_month, (p_month + interval '1 month')::date, null, null, null)
  ),
  people as (
    select u.id, u.full_name
      from public.users u
     where u.is_active = true and coalesce(u.is_deleted, false) = false
       and public.resolve_permission(u.id, 'customer_review_requests', 'use')
    union
    select u.id, u.full_name
      from public.users u
     where u.id in (select submitted_by from r where eligible)
  )
  select p.id,
         coalesce(nullif(btrim(p.full_name), ''), 'Unknown'),
         (count(r.id) filter (where r.eligible))::integer,
         coalesce(sum(r.credits) filter (where r.eligible), 0)
    from people p
    left join r on r.submitted_by = p.id
   group by p.id, p.full_name;
$$;

revoke execute on function public.customer_review_month_standings(date) from public, anon, authenticated, service_role;

create or replace function public.customer_review_leaderboard(p_month date default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid       uuid := auth.uid();
  v_current   date := date_trunc('month', (now() at time zone 'Asia/Kolkata')::date)::date;
  v_month     date := coalesce(date_trunc('month', p_month)::date, v_current);
  v_cpp       numeric := public.customer_review_credits_per_point();
  v_leader    integer;
  v_leaders   integer;
  v_rows      jsonb;
  v_me        jsonb;
  v_count     integer;
  v_need      integer;
  v_state     text;
  v_my_reviews integer;
begin
  if v_uid is null or not exists (
    select 1 from public.users u where u.id = v_uid and u.is_active and coalesce(u.is_deleted, false) = false
  ) then
    raise exception 'CUSTOMER_REVIEW_LEADERBOARD_UNAUTHORIZED: Sign in to continue' using errcode = '42501';
  end if;
  if v_month > v_current then
    raise exception 'CUSTOMER_REVIEW_LEADERBOARD_INVALID: That month has not started' using errcode = '22023';
  end if;

  with s as (
    select * from public.customer_review_month_standings(v_month)
  ),
  ranked as (
    select s.*, (1 + (select count(*) from s o where o.reviews > s.reviews))::integer as rank from s
  )
  select
    coalesce((select max(reviews) from ranked), 0),
    (select count(*) from ranked
      where reviews = (select max(reviews) from ranked) and (select max(reviews) from ranked) > 0),
    (select coalesce(jsonb_agg(jsonb_build_object(
              'rank', t.rank, 'employee_id', t.employee_id, 'name', t.name,
              'reviews', t.reviews, 'credits', t.credits, 'points', round(t.credits / v_cpp, 3),
              'is_me', t.employee_id = v_uid,
              'tied', (select count(*) from ranked x where x.rank = t.rank) > 1
            ) order by t.reviews desc, t.name, t.employee_id), '[]'::jsonb) from ranked t),
    (select jsonb_build_object('rank', m.rank, 'reviews', m.reviews, 'credits', m.credits, 'points', round(m.credits / v_cpp, 3))
       from ranked m where m.employee_id = v_uid),
    (select count(*) from ranked)
  into v_leader, v_leaders, v_rows, v_me, v_count;

  v_my_reviews := (v_me ->> 'reviews')::integer;

  if v_me is null then
    v_need := null; v_state := 'not_taking_part';
  elsif v_leader = 0 then
    v_need := 1; v_state := 'no_activity';
  elsif v_my_reviews = v_leader and v_leaders = 1 then
    v_need := null; v_state := 'leading';
  elsif v_my_reviews = v_leader then
    v_need := 1; v_state := 'joint';   -- one more eligible review makes a joint leader the sole leader
  else
    v_need := v_leader - v_my_reviews + 1; v_state := 'behind';
  end if;

  return jsonb_build_object(
    'month', v_month,
    'current_month', v_current,
    'credits_per_point', v_cpp,
    'leader_reviews', v_leader,
    'leaders', v_leaders,
    'state', v_state,
    'need', v_need,
    'me', v_me,
    'participants', v_count,
    'rows', v_rows
  );
end;
$$;

revoke execute on function public.customer_review_leaderboard(date) from public, anon;
grant  execute on function public.customer_review_leaderboard(date) to authenticated;

comment on function public.customer_review_leaderboard(date) is
  'The monthly review leaderboard for every signed-in employee: rank (equal counts share a rank), name, reward-eligible review count, review-earned credits and points (credits x 10, per month). The caller''s own row is marked; need = leader count - own count + 1 while behind. Names and counts only — no review content.';

-- The compact card on the shared dashboard: the leader(s) and the caller's own standing.
create or replace function public.customer_review_leader_card()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_board jsonb := public.customer_review_leaderboard(null);
begin
  return jsonb_build_object(
    'month', v_board -> 'month',
    'leader_reviews', v_board -> 'leader_reviews',
    'leaders', v_board -> 'leaders',
    'leader_names', (
      select coalesce(jsonb_agg(r ->> 'name' order by r ->> 'name'), '[]'::jsonb)
        from (select r from jsonb_array_elements(v_board -> 'rows') r
               where (r ->> 'reviews')::integer = (v_board ->> 'leader_reviews')::integer
                 and (v_board ->> 'leader_reviews')::integer > 0
               order by r ->> 'name' limit 3) t
    ),
    'state', v_board -> 'state',
    'need', v_board -> 'need',
    'me', v_board -> 'me'
  );
end;
$$;

revoke execute on function public.customer_review_leader_card() from public, anon;
grant  execute on function public.customer_review_leader_card() to authenticated;

-- ═══ 6. Assertions ═══════════════════════════════════════════════════════

do $$
begin
  if has_function_privilege('authenticated', 'public.customer_review_report_rows(date, date, uuid, text, text)', 'EXECUTE')
     or has_function_privilege('service_role', 'public.customer_review_report_rows(date, date, uuid, text, text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.customer_review_month_standings(date)', 'EXECUTE') then
    raise exception 'CUSTOM_REVIEW_REPORTING: an internal function is callable';
  end if;
  if not has_function_privilege('authenticated', 'public.customer_review_report(date, uuid, text, text)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.customer_review_report_list(date, uuid, text, text, text, integer, integer)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.customer_review_leaderboard(date)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.customer_review_leader_card()', 'EXECUTE')
     or has_function_privilege('anon', 'public.customer_review_report(date, uuid, text, text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.customer_review_leaderboard(date)', 'EXECUTE') then
    raise exception 'CUSTOM_REVIEW_REPORTING: the reporting functions have the wrong grants';
  end if;
end $$;
