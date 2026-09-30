-- ═══════════════════════════════════════════════════════════════════════════
-- Review Workflow — possible-duplicate detection for custom reviews.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT THIS ADDS
-- --------------
--   customer_review_custom_submissions  + reviewer_name, review_text            (optional, the employee's words)
--                                       + reviewer_name_norm, review_text_norm  (normalized once, by the route)
--                                       + proof_phash                           (4096-bit difference hash, hex)
--   customer_review_custom_duplicate_checks   one row per check run (submit, edit, reapply)
--   customer_review_custom_duplicate_flags    one row per possible-duplicate match, with reasons,
--                                             evidence, whether the employee proceeded, and the
--                                             verifier's decision
--   customer_review_custom_duplicate_summary  security_invoker view: the state a list needs
--   customer_review_custom_duplicate_candidates()   SERVICE ROLE: what the route compares against
--   decide_customer_review_custom_duplicate()       browser RPC: a verifier records Duplicate / Different
--   record_customer_review_custom_duplicate_check() internal: writes a run and its flags atomically
--   create / edit / reapply                         re-created with the new fields and the check result
--
-- THE RULES, STATED ONCE
-- ----------------------
--   A WARNING IS NOT A DECISION. A possible duplicate never rejects a review,
--   holds it back or touches a credit: it is a non-blocking flag a verifier looks at.
--
--   A DECISION OF "DUPLICATE" IS BINDING. A verifier who records 'duplicate' on a
--   non-weak flag of a review's CURRENT check, in one transaction:
--     * REJECTS the review ("Confirmed duplicate of an earlier review") — a review
--       that is pending, or approved, or edited and waiting;
--     * REVERSES its credit ONCE through the ledger (an approved or held credit;
--       a credit already expired with a closed month is not reversed a second time);
--     * and from then on approve_customer_review_custom_submission() REFUSES it
--       while that decision stands (also under a concurrent approval: both lock the
--       review row first, so one runs after the other and the second sees the first).
--   The review stays in submitted totals with its status (Rejected) and a
--   "Confirmed duplicate" mark; it is excluded from reward-eligible counts and the
--   leaderboard because it is no longer approved.
--
--   "DIFFERENT" AFTER "DUPLICATE" — WHAT IT DOES AND DOES NOT DO. Changing the flag
--   to 'different' removes the "confirmed duplicate" mark. It does NOT restore a
--   reversed credit and does not un-reject the review: the ledger allows one reward
--   per source and one reversal per row, and a reversal cannot be reversed. So:
--     * a review that had NO credit (it was pending) is Rejected and the employee
--       may Edit & Reapply it as usual;
--     * a review whose credit WAS reversed stays Rejected and cannot be reapplied
--       ("submit it again as a new review" — a new review earns a new reward), or
--       an administrator may post an admin_adjustment with a reason in BOE Credits.
--   Nothing promises a restored reward.
--
--   A weak (name-only) flag can never be decided 'duplicate'.
--
--   WHO CHECKS. The route compares a submission with every earlier review of every
--   employee — deleted ones included, so deleting and reposting is seen — and hands
--   the result to the create / edit / reapply function, which stores the run and
--   its flags IN THE SAME TRANSACTION as the change. The database does not do the
--   matching (text and image similarity live in duplicateDetection.ts); it stores
--   what the route found and refuses a result it cannot make sense of.
--
--   THE EMPLOYEE MUST HAVE SEEN THE WARNING. A run whose status is 'flagged' or
--   'unavailable' is refused unless employee_proceeded is true — the employee saw
--   the inline warning and chose Submit anyway. That choice is stored on the run
--   and on every flag.
--
--   A CHANGED REVIEW IS CHECKED AGAIN. Each run carries a content fingerprint
--   (SHA-256 of proof hash, normalized name and normalized text). A verifier's
--   decision belongs to one (review, matched review, fingerprint). Editing the
--   content produces a new fingerprint, so an earlier 'different' decision is
--   history, not a clearance: the new run raises its own undecided flags.
--
--   ONLY VERIFIERS READ THE EVIDENCE. Checks and flags have one SELECT policy,
--   for customer_review_requests.verify holders; no client role can write them.
--   The employee is told the reason categories by the route, never another
--   employee's review.
--
--   A DECISION NEEDS THE CURRENT RUN. A flag can be decided only while its
--   fingerprint is the review's latest; and never by the review's own submitter.
--
--   A WEAK MATCH (a shared name and nothing else) is stored and shown, is not queued
--   for a decision (strength 'weak') and cannot be confirmed as a duplicate.
--
-- PRODUCTION SAFETY. Additive columns, two tables, one view, functions. Three
-- functions are re-created with new trailing parameters that have DEFAULTS, so an
-- old-style call still resolves; their old signatures are dropped first so the
-- call is never ambiguous. Existing rows keep null for the new columns and show as
-- "not checked". Re-runnable.
--
-- DEPLOYMENT ORDER. After 20270223000000; before the application code.
-- After the code is live, run scripts/backfill-review-image-hashes.ts (service
-- role; not part of the migration) so older screenshots can be matched visually.
--
-- ROLLBACK (lossless while no review carries a name, text or hash)
--   drop view     if exists public.customer_review_custom_duplicate_summary;
--   drop function if exists public.decide_customer_review_custom_duplicate(uuid, text, text);
--   drop function if exists public.customer_review_custom_duplicate_candidates(uuid);
--   drop table    if exists public.customer_review_custom_duplicate_flags;
--   drop table    if exists public.customer_review_custom_duplicate_checks;
--   -- then re-apply 20270223000000 §4, §5, §8–§10 for the re-created functions.

-- ═══ 1. Columns ═══════════════════════════════════════════════════════════

alter table public.customer_review_custom_submissions
  add column if not exists reviewer_name       text,
  add column if not exists review_text         text,
  add column if not exists reviewer_name_norm  text,
  add column if not exists review_text_norm    text,
  add column if not exists proof_phash         text;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.customer_review_custom_submissions'::regclass
                   and conname = 'custom_review_submission_match_fields_shape') then
    alter table public.customer_review_custom_submissions
      add constraint custom_review_submission_match_fields_shape check (
        (reviewer_name is null or (btrim(reviewer_name) <> '' and length(reviewer_name) <= 80))
        and (review_text is null or (btrim(review_text) <> '' and length(review_text) <= 2000))
        and (reviewer_name_norm is null or length(reviewer_name_norm) <= 160)
        and (review_text_norm is null or length(review_text_norm) <= 2000)
        and (proof_phash is null or (length(proof_phash) = 1024 and proof_phash ~ '^[0-9a-f]+$'))
      );
  end if;
end $$;

comment on column public.customer_review_custom_submissions.reviewer_name is
  'The customer or reviewer name as the employee typed it. Optional. Compared, normalized, by the duplicate check.';
comment on column public.customer_review_custom_submissions.review_text is
  'The text of the published review as the employee typed it. Optional. Compared, normalized, by the duplicate check.';
comment on column public.customer_review_custom_submissions.proof_phash is
  '4096-bit difference hash (1024 hex characters) of the stored proof image; null for reviews from before the duplicate check until the backfill script has run.';

