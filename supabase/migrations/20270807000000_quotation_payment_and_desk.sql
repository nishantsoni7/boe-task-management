-- Quotations (owner, 2026-11-18 evening): three things in one migration.
--
--   1. No approval before sharing. Price approval stays as an optional ask, but nothing waits for it: quotation_price_state
--      now always returns blocked = false. quotation_share, the Confirm -> PI function and version create all read that one
--      value, so the client link, Confirm -> PI and new versions are never held back. Limits, the ask and the desk queue are
--      unchanged.
--   2. Price suggestions for the pricing desk only (the administrator and anyone with quotations edit + view all, today the
--      owner and Nitish). An EMPTY shown_to now means "the pricing desk"; NULL is still "everyone". quotation_suggestions_set
--      keeps its signature: false = pricing desk only, true = everyone. The row is set to the pricing desk below (owner's
--      decision; he widens it later from Control Center once the suggester is trained).
--   3. Payment details and the UPI QR printed on the quotation. A NEW one-row table quotation_payment_details (the QR is
--      kept in the row as a small image, no storage bucket). Read: quotation_payment_details(p_token) for the client link
--      (valid share token) or for staff with Quotations access; the Customer ID is never returned there. Write and the full
--      read: administrators only (quotation_payment_get / _set), repeated here as the database check.
-- Only a function body is replaced and a NEW table is added; no existing table or row of data is altered except the one
-- setting row of the new suggestions table, so no backup is needed first.
--
-- Rollback:
--   drop function public.quotation_payment_set(jsonb); drop function public.quotation_payment_get();
--   drop function public.quotation_payment_details(text); drop table public.quotation_payment_details;
--   update public.quotation_suggestion_settings set shown_to = null where id;
--   (re-apply the bodies of quotation_price_state from 20270617000000 and quotation_suggestions_get/_set from 20270731000000)

begin;

