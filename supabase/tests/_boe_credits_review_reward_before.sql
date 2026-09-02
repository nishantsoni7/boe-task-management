-- ═════════════════════════════════════════════════════════════════════════════
-- TEST-ONLY FIXTURE — the world BEFORE 20261102000000 applies
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Applied by run_boe_credits_review_reward_local.sh AFTER the Review Workflow
-- chain and the BOE Credits foundation, and BEFORE the migration under test.
-- It creates the people the assertions name, and ONE review that was already
-- verified under the previous definition of the transition — the historical
-- record Phase 1B promises not to reward. The assertions check that promise.
--
-- It is not a migration and must never enter supabase/migrations. It commits
-- (the assertions roll back around it), so a run leaves these rows on the
-- disposable database; that is what the runner's emptiness guard is for.

-- ─── The people ──────────────────────────────────────────────────────────────
--
-- admin     use + verify, from the role_permissions seed in 20261017000000.
-- tester    use only, by employee override. The employee who does reviews.
-- second    use only, by employee override. A second reviewer, to prove the
--           reward follows the card's holder and not the last person rewarded.
-- nobody    an active member with no grant at all.
-- exverif   an admin who was deactivated.

insert into public.users (id, full_name, email, role, team, is_active, created_at, updated_at, employee_code) values
  ('a0000000-0000-4000-8000-00000000000a', 'Test Admin',    'admin@example.test',  'admin',  'management', true,  now(), now(), 'T-ADM'),
  ('e1000000-0000-4000-8000-0000000000e1', 'Test Reviewer', 'one@example.test',    'member', 'sales',      true,  now(), now(), 'T-001'),
  ('e2000000-0000-4000-8000-0000000000e2', 'Second Reviewer','two@example.test',   'member', 'sales',      true,  now(), now(), 'T-002'),
  ('e3000000-0000-4000-8000-0000000000e3', 'Test Nobody',   'nobody@example.test', 'member', 'sales',      true,  now(), now(), 'T-003'),
  ('a1000000-0000-4000-8000-00000000001a', 'Test Ex-Admin', 'ex@example.test',     'admin',  'management', false, now(), now(), 'T-EXA');

-- `use` for the two reviewers, as Control Center would grant it.
insert into public.employee_permission_overrides (user_id, module_id, action_id, allowed, granted_by)
select u.id, pm.id, pa.id, true, 'a0000000-0000-4000-8000-00000000000a'
  from public.permission_modules pm
  join public.permission_actions pa on pa.action_key = 'use'
  join public.users u on u.id in ('e1000000-0000-4000-8000-0000000000e1', 'e2000000-0000-4000-8000-0000000000e2')
 where pm.module_key = 'customer_review_requests';

-- ─── The historical review ───────────────────────────────────────────────────
--
-- Verified BEFORE Phase 1B exists, by the previous transition. Inserted as the
-- finished record it would be by now, with every timestamp the shape rules
-- require. It must still have no reward after 20261102000000 applies.

insert into public.customer_review_test_cards (
  id, card_ref, test_category, test_title, test_body, status,
  approved_by, approved_at,
  booked_by, booked_at,
  sent_confirmed_by, sent_confirmed_at,
  submitted_by, submitted_at,
  verified_by, verified_at, verification_note
) values (
  'c0000000-0000-4000-8000-0000000000c0', 'RW-000900', 'restaurant_test',
  'Historical review, verified before Phase 1B',
  'Harness filler long enough to clear the minimum body length. It describes nothing and is attributed to nobody. Historical.',
  'verified',
  'a0000000-0000-4000-8000-00000000000a', now() - interval '10 days',
  'e1000000-0000-4000-8000-0000000000e1', now() - interval '9 days',
  'e1000000-0000-4000-8000-0000000000e1', now() - interval '8 days',
  'e1000000-0000-4000-8000-0000000000e1', now() - interval '7 days',
  'a0000000-0000-4000-8000-00000000000a', now() - interval '6 days', 'Verified under the old definition'
);

do $$
begin
  assert (select count(*) from public.boe_credit_transactions) = 0,
    'BEFORE: the ledger must be empty before the migration under test';
  assert (select count(*) from public.customer_review_test_cards where status = 'verified') = 1,
    'BEFORE: exactly one historical verified review';
  raise notice 'BEFORE: 5 people, 2 use grants, 1 historical verified review, ledger empty';
end $$;
