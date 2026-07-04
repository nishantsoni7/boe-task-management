-- Phase 3C/3E follow-up (pre-cutover gate, NOT Phase 3F): backfill the
-- centralized engine's employee_permission_overrides from the legacy
-- employee_permissions table for Sample Tracking.
--
-- This is the exact, reviewed backfill from
-- docs/Module Docs/permissions-3f-backfill-DRAFT.sql PART 3, validated
-- against production data in Phase 3C (dry run: 3 rows, all
-- would-migrate-direct, 0 rejected, 0 skipped) and confirmed as the sole
-- source of the 3 explained mismatches found in Phase 3E's shadow
-- verification (docs/Module Docs/PERMISSIONS_MIGRATION_PHASE3E.md).
--
-- Scope discipline: this migration ONLY writes employee_permission_overrides.
-- It does not touch RLS, has_permission(), any application code, or the
-- legacy employee_permissions table itself (which remains the live
-- authorization source until Phase 3F). Enforcement is unchanged — nothing
-- in any live RLS policy or route consults employee_permission_overrides
-- for the sample_tracking module yet.
--
-- Idempotent: NOT EXISTS guard + ON CONFLICT DO NOTHING on the
-- (user_id, module_id, action_id) unique constraint.

INSERT INTO public.employee_permission_overrides
  (user_id, module_id, action_id, allowed, granted_by, granted_at, revoked_by, revoked_at)
SELECT
  ep.user_id,
  pm.id,
  pa.id,
  true,
  ep.granted_by,
  ep.granted_at,
  ep.revoked_by,
  ep.revoked_at
FROM public.employee_permissions ep
JOIN (VALUES
    ('samples_dispatch', 'dispatch'),
    ('samples_receive',  'receive'),
    ('samples_lost',     'mark_lost'),
    ('samples_close',    'close')
  ) AS lam(permission_key, action_key) ON lam.permission_key = ep.permission_key
JOIN public.permission_modules pm ON pm.module_key = 'sample_tracking'
JOIN public.permission_actions pa ON pa.action_key = lam.action_key
WHERE NOT EXISTS (
  SELECT 1 FROM public.employee_permission_overrides epo
  WHERE epo.user_id = ep.user_id AND epo.module_id = pm.id AND epo.action_id = pa.id
)
ON CONFLICT (user_id, module_id, action_id) DO NOTHING;