create index if not exists customer_review_custom_submissions_sha_idx
  on public.customer_review_custom_submissions (proof_content_sha256);

-- ═══ 2. History: two more events ══════════════════════════════════════════

alter table public.customer_review_custom_submission_events
  drop constraint if exists customer_review_custom_submission_events_event_type_check;
alter table public.customer_review_custom_submission_events
  add constraint customer_review_custom_submission_events_event_type_check
  check (event_type in ('submitted', 'rejected', 'reapplied', 'approved', 'edited', 'deleted',
                        'duplicate_flagged', 'duplicate_decided'));

-- ═══ 3. The checks and the flags ══════════════════════════════════════════

create table if not exists public.customer_review_custom_duplicate_checks (
  id                   uuid        primary key default gen_random_uuid(),
  -- The run order. created_at is one value for every run in a transaction, so "latest" is decided by this.
  seq                  bigint      generated always as identity,
  submission_id        uuid        not null references public.customer_review_custom_submissions(id),
  content_fingerprint  text        not null check (content_fingerprint ~ '^[0-9a-f]{64}$'),
  status               text        not null check (status in ('clear', 'flagged', 'unavailable')),
  -- The employee saw the inline warning and chose Submit anyway.
  employee_proceeded   boolean     not null default false,
  trigger_event        text        not null check (trigger_event in ('submitted', 'edited', 'reapplied')),
  match_count          integer     not null default 0 check (match_count >= 0),
  created_by           uuid        references public.users(id),
  created_at           timestamptz not null default now(),
  constraint duplicate_check_proceeded_only_when_warned check (status <> 'clear' or employee_proceeded = false)
);

create index if not exists customer_review_custom_duplicate_checks_submission_idx
  on public.customer_review_custom_duplicate_checks (submission_id, seq desc);

create table if not exists public.customer_review_custom_duplicate_flags (
  id                       uuid        primary key default gen_random_uuid(),
  submission_id            uuid        not null references public.customer_review_custom_submissions(id),
  matched_submission_id    uuid        not null references public.customer_review_custom_submissions(id),
  check_id                 uuid        not null references public.customer_review_custom_duplicate_checks(id),
  content_fingerprint      text        not null check (content_fingerprint ~ '^[0-9a-f]{64}$'),
  reasons                  text[]      not null
                             check (cardinality(reasons) between 1 and 3
                                    and reasons <@ array['reviewer_name', 'review_text', 'image']::text[]),
  strength                 text        not null check (strength in ('strong', 'moderate', 'weak')),
  -- Scores and kinds, e.g. {"text_kind":"similar","text_similarity":0.91,"image_kind":"identical","image_distance":0}
  evidence                 jsonb       not null default '{}'::jsonb,
  employee_proceeded       boolean     not null default false,
  matched_was_deleted      boolean     not null default false,
  created_at               timestamptz not null default now(),

  decision                 text        check (decision in ('duplicate', 'different')),
  decided_by               uuid        references public.users(id),
  decided_at               timestamptz,
  decision_note            text        check (decision_note is null or (btrim(decision_note) <> '' and length(decision_note) <= 300)),

  constraint duplicate_flag_not_self check (submission_id <> matched_submission_id),
  constraint duplicate_flag_decision_consistent check (
    (decision is null and decided_by is null and decided_at is null and decision_note is null)
    or (decision is not null and decided_by is not null and decided_at is not null)
  ),
  constraint duplicate_flag_once_per_content unique (submission_id, matched_submission_id, content_fingerprint)
);

create index if not exists customer_review_custom_duplicate_flags_submission_idx
  on public.customer_review_custom_duplicate_flags (submission_id);
create index if not exists customer_review_custom_duplicate_flags_matched_idx
  on public.customer_review_custom_duplicate_flags (matched_submission_id);

comment on table public.customer_review_custom_duplicate_checks is
  'One duplicate-check run per submit, edit or reapply: the content fingerprint, the outcome (clear / flagged / unavailable), and whether the employee proceeded after the warning. Append-only.';
comment on table public.customer_review_custom_duplicate_flags is
  'One possible-duplicate match: which review, which earlier review, why (reasons, evidence), and the verifier''s decision. A decision belongs to one content fingerprint; changed content is checked again and raises new flags. Only the decision columns change, from null to set or between the two values; nothing is deleted.';

-- Checks are append-only; flags change only in their decision columns.
create or replace function public.customer_review_custom_duplicate_checks_guard()
returns trigger
language plpgsql
as $$
begin
  raise exception 'CUSTOMER_REVIEW_CUSTOM_APPEND_ONLY: a duplicate-check run is never changed or deleted'
    using errcode = '42501';
end;
$$;
revoke execute on function public.customer_review_custom_duplicate_checks_guard() from public, anon, authenticated;

drop trigger if exists customer_review_custom_duplicate_checks_guard on public.customer_review_custom_duplicate_checks;
create trigger customer_review_custom_duplicate_checks_guard
  before update or delete on public.customer_review_custom_duplicate_checks
  for each row execute function public.customer_review_custom_duplicate_checks_guard();

create or replace function public.customer_review_custom_duplicate_flags_guard()
returns trigger
language plpgsql
as $$
declare
  v_decision text[] := array['decision', 'decided_by', 'decided_at', 'decision_note'];
begin
  if tg_op = 'DELETE' then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_APPEND_ONLY: a duplicate flag is never deleted'
      using errcode = '42501';
  end if;
  if (to_jsonb(new) - v_decision) <> (to_jsonb(old) - v_decision) then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_APPEND_ONLY: only the decision on a duplicate flag may change'
      using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke execute on function public.customer_review_custom_duplicate_flags_guard() from public, anon, authenticated;

drop trigger if exists customer_review_custom_duplicate_flags_guard on public.customer_review_custom_duplicate_flags;
create trigger customer_review_custom_duplicate_flags_guard
  before update or delete on public.customer_review_custom_duplicate_flags
  for each row execute function public.customer_review_custom_duplicate_flags_guard();

-- Only verifiers read the evidence. Nobody writes it from a browser.
create or replace function public.can_read_customer_review_custom_duplicate_evidence()
returns boolean
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select auth.uid() is not null
    and exists (select 1 from public.users u where u.id = auth.uid() and u.is_active and coalesce(u.is_deleted, false) = false)
    and public.resolve_permission(auth.uid(), 'customer_review_requests', 'verify');
$$;
revoke execute on function public.can_read_customer_review_custom_duplicate_evidence() from public, anon;
grant  execute on function public.can_read_customer_review_custom_duplicate_evidence() to authenticated;

alter table public.customer_review_custom_duplicate_checks enable row level security;
alter table public.customer_review_custom_duplicate_flags  enable row level security;

revoke insert, update, delete, truncate, references, trigger on public.customer_review_custom_duplicate_checks from authenticated, anon;
revoke insert, update, delete, truncate, references, trigger on public.customer_review_custom_duplicate_flags  from authenticated, anon;
revoke select on public.customer_review_custom_duplicate_checks from anon;
revoke select on public.customer_review_custom_duplicate_flags  from anon;
grant  select on public.customer_review_custom_duplicate_checks to authenticated;
grant  select on public.customer_review_custom_duplicate_flags  to authenticated;

