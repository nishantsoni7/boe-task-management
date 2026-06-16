-- Asset Inventory correction: allow admins to delete assets.
-- The V1 reset migration (20260640) granted admins select/insert/update on
-- public.assets but no delete policy, so deletes were blocked by RLS.
-- Employee permissions are unchanged.

create policy "assets_admin_delete" on public.assets
  for delete to authenticated
  using (
    exists (select 1 from public.users where users.id = auth.uid() and users.role = 'admin')
  );
