-- Permanent deletion of a PI submission
-- ===========================================================================
-- Forward-only. Adds three columns, one constraint, four functions, four guard
-- triggers and one TTL. It rewrites no history and edits nothing that is
-- applied: 20260913000000 and everything before it are immutable, and no
-- function they define is restated here.
--
--
-- WHAT THIS IS FOR
-- ----------------
-- A PI that should not exist. An employee uploads the wrong workbook, or the
-- client walks away before anything is agreed, or management refuses the order
-- outright — and today the record stays in PI Drafts forever, because nothing in
-- the product can remove it. The business does not require a refused or
-- abandoned PI to be retained, so this erases it.
--
-- IT IS A HARD DELETE. Not an archive, not a flag, not a hidden status. The row,
-- its product lines, its pictures' metadata and its whole activity trail are
-- gone, and the caller is handed the storage keys so the FILES can go too.
--
--
-- WHO MAY DELETE WHAT
-- -------------------
--                     owner   admin   anybody else
--   draft              yes     yes        no
--   needs_changes      yes     yes        no
--   rejected           yes     yes        no
--   submitted           NO      NO        no
--   approved            NO      NO        no
--   anything else       NO      NO        no
--
-- THE OWNER, OR AN ADMIN. Nothing else, and deliberately not a permission:
--
--   orders.view_all                    seeing every PI is not authority over it
--   orders.approve_order               a reviewer decides a PI, and a decision
--                                      is not an erasure — a reviewer who wants
--                                      it gone has Reject, which the owner may
--                                      then delete
--   orders.approve_advance_exception   settles one commercial term and nothing
--                                      else
--   orders.delete                      means "remove an Order Request"
--                                      (20260901000000). Reusing it would hand
--                                      cross-owner PI deletion to everybody who
--                                      can tidy a request today, silently, with
--                                      no grant being changed
--
-- Admin authority is the project's established check — users.role = 'admin',
-- active, not soft-deleted — the same one permanently_delete_asset() uses.
--
-- SUBMITTED IS UNTOUCHABLE, ADMIN INCLUDED. A PI under review is a record
-- somebody has been asked to act on, and it must not evaporate while they are
-- reading it. An admin who genuinely needs it gone rejects it first, which is a
-- visible decision with a reason, and then deletes it.
--
-- IT FAILS CLOSED. The eligible statuses are an allow-list, so 'approved' — and
-- any status a later phase adds — is refused until somebody deliberately writes
-- it in here.
--
--
-- ═══ THE DEFECT THIS DESIGN EXISTS TO PREVENT ═══════════════════════════════
--
-- Postgres and Supabase Storage cannot share a transaction, so deletion is two
-- steps and something can happen between them. The obvious two-step orderings
-- are both wrong:
--
--   database first, then storage    a failed sweep leaves bytes in a bucket with
--                                   no row pointing at them: undiscoverable, and
--                                   unrecoverable.
--
--   storage first, then database    the sweep succeeds, and in the gap before the
--                                   delete the owner submits the PI from another
--                                   tab. The delete is now correctly refused —
--                                   and a VALID SUBMITTED PI SURVIVES WITH ITS
--                                   WORKBOOK AND EVERY PRODUCT IMAGE DESTROYED.
--                                   A reviewer opens a PI they cannot read.
--
-- The second is the one that must be impossible. It is not enough to make it
-- unlikely: it is silent, it is permanent, and it lands on the reviewer rather
-- than on whoever caused it.
--
-- THE FIX IS TO REMOVE THE GAP, NOT TO NARROW IT. Deletion RESERVES the record
-- before a single byte is removed, and while the reservation stands the PI
-- cannot be submitted, resubmitted, replaced, reviewed, decided or transitioned
-- by anybody, through any route, including direct SQL and the service role. So
-- by the time storage is touched there is no longer any transition that could
-- contradict it, and the final delete cannot be refused by an ordinary race
-- because an ordinary race can no longer occur.
--
--   1. begin_order_submission_deletion     authorize, verify status, RESERVE,
--                                          and hand back the storage keys
--   2. (the server route removes the objects)
--   3. finalize_order_submission_deletion  prove the claim, erase everything
--      or
--      release_order_submission_deletion   give the record back, intact
--
-- THE PATTERN IS NOT NEW. This is the processing lease of 20260909000000 —
-- begin_order_submission_processing / finish_order_submission_processing, a
-- token column, a timestamp column, a consistency CHECK and a TTL — applied to a
-- second operation that also spans the storage boundary. Reusing its shape
-- rather than inventing a parallel framework is deliberate: one idea to
-- understand, and one already proven in this schema.
--
--
-- WHY THE CLAIM BLOCKS TRANSITIONS AT ANY AGE
-- -------------------------------------------
-- A claim that expired into harmlessness would reopen the exact gap it exists to
-- close: the sweep runs long, the claim lapses, somebody submits, and the finalize
-- is refused with the files already gone. So the claim blocks workflow
-- transitions for as long as it exists, and its AGE governs only two things:
--
--   * whether ANOTHER DELETION ATTEMPT may take it over. A taken-over claim
--     still ends in deletion, so files already removed stay consistent with the
--     outcome.
--   * whether it may be RELEASED without presenting the token, which is how an
--     abandoned claim is cleared by hand.
--
-- So a crashed request never blocks a PI forever — it is retried, which takes
-- the claim over and finishes the job, or released, which gives the record back.
-- Neither is automatic, and that is the point: a claim standing after a crash
-- means files MAY already be gone, and quietly unfreezing the record would be
-- asserting something this database cannot know.
--
-- AND THE LAST LINE OF DEFENCE IS ALREADY THERE. submit_order_submission_*
-- verifies that the workbook and every product image still exist in storage
-- before it will submit anything (20260908000000 §8, 20260909000000 §6). A PI
-- whose files were removed therefore CANNOT reach review even if its claim were
-- released by hand — it is refused with ORDER_SUBMISSION_WORKBOOK_NOT_STORED.
-- Two independent mechanisms, and the invariant needs only one of them.
--
--
-- WHAT IS NOT DELETED
-- -------------------
-- Users, clients, catalogue products, Orders, Finance and payment records, and
-- every notification: the PI submission feature writes none, and nothing here
-- names one. The child deletes are each keyed on this submission's id alone.
--
--
-- WHAT THIS CANNOT DO
-- -------------------
-- Approve anything. No status transition is added, 'approved' stays unreachable,
-- order_id is never written, no number is allocated and no payment is touched.

