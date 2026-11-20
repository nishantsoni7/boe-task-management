-- 20270817000000_quotation_delete.sql
--
-- Deleting a quotation (owner, 20 Nov 2026: "an option to delete the quotation as an admin ... everyone should have authority to delete
-- till they are not submitted or shared to client for approval. Once submitted or shared for price approval, they can only modify and not
-- delete it."). This reverses the 12 Nov default "Archive, never delete" for two cases only: an unsent draft, and an administrator.
--
-- THE RULE (one function, quotation_delete_blocker, answers it for the list, the page and the delete itself)
--   * A quotation that became a PI draft (pi_submission_id) is never deleted, not even by an administrator: an order's paperwork came from it.
--   * An administrator may delete any other quotation, at any stage.
--   * Anyone else may delete only a quotation they own or made, and only while it is still unsent:
--       status Draft, never shared with the client (no link, no shared_at), never sent to a senior (no quotation_requests row, even a
--       withdrawn one), and price approval never asked (no quotation_price_reviews row).
--     After any of those it can be changed, not deleted (Archive stays).
--   * A person who can only SEE it (a "see all" reader, the pricing desk) cannot delete another person's quotation.
--
-- WHAT GOES WITH IT: rooms, products, history, versions, requests to a senior, price-approval history and the picture switch (cascades, all
-- already declared). What stays: the Sales lead (quotations.lead_id points the other way), the picture files in storage (unreachable; a later
-- clean-up), price reasons already saved in Pricing learning (their quotation_id becomes null, as declared in 20270715000000).
--
-- WRITE
--   1. quotation_price_reviews' append-only trigger now fires only on a direct change (depth 0), like quotation_events and quotation_versions:
--      without it the cascade from deleting a whole quotation that went through price approval is refused. A direct update or delete is
--      refused exactly as before.
--   2. quotation_deletions: who deleted which quotation, when. Closed to every client role (RLS on, no policy, no grant).
--   3. quotation_delete_blocker (internal), quotation_delete_check(id) (the page asks), quotation_delete(id).
--   4. quotation_list: the function of 20270614000000 with one more field per row, may_delete.
--
-- ROLLBACK: drop functions quotation_delete(uuid), quotation_delete_check(uuid), quotation_delete_blocker(public.quotations, uuid, boolean, boolean, boolean);
--   drop table public.quotation_deletions; re-run quotation_list from 20270614000000; drop and re-create the quotation_price_reviews trigger without
--   the WHEN clause (20270617000000). A deleted quotation itself can only come back from a backup.

do $$
begin
  if to_regprocedure('public.quotation_actor()') is null
     or to_regprocedure('public.quotation_sees(uuid, uuid, uuid, boolean, boolean)') is null
     or to_regprocedure('public.quotation_value_before_gst(uuid)') is null
     or to_regclass('public.quotation_requests') is null
     or to_regclass('public.quotation_price_reviews') is null then
    raise exception 'DEPENDENCY MISSING: Quotations (20270614000000), its pricing desk (20270617000000) and its requests (20270814000200) must exist';
  end if;
end $$;

-- ═══ 1. The cascade may remove price-approval history; a direct change is still refused ═══════════════════════════════════════

drop trigger quotation_price_reviews_append_only on public.quotation_price_reviews;
create trigger quotation_price_reviews_append_only before update or delete on public.quotation_price_reviews
  -- Depth 0 only: a direct change is refused, the cascade from deleting a whole quotation is not.
  for each row when (pg_trigger_depth() = 0)
  execute function public.quotation_price_reviews_append_only();

-- ═══ 2. The record of what was deleted ═════════════════════════════════════════════════════════════════════════════════════════

create table public.quotation_deletions (
  id               bigserial primary key,
  quotation_id     uuid not null,
  quote_no         text not null,
  client_name      text not null,
  project_name     text,
  status           text not null,
  value_before_gst bigint not null default 0,
  owner_id         uuid references public.users (id),
  lead_id          uuid,
  deleted_by       uuid not null references public.users (id),
  deleted_at       timestamptz not null default now()
);
create index quotation_deletions_at_idx on public.quotation_deletions (deleted_at desc);
alter table public.quotation_deletions enable row level security;
revoke all on public.quotation_deletions from public, anon, authenticated;
revoke all on sequence public.quotation_deletions_id_seq from public, anon, authenticated;

-- ═══ 3. The rule and the delete ═══════════════════════════════════════════════════════════════════════════════════════════

-- Internal: why this person may NOT delete this quotation, in a sentence the screen can show; null when they may.
create or replace function public.quotation_delete_blocker(q public.quotations, p_uid uuid, p_admin boolean, p_create boolean, p_edit boolean)
returns text language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  if q.pi_submission_id is not null then
    return 'This quotation was confirmed into a PI draft, so it cannot be deleted.';
  end if;
  if p_admin then return null; end if;
  if not ((p_create or p_edit) and (q.owner_id = p_uid or q.created_by = p_uid)) then
    return 'Only the person who made this quotation, or an administrator, can delete it.';
  end if;
  if q.status <> 'draft' then
    return 'This quotation is no longer a draft, so it can be changed but not deleted. Archive it if you no longer need it.';
  end if;
  if q.share_token is not null or q.shared_at is not null then
    return 'This quotation was shared with the client, so it can be changed but not deleted.';
  end if;
  if exists (select 1 from public.quotation_requests r where r.quotation_id = q.id) then
    return 'This quotation was sent to a senior for prices or checking, so it can be changed but not deleted.';
  end if;
  if exists (select 1 from public.quotation_price_reviews pr where pr.quotation_id = q.id) then
    return 'Price approval was asked for this quotation, so it can be changed but not deleted.';
  end if;
  return null;
end $$;
revoke all on function public.quotation_delete_blocker(public.quotations, uuid, boolean, boolean, boolean) from public, anon, authenticated;

-- The page asks before it shows a Delete button: { may, reason }.
create or replace function public.quotation_delete_check(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare a record; q public.quotations; v_why text;
begin
  select * into a from public.quotation_actor();
  select * into q from public.quotations where id = p_id;
  if q.id is null or not public.quotation_sees(q.owner_id, q.created_by, a.p_uid, a.p_admin, a.p_view_all) then
    raise exception 'QUOTATION_NOT_FOUND' using errcode = 'P0002';
  end if;
  v_why := public.quotation_delete_blocker(q, a.p_uid, a.p_admin, a.p_create, a.p_edit);
  return jsonb_build_object('may', v_why is null, 'reason', v_why);
end $$;
revoke all on function public.quotation_delete_check(uuid) from public, anon;
grant execute on function public.quotation_delete_check(uuid) to authenticated;

create or replace function public.quotation_delete(p_id uuid)
returns void language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare a record; q public.quotations; v_why text;
begin
  select * into a from public.quotation_actor();
  -- The row lock: a send to a senior, a share or a price request on the same quotation waits for this, then finds it gone (or is seen here).
  select * into q from public.quotations where id = p_id for update;
  if q.id is null or not public.quotation_sees(q.owner_id, q.created_by, a.p_uid, a.p_admin, a.p_view_all) then
    raise exception 'QUOTATION_NOT_FOUND' using errcode = 'P0002';
  end if;
  v_why := public.quotation_delete_blocker(q, a.p_uid, a.p_admin, a.p_create, a.p_edit);
  if v_why is not null then raise exception 'QUOTATION_LOCKED: %', v_why using errcode = '22023'; end if;
  insert into public.quotation_deletions (quotation_id, quote_no, client_name, project_name, status, value_before_gst, owner_id, lead_id, deleted_by)
  values (q.id, q.quote_no, q.client_name, q.project_name, q.status, coalesce(public.quotation_value_before_gst(q.id), 0), q.owner_id, q.lead_id, a.p_uid);
  delete from public.quotations where id = p_id;
end $$;
revoke all on function public.quotation_delete(uuid) from public, anon;
grant execute on function public.quotation_delete(uuid) to authenticated;

-- ═══ 4. The list says which rows may be deleted ═══════════════════════════════════════════════════════════════════════════════
-- The function of 20270614000000, with the one field may_delete added.

create or replace function public.quotation_list(p_scope text default 'mine')
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare a record; v jsonb;
begin
  select * into a from public.quotation_actor();
  if p_scope not in ('mine', 'all') then raise exception 'QUOTATION_INVALID: scope' using errcode = '22023'; end if;
  select coalesce(jsonb_agg(r order by r.updated_at desc), '[]'::jsonb) into v from (
    select q.id, q.quote_no, q.status, q.client_name, q.project_name, q.owner_id,
           (select u.full_name from public.users u where u.id = q.owner_id) as owner_name,
           q.created_at, q.updated_at, q.sent_at, q.valid_days, (q.share_token is not null) as shared,
           (select count(*) from public.quotation_lines l where l.quotation_id = q.id) as line_count,
           (select l.image_path from public.quotation_lines l where l.quotation_id = q.id and l.image_path is not null
              order by l.position limit 1) as first_image,
           public.quotation_value_before_gst(q.id) as value_before_gst,
           (select max(e.at) from public.quotation_events e where e.quotation_id = q.id and e.kind = 'opened') as last_opened_at,
           public.quotation_delete_blocker(q, a.p_uid, a.p_admin, a.p_create, a.p_edit) is null as may_delete
    from public.quotations q
    where (p_scope = 'all' and (a.p_admin or a.p_view_all))
       or q.owner_id = a.p_uid or q.created_by = a.p_uid
    order by q.updated_at desc
    limit 500
  ) r;
  return v;
end $$;
revoke all on function public.quotation_list(text) from public, anon;
grant execute on function public.quotation_list(text) to authenticated;