drop policy if exists "customer_review_custom_duplicate_checks_select" on public.customer_review_custom_duplicate_checks;
create policy "customer_review_custom_duplicate_checks_select"
  on public.customer_review_custom_duplicate_checks for select to authenticated
  using (public.can_read_customer_review_custom_duplicate_evidence());

drop policy if exists "customer_review_custom_duplicate_flags_select" on public.customer_review_custom_duplicate_flags;
create policy "customer_review_custom_duplicate_flags_select"
  on public.customer_review_custom_duplicate_flags for select to authenticated
  using (public.can_read_customer_review_custom_duplicate_evidence());

-- ═══ 4. The summary a list needs ══════════════════════════════════════════
--
-- One row per submission. security_invoker: the reader's own RLS applies, so an
-- employee reads no evidence (the checks and flags return nothing to them) and a
-- verifier reads every row. "Current" means the flags of the review's LATEST run.

create or replace view public.customer_review_custom_duplicate_summary
with (security_invoker = true) as
select s.id                                   as submission_id,
       c.status                               as check_status,
       c.created_at                           as checked_at,
       c.employee_proceeded                   as employee_proceeded,
       c.content_fingerprint                  as content_fingerprint,
       coalesce(f.flags_current, 0)::integer  as flags_current,
       coalesce(f.flags_open, 0)::integer     as flags_open,
       coalesce(f.decided_duplicate, 0)::integer as decided_duplicate,
       coalesce(f.decided_different, 0)::integer as decided_different
  from public.customer_review_custom_submissions s
  left join lateral (
    select k.status, k.created_at, k.employee_proceeded, k.content_fingerprint
      from public.customer_review_custom_duplicate_checks k
     where k.submission_id = s.id
     order by k.seq desc
     limit 1
  ) c on true
  left join lateral (
    select count(*)                                                        as flags_current,
           count(*) filter (where fl.decision is null and fl.strength <> 'weak') as flags_open,
           count(*) filter (where fl.decision = 'duplicate')               as decided_duplicate,
           count(*) filter (where fl.decision = 'different')               as decided_different
      from public.customer_review_custom_duplicate_flags fl
     where fl.submission_id = s.id and fl.content_fingerprint = c.content_fingerprint
  ) f on true;

revoke all on public.customer_review_custom_duplicate_summary from anon;
grant  select on public.customer_review_custom_duplicate_summary to authenticated;

-- ═══ 5. What the route compares against ═══════════════════════════════════
--
-- SERVICE ROLE ONLY. Every earlier review of every employee, deleted ones
-- included, newest first, capped. Only what the comparison needs; the route
-- projects a much smaller answer to the employee.

