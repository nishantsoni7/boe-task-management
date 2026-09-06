-- ════════════════════════════════════════════════════════════════════════════
-- Performance participation: hold one partner out of the measured population
-- ════════════════════════════════════════════════════════════════════════════
--
-- A DATA MIGRATION, NOT A SCHEMA ONE. Nothing is created, altered or dropped
-- here. The mechanism already exists and has since 20260719000000:
--
--   users.performance_tracking_enabled   NOT NULL DEFAULT true
--
-- and src/lib/performanceEligibility.ts applies it through partitionByTracking()
-- in GET /api/performance-metrics/team BEFORE any employee is fetched and before
-- any figure is computed. Two accounts are already held out by it (an
-- administrator account and a test account), so this file uses a switch the
-- product has been using for months rather than inventing a second one.
--
-- WHAT IT DOES. Sets the flag false for one employee: a PARTNER who holds a
-- manager role and full system access but is not one of the employees
-- Performance measures. He was appearing in the team list, the team average,
-- the rankings, Best Performer / Most Improved / Needs Attention, the EOD
-- on-time rate and the tracked-employee count — describing a population the
-- owner does not manage, which is the exact problem performance_tracking_enabled
-- exists to solve.
--
-- PARTICIPATION IS NOT ACCESS, and this file changes only the first:
--
--   participation  users.performance_tracking_enabled — are you MEASURED?
--   access         performance:view / view_team / view_all — what may you OPEN?
--
-- His role, his login, his module access and his permission rows are untouched.
-- He remains an active user with the same authority he had this morning.
--
-- NOTHING IS DELETED. No score, EOD log, activity row or historical record is
-- read or written by this migration. Exclusion is a reporting decision applied
-- at query time, so it is fully reversible: an administrator can switch
-- "Included in Performance" back on in Control Center › People › Employees and
-- his history becomes visible again under the ordinary date rules. That is the
-- reason this is a flag rather than a deletion.
--
-- TARGETED BY users.id, the stable identifier and the repository's convention
-- for a per-employee change (20260723000000 §3a/§3b lists ten ids with the name
-- in a trailing comment). A display name is editable free text and two employees
-- may share one; the primary key is neither. Section 2 additionally refuses to
-- let the flag be set on the wrong person.
--
-- Idempotent: the UPDATE is a no-op on a second run, and it writes nothing on a
-- database that does not contain this id — a fresh local stack, a restored
-- fixture — so the migration is a production fact, not a schema fact.

-- ─── 1. Hold the partner out of Performance reporting ────────────────────────
--
-- The note is written alongside the flag because the admin-only Performance
-- Coverage panel reads it, and "why is this person not in the report" is a
-- question somebody will ask months from now. It records management's reason,
-- and — see EXCLUDED_SELF_NOTICE in performanceEligibility.ts — it is
-- deliberately never shown to the account holder.

update public.users
   set performance_tracking_enabled = false,
       performance_tracking_note =
         'Partner. Holds a manager role and full system access, but is not one of '
         || 'the employees Performance measures, so he is excluded from the team '
         || 'list, averages, rankings and rates. Access is unchanged; history is '
         || 'retained and this is reversible from Control Center.'
 where id = '58ec48e3-d252-4660-b61b-4db48fb58e9e'   -- Nitish Bansal, nitish.bansal4956@gmail.com
   and performance_tracking_enabled is distinct from false;

-- ─── 2. Assertions ───────────────────────────────────────────────────────────
--
-- A silently mis-targeted participation change would remove the wrong person
-- from every Performance figure in the company, and nothing downstream would
-- report an error — the report would simply be quietly wrong. So the identity is
-- re-checked against the email before the result is accepted.

do $$
declare
  v_target record;
begin
  select id, lower(trim(email)) as email, role, is_active, performance_tracking_enabled
    into v_target
    from public.users
   where id = '58ec48e3-d252-4660-b61b-4db48fb58e9e';

  -- Absent on a database that never had him. Nothing was written; nothing to check.
  if v_target.id is null then
    raise notice 'Performance participation: target account absent, no change made';
    return;
  end if;

  if v_target.email is distinct from 'nitish.bansal4956@gmail.com' then
    raise exception
      'refusing to change Performance participation: % is %, not the reviewed account',
      v_target.id, coalesce(v_target.email, '<no email>');
  end if;

  if v_target.performance_tracking_enabled is distinct from false then
    raise exception 'the reviewed account should be excluded from Performance; flag is %',
      coalesce(v_target.performance_tracking_enabled::text, 'null');
  end if;

  -- ACCESS IS UNTOUCHED. Stated as an assertion rather than a promise: if this
  -- file ever grows a statement that revokes something, this fails.
  if v_target.is_active is not true then
    raise exception 'the reviewed account must remain active; participation is not access';
  end if;
  if v_target.role is distinct from 'manager' then
    raise exception 'the reviewed account role changed to %; this migration must not touch roles',
      v_target.role;
  end if;
end $$;
