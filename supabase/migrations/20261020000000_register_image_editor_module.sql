-- Image Editor — Control Center registration and two permissions.
--
-- WHAT THIS IS
-- ------------
-- The Image Editor shipped in #69/#70 and is open to every signed-in BOE user.
-- This puts it behind Control Center like every other module, with the two
-- grants the product owner asked for:
--
--   view    → "View" in Control Center. See the launcher card, open
--             /image-editor.
--   create  → "Use" in Control Center. Upload a photograph and generate,
--             which costs TWO billable provider requests per image.
--
-- No custom action key. `create` is a system action already registered by
-- 20260660, so this adds no vocabulary — generating a catalogue image is
-- creating a work product, the same reading `create` carries everywhere else.
--
-- NO TABLES, AND WHAT THAT MEANS FOR THE PARENT GATE
-- ---------------------------------------------------
-- The Image Editor stores nothing: no bucket, no rows, no history. Uploads are
-- read into memory, sent to the provider, and returned in the response body.
-- So unlike every module before it there is nothing here to attach a
-- RESTRICTIVE policy to, and 20260905000000's module_entry_open() gate — which
-- works by being AND-ed with the policies on a module's tables — has no
-- surface.
--
-- resolve_permission() does not apply that gate either; it returns the raw
-- effective value for the action asked about. So the dormant-child state
-- (view = false, create = true), which Control Center deliberately allows an
-- administrator to store, MUST be gated in the application instead:
-- src/lib/permissions/imageEditor.ts requires BOTH actions before it reports
-- canGenerate, and both API routes check the same way before reading an upload
-- or calling a provider. That is stated here because a future reader looking
-- for the usual RLS gate will not find one, and the absence is deliberate.
--
-- DELIBERATELY NOT HERE
--   No roles, no approval flow, no usage limits, no billing. No new table, no
--   RLS policy, no change to any other module's grants.

-- ═══ 1. Control Center module registry (route visibility) ═══════════════════
--
-- Mirrors the seed shape in 20260645_create_control_center_v1.sql. Sort order
-- 95, after Meetings (90).

INSERT INTO public.app_modules
  (module_key, module_name, description, route_path, visibility_type, allowed_department, sort_order)
VALUES
  ('image_editor', 'Image Editor',
   'Turn factory furniture photographs into catalogue studio images.',
   '/image-editor', 'live', NULL, 95)
ON CONFLICT (module_key) DO NOTHING;

-- ═══ 2. Permission engine registry ══════════════════════════════════════════
--
-- Mirrors src/lib/permissions/modules.ts exactly — `npm run permissions:check`
-- fails the build if the two drift.

INSERT INTO public.permission_modules (module_key, display_name, description) VALUES
  ('image_editor', 'Image Editor',
   'Turn factory furniture photographs into catalogue studio images.')
ON CONFLICT (module_key) DO NOTHING;

-- ═══ 3. Actions, both defaulting to DENIED ══════════════════════════════════
--
-- System Default = false for both. Every generation costs money, so nobody
-- holds anything here until an administrator grants it — the same stance
-- Meetings took (20260814000000), and the opposite of the 'live' default that
-- made the asset inventory readable company-wide (see 20260810000000).

INSERT INTO public.module_permission_actions (module_id, action_id, default_allowed)
SELECT pm.id, pa.id, false
FROM public.permission_modules pm
JOIN public.permission_actions pa ON pa.action_key IN ('view', 'create')
WHERE pm.module_key = 'image_editor'
ON CONFLICT (module_id, action_id) DO NOTHING;

-- ═══ 4. Role defaults ═══════════════════════════════════════════════════════
--
-- admin only, matching every other module's seed. No manager or member default:
-- this is a paid feature and a manager who needs it is granted it explicitly.

INSERT INTO public.role_permissions (role, module_id, action_id, allowed)
SELECT 'admin', mpa.module_id, mpa.action_id, true
FROM public.module_permission_actions mpa
JOIN public.permission_modules pm ON pm.id = mpa.module_id AND pm.module_key = 'image_editor'
ON CONFLICT (role, module_id, action_id) DO NOTHING;