create or replace function public.customer_review_custom_duplicate_candidates(p_exclude uuid default null)
returns table (
  id uuid, submitted_by uuid, submission_ref text,
  reviewer_name_norm text, review_text_norm text,
  proof_content_sha256 text, proof_phash text, deleted boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select s.id, s.submitted_by, s.submission_ref, s.reviewer_name_norm, s.review_text_norm,
         s.proof_content_sha256, s.proof_phash, (s.deleted_at is not null)
    from public.customer_review_custom_submissions s
   where p_exclude is null or s.id <> p_exclude
   order by s.submitted_at desc
   limit 5000;
$$;
revoke execute on function public.customer_review_custom_duplicate_candidates(uuid) from public, anon, authenticated;
grant  execute on function public.customer_review_custom_duplicate_candidates(uuid) to service_role;

-- ═══ 6. Recording a run (internal) ════════════════════════════════════════
--
-- Called by create / edit / reapply inside their own transaction, so a run can
-- never exist without its review nor a review without the run the route made.
-- p_duplicate:
--   { "status": "clear" | "flagged" | "unavailable",
--     "fingerprint": "<64 hex>",
--     "employee_proceeded": true | false,
--     "matches": [ { "matched_id": "<uuid>", "reasons": ["image", ...],
--                    "strength": "strong" | "moderate" | "weak", "evidence": { ... } } ] }
-- A null p_duplicate records nothing (the review then reads as "not checked").

create or replace function public.record_customer_review_custom_duplicate_check(
  p_submission_id uuid,
  p_actor_id      uuid,
  p_trigger       text,
  p_duplicate     jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_status    text;
  v_fp        text;
  v_proceeded boolean;
  v_matches   jsonb;
  v_check     uuid;
  m           jsonb;
  v_matched   uuid;
  v_reasons   text[];
  v_strength  text;
  v_n         integer := 0;
  v_top       text := null;
  v_was_del   boolean;
begin
  if p_duplicate is null then
    return;
  end if;

  v_status    := p_duplicate ->> 'status';
  v_fp        := p_duplicate ->> 'fingerprint';
  v_proceeded := coalesce((p_duplicate ->> 'employee_proceeded')::boolean, false);
  v_matches   := coalesce(p_duplicate -> 'matches', '[]'::jsonb);

  if v_status is null or v_status not in ('clear', 'flagged', 'unavailable')
     or v_fp is null or v_fp !~ '^[0-9a-f]{64}$'
     or jsonb_typeof(v_matches) <> 'array'
     or p_trigger not in ('submitted', 'edited', 'reapplied') then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_INVALID: The duplicate check result could not be read'
      using errcode = '22023';
  end if;
  if (v_status = 'flagged') <> (jsonb_array_length(v_matches) > 0) and v_status <> 'unavailable' then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_INVALID: The duplicate check result is inconsistent'
      using errcode = '22023';
  end if;
  if v_status = 'unavailable' and jsonb_array_length(v_matches) > 0 then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_INVALID: An unavailable check cannot carry matches'
      using errcode = '22023';
  end if;
  -- The employee saw the warning and chose to go on — or nothing was wrong.
  if v_status <> 'clear' and not v_proceeded then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_DUPLICATE_WARNING: Review the duplicate warning and choose Submit anyway to continue'
      using errcode = '55000';
  end if;

  insert into public.customer_review_custom_duplicate_checks
    (submission_id, content_fingerprint, status, employee_proceeded, trigger_event, match_count, created_by)
  values
    (p_submission_id, v_fp, v_status, v_proceeded and v_status <> 'clear', p_trigger, jsonb_array_length(v_matches), p_actor_id)
  returning id into v_check;

  for m in select * from jsonb_array_elements(v_matches) loop
    v_matched := (m ->> 'matched_id')::uuid;
    v_strength := m ->> 'strength';
    select coalesce(array_agg(x order by x), '{}') into v_reasons from jsonb_array_elements_text(m -> 'reasons') x;
    if v_matched is null or v_matched = p_submission_id
       or v_strength is null or v_strength not in ('strong', 'moderate', 'weak')
       or cardinality(v_reasons) = 0
       or not (v_reasons <@ array['reviewer_name', 'review_text', 'image']::text[]) then
      raise exception 'CUSTOMER_REVIEW_CUSTOM_INVALID: A duplicate match could not be read'
        using errcode = '22023';
    end if;
    select (deleted_at is not null) into v_was_del
      from public.customer_review_custom_submissions where id = v_matched;
    if not found then
      raise exception 'CUSTOMER_REVIEW_CUSTOM_INVALID: A matched review does not exist'
        using errcode = '22023';
    end if;

    insert into public.customer_review_custom_duplicate_flags
      (submission_id, matched_submission_id, check_id, content_fingerprint, reasons, strength,
       evidence, employee_proceeded, matched_was_deleted)
    values
      (p_submission_id, v_matched, v_check, v_fp, v_reasons, v_strength,
       coalesce(m -> 'evidence', '{}'::jsonb), v_proceeded, v_was_del)
    on conflict (submission_id, matched_submission_id, content_fingerprint) do nothing;

    v_n := v_n + 1;
    if v_top is null or (v_strength = 'strong')
       or (v_strength = 'moderate' and v_top = 'weak') then
      v_top := v_strength;
    end if;
  end loop;

  if v_status <> 'clear' then
    insert into public.customer_review_custom_submission_events (submission_id, event_type, actor_id, details)
    values (p_submission_id, 'duplicate_flagged', p_actor_id,
            jsonb_build_object('check_id', v_check, 'status', v_status, 'matches', v_n,
                               'strongest', v_top, 'employee_proceeded', v_proceeded, 'trigger', p_trigger));
  end if;
end;
$$;

revoke execute on function public.record_customer_review_custom_duplicate_check(uuid, uuid, text, jsonb)
  from public, anon, authenticated, service_role;

-- ═══ 7. A verifier decides ════════════════════════════════════════════════

create or replace function public.decide_customer_review_custom_duplicate(
  p_flag_id  uuid,
  p_decision text,
  p_note     text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid   uuid := auth.uid();
  v_note  text := nullif(btrim(coalesce(p_note, '')), '');
  f       public.customer_review_custom_duplicate_flags%rowtype;
  s       public.customer_review_custom_submissions%rowtype;
  v_latest text;
  v_previous text;
  v_reversal uuid;
  v_rejected boolean := false;
begin
  if v_uid is null then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_UNAUTHORIZED: Sign in to continue' using errcode = '42501';
  end if;
  if not exists (select 1 from public.users u where u.id = v_uid and u.is_active and coalesce(u.is_deleted, false) = false) then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_UNAUTHORIZED: Your account is not active' using errcode = '42501';
  end if;
  if not public.resolve_permission(v_uid, 'customer_review_requests', 'verify') then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_UNAUTHORIZED: Deciding a duplicate needs the Verify permission'
      using errcode = '42501';
  end if;
  if p_decision is null or p_decision not in ('duplicate', 'different') then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_INVALID: Choose Duplicate or Different review' using errcode = '22023';
  end if;
  if v_note is not null and length(v_note) > 300 then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_INVALID: Keep the note under 300 characters' using errcode = '22023';
  end if;

  select * into f from public.customer_review_custom_duplicate_flags where id = p_flag_id for update;
  if not found then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_NOT_FOUND: That duplicate flag no longer exists' using errcode = 'P0002';
  end if;
  -- THE REVIEW ROW IS LOCKED before anything is read or changed, exactly as approve does,
  -- so a decision and an approval of the same review run one after the other.
  select * into s from public.customer_review_custom_submissions where id = f.submission_id for update;

  -- Nobody decides on their own review.
  if s.submitted_by = v_uid then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_SELF: You cannot decide a duplicate flag on your own review'
      using errcode = '42501';
  end if;

  -- Only the current run: changed content has its own flags.
  select content_fingerprint into v_latest
    from public.customer_review_custom_duplicate_checks
   where submission_id = f.submission_id order by seq desc limit 1;
  if v_latest is distinct from f.content_fingerprint then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_STALE: This review changed after the flag was raised. Decide on the current check.'
      using errcode = '40001';
  end if;

  if f.decision = p_decision and f.decided_by = v_uid and f.decision_note is not distinct from v_note then
    return jsonb_build_object('flag_id', f.id, 'decision', f.decision, 'unchanged', true, 'review_rejected', false, 'credit_reversed', false);
  end if;

  if p_decision = 'duplicate' and f.strength = 'weak' then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_INVALID: A shared name alone is not enough to confirm a duplicate'
      using errcode = '22023';
  end if;

  v_previous := f.decision;
  update public.customer_review_custom_duplicate_flags
     set decision = p_decision, decided_by = v_uid, decided_at = now(), decision_note = v_note
   where id = f.id
   returning * into f;

  -- CONFIRMED DUPLICATE: reject the review and reverse its credit once (ledger; the
  -- credits lock is taken inside the helper, after the row lock — the same order as
  -- approve). A deleted or already-rejected review needs no status change.
  if p_decision = 'duplicate' and s.deleted_at is null and s.status in ('pending_verification', 'approved') then
    if s.credit_transaction_id is not null and s.reward_reversal_transaction_id is null then
      v_reversal := public.reverse_customer_review_custom_reward(s.id, v_uid, 'Confirmed duplicate review');
    end if;
    update public.customer_review_custom_submissions
       set status                         = 'rejected',
           rejected_by                    = v_uid,
           rejected_at                    = now(),
           rejection_reason               = 'Confirmed duplicate of an earlier review',
           approved_by                    = null,
           approved_at                    = null,
           credits_awarded                = null,
           credit_transaction_id          = null,
           reward_held                    = false,
           reward_reversal_transaction_id = coalesce(v_reversal, reward_reversal_transaction_id)
     where id = s.id;
    v_rejected := true;
  end if;

  insert into public.customer_review_custom_submission_events (submission_id, event_type, actor_id, note, details)
  values (f.submission_id, 'duplicate_decided', v_uid, v_note,
          jsonb_build_object('flag_id', f.id, 'matched_submission_id', f.matched_submission_id,
                             'decision', p_decision, 'previous_decision', v_previous,
                             'reasons', to_jsonb(f.reasons), 'strength', f.strength,
                             'review_rejected', v_rejected, 'credit_reversed', v_reversal is not null));

  return jsonb_build_object('flag_id', f.id, 'decision', f.decision, 'unchanged', false,
                            'review_rejected', v_rejected, 'credit_reversed', v_reversal is not null);
end;
$$;

revoke execute on function public.decide_customer_review_custom_duplicate(uuid, text, text) from public, anon;
grant  execute on function public.decide_customer_review_custom_duplicate(uuid, text, text) to authenticated;

comment on function public.decide_customer_review_custom_duplicate(uuid, text, text) is
  'A verifier records "duplicate" or "different" on one possible-duplicate flag of a review''s CURRENT check. Never the review''s own submitter. "Duplicate" (never on a weak flag) rejects the review and reverses its credit once; "different" changes no status and restores no credit. Decisions and any change of mind are kept in the history.';

-- ═══ 8. The guard, re-created with the new columns ════════════════════════

create or replace function public.customer_review_custom_submissions_guard()
returns trigger
language plpgsql
as $$
declare
  v_decision text[] := array[
    'status', 'approved_by', 'approved_at', 'credits_awarded', 'credit_transaction_id',
    'rejected_by', 'rejected_at', 'rejection_reason', 'updated_at',
    'reward_held', 'reward_reversal_transaction_id'
  ];
  v_reapply text[] := array[
    'status', 'approved_by', 'approved_at', 'credits_awarded', 'credit_transaction_id',
    'rejected_by', 'rejected_at', 'rejection_reason', 'updated_at',
    'review_type', 'published_on', 'remark',
    'proof_storage_path', 'proof_file_name', 'proof_mime_type', 'proof_byte_size', 'proof_content_sha256',
    'reviewer_name', 'review_text', 'reviewer_name_norm', 'review_text_norm', 'proof_phash',
    'candidate_note', 'reapplication_count', 'last_reapplied_at'
  ];
  v_edit text[] := array[
    'status', 'updated_at', 'reward_held',
    'review_type', 'published_on', 'remark',
    'proof_storage_path', 'proof_file_name', 'proof_mime_type', 'proof_byte_size', 'proof_content_sha256',
    'reviewer_name', 'review_text', 'reviewer_name_norm', 'review_text_norm', 'proof_phash',
    'edit_count', 'last_edited_at'
  ];
  v_delete text[] := array['deleted_at', 'deleted_by', 'reward_reversal_transaction_id', 'updated_at'];
begin
  if tg_op = 'DELETE' then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_APPEND_ONLY: a custom review submission is never deleted — it is the audit record'
      using errcode = '42501';
  end if;

  -- BACKFILL of the image hash for a review from before duplicate detection: the
  -- one column that goes from null to a value with nothing else changing, on any
  -- row (a deleted one included — it is comparison evidence). Written only by
  -- backfill_customer_review_custom_proof_phash().
  if old.proof_phash is null and new.proof_phash is not null
     and (to_jsonb(new) - 'proof_phash' - 'updated_at') = (to_jsonb(old) - 'proof_phash' - 'updated_at') then
    return new;
  end if;

  if old.deleted_at is not null then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_APPEND_ONLY: a deleted custom review submission is kept as it was'
      using errcode = '42501';
  end if;

  if new.deleted_at is not null then
    if (to_jsonb(new) - v_delete) <> (to_jsonb(old) - v_delete) then
      raise exception 'CUSTOMER_REVIEW_CUSTOM_APPEND_ONLY: a delete may change nothing but the delete stamp'
        using errcode = '42501';
    end if;
    new.updated_at := now();
    return new;
  end if;

  if new.edit_count <> old.edit_count then
    if new.edit_count <> old.edit_count + 1 or new.last_edited_at is null then
      raise exception 'CUSTOMER_REVIEW_CUSTOM_APPEND_ONLY: an edit is counted exactly once'
        using errcode = '42501';
    end if;
    if not (old.status in ('pending_verification', 'approved') and new.status = 'pending_verification') then
      raise exception 'CUSTOMER_REVIEW_CUSTOM_APPEND_ONLY: only a pending or approved review can be edited'
        using errcode = '42501';
    end if;
    if (to_jsonb(new) - v_edit) <> (to_jsonb(old) - v_edit) then
      raise exception 'CUSTOMER_REVIEW_CUSTOM_APPEND_ONLY: an edit may change only the employee''s own content'
        using errcode = '42501';
    end if;
    if old.status = 'approved' and (new.review_type <> old.review_type or new.reward_held is not true) then
      raise exception 'CUSTOMER_REVIEW_CUSTOM_APPEND_ONLY: an approved review keeps its type and holds its credit while it is edited'
        using errcode = '42501';
    end if;
    new.updated_at := now();
    return new;
  end if;

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

  -- CONFIRMED DUPLICATE: an approved review may be rejected, and only by
  -- decide_customer_review_custom_duplicate() — proved by a 'duplicate' decision on
  -- one of its flags recorded in THIS transaction.
  if old.status = 'approved' and new.status = 'rejected' then
    if not exists (
      select 1 from public.customer_review_custom_duplicate_flags fl
       where fl.submission_id = old.id and fl.decision = 'duplicate' and fl.decided_at = now()
    ) then
      raise exception 'CUSTOMER_REVIEW_CUSTOM_APPEND_ONLY: a decided custom review submission is final'
        using errcode = '42501';
    end if;
    if (to_jsonb(new) - v_decision) <> (to_jsonb(old) - v_decision) then
      raise exception 'CUSTOMER_REVIEW_CUSTOM_APPEND_ONLY: only the decision on a custom review submission may change'
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

-- ═══ 8b. Backfilling the image hash of older reviews ═════════════════════
--
-- SERVICE ROLE ONLY. scripts/backfill-review-image-hashes.ts downloads a
-- pre-existing proof, hashes it, and stores the hash here. Only a null hash is
-- ever filled; the guard above allows nothing else to move.

create or replace function public.backfill_customer_review_custom_proof_phash(p_submission_id uuid, p_phash text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_phash is null or length(p_phash) <> 1024 or p_phash !~ '^[0-9a-f]+$' then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_INVALID: The image hash could not be read' using errcode = '22023';
  end if;
  update public.customer_review_custom_submissions
     set proof_phash = p_phash
   where id = p_submission_id and proof_phash is null;
  return found;
end;
$$;

revoke execute on function public.backfill_customer_review_custom_proof_phash(uuid, text) from public, anon, authenticated;
grant  execute on function public.backfill_customer_review_custom_proof_phash(uuid, text) to service_role;

-- ═══ 9. The trail, re-created: edits and reapplications keep the name and text ═

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

  elsif old.deleted_at is null and new.deleted_at is not null then
    insert into public.customer_review_custom_submission_events (submission_id, event_type, actor_id, details, created_at)
    values (new.id, 'deleted', new.deleted_by,
            jsonb_build_object(
              'status_at_delete', old.status,
              'credits_awarded', old.credits_awarded,
              'credits_reversed', new.reward_reversal_transaction_id is not null,
              'reversal_transaction_id', new.reward_reversal_transaction_id
            ),
            new.deleted_at);
    return null;

  elsif new.edit_count = old.edit_count + 1 then
    insert into public.customer_review_custom_submission_events (submission_id, event_type, actor_id, details, created_at)
    values (new.id, 'edited', new.submitted_by,
            jsonb_build_object(
              'edit', new.edit_count,
              'status_before', old.status,
              'sent_back_for_approval', old.status = 'approved',
              'credit_held', new.reward_held,
              'previous', jsonb_build_object(
                'review_type', old.review_type, 'published_on', old.published_on, 'remark', old.remark,
                'reviewer_name', old.reviewer_name, 'review_text', old.review_text,
                'proof_storage_path', old.proof_storage_path, 'proof_file_name', old.proof_file_name
              ),
              'current', jsonb_build_object(
                'review_type', new.review_type, 'published_on', new.published_on, 'remark', new.remark,
                'reviewer_name', new.reviewer_name, 'review_text', new.review_text,
                'proof_storage_path', new.proof_storage_path, 'proof_file_name', new.proof_file_name
              ),
              'proof_replaced', old.proof_storage_path is distinct from new.proof_storage_path
            ),
            coalesce(new.last_edited_at, now()));
    if old.status <> 'approved' then
      return null;
    end if;
    v_kind := 'customer_review_reapplied';

  elsif old.status = 'pending_verification' and new.status = 'approved' then
    insert into public.customer_review_custom_submission_events (submission_id, event_type, actor_id, details, created_at)
    values (new.id, 'approved', new.approved_by,
            jsonb_build_object(
              'credits_awarded', new.credits_awarded,
              'credit_transaction_id', new.credit_transaction_id,
              'reaffirmed_after_edit', old.reward_held
            ),
            coalesce(new.approved_at, now()));
    return null;

  elsif old.status in ('pending_verification', 'approved') and new.status = 'rejected' then
    insert into public.customer_review_custom_submission_events (submission_id, event_type, actor_id, reason, details, created_at)
    values (new.id, 'rejected', new.rejected_by, new.rejection_reason,
            jsonb_build_object(
              'credit_reversed', new.reward_reversal_transaction_id is not null,
              'reversal_transaction_id', new.reward_reversal_transaction_id
            ),
            coalesce(new.rejected_at, now()));
    return null;

  elsif old.status = 'rejected' and new.status = 'pending_verification' then
    insert into public.customer_review_custom_submission_events (submission_id, event_type, actor_id, note, details, created_at)
    values (new.id, 'reapplied', new.submitted_by, new.candidate_note,
            jsonb_build_object(
              'attempt', new.reapplication_count,
              'previous', jsonb_build_object(
                'review_type', old.review_type, 'published_on', old.published_on, 'remark', old.remark,
                'reviewer_name', old.reviewer_name, 'review_text', old.review_text,
                'proof_storage_path', old.proof_storage_path, 'proof_file_name', old.proof_file_name,
                'rejection_reason', old.rejection_reason, 'rejected_by', old.rejected_by, 'rejected_at', old.rejected_at
              ),
              'current', jsonb_build_object(
                'review_type', new.review_type, 'published_on', new.published_on, 'remark', new.remark,
                'reviewer_name', new.reviewer_name, 'review_text', new.review_text,
                'proof_storage_path', new.proof_storage_path, 'proof_file_name', new.proof_file_name
              ),
              'proof_replaced', old.proof_storage_path is distinct from new.proof_storage_path
            ),
            coalesce(new.last_reapplied_at, now()));
    v_kind := 'customer_review_reapplied';

  else
    return null;
  end if;

  select full_name into v_name from public.users where id = new.submitted_by;
  v_type := case new.review_type when 'image' then 'Image' else 'Text' end;
  if v_kind = 'customer_review_submitted' then
    v_title := format('%s submitted a custom %s Review for approval.', coalesce(nullif(btrim(v_name), ''), 'An employee'), v_type);
    v_body  := new.submission_ref;
  elsif tg_op = 'UPDATE' and new.edit_count = old.edit_count + 1 then
    v_title := format('%s edited an approved custom %s Review; it needs approval again.', coalesce(nullif(btrim(v_name), ''), 'An employee'), v_type);
    v_body  := format('%s · edit %s · credit stays in balance', new.submission_ref, new.edit_count);
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

-- ═══ 10. Create, re-created with the new fields and the check result ═══════

drop function if exists public.create_customer_review_custom_submission(uuid, uuid, text, date, text, text, text, text, integer, text);

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
  p_proof_content_sha256 text,
  p_reviewer_name        text  default null,
  p_review_text          text  default null,
  p_reviewer_name_norm   text  default null,
  p_review_text_norm     text  default null,
  p_proof_phash          text  default null,
  p_duplicate            jsonb default null
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
  v_name   text := nullif(btrim(coalesce(p_reviewer_name, '')), '');
  v_text   text := nullif(btrim(coalesce(p_review_text, '')), '');
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
  if v_name is not null and length(v_name) > 80 then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_INVALID: Keep the reviewer name under 80 characters'
      using errcode = '22023';
  end if;
  if v_text is not null and length(v_text) > 2000 then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_INVALID: Keep the review text under 2000 characters'
      using errcode = '22023';
  end if;
  if p_proof_storage_path is null or split_part(p_proof_storage_path, '/', 1) <> p_submission_id::text then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_INVALID: A screenshot of the published review is required'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext('customer_review_custom_month'), hashtext(p_actor_id::text));
  perform public.check_customer_review_custom_month_rules(p_actor_id, v_month, p_review_type, null, null);

  if exists (
    select 1 from public.customer_review_custom_submissions
     where submitted_by = p_actor_id
       and proof_content_sha256 = p_proof_content_sha256
       and status <> 'rejected'
       and deleted_at is null
  ) then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_DUPLICATE: This screenshot has already been submitted'
      using errcode = '23505';
  end if;

  begin
    insert into public.customer_review_custom_submissions (
      id, submitted_by, review_type, published_on, remark,
      proof_storage_path, proof_file_name, proof_mime_type, proof_byte_size, proof_content_sha256,
      reviewer_name, review_text,
      reviewer_name_norm, review_text_norm, proof_phash
    ) values (
      p_submission_id, p_actor_id, p_review_type, p_published_on, v_remark,
      p_proof_storage_path, p_proof_file_name, p_proof_mime_type, p_proof_byte_size, p_proof_content_sha256,
      v_name, v_text,
      case when v_name is null then null else p_reviewer_name_norm end,
      case when v_text is null then null else p_review_text_norm end,
      p_proof_phash
    )
    returning * into v_row;
  exception when unique_violation then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_DUPLICATE: This screenshot has already been submitted'
      using errcode = '23505';
  end;

  perform public.record_customer_review_custom_duplicate_check(v_row.id, p_actor_id, 'submitted', p_duplicate);

  return to_jsonb(v_row);
end;
$$;

revoke execute on function public.create_customer_review_custom_submission(uuid, uuid, text, date, text, text, text, text, integer, text, text, text, text, text, text, jsonb)
  from public, anon, authenticated;
grant  execute on function public.create_customer_review_custom_submission(uuid, uuid, text, date, text, text, text, text, integer, text, text, text, text, text, text, jsonb)
  to service_role;

-- ═══ 11. Reapply, re-created ══════════════════════════════════════════════

drop function if exists public.reapply_customer_review_custom_submission(uuid, uuid, text, date, text, text, text, text, text, integer, text);

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
  p_proof_content_sha256 text,
  p_reviewer_name        text  default null,
  p_review_text          text  default null,
  p_reviewer_name_norm   text  default null,
  p_review_text_norm     text  default null,
  p_proof_phash          text  default null,
  p_duplicate            jsonb default null
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
  v_name     text := nullif(btrim(coalesce(p_reviewer_name, '')), '');
  v_text     text := nullif(btrim(coalesce(p_review_text, '')), '');
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
  if v_name is not null and length(v_name) > 80 then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_INVALID: Keep the reviewer name under 80 characters'
      using errcode = '22023';
  end if;
  if v_text is not null and length(v_text) > 2000 then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_INVALID: Keep the review text under 2000 characters'
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

  perform pg_advisory_xact_lock(hashtext('customer_review_custom_month'), hashtext(p_actor_id::text));

  select * into s from public.customer_review_custom_submissions where id = p_submission_id for update;
  if not found or s.deleted_at is not null then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_NOT_FOUND: That submission no longer exists' using errcode = 'P0002';
  end if;

  if s.submitted_by <> p_actor_id then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_NOT_OWNER: You can only reapply your own review' using errcode = '42501';
  end if;

  if s.status = 'pending_verification' then
    return jsonb_build_object('submission', to_jsonb(s), 'already_pending', true, 'previous_proof_storage_path', null);
  end if;
  if s.status = 'approved' then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_DECIDED: This review was already approved' using errcode = '55000';
  end if;
  if s.reward_reversal_transaction_id is not null then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_DECIDED: The credit for this review was withdrawn when its edit was rejected. Submit it again as a new review.'
      using errcode = '55000';
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
       and deleted_at is null
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
           reviewer_name        = v_name,
           review_text          = v_text,
           reviewer_name_norm   = case when v_name is null then null else p_reviewer_name_norm end,
           review_text_norm     = case when v_text is null then null else p_review_text_norm end,
           proof_storage_path   = case when v_new_path then p_proof_storage_path   else proof_storage_path   end,
           proof_file_name      = case when v_new_path then p_proof_file_name      else proof_file_name      end,
           proof_mime_type      = case when v_new_path then p_proof_mime_type      else proof_mime_type      end,
           proof_byte_size      = case when v_new_path then p_proof_byte_size      else proof_byte_size      end,
           proof_content_sha256 = case when v_new_path then p_proof_content_sha256 else proof_content_sha256 end,
           proof_phash          = case when v_new_path then p_proof_phash          else coalesce(p_proof_phash, proof_phash) end,
           reapplication_count  = reapplication_count + 1,
           last_reapplied_at    = now()
     where id = s.id
     returning * into s;
  exception when unique_violation then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_DUPLICATE: This screenshot has already been submitted'
      using errcode = '23505';
  end;

  perform public.record_customer_review_custom_duplicate_check(s.id, p_actor_id, 'reapplied', p_duplicate);

  return jsonb_build_object('submission', to_jsonb(s), 'already_pending', false, 'previous_proof_storage_path', v_previous);
end;
$$;

revoke execute on function public.reapply_customer_review_custom_submission(uuid, uuid, text, date, text, text, text, text, text, integer, text, text, text, text, text, text, jsonb)
  from public, anon, authenticated;
grant  execute on function public.reapply_customer_review_custom_submission(uuid, uuid, text, date, text, text, text, text, text, integer, text, text, text, text, text, text, jsonb)
  to service_role;

-- ═══ 12. Edit, re-created ═════════════════════════════════════════════════

drop function if exists public.edit_customer_review_custom_submission(uuid, uuid, text, date, text, integer, text, text, text, integer, text);

create or replace function public.edit_customer_review_custom_submission(
  p_submission_id        uuid,
  p_actor_id             uuid,
  p_review_type          text,
  p_published_on         date,
  p_remark               text,
  p_expected_edit_count  integer,
  p_proof_storage_path   text,
  p_proof_file_name      text,
  p_proof_mime_type      text,
  p_proof_byte_size      integer,
  p_proof_content_sha256 text,
  p_reviewer_name        text  default null,
  p_review_text          text  default null,
  p_reviewer_name_norm   text  default null,
  p_review_text_norm     text  default null,
  p_proof_phash          text  default null,
  p_duplicate            jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_today    date := (now() at time zone 'Asia/Kolkata')::date;
  v_remark   text := nullif(btrim(coalesce(p_remark, '')), '');
  v_name     text := nullif(btrim(coalesce(p_reviewer_name, '')), '');
  v_text     text := nullif(btrim(coalesce(p_review_text, '')), '');
  v_new_path boolean := p_proof_storage_path is not null;
  v_month    date;
  s          public.customer_review_custom_submissions%rowtype;
  v_same     boolean;
  v_previous text;
  v_was_approved boolean;
begin
  if p_actor_id is null or not exists (
    select 1 from public.users
     where id = p_actor_id and is_active = true and coalesce(is_deleted, false) = false
  ) then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_UNAUTHORIZED: Your account is not active'
      using errcode = '42501';
  end if;
  if not public.resolve_permission(p_actor_id, 'customer_review_requests', 'use') then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_UNAUTHORIZED: You do not have permission to edit a custom review'
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
  if v_name is not null and length(v_name) > 80 then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_INVALID: Keep the reviewer name under 80 characters'
      using errcode = '22023';
  end if;
  if v_text is not null and length(v_text) > 2000 then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_INVALID: Keep the review text under 2000 characters'
      using errcode = '22023';
  end if;
  if p_expected_edit_count is null or p_expected_edit_count < 0 then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_INVALID: The edit could not be identified'
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

  perform pg_advisory_xact_lock(hashtext('customer_review_custom_month'), hashtext(p_actor_id::text));

  select * into s from public.customer_review_custom_submissions where id = p_submission_id for update;
  if not found or s.deleted_at is not null then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_NOT_FOUND: That review no longer exists' using errcode = 'P0002';
  end if;

  if s.submitted_by <> p_actor_id then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_NOT_OWNER: You can only edit your own review' using errcode = '42501';
  end if;

  if s.status = 'rejected' then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_NOT_EDITABLE: A rejected review is corrected with Edit & Reapply.'
      using errcode = '55000';
  end if;

  v_same := s.review_type = p_review_type
        and s.published_on = p_published_on
        and s.remark is not distinct from v_remark
        and s.reviewer_name is not distinct from v_name
        and s.review_text is not distinct from v_text
        and (not v_new_path or s.proof_content_sha256 = p_proof_content_sha256);

  if v_same then
    return jsonb_build_object('submission', to_jsonb(s), 'unchanged', true,
                              'sent_back_for_approval', false, 'previous_proof_storage_path', null);
  end if;
  if s.edit_count <> p_expected_edit_count then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_STALE: This review changed since you opened it. Close this form and open it again.'
      using errcode = '40001';
  end if;

  v_month := date_trunc('month', (s.submitted_at at time zone 'Asia/Kolkata')::date)::date;
  if exists (
    select 1 from public.boe_credit_review_months m
     where m.employee_id = s.submitted_by and m.review_month = v_month and m.status = 'lapsed'
  ) then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_MONTH_CLOSED: %',
      format('%s has been closed for BOE Credits, so this review can no longer be edited.', trim(to_char(v_month, 'Month')) || ' ' || to_char(v_month, 'YYYY'))
      using errcode = '55000';
  end if;

  v_was_approved := s.status = 'approved' or s.reward_held;
  if v_was_approved and p_review_type <> s.review_type then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_INVALID: The type of an approved review cannot change. Delete it and submit a new review instead.'
      using errcode = '22023';
  end if;

  if v_new_path and exists (
    select 1 from public.customer_review_custom_submissions
     where submitted_by = p_actor_id
       and proof_content_sha256 = p_proof_content_sha256
       and status <> 'rejected'
       and deleted_at is null
       and id <> s.id
  ) then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_DUPLICATE: This screenshot has already been submitted'
      using errcode = '23505';
  end if;

  if p_review_type <> s.review_type then
    perform public.check_customer_review_custom_month_rules(p_actor_id, v_month, p_review_type, s.id, s.review_type);
  end if;

  v_previous := case when v_new_path then s.proof_storage_path else null end;

  begin
    update public.customer_review_custom_submissions
       set status               = 'pending_verification',
           reward_held          = s.status = 'approved' or s.reward_held,
           review_type          = p_review_type,
           published_on         = p_published_on,
           remark               = v_remark,
           reviewer_name        = v_name,
           review_text          = v_text,
           reviewer_name_norm   = case when v_name is null then null else p_reviewer_name_norm end,
           review_text_norm     = case when v_text is null then null else p_review_text_norm end,
           proof_storage_path   = case when v_new_path then p_proof_storage_path   else proof_storage_path   end,
           proof_file_name      = case when v_new_path then p_proof_file_name      else proof_file_name      end,
           proof_mime_type      = case when v_new_path then p_proof_mime_type      else proof_mime_type      end,
           proof_byte_size      = case when v_new_path then p_proof_byte_size      else proof_byte_size      end,
           proof_content_sha256 = case when v_new_path then p_proof_content_sha256 else proof_content_sha256 end,
           proof_phash          = case when v_new_path then p_proof_phash          else coalesce(p_proof_phash, proof_phash) end,
           edit_count           = edit_count + 1,
           last_edited_at       = now()
     where id = s.id
     returning * into s;
  exception when unique_violation then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_DUPLICATE: This screenshot has already been submitted'
      using errcode = '23505';
  end;

  perform public.record_customer_review_custom_duplicate_check(s.id, p_actor_id, 'edited', p_duplicate);

  return jsonb_build_object('submission', to_jsonb(s), 'unchanged', false,
                            'sent_back_for_approval', v_was_approved, 'previous_proof_storage_path', v_previous);
end;
$$;

revoke execute on function public.edit_customer_review_custom_submission(uuid, uuid, text, date, text, integer, text, text, text, integer, text, text, text, text, text, text, jsonb)
  from public, anon, authenticated;
grant  execute on function public.edit_customer_review_custom_submission(uuid, uuid, text, date, text, integer, text, text, text, integer, text, text, text, text, text, text, jsonb)
  to service_role;

-- ═══ 12b. Approve, re-created: a held credit is not paid again, a confirmed duplicate is refused ══

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
  if not found or s.deleted_at is not null then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_NOT_FOUND: That submission no longer exists' using errcode = 'P0002';
  end if;

  if s.submitted_by = v_uid then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_SELF: You cannot approve or reject your own submission'
      using errcode = '42501';
  end if;

  if s.status = 'approved' then
    return jsonb_build_object('submission', to_jsonb(s), 'reward', null, 'already_decided', true);
  end if;
  if s.status = 'rejected' then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_DECIDED: This submission was already rejected' using errcode = '55000';
  end if;

  -- A CONFIRMED DUPLICATE CANNOT BE APPROVED. The review row is locked (above), and a
  -- duplicate decision locks it too, so this reads either the committed decision or
  -- waits for it. A review whose credit was already reversed cannot be paid again.
  if exists (
    select 1 from public.customer_review_custom_duplicate_summary d
     where d.submission_id = s.id and d.decided_duplicate > 0
  ) then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_DUPLICATE_CONFIRMED: A reviewer marked this review a duplicate, so it cannot be approved. Change the decision to Different review first, or reject it.'
      using errcode = '55000';
  end if;
  if s.reward_reversal_transaction_id is not null then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_DECIDED: The credit for this review was already withdrawn, and the ledger pays a review only once. Ask the employee to submit it again as a new review.'
      using errcode = '55000';
  end if;

  -- AN EDITED REVIEW WHOSE CREDIT IS HELD: approve it again, post nothing. The
  -- credit already on the ledger stands; the ledger would refuse a second
  -- review_reward for this source anyway.
  if s.reward_held then
    update public.customer_review_custom_submissions
       set status      = 'approved',
           approved_by = v_uid,
           approved_at = now(),
           reward_held = false
     where id = s.id
     returning * into s;
    return jsonb_build_object('submission', to_jsonb(s), 'reward', null, 'already_decided', false, 'reaffirmed', true);
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
    s.submitted_by, s.id, s.submission_ref, p_credits, s.submitted_at, v_uid
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

-- ═══ 13. Assertions ═══════════════════════════════════════════════════════

do $$
begin
  if to_regclass('public.customer_review_custom_duplicate_flags') is null
     or to_regclass('public.customer_review_custom_duplicate_checks') is null
     or to_regclass('public.customer_review_custom_duplicate_summary') is null then
    raise exception 'CUSTOM_REVIEW_DUPLICATES: a table or the view is missing';
  end if;
  if has_table_privilege('authenticated', 'public.customer_review_custom_duplicate_flags', 'INSERT')
     or has_table_privilege('authenticated', 'public.customer_review_custom_duplicate_flags', 'UPDATE')
     or has_table_privilege('authenticated', 'public.customer_review_custom_duplicate_flags', 'DELETE')
     or has_table_privilege('authenticated', 'public.customer_review_custom_duplicate_checks', 'INSERT')
     or has_table_privilege('authenticated', 'public.customer_review_custom_duplicate_checks', 'UPDATE')
     or has_table_privilege('authenticated', 'public.customer_review_custom_duplicate_checks', 'DELETE')
     or has_table_privilege('anon', 'public.customer_review_custom_duplicate_flags', 'SELECT')
     or has_table_privilege('anon', 'public.customer_review_custom_duplicate_checks', 'SELECT') then
    raise exception 'CUSTOM_REVIEW_DUPLICATES: a client role holds a write, or anon a read, on the evidence';
  end if;
  if (select count(*) from pg_policies where schemaname = 'public'
       and tablename in ('customer_review_custom_duplicate_flags', 'customer_review_custom_duplicate_checks')) <> 2 then
    raise exception 'CUSTOMER_REVIEW_DUPLICATES: expected exactly one policy on each evidence table';
  end if;
  if has_function_privilege('authenticated', 'public.customer_review_custom_duplicate_candidates(uuid)', 'EXECUTE')
     or has_function_privilege('anon', 'public.customer_review_custom_duplicate_candidates(uuid)', 'EXECUTE')
     or has_function_privilege('service_role', 'public.record_customer_review_custom_duplicate_check(uuid, uuid, text, jsonb)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.record_customer_review_custom_duplicate_check(uuid, uuid, text, jsonb)', 'EXECUTE') then
    raise exception 'CUSTOM_REVIEW_DUPLICATES: an owner-only function is callable';
  end if;
  if not has_function_privilege('authenticated', 'public.decide_customer_review_custom_duplicate(uuid, text, text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.decide_customer_review_custom_duplicate(uuid, text, text)', 'EXECUTE') then
    raise exception 'CUSTOM_REVIEW_DUPLICATES: the decision function has the wrong grants';
  end if;
end $$;
