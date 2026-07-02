-- Register Finance in the Control Center module registry (app_modules).
-- 'live' preserves Finance's current default access (no guard existed before,
-- so it was open to any authenticated user) while making it controllable
-- from Control Center going forward.

INSERT INTO public.app_modules
  (module_key, module_name, description, route_path, visibility_type, allowed_department, sort_order)
VALUES
  (
    'finance',
    'Finance',
    'Payment confirmations, order advances, and finance approvals.',
    '/finance',
    'live',
    NULL,
    90
  )
ON CONFLICT (module_key) DO NOTHING;
