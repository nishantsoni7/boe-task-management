-- 20270519000000_seo_board_edits_and_decisions.sql
--
-- SEO step 2: the module's first writes from the app. `edit` updates a Vision board item (Contributor); `approve`
-- answers a proposed strategy change (Manager), so the SEO employee can be given board updates without deciding
-- strategy. The Admin role holds both. Everybody else is off until an administrator grants it per person.
--
-- The tables still refuse browsers: both writes go through a function here, which reads auth.uid() itself. The
-- sessions fetch edits and answers from GET /api/integrations/seo/decisions before they send, so the website folder
-- never overwrites them. The door's upsert does not name the new columns, so it leaves them alone.
--
-- ROLLBACK (nothing else reads these):
--   drop function public.seo_update_plan_item(text, text, text), public.seo_decide_proposal(text, text, text);
--   alter table public.seo_plan_items drop column edited_at, drop column edited_by;
--   alter table public.seo_log drop column decision, drop column decision_note, drop column decided_at, drop column decided_by;
--   delete the `edit` and `approve` rows for 'seo' from employee_permission_overrides, role_permissions and
--   module_permission_actions.

insert into public.module_permission_actions (module_id, action_id, default_allowed)
select pm.id, pa.id, false
from public.permission_modules pm
join public.permission_actions pa on pa.action_key in ('edit', 'approve')
where pm.module_key = 'seo'
on conflict (module_id, action_id) do nothing;

insert into public.role_permissions (role, module_id, action_id, allowed)
select 'admin', mpa.module_id, mpa.action_id, true
from public.module_permission_actions mpa
join public.permission_modules pm on pm.id = mpa.module_id
where pm.module_key = 'seo'
on conflict (role, module_id, action_id) do nothing;

alter table public.seo_plan_items
  add column edited_at timestamptz,
  add column edited_by uuid references public.users(id) on delete set null;

alter table public.seo_log
  add column decision text check (decision in ('keep', 'change')),
  add column decision_note text not null default '' check (length(decision_note) <= 1000),
  add column decided_at timestamptz,
  add column decided_by uuid references public.users(id) on delete set null;

create function public.seo_update_plan_item(p_id text, p_status text, p_evidence text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_evidence text := btrim(coalesce(p_evidence, ''));
begin
  if auth.uid() is null
    or not (
      exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'admin')
      or public.resolve_permission(auth.uid(), 'seo', 'edit')
    ) then
    raise exception 'SEO_FORBIDDEN';
  end if;
  if p_status is null or p_status not in ('done', 'started', 'waiting_owner', 'not_started') then
    raise exception 'SEO_INVALID';
  end if;
  if length(v_evidence) > 1000 then
    raise exception 'SEO_INVALID';
  end if;
  -- The board's own rule: an item changes only with evidence, and nothing is done on a guess.
  if p_status = 'done' and v_evidence = '' then
    raise exception 'SEO_EVIDENCE_REQUIRED';
  end if;

  update public.seo_plan_items
  set status = p_status, evidence = v_evidence, edited_at = now(), edited_by = auth.uid(), updated_at = now()
  where id = p_id;
  if not found then
    raise exception 'SEO_NOT_FOUND';
  end if;
end;
$$;

create function public.seo_decide_proposal(p_id text, p_decision text, p_note text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_note text := btrim(coalesce(p_note, ''));
  v_decision text;
begin
  if auth.uid() is null
    or not (
      exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'admin')
      or public.resolve_permission(auth.uid(), 'seo', 'approve')
    ) then
    raise exception 'SEO_FORBIDDEN';
  end if;
  if p_decision is null or p_decision not in ('keep', 'change') or length(v_note) > 1000 then
    raise exception 'SEO_INVALID';
  end if;

  select decision into v_decision from public.seo_log where id = p_id and kind = 'proposal' for update;
  if not found then
    raise exception 'SEO_NOT_FOUND';
  end if;
  -- The Monday review may already have acted on the first answer.
  if v_decision is not null then
    raise exception 'SEO_ALREADY_DECIDED';
  end if;

  update public.seo_log
  set decision = p_decision, decision_note = v_note, decided_at = now(), decided_by = auth.uid(), updated_at = now()
  where id = p_id;
end;
$$;

revoke all on function public.seo_update_plan_item(text, text, text) from public, anon;
revoke all on function public.seo_decide_proposal(text, text, text) from public, anon;
grant execute on function public.seo_update_plan_item(text, text, text) to authenticated;
grant execute on function public.seo_decide_proposal(text, text, text) to authenticated;

do $$
begin
  if (select count(*)
      from public.role_permissions rp
      join public.permission_modules pm on pm.id = rp.module_id
      where pm.module_key = 'seo' and rp.role = 'admin' and rp.allowed) <> 3 then
    raise exception 'SEO_MODULE: Admin needs view, edit and approve';
  end if;
  if has_function_privilege('anon', 'public.seo_update_plan_item(text, text, text)', 'execute')
    or has_function_privilege('anon', 'public.seo_decide_proposal(text, text, text)', 'execute') then
    raise exception 'SEO_MODULE: anon can call a write';
  end if;
end $$;