-- ═══ 1. The reservation, as columns ═════════════════════════════════════════
--
-- On order_submissions rather than in a table of its own, exactly as the
-- processing lease is. A claim is a property of one record, at most one at a
-- time, and the row lock that decides "is this deletable" is then the same lock
-- that decides "is it already claimed" — one decision, not two that can
-- disagree.

alter table public.order_submissions
  add column if not exists deletion_claim_token uuid,
  add column if not exists deletion_claimed_at  timestamptz,
  add column if not exists deletion_claimed_by  uuid references public.users(id);

comment on column public.order_submissions.deletion_claim_token is
  'Reservation token held while a permanent deletion is in flight. Random per claim and never reusable for another submission: finalization matches it against THIS row. While it is set the record cannot be submitted, replaced, reviewed or transitioned by anybody.';
comment on column public.order_submissions.deletion_claimed_at is
  'When the deletion reservation was taken. Governs takeover and token-less release only — never whether the claim still blocks transitions.';
comment on column public.order_submissions.deletion_claimed_by is
  'The actor who reserved this record for deletion.';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.order_submissions'::regclass
      and conname  = 'order_submissions_deletion_claim_consistent'
  ) then
    alter table public.order_submissions
      add constraint order_submissions_deletion_claim_consistent check (
        (deletion_claim_token is null
         and deletion_claimed_at is null
         and deletion_claimed_by is null)
        or
        (deletion_claim_token is not null
         and deletion_claimed_at is not null
         and deletion_claimed_by is not null)
      );
  end if;
end $$;

-- Only a claimed row is indexed: a claim is rare and short-lived, and this is
-- read to find abandoned ones.
create index if not exists order_submissions_deletion_claimed_idx
  on public.order_submissions (deletion_claimed_at)
  where deletion_claim_token is not null;

/**
 * How long before an unfinished claim may be taken over or released by hand.
 *
 * FIVE MINUTES. A deletion is one storage listing and one remove call — seconds,
 * not minutes — so five is generous for the slowest real PI and short enough
 * that an abandoned claim is a brief inconvenience rather than a lost afternoon.
 * The processing lease next door is fifteen because a full workbook re-parse is
 * genuinely long; this is not.
 */
