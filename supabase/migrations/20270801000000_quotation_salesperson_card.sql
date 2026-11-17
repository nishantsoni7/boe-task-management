-- The salesperson's own details on the quotation (owner, 18 Nov 2026: "Do not keep anything as demo in this. Ask Sales person
-- to fill in the data once (and keep it editable for future usage) and then have that information displayed in the Quotation.")
--
--   1. New table quotation_salesperson_cards: one row per person, written only through quotation_my_card_save. It holds the name
--      as printed, the role ("Sales Manager"), the mobile (WhatsApp) and the e-mail. A NEW table: no existing table or row changes.
--   2. quotation_my_card(): the caller's saved details, or what their profile already has (users.full_name, phone, email) to start
--      the form from, with saved = false so the screens ask them to fill it in.
--   3. quotation_get and quotation_public print the saved details when there are any; without a saved card they print exactly
--      what they printed before (users.full_name, users.phone, users.email). Once saved, a blank mobile or e-mail prints nothing:
--      the salesperson chose that. The client's own phone and e-mail, internal notes, owner id, token and cost are still never returned.
--   quotation_get and quotation_public are copied from 20270717000000 with only the salesperson lines changed.

create table if not exists public.quotation_salesperson_cards (
  user_id      uuid primary key references public.users(id) on delete cascade,
  display_name text not null check (char_length(btrim(display_name)) between 2 and 80),
  title        text check (title is null or char_length(title) <= 60),
  phone        text check (phone is null or char_length(phone) <= 30),
  email        text check (email is null or char_length(email) <= 120),
  updated_at   timestamptz not null default now()
);
alter table public.quotation_salesperson_cards enable row level security;
revoke all on table public.quotation_salesperson_cards from public, anon, authenticated;

create or replace function public.quotation_my_card()
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare a record; c public.quotation_salesperson_cards; u public.users;
begin
  select * into a from public.quotation_actor();
  select * into c from public.quotation_salesperson_cards where user_id = a.p_uid;
  if c.user_id is not null then
    return jsonb_build_object('saved', true, 'name', c.display_name, 'title', coalesce(c.title, ''), 'phone', coalesce(c.phone, ''),
                              'email', coalesce(c.email, ''), 'updated_at', c.updated_at);
  end if;
  select * into u from public.users where id = a.p_uid;
  return jsonb_build_object('saved', false, 'name', coalesce(btrim(u.full_name), ''), 'title', '',
                            'phone', coalesce(btrim(u.phone), ''), 'email', coalesce(btrim(u.email), ''));
end $$;
revoke all on function public.quotation_my_card() from public, anon;
grant execute on function public.quotation_my_card() to authenticated;

create or replace function public.quotation_my_card_save(p jsonb)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare a record;
  v_name  text := btrim(coalesce(p->>'name', ''));
  v_title text := nullif(btrim(coalesce(p->>'title', '')), '');
  v_phone text := nullif(btrim(coalesce(p->>'phone', '')), '');
  v_email text := nullif(lower(btrim(coalesce(p->>'email', ''))), '');