-- ═══ 1. nothing waits for price approval ════════════════════════════════════
create or replace function public.quotation_price_state(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare c jsonb := public.quotation_price_check(p_id); fp text := public.quotation_price_fingerprint(p_id); r record; v_state text;
begin
  select pr.decision, pr.note, pr.at, (select u.full_name from public.users u where u.id = pr.actor_id) as by_name into r
    from public.quotation_price_reviews pr where pr.quotation_id = p_id and pr.fingerprint = fp order by pr.at desc limit 1;
  v_state := case when not (c->>'needed')::boolean then 'not_needed' when r.decision is null then 'to_ask' else r.decision end;
  -- blocked is always false (owner, 18 Nov 2026): approval is an optional ask, never a gate.
  return c || jsonb_build_object('state', v_state, 'blocked', false,
                                  'note', r.note, 'by', r.by_name, 'at', r.at);
end $$;
revoke all on function public.quotation_price_state(uuid) from public, anon, authenticated;

-- ═══ 2. suggestions: the pricing desk ═══════════════════════════════════════
create or replace function public.quotation_suggestions_get()
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare a record;
begin
  select * into a from public.quotation_actor();
  return (select jsonb_build_object(
      'everyone', s.shown_to is null,
      'desk', s.shown_to is not null and cardinality(s.shown_to) = 0,
      'for_me', s.shown_to is null
                or (cardinality(s.shown_to) = 0 and (a.p_admin or (a.p_edit and a.p_view_all)))
                or a.p_uid = any(s.shown_to),
      'shown_to', coalesce((select jsonb_agg(u.full_name order by u.full_name) from public.users u where u.id = any(s.shown_to)), '[]'::jsonb),
      'may_change', a.p_admin,
      'updated_at', s.updated_at)
    from public.quotation_suggestion_settings s where s.id);
end $$;
revoke all on function public.quotation_suggestions_get() from public, anon;
grant execute on function public.quotation_suggestions_get() to authenticated;

create or replace function public.quotation_suggestions_set(p_everyone boolean)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare a record;
begin
  select * into a from public.quotation_actor();
  if not a.p_admin then raise exception 'QUOTATIONS_FORBIDDEN: only an administrator decides who sees price suggestions' using errcode = '42501'; end if;
  update public.quotation_suggestion_settings
     set shown_to = case when coalesce(p_everyone, true) then null else '{}'::uuid[] end,
         updated_by = a.p_uid, updated_at = now()
   where id;
  return public.quotation_suggestions_get();
end $$;
revoke all on function public.quotation_suggestions_set(boolean) from public, anon;
grant execute on function public.quotation_suggestions_set(boolean) to authenticated;

update public.quotation_suggestion_settings set shown_to = '{}'::uuid[], updated_at = now() where id;

-- ═══ 3. payment details and the QR ══════════════════════════════════════════
create table public.quotation_payment_details (
  id             boolean primary key default true check (id),
  account_holder text not null default '',
  bank           text not null default '',
  account_no     text not null default '',
  ifsc           text not null default '',
  branch         text not null default '',
  customer_id    text not null default '',
  upi_id         text not null default '',
  qr_image       text check (qr_image is null or (qr_image ~ '^data:image/(png|jpeg);base64,' and length(qr_image) <= 400000)),
  updated_by     uuid references public.users(id),
  updated_at     timestamptz not null default now()
);
alter table public.quotation_payment_details enable row level security;
revoke all on public.quotation_payment_details from public, anon, authenticated;
-- No policies: read and written only through the functions below.

insert into public.quotation_payment_details (account_holder, bank, account_no, ifsc, branch, customer_id, upi_id)
values ('Best of Exports', 'HDFC Bank', '99982000009999', 'HDFC0004204', 'Jodhpur, Rajasthan', '271662686', '9829383706@hdfc');

-- For the printed quotation: staff with Quotations access, or anybody holding a valid client link. No Customer ID.
create or replace function public.quotation_payment_details(p_token text default null)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare v_ok boolean := false;
begin
  if p_token is not null then
    v_ok := p_token ~ '^[0-9a-f]{32}$' and exists (select 1 from public.quotations q where q.share_token = p_token and q.status <> 'archived');
  elsif auth.uid() is not null then
    v_ok := public.module_entry_open('quotations');
  end if;
  if not v_ok then return null; end if;
  return (select jsonb_build_object('account_holder', d.account_holder, 'bank', d.bank, 'account_no', d.account_no, 'ifsc', d.ifsc,
                                    'branch', d.branch, 'upi_id', d.upi_id, 'qr_image', d.qr_image)
            from public.quotation_payment_details d where d.id);
end $$;
revoke all on function public.quotation_payment_details(text) from public;
grant execute on function public.quotation_payment_details(text) to anon, authenticated;

create or replace function public.quotation_payment_get()
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare a record;
begin
  select * into a from public.quotation_actor();
  if not a.p_admin then raise exception 'QUOTATIONS_FORBIDDEN: only an administrator reads the payment settings' using errcode = '42501'; end if;
  return (select to_jsonb(d) - 'id' - 'updated_by' from public.quotation_payment_details d where d.id);
end $$;
revoke all on function public.quotation_payment_get() from public, anon;
grant execute on function public.quotation_payment_get() to authenticated;

-- p_data keys: account_holder, bank, account_no, ifsc, branch, customer_id, upi_id, and qr_image (a data URL, or '' to remove it).
-- A key left out keeps its value.
create or replace function public.quotation_payment_set(p_data jsonb)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare a record; k text;
begin
  select * into a from public.quotation_actor();
  if not a.p_admin then raise exception 'QUOTATIONS_FORBIDDEN: only an administrator changes the payment settings' using errcode = '42501'; end if;
  for k in select jsonb_object_keys(coalesce(p_data, '{}'::jsonb)) loop
    if k not in ('account_holder','bank','account_no','ifsc','branch','customer_id','upi_id','qr_image') then
      raise exception 'QUOTATION_PAYMENT: unknown field %', k using errcode = '22023';
    end if;
  end loop;
  update public.quotation_payment_details d set
    account_holder = coalesce(btrim(p_data->>'account_holder'), d.account_holder),
    bank           = coalesce(btrim(p_data->>'bank'), d.bank),
    account_no     = coalesce(btrim(p_data->>'account_no'), d.account_no),
    ifsc           = coalesce(upper(btrim(p_data->>'ifsc')), d.ifsc),
    branch         = coalesce(btrim(p_data->>'branch'), d.branch),
    customer_id    = coalesce(btrim(p_data->>'customer_id'), d.customer_id),
    upi_id         = coalesce(btrim(p_data->>'upi_id'), d.upi_id),
    qr_image       = case when p_data ? 'qr_image' then nullif(p_data->>'qr_image', '') else d.qr_image end,
    updated_by = a.p_uid, updated_at = now()
  where d.id;
  return public.quotation_payment_get();
end $$;
revoke all on function public.quotation_payment_set(jsonb) from public, anon;
grant execute on function public.quotation_payment_set(jsonb) to authenticated;

do $$
begin
  if has_function_privilege('anon', 'public.quotation_payment_get()', 'execute') then raise exception 'quotation_payment_get open to anon'; end if;
  if has_function_privilege('anon', 'public.quotation_payment_set(jsonb)', 'execute') then raise exception 'quotation_payment_set open to anon'; end if;
  if not has_function_privilege('anon', 'public.quotation_payment_details(text)', 'execute') then raise exception 'quotation_payment_details must be callable with a client link'; end if;
  if (select count(*) from public.quotation_payment_details) <> 1 then raise exception 'quotation_payment_details must hold one row'; end if;
  if (public.quotation_payment_details(null)) is not null then raise exception 'payment details must not be readable without a link or a session'; end if;
  if (select shown_to from public.quotation_suggestion_settings) is distinct from '{}'::uuid[] then raise exception 'suggestions must be set to the pricing desk'; end if;
end $$;

commit;