create or replace function public.order_submission_deletion_claim_ttl()
returns interval
language sql
immutable
set search_path = public, pg_temp
as $$ select interval '5 minutes' $$;

revoke execute on function public.order_submission_deletion_claim_ttl() from public, anon;
grant  execute on function public.order_submission_deletion_claim_ttl() to authenticated;

-- ═══ 2. The rule ════════════════════════════════════════════════════════════
--
-- ONE PLACE. The RPCs enforce it, the assertion suite tests it directly, and the
-- screen draws its control from the same three facts (status, owner, admin) so a
-- visible Delete matches what the database will allow.

create or replace function public.order_submission_deletable_statuses()
returns text[]
language sql
immutable
as $$
  -- 'draft' and 'needs_changes' are the states the EMPLOYEE owns. 'rejected' is
  -- a closed record the business does not require kept. Everything else — most
  -- importantly 'submitted' and 'approved' — is absent, and absence is the
  -- refusal: this is an allow-list, so a status invented by a later phase is
  -- refused until it is deliberately added here.
  select array['draft', 'needs_changes', 'rejected']::text[];
$$;

comment on function public.order_submission_deletable_statuses() is
  'The PI submission statuses that may be permanently deleted. An allow-list, so any future status fails closed.';

revoke execute on function public.order_submission_deletable_statuses() from public, anon;
grant  execute on function public.order_submission_deletable_statuses() to authenticated;