begin
  select * into a from public.quotation_actor();
  if char_length(v_name) < 2 or char_length(v_name) > 80 then
    raise exception 'QUOTATION_INVALID: write your name as it should print (2 to 80 letters)' using errcode = '22023';
  end if;
  if v_title is not null and char_length(v_title) > 60 then
    raise exception 'QUOTATION_INVALID: the role is too long (60 letters at most)' using errcode = '22023';
  end if;
  if v_phone is not null and (v_phone !~ '^[0-9+() .-]{8,30}$' or char_length(regexp_replace(v_phone, '[^0-9]', '', 'g')) < 8) then
    raise exception 'QUOTATION_INVALID: the mobile number is not valid' using errcode = '22023';
  end if;
  if v_email is not null and (char_length(v_email) > 120 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$') then
    raise exception 'QUOTATION_INVALID: the e-mail is not valid' using errcode = '22023';
  end if;
  insert into public.quotation_salesperson_cards (user_id, display_name, title, phone, email, updated_at)
  values (a.p_uid, v_name, v_title, v_phone, v_email, now())
  on conflict (user_id) do update set display_name = excluded.display_name, title = excluded.title, phone = excluded.phone,
                                      email = excluded.email, updated_at = now();
  return public.quotation_my_card();
end $$;
revoke all on function public.quotation_my_card_save(jsonb) from public, anon;
grant execute on function public.quotation_my_card_save(jsonb) to authenticated;

-- The print page's read of one quotation: as 20270717000000; the salesperson's contact comes from their saved details when
-- they have saved them, and owner_display_name / owner_title / owner_card_saved are added.
create or replace function public.quotation_get(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare a record; q public.quotations; c public.quotation_salesperson_cards;
begin
  select * into a from public.quotation_actor();
  select * into q from public.quotations where id = p_id;
  if q.id is null or not public.quotation_sees(q.owner_id, q.created_by, a.p_uid, a.p_admin, a.p_view_all) then
    raise exception 'QUOTATION_NOT_FOUND' using errcode = 'P0002';
  end if;
  select * into c from public.quotation_salesperson_cards where user_id = q.owner_id;
  return jsonb_build_object(
    'quotation', to_jsonb(q),
    'owner_name', (select u.full_name from public.users u where u.id = q.owner_id),
    'owner_display_name', c.display_name,
    'owner_title', c.title,
    'owner_card_saved', c.user_id is not null,
    'owner_phone', case when c.user_id is not null then c.phone else (select nullif(btrim(u.phone), '') from public.users u where u.id = q.owner_id) end,
    'owner_email', case when c.user_id is not null then c.email else (select nullif(btrim(u.email), '') from public.users u where u.id = q.owner_id) end,
    'may_edit', public.quotation_may_edit(q.owner_id, q.created_by, a.p_uid, a.p_admin, a.p_create, a.p_edit, a.p_view_all),
    'pi', (select jsonb_build_object('id', s.id, 'draft_reference', s.draft_reference, 'status', s.status)
             from public.order_submissions s where s.id = q.pi_submission_id),
    'request', (select jsonb_build_object('id', t.id, 'title', t.title, 'status', t.status, 'created_by', t.created_by, 'assigned_to', t.assigned_to,
                                          'created_at', t.created_at, 'last_update_at', t.last_update_at,
                                          'asked_by', (select u.full_name from public.users u where u.id = t.created_by),
                                          'may_send', t.assigned_to = a.p_uid and t.status not in ('completed', 'cancelled'))
                  from public.tasks t where t.id = q.request_task_id),
    'price', public.quotation_price_state(p_id) || jsonb_build_object('may_decide', a.p_admin or (a.p_edit and a.p_view_all)),
    'areas', coalesce((select jsonb_agg(to_jsonb(x) order by x.position) from public.quotation_areas x where x.quotation_id = p_id), '[]'::jsonb),
    'lines', coalesce((select jsonb_agg(to_jsonb(l) order by l.position) from public.quotation_lines l where l.quotation_id = p_id), '[]'::jsonb),
    'events', coalesce((select jsonb_agg(e order by e.at desc) from (
        select ev.kind, ev.detail, ev.at, (select u.full_name from public.users u where u.id = ev.actor_id) as actor_name
        from public.quotation_events ev where ev.quotation_id = p_id order by ev.at desc limit 30) e), '[]'::jsonb)
  );
end $$;
revoke all on function public.quotation_get(uuid) from public, anon;
grant execute on function public.quotation_get(uuid) to authenticated;

-- The client link: as 20270717000000; the salesperson's name, role, mobile and e-mail come from their saved details when there are any.
create or replace function public.quotation_public(p_token text)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare q public.quotations; v record; c public.quotation_salesperson_cards;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{32}$' then return null; end if;
  select * into q from public.quotations where share_token = p_token and status <> 'archived';
  if q.id is null then return null; end if;
  if not exists (select 1 from public.quotation_events e where e.quotation_id = q.id and e.kind = 'opened' and e.at > now() - interval '30 minutes') then
    insert into public.quotation_events (quotation_id, actor_id, kind) values (q.id, auth.uid(), 'opened');
  end if;
  select qv.doc, qv.version_no, qv.created_at into v from public.quotation_versions qv where qv.quotation_id = q.id order by qv.version_no desc limit 1;
  select * into c from public.quotation_salesperson_cards where user_id = q.owner_id;
  return coalesce(v.doc, public.quotation_client_doc(q.id)) || jsonb_build_object(
    'quote_no', q.quote_no, 'status', q.status,
    'issued_at', coalesce(v.created_at, q.sent_at, q.created_at),
    'version_no', v.version_no,
    'salesperson', coalesce(c.display_name, (select u.full_name from public.users u where u.id = q.owner_id)))
    || jsonb_strip_nulls(jsonb_build_object(
         'salesperson_title', c.title,
         'salesperson_phone', case when c.user_id is not null then c.phone else (select nullif(btrim(u.phone), '') from public.users u where u.id = q.owner_id) end,
         'salesperson_email', case when c.user_id is not null then c.email else (select nullif(btrim(u.email), '') from public.users u where u.id = q.owner_id) end));
end $$;
revoke all on function public.quotation_public(text) from public;
grant execute on function public.quotation_public(text) to anon, authenticated;

do $$
begin
  if has_table_privilege('anon', 'public.quotation_salesperson_cards', 'select')
     or has_table_privilege('authenticated', 'public.quotation_salesperson_cards', 'select')
     or has_table_privilege('authenticated', 'public.quotation_salesperson_cards', 'insert') then
    raise exception 'QUOTATION_SALESPERSON_CARD: the table must be closed to direct reads and writes';
  end if;
  if has_function_privilege('anon', 'public.quotation_my_card()', 'execute')
     or has_function_privilege('anon', 'public.quotation_my_card_save(jsonb)', 'execute')
     or has_function_privilege('anon', 'public.quotation_get(uuid)', 'execute') then
    raise exception 'QUOTATION_SALESPERSON_CARD: function grants are wrong';
  end if;
  if not has_function_privilege('anon', 'public.quotation_public(text)', 'execute') then
    raise exception 'QUOTATION_SALESPERSON_CARD: the client link must stay open to anon';
  end if;
end $$;
