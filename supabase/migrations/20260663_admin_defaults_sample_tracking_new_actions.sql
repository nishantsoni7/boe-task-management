-- Phase 3D: populate default role_permissions for the 4 Sample Tracking
-- actions added in Phase 3B (dispatch, receive, mark_lost, close).
--
-- Additive only, admin-only. Mirrors the original seed pattern in
-- 20260660_create_permission_engine.sql ("admin retains full access to
-- every registered module/action") for exactly the 4 new
-- module_permission_actions rows that 20260660 predates and therefore
-- never seeded. Does not touch role_permissions for manager/member (this
-- app's other role values) or for any other module — the legacy
-- employee_permissions mechanism never auto-granted samples_* to
-- non-admins by default either, so leaving them unseeded here preserves
-- that behavior rather than changing it.
--
-- Zero enforcement impact: nothing in any live RLS policy or application
-- route calls resolve_permission()/resolve_effective_permissions() for the
-- sample_tracking module yet — Sample Tracking authorization is still
-- entirely governed by the legacy has_permission()/employee_permissions
-- path (see docs/Module Docs/PERMISSIONS_MIGRATION_PHASE3A.md). This
-- migration only makes the *future* resolver answer correctly once
-- Phase 3F wires it in; it changes no runtime behavior today.

INSERT INTO public.role_permissions (role, module_id, action_id, allowed)
SELECT 'admin', mpa.module_id, mpa.action_id, true
FROM public.module_permission_actions mpa
JOIN public.permission_modules pm ON pm.id = mpa.module_id AND pm.module_key = 'sample_tracking'
JOIN public.permission_actions pa ON pa.id = mpa.action_id AND pa.action_key IN ('dispatch', 'receive', 'mark_lost', 'close')
ON CONFLICT (role, module_id, action_id) DO NOTHING;
