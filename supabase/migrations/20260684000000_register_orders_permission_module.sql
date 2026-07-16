-- Registers the existing `orders` module (Order Management) in the
-- centralized permission engine so it appears on Control Center ->
-- Access Control and admins keep full access to it by default.
--
-- Order Management already exists as a live app_modules entry (see
-- 20260655_create_orders.sql) and as live routes (/orders, /orders/all,
-- /orders/requests, /orders/[id]) — this migration only adds it to the
-- *separate* permission_modules registry (see
-- 20260660_create_permission_engine.sql for why the two systems are
-- distinct and do not drift into each other). Mirrors that migration's
-- original seed shape exactly, plus the admin role_permissions backfill
-- pattern from 20260663_admin_defaults_sample_tracking_new_actions.sql.
--
-- Order Requests (/orders/requests) is deliberately NOT registered as its
-- own module here — it lives under the same /orders route tree and
-- inherits this module's 'view' permission via the shared
-- src/app/orders/layout.tsx guard (see that file and
-- src/lib/permissions/modules.ts for the app-code half of this change).

INSERT INTO public.permission_modules (module_key, display_name, description) VALUES
  ('orders', 'Order Management', 'Track confirmed orders from request through production and dispatch.')
ON CONFLICT (module_key) DO NOTHING;

-- Supported actions, System Default = false (deny) everywhere, matching
-- every other module's seed convention.
INSERT INTO public.module_permission_actions (module_id, action_id, default_allowed)
SELECT pm.id, pa.id, false
FROM public.permission_modules pm
JOIN public.permission_actions pa ON pa.action_key IN
  ('view', 'create', 'edit', 'delete', 'approve', 'export', 'manage')
WHERE pm.module_key = 'orders'
ON CONFLICT (module_id, action_id) DO NOTHING;

-- Role level: admin retains full access, matching the existing app-wide
-- "admin can do everything" convention and every other module's seed.
INSERT INTO public.role_permissions (role, module_id, action_id, allowed)
SELECT 'admin', mpa.module_id, mpa.action_id, true
FROM public.module_permission_actions mpa
JOIN public.permission_modules pm ON pm.id = mpa.module_id AND pm.module_key = 'orders'
ON CONFLICT (role, module_id, action_id) DO NOTHING;