create or replace function public.order_submission_deletable_by(
  p_submission_id uuid,
  p_actor_id      uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_sub public.order_submissions%rowtype;
begin
  if p_submission_id is null or p_actor_id is null then
    return false;
  end if;

  -- The actor must be a real, active, non-deleted account. A soft-deleted
  -- employee does not keep the power to erase their old records.
  if not exists (
    select 1 from public.users u
    where u.id = p_actor_id and u.is_active and coalesce(u.is_deleted, false) = false
  ) then
    return false;
  end if;

  select * into v_sub from public.order_submissions where id = p_submission_id;
  if not found then
    return false;
  end if;

  if not (v_sub.status = any (public.order_submission_deletable_statuses())) then
    return false;
  end if;

  -- OWNERSHIP, the same pair can_edit_order_submission reads: the account the
  -- record was created by, or the one it is submitted on behalf of. Being the
  -- assigned REVIEWER is not ownership and confers nothing here.
  if v_sub.created_by = p_actor_id or v_sub.submitted_by = p_actor_id then
    return true;
  end if;

  -- Or an administrator. Not a permission — see the header.
  return exists (
    select 1 from public.users u
    where u.id = p_actor_id
      and u.is_active
      and coalesce(u.is_deleted, false) = false
      and u.role = 'admin'
  );
end;
$$;

comment on function public.order_submission_deletable_by(uuid, uuid) is
  'Whether this actor may permanently delete this PI submission: an active owner or an active admin, and only while the PI is a draft, has been returned for changes, or was rejected. Never a permission grant, and never while the PI is under review.';

revoke execute on function public.order_submission_deletable_by(uuid, uuid) from public, anon;
grant  execute on function public.order_submission_deletable_by(uuid, uuid) to authenticated;

-- ═══ 3. The purge marker ════════════════════════════════════════════════════
--
-- Set by finalization and by nothing else, for the duration of one transaction,
-- naming ONE submission id — so a purge in flight authorizes exactly the rows of
-- that submission and opens no window for any other.

create or replace function public.order_submission_purge_in_progress(p_submission_id uuid)
returns boolean
language plpgsql
stable
as $$
declare
  v_marker text := current_setting('boe.order_submission_purge_id', true);
begin
  return p_submission_id is not null
     and v_marker is not null
     and v_marker <> ''
     and v_marker = p_submission_id::text;
exception when others then
  -- A marker that is not a uuid, or any other surprise, is not authorization.
  return false;
end;
$$;

comment on function public.order_submission_purge_in_progress(uuid) is
  'True only inside finalize_order_submission_deletion(), and only for the submission that call is erasing.';

revoke execute on function public.order_submission_purge_in_progress(uuid)
  from public, anon, authenticated, service_role;

-- ═══ 4. A reserved PI is frozen, for every caller ═══════════════════════════
--
-- WHY TRIGGERS AND NOT SIX RESTATED FUNCTIONS. The transitions that must be
-- blocked live in submit_order_submission, submit_order_submission_with_note,
-- submit_order_submission_with_advance, replace_order_submission_parse,
-- request_order_submission_changes, reject_order_submission,
-- approve_pi_advance_exception and reject_pi_advance_exception — all of them
-- applied, all of them immutable, and every one of them ending in an UPDATE of
-- this row. Restating eight functions in order to add one condition to each
-- would be eight chances to drift from what is deployed. One trigger on the
-- UPDATE they all share is smaller, catches every one of them, and catches the
-- next one too — including direct SQL and the service role, neither of which
-- RLS or a table grant can reach.
--
-- WHAT IS STILL ALLOWED while a claim stands: writing, moving or clearing the
-- CLAIM ITSELF, and the purge. Nothing else about the record may move.

create or replace function public.order_submissions_guard_deletion_claim()
returns trigger
language plpgsql
as $$
declare
  v_claim_columns text[] := array[
    'deletion_claim_token', 'deletion_claimed_at', 'deletion_claimed_by', 'updated_at'
  ];
begin
  -- No reservation: this trigger has no opinion about anything.
  if old.deletion_claim_token is null then
    return new;
  end if;

  -- The purge itself, which is the one write that is meant to end this record.
  if public.order_submission_purge_in_progress(old.id) then
    return new;
  end if;

  -- Taking, moving or releasing the claim. Everything OUTSIDE the claim columns
  -- must be identical, so this cannot be used to smuggle a status change in
  -- alongside a release. updated_at is excluded because set_updated_at stamps it
  -- on every write and it says nothing about what changed.
  if (to_jsonb(new) - v_claim_columns) = (to_jsonb(old) - v_claim_columns) then
    return new;
  end if;

  raise exception
    'ORDER_SUBMISSION_DELETION_CLAIMED: this PI is reserved for deletion and cannot be changed'
    using errcode = '55P03';
end;
$$;

revoke execute on function public.order_submissions_guard_deletion_claim()
  from public, anon, authenticated, service_role;

drop trigger if exists order_submissions_guard_deletion_claim on public.order_submissions;
create trigger order_submissions_guard_deletion_claim
  before update on public.order_submissions
  for each row execute function public.order_submissions_guard_deletion_claim();

-- The children, for the same reason. A Change PI rewrites the product lines and
-- the pictures as well as the parent row, and while the parent row alone would
-- be enough to stop it atomically, a guard that names only one of the three
-- tables invites the next writer to use the other two.
create or replace function public.order_submission_child_guard_deletion_claim()
returns trigger
language plpgsql
as $$
declare
  v_submission uuid := coalesce(new.submission_id, old.submission_id);
begin
  if public.order_submission_purge_in_progress(v_submission) then
    return coalesce(new, old);
  end if;

  if exists (
    select 1 from public.order_submissions s
    where s.id = v_submission and s.deletion_claim_token is not null
  ) then
    raise exception
      'ORDER_SUBMISSION_DELETION_CLAIMED: this PI is reserved for deletion and cannot be changed'
      using errcode = '55P03';
  end if;

  return coalesce(new, old);
end;
$$;

revoke execute on function public.order_submission_child_guard_deletion_claim()
  from public, anon, authenticated, service_role;

drop trigger if exists order_submission_items_guard_deletion_claim
  on public.order_submission_items;
create trigger order_submission_items_guard_deletion_claim
  before insert or update or delete on public.order_submission_items
  for each row execute function public.order_submission_child_guard_deletion_claim();

drop trigger if exists order_submission_item_images_guard_deletion_claim
  on public.order_submission_item_images;
create trigger order_submission_item_images_guard_deletion_claim
  before insert or update or delete on public.order_submission_item_images
  for each row execute function public.order_submission_child_guard_deletion_claim();

-- ═══ 5. Direct deletion is refused, for every caller ════════════════════════
--
-- There is no DELETE policy on these tables and no DELETE grant to
-- `authenticated`, so a signed-in client already cannot delete a row — but RLS
-- and table privileges are both bypassed by the SERVICE ROLE and by direct psql.
-- A trigger is not.

create or replace function public.order_submissions_guard_delete()
returns trigger
language plpgsql
as $$
begin
  if public.order_submission_purge_in_progress(old.id) then
    return old;
  end if;
  raise exception
    'ORDER_SUBMISSION_DELETE_DENIED: a PI submission is deleted only through finalize_order_submission_deletion()'
    using errcode = '42501';
end;
$$;

revoke execute on function public.order_submissions_guard_delete()
  from public, anon, authenticated, service_role;

drop trigger if exists order_submissions_guard_delete on public.order_submissions;
create trigger order_submissions_guard_delete
  before delete on public.order_submissions
  for each row execute function public.order_submissions_guard_delete();

-- The activity trail was append-only with no DELETE policy for anybody, admin
-- included (20260908000000 §3). It stays that way. The ONE exception is the
-- purge of the submission the entries belong to — a trail without its record is
-- not history, it is litter.
create or replace function public.order_submission_activity_guard_delete()
returns trigger
language plpgsql
as $$
begin
  if public.order_submission_purge_in_progress(old.submission_id) then
    return old;
  end if;
  raise exception
    'ORDER_SUBMISSION_ACTIVITY_IMMUTABLE: PI submission history cannot be deleted'
    using errcode = '42501';
end;
$$;

revoke execute on function public.order_submission_activity_guard_delete()
  from public, anon, authenticated, service_role;

drop trigger if exists order_submission_activity_guard_delete on public.order_submission_activity;
create trigger order_submission_activity_guard_delete
  before delete on public.order_submission_activity
  for each row execute function public.order_submission_activity_guard_delete();

-- ═══ 6. begin — authorize, reserve, and report the files ════════════════════
--
-- NOTHING IS DESTROYED HERE. This proves the caller may delete this record, and
-- freezes it so that nothing can contradict what happens next. If any check
-- fails, no reservation is taken and no storage object has been touched.
--
-- THE KEYS ARE READ FROM THE DATABASE, never from anything a browser sent, and
-- they are all under submissions/{id}/, which the path CHECK constraints in
-- 20260908000000 and 20260909000000 make exclusive to this submission. No shared
-- object can be named by this function.

create or replace function public.begin_order_submission_deletion(p_submission_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor     uuid := public.assert_order_submission_actor();
  v_sub       public.order_submissions%rowtype;
  v_token     uuid;
  v_took_over boolean := false;
  v_paths     text[];
begin
  -- THE LOCK COMES FIRST, before the status is judged. Between the screen
  -- drawing a Delete control and this running, the owner may have submitted the
  -- PI in another tab; `for update` makes the state this function reads the
  -- state it reserves.
  select * into v_sub
  from public.order_submissions
  where id = p_submission_id
  for update;

  if not found then
    raise exception 'ORDER_SUBMISSION_DELETE_MISSING: this PI no longer exists'
      using errcode = 'P0002';
  end if;

  -- STATUS BEFORE ACTOR, deliberately. "This PI is under review and cannot be
  -- deleted" is the true and useful answer for an owner AND for an admin, and
  -- answering it with a permission refusal would send both of them looking for a
  -- grant that would never have helped.
  if not (v_sub.status = any (public.order_submission_deletable_statuses())) then
    raise exception
      'ORDER_SUBMISSION_DELETE_STATUS: a PI in this state cannot be deleted (this one is %)',
      v_sub.status
      using errcode = 'P0001';
  end if;

  if not public.order_submission_deletable_by(p_submission_id, v_actor) then
    raise exception
      'ORDER_SUBMISSION_DELETE_DENIED: only the owner of this PI or an administrator can delete it'
      using errcode = '42501';
  end if;

  if v_sub.deletion_claim_token is not null then
    if v_sub.deletion_claimed_at > now() - public.order_submission_deletion_claim_ttl() then
      -- 55P03 is lock_not_available: a retryable "busy", not a failure. This is
      -- what a double click meets, and the screen says so neutrally rather than
      -- reporting an error for a deletion that is already happening.
      raise exception
        'ORDER_SUBMISSION_DELETION_IN_PROGRESS: this PI is already being deleted'
        using errcode = '55P03';
    end if;
    -- Past the TTL the previous attempt is presumed dead. Taking over issues a
    -- NEW token, so the abandoned request can no longer finalize or release
    -- behind this one's back — and because a takeover still ends in deletion,
    -- any object the dead attempt already removed stays consistent with the
    -- outcome.
    v_took_over := true;
  end if;

  -- The workbook, and every picture. Collected BEFORE the freeze is announced
  -- so the caller has the complete list it needs and never has to ask again.
  select coalesce(array_agg(path order by path), array[]::text[])
    into v_paths
  from (
    select v_sub.source_workbook_path as path
    where nullif(btrim(coalesce(v_sub.source_workbook_path, '')), '') is not null
    union
    select i.storage_path
    from public.order_submission_item_images i
    where i.submission_id = p_submission_id
      and nullif(btrim(coalesce(i.storage_path, '')), '') is not null
  ) owned;

  -- gen_random_uuid() is pgcrypto's CSPRNG. The token is not guessable, and it
  -- is not reusable for another submission: finalization matches it against THIS
  -- row, so a token issued for one PI names nothing on any other.
  v_token := gen_random_uuid();

  update public.order_submissions
     set deletion_claim_token = v_token,
         deletion_claimed_at  = now(),
         deletion_claimed_by  = v_actor
   where id = p_submission_id;

  return jsonb_build_object(
    'submission_id',  p_submission_id,
    'claim_token',    v_token,
    'took_over',      v_took_over,
    'client_name',    v_sub.client_name,
    'status',         v_sub.status,
    'storage_prefix', 'submissions/' || p_submission_id::text,
    'storage_paths',  to_jsonb(v_paths)
  );
end;
$$;

comment on function public.begin_order_submission_deletion(uuid) is
  'Reserves one PI submission for permanent deletion and returns the storage keys it owns. Owner or active admin only, and only from draft, needs_changes or rejected. Destroys nothing: while the reservation stands the PI cannot be submitted, replaced, reviewed or transitioned by any caller, so the storage cleanup that follows cannot be contradicted.';

revoke all     on function public.begin_order_submission_deletion(uuid) from public, anon;
grant  execute on function public.begin_order_submission_deletion(uuid) to authenticated;

-- ═══ 7. release — give the record back, whole ═══════════════════════════════
--
-- The storage sweep failed, or the operator changed their mind. The record and
-- every one of its child rows are untouched, so releasing the claim returns it
-- to exactly the state it was in before begin ran.
--
-- IT RETURNS RATHER THAN RAISES, because the route calls it from a failure path:
-- a release that threw would replace the real error with a cleanup error and
-- lose the reason the operation failed.
--
-- TWO WAYS IN. With the token, which is the holder finishing its own failed
-- attempt. Or without it, which is how an ABANDONED claim is cleared by hand —
-- allowed only once the claim is stale, and only for somebody who could have
-- deleted the record anyway.

create or replace function public.release_order_submission_deletion(
  p_submission_id uuid,
  p_claim_token   uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := public.assert_order_submission_actor();
  v_sub   public.order_submissions%rowtype;
  v_stale boolean;
begin
  select * into v_sub
  from public.order_submissions
  where id = p_submission_id
  for update;

  if not found then
    return jsonb_build_object('released', false, 'reason', 'not_found');
  end if;
  if v_sub.deletion_claim_token is null then
    return jsonb_build_object('released', false, 'reason', 'not_claimed');
  end if;

  v_stale := v_sub.deletion_claimed_at
             <= now() - public.order_submission_deletion_claim_ttl();

  if p_claim_token is not null then
    if v_sub.deletion_claim_token <> p_claim_token then
      -- A late arrival whose claim was taken over releases nothing, which is the
      -- correct outcome: the record now belongs to somebody else's attempt.
      return jsonb_build_object('released', false, 'reason', 'not_holder');
    end if;
  else
    -- The by-hand path. A LIVE claim is somebody's attempt in flight and must not
    -- be snatched away from it; a stale one is nobody's.
    if not v_stale then
      return jsonb_build_object('released', false, 'reason', 'claim_active');
    end if;
    if not public.order_submission_deletable_by(p_submission_id, v_actor) then
      return jsonb_build_object('released', false, 'reason', 'not_permitted');
    end if;
  end if;

  update public.order_submissions
     set deletion_claim_token = null,
         deletion_claimed_at  = null,
         deletion_claimed_by  = null
   where id = p_submission_id;

  return jsonb_build_object('released', true, 'was_stale', v_stale);
end;
$$;

comment on function public.release_order_submission_deletion(uuid, uuid) is
  'Releases a deletion reservation, leaving the PI and all of its records exactly as they were. With the claim token, for the holder of a failed attempt; without it, for an owner or admin clearing a claim that has gone stale. Returns rather than raises, because it is called from a failure path.';

revoke all     on function public.release_order_submission_deletion(uuid, uuid) from public, anon;
grant  execute on function public.release_order_submission_deletion(uuid, uuid) to authenticated;

-- ═══ 8. finalize — erase it ═════════════════════════════════════════════════
--
-- The storage objects are gone. This is the point of no return, and it is
-- reached only by presenting the claim that froze the record — so the status it
-- checks cannot have moved since begin read it, because the guard in section 4
-- has refused every transition in between.
--
-- ATOMICITY — one function body is one transaction. A failure at any step rolls
-- back every earlier step, so there is no state in which the product lines are
-- gone but the submission survives, or the submission is gone but its trail
-- remains.
--
-- ORDER — children first, then the row. Every child FK is ON DELETE CASCADE and
-- none of them is relied on: the rows are removed explicitly and counted, so the
-- result reports what actually happened rather than what Postgres was trusted to
-- do quietly.

create or replace function public.finalize_order_submission_deletion(
  p_submission_id uuid,
  p_claim_token   uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor    uuid := public.assert_order_submission_actor();
  v_sub      public.order_submissions%rowtype;
  v_n_images int;
  v_n_items  int;
  v_n_events int;
begin
  if p_claim_token is null then
    raise exception 'ORDER_SUBMISSION_DELETION_CLAIM_INVALID: a deletion claim is required'
      using errcode = 'P0001';
  end if;

  select * into v_sub
  from public.order_submissions
  where id = p_submission_id
  for update;

  if not found then
    raise exception 'ORDER_SUBMISSION_DELETE_MISSING: this PI no longer exists'
      using errcode = 'P0002';
  end if;

  -- THE CLAIM, and it must be THIS submission's own. A token issued for another
  -- record matches nothing here, and a claim that was released or taken over
  -- matches nothing either — so a stale token cannot delete anything.
  if v_sub.deletion_claim_token is null
     or v_sub.deletion_claim_token <> p_claim_token then
    raise exception
      'ORDER_SUBMISSION_DELETION_CLAIM_INVALID: this deletion claim is not valid for this PI'
      using errcode = '42501';
  end if;

  -- The claim holder finishes their own attempt; an admin may finish anybody's.
  -- A colleague holding a leaked token still cannot, because they could not have
  -- deleted the record in the first place.
  if v_sub.deletion_claimed_by <> v_actor
     and not public.order_submission_deletable_by(p_submission_id, v_actor) then
    raise exception
      'ORDER_SUBMISSION_DELETE_DENIED: only the owner of this PI or an administrator can delete it'
      using errcode = '42501';
  end if;

  -- BELT AND BRACES. The guard in section 4 has made this unreachable — nothing
  -- could have moved the status while the claim stood — and it is checked anyway,
  -- because "unreachable" is a claim about code that has not been edited yet.
  if not (v_sub.status = any (public.order_submission_deletable_statuses())) then
    raise exception
      'ORDER_SUBMISSION_DELETE_STATUS: a PI in this state cannot be deleted (this one is %)',
      v_sub.status
      using errcode = 'P0001';
  end if;

  perform set_config('boe.order_submission_purge_id', p_submission_id::text, true);

  delete from public.order_submission_item_images where submission_id = p_submission_id;
  get diagnostics v_n_images = row_count;

  delete from public.order_submission_items where submission_id = p_submission_id;
  get diagnostics v_n_items = row_count;

  delete from public.order_submission_activity where submission_id = p_submission_id;
  get diagnostics v_n_events = row_count;

  delete from public.order_submissions where id = p_submission_id;

  perform set_config('boe.order_submission_purge_id', '', true);

  return jsonb_build_object(
    'deleted',       true,
    'submission_id', p_submission_id,
    'client_name',   v_sub.client_name,
    'status',        v_sub.status,
    'items',         v_n_items,
    'images',        v_n_images,
    'activity',      v_n_events
  );
end;
$$;

comment on function public.finalize_order_submission_deletion(uuid, uuid) is
  'Erases a reserved PI submission and every record that belongs solely to it, in one transaction, on presentation of its deletion claim. Deletes no storage object — the caller has already removed them, which is why the reservation existed. Creates, records and implies no payment and no approval.';

revoke all     on function public.finalize_order_submission_deletion(uuid, uuid) from public, anon;
grant  execute on function public.finalize_order_submission_deletion(uuid, uuid) to authenticated;
