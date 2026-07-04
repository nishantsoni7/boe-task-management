-- ============================================================================
-- Phase 3E — Shadow Verification (read-only, no writes)
-- ============================================================================
-- Compares the legacy authorization decision against the centralized
-- resolver's decision, for every active user x every Sample Tracking
-- action, using the REAL functions from both systems (not a
-- reimplementation of their logic).
--
-- "Legacy effective" mirrors what the live RLS policies actually decide
-- today: sample_dispatches' policies are `role = 'admin' OR
-- has_permission(uid, key)` (see sample_dispatches_select in
-- 20260634_create_employee_permissions.sql) — has_permission() itself
-- has no admin bypass baked in, the OR in the policy provides it. So
-- comparing raw has_permission() output to resolve_permission() output
-- (which DOES have admin baked in via Phase 3D's role_permissions) would
-- report false "mismatches" for every admin, on every action, even though
-- real-world authorization is identical. This query reproduces the real
-- policy-level decision on the legacy side so the comparison reflects
-- actual behavioral equivalence, not an artifact of where each system
-- happens to store its admin bypass.
--
-- Run: npx supabase db query --linked -f <this file>
-- ============================================================================

WITH legacy_action_map (permission_key, action_key) AS (
  VALUES
    ('samples_dispatch', 'dispatch'),
    ('samples_receive',  'receive'),
    ('samples_lost',     'mark_lost'),
    ('samples_close',    'close')
),
checks AS (
  SELECT
    u.id                                                          AS user_id,
    u.full_name,
    u.role,
    lam.permission_key,
    lam.action_key,
    has_permission(u.id, lam.permission_key)                      AS legacy_raw,
    (u.role = 'admin' OR has_permission(u.id, lam.permission_key)) AS legacy_effective,
    resolve_permission(u.id, 'sample_tracking', lam.action_key)    AS centralized_effective
  FROM users u
  CROSS JOIN legacy_action_map lam
  -- No is_active filter: this is the full user population (13 users x 4
  -- actions = 52 checks), not a sample, so an inactive account's disposition
  -- is verified too rather than assumed.
)
SELECT
  full_name,
  role,
  permission_key,
  action_key,
  legacy_raw,
  legacy_effective,
  centralized_effective,
  (legacy_effective = centralized_effective) AS match
FROM checks
ORDER BY (legacy_effective = centralized_effective) ASC, full_name, permission_key;
