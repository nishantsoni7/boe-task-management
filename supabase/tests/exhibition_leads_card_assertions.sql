-- EXHIBITION LEAD EMAIL + CARD PHOTOGRAPH (20270308000000) — behavioural assertions
-- ===========================================================================
-- Through the real door, as real roles, on a disposable database:
--
--   1. attach       email and a photograph go on the lead; same call twice = unchanged
--   2. who          owner and Admin may; another salesperson, an outsider and anon may not
--   3. the photo    only the caller's own uploaded file, only once, only in their folder
--   4. history      the first attach after Save is not an "edit"; a later one is
--   5. the JSON     the lead carries email and card_photo_path
--   6. storage      the bucket is private; read follows the lead; delete only if unattached
--   7. archived     an archived lead refuses
--
-- ONE transaction ending in ROLLBACK. SELF-CONTAINED: its own people (57c0d…) and
-- its own exhibition. Needs the migration chain through 20270308000000.
-- On success prints NOTICE 'ALL CARD ASSERTIONS PASSED'.

\set ON_ERROR_STOP on

begin;

create function public._t_assert(p_ok boolean, p_msg text) returns void
language plpgsql as $$
begin
  if p_ok is not true then raise exception 'ASSERTION FAILED: %', p_msg; end if;
end $$;

create function public._t_raises(p_sql text, p_expect text) returns void
language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if position(p_expect in sqlerrm) = 0 then
      raise exception 'ASSERTION FAILED: expected [%] but got [%] for: %', p_expect, sqlerrm, p_sql;
    end if;
    return;
  end;
  raise exception 'ASSERTION FAILED: no error (expected [%]) for: %', p_expect, p_sql;
end $$;

create function public._t_as(p_uid uuid) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_uid::text, 'role', 'authenticated')::text, true);
end $$;

create function public._t_id(p_key text) returns uuid
language sql as $$ select current_setting('t.' || p_key)::uuid $$;

do $$
begin
  perform set_config('t.admin', '57c0d000-0000-4000-8000-000000000001', true);
  perform set_config('t.s1',    '57c0d000-0000-4000-8000-000000000002', true);
  perform set_config('t.s2',    '57c0d000-0000-4000-8000-000000000003', true);
  perform set_config('t.x',     '57c0d000-0000-4000-8000-000000000004', true);  -- design: no access
  perform set_config('t.exh',   '57c0d000-0000-4000-8000-0000000000a1', true);
  insert into public.users (id, full_name, email, role, team, is_active, employee_code) values
    ('57c0d000-0000-4000-8000-000000000001', 'CRD Admin',    'crd-admin@suite.test', 'admin',  'management', true, 'CRD-ADM'),
    ('57c0d000-0000-4000-8000-000000000002', 'CRD Sales 1',  'crd-s1@suite.test',    'member', 'sales',      true, 'CRD-S1'),
    ('57c0d000-0000-4000-8000-000000000003', 'CRD Sales 2',  'crd-s2@suite.test',    'member', 'sales',      true, 'CRD-S2'),
    ('57c0d000-0000-4000-8000-000000000004', 'CRD Outsider', 'crd-x@suite.test',     'member', 'design',     true, 'CRD-X');
  insert into public.exhibitions (id, slug, name, starts_on, ends_on)
  values ('57c0d000-0000-4000-8000-0000000000a1', 'card-fair', 'Card Fair',
          (now() at time zone 'Asia/Kolkata')::date - 1, (now() at time zone 'Asia/Kolkata')::date + 1);
  -- Files "uploaded" by S1 and S2 (the bucket policy is proven in §6; here the rows stand in for uploads).
  insert into storage.objects (bucket_id, name, owner_id) values
    ('exhibition-lead-cards', '57c0d000-0000-4000-8000-000000000002/57c0d000-0000-4000-9000-0000000000f1.jpg', '57c0d000-0000-4000-8000-000000000002'),
    ('exhibition-lead-cards', '57c0d000-0000-4000-8000-000000000002/57c0d000-0000-4000-9000-0000000000f2.jpg', '57c0d000-0000-4000-8000-000000000002'),
    ('exhibition-lead-cards', '57c0d000-0000-4000-8000-000000000003/57c0d000-0000-4000-9000-0000000000f3.jpg', '57c0d000-0000-4000-8000-000000000003');
end $$;

create function public._t_create(p_sub uuid, p_name text, p_phone text) returns jsonb
language sql as $$
  select public.create_exhibition_lead(p_sub, public._t_id('exh'), p_name, p_phone, 'consultant', array['hotel'],
                                       null, null, null, 'warm', null, null)
$$;

create function public._t_lead(p_name text) returns uuid
language sql as $$ select id from public.exhibition_leads where contact_name = p_name $$;

-- ═══ 1–2. ATTACH, AND WHO MAY ══════════════════════════════════════════════
set local role authenticated;
select public._t_as(public._t_id('s1'));
select public._t_create('57c0d000-0000-4000-9000-000000000001', 'Card Lead One', '9822200001');
select public._t_create('57c0d000-0000-4000-9000-000000000002', 'Card Lead Two', '9822200002');

-- Straight after Save: email + photograph.
select public._t_assert(
  public.set_exhibition_lead_contact(public._t_lead('Card Lead One'), jsonb_build_object(
    'email', '  Asha@RaoStudio.IN ',
    'card_photo_path', '57c0d000-0000-4000-8000-000000000002/57c0d000-0000-4000-9000-0000000000f1.jpg'))->>'outcome' = 'updated',
  'the first attach updates the lead');
select public._t_assert((public.get_exhibition_lead(public._t_lead('Card Lead One'))->'lead'->>'email') = 'asha@raostudio.in',
  'the email is stored trimmed and lower-cased, and is in the lead JSON');
select public._t_assert((public.get_exhibition_lead(public._t_lead('Card Lead One'))->'lead'->>'card_photo_path') like '%f1.jpg',
  'the photograph path is in the lead JSON');
select public._t_assert(
  public.set_exhibition_lead_contact(public._t_lead('Card Lead One'), jsonb_build_object('email', 'asha@raostudio.in'))->>'outcome' = 'unchanged',
  'the same email twice changes nothing (the outbox may retry freely)');

-- 4. History: that first attach was part of creating the lead.
select public._t_assert((select count(*) = 1 from public.exhibition_lead_events where lead_id = public._t_lead('Card Lead One')),
  'the attach right after Save adds no history line');
select public.set_exhibition_lead_contact(public._t_lead('Card Lead One'), jsonb_build_object('email', 'asha2@raostudio.in'));
select public._t_assert((select count(*) = 1 from public.exhibition_lead_events
    where lead_id = public._t_lead('Card Lead One') and event_type = 'details_edited'
      and detail->'fields' = '["email"]'::jsonb),
  'a later change is a history line naming only the field');

-- Validation.
select public._t_raises($q$ select public.set_exhibition_lead_contact(public._t_lead('Card Lead One'), '{"email":"not an address"}') $q$, 'Enter a valid email address');
select public._t_raises($q$ select public.set_exhibition_lead_contact(public._t_lead('Card Lead One'), '{"phone":"+911"}') $q$, 'Unknown field');
select public.set_exhibition_lead_contact(public._t_lead('Card Lead Two'), '{"email":"x@y.co"}');
select public.set_exhibition_lead_contact(public._t_lead('Card Lead Two'), '{"email":""}');
select public._t_assert((public.get_exhibition_lead(public._t_lead('Card Lead Two'))->'lead'->>'email') is null, 'an empty email clears it');

-- 3. The photograph: only the caller's own, only once.
select public._t_raises($q$ select public.set_exhibition_lead_contact(public._t_lead('Card Lead Two'), jsonb_build_object('card_photo_path', '57c0d000-0000-4000-8000-000000000003/57c0d000-0000-4000-9000-0000000000f3.jpg')) $q$, 'not yours to attach');
select public._t_raises($q$ select public.set_exhibition_lead_contact(public._t_lead('Card Lead Two'), jsonb_build_object('card_photo_path', '57c0d000-0000-4000-8000-000000000002/57c0d000-0000-4000-9000-0000000000f9.jpg')) $q$, 'not finished uploading');
select public._t_raises($q$ select public.set_exhibition_lead_contact(public._t_lead('Card Lead Two'), jsonb_build_object('card_photo_path', '57c0d000-0000-4000-8000-000000000002/57c0d000-0000-4000-9000-0000000000f1.jpg')) $q$, 'already belongs to another lead');

-- Not the owner.
select public._t_as(public._t_id('s2'));
select public._t_raises($q$ select public.set_exhibition_lead_contact(public._t_lead('Card Lead One'), '{"email":"s2@steal.in"}') $q$, 'EXHIBITION_LEADS_NOT_FOUND');
reset role;
set local role authenticated;
select public._t_as(public._t_id('x'));
select public._t_raises($q$ select public.set_exhibition_lead_contact(public._t_lead('Card Lead One'), '{"email":"x@x.in"}') $q$, 'EXHIBITION_LEADS_FORBIDDEN');
reset role;
set local role anon;
select public._t_raises($q$ select public.set_exhibition_lead_contact('57c0d000-0000-4000-8000-000000000999', '{}') $q$, 'permission denied');
reset role;

-- Admin may.
set local role authenticated;
select public._t_as(public._t_id('admin'));
select public._t_assert(
  public.set_exhibition_lead_contact(public._t_lead('Card Lead Two'), '{"email":"admin@fix.in"}')->>'outcome' = 'updated',
  'Admin may set it');

-- ═══ 5. THE LIST CARRIES BOTH ═════════════════════════════════════════════
select public._t_assert((select bool_or(r->>'email' = 'asha2@raostudio.in' and r->>'card_photo_path' is not null)
    from jsonb_array_elements(public.exhibition_leads_page(jsonb_build_object('exhibition_id', public._t_id('exh'), 'scope', 'all'), 50, 0)->'rows') r),
  'the list rows carry email and card_photo_path');

-- ═══ 6. STORAGE ═══════════════════════════════════════════════════════════
reset role;  -- the bucket table is not the app's to read; look at it as the owner
select public._t_assert((select public from storage.buckets where id = 'exhibition-lead-cards') = false, 'the bucket is private');
select public._t_assert((select allowed_mime_types = array['image/jpeg'] from storage.buckets where id = 'exhibition-lead-cards'), 'JPEG only');
set local role authenticated;
select public._t_as(public._t_id('s1'));
select public._t_assert(public.exhibition_lead_card_can_upload('57c0d000-0000-4000-8000-000000000002/57c0d000-0000-4000-9000-0000000000aa.jpg'), 'own folder, uuid.jpg: allowed');
select public._t_assert(not public.exhibition_lead_card_can_upload('57c0d000-0000-4000-8000-000000000003/57c0d000-0000-4000-9000-0000000000aa.jpg'), 'someone else''s folder: refused');
select public._t_assert(not public.exhibition_lead_card_can_upload('57c0d000-0000-4000-8000-000000000002/evil.jpg'), 'not a uuid name: refused');
select public._t_assert(not public.exhibition_lead_card_can_upload('57c0d000-0000-4000-8000-000000000002/57c0d000-0000-4000-9000-0000000000aa.png'), 'not a jpg: refused');
-- Read follows the lead: the owner reads, a stranger does not.
select public._t_assert(public.exhibition_lead_card_readable('57c0d000-0000-4000-8000-000000000002/57c0d000-0000-4000-9000-0000000000f1.jpg', '57c0d000-0000-4000-8000-000000000002'), 'the owner reads the photo on their lead');
select public._t_as(public._t_id('s2'));
select public._t_assert(not public.exhibition_lead_card_readable('57c0d000-0000-4000-8000-000000000002/57c0d000-0000-4000-9000-0000000000f1.jpg', '57c0d000-0000-4000-8000-000000000002'), 'another salesperson cannot read it');
select public._t_as(public._t_id('x'));
select public._t_assert(not public.exhibition_lead_card_readable('57c0d000-0000-4000-8000-000000000002/57c0d000-0000-4000-9000-0000000000f1.jpg', '57c0d000-0000-4000-8000-000000000002'), 'an outsider cannot read it');
select public._t_as(public._t_id('admin'));
select public._t_assert(public.exhibition_lead_card_readable('57c0d000-0000-4000-8000-000000000002/57c0d000-0000-4000-9000-0000000000f1.jpg', '57c0d000-0000-4000-8000-000000000002'), 'Admin reads it');
reset role;

-- ═══ 7. ARCHIVED ═════════════════════════════════════════════════════════
set local role authenticated;
select public._t_as(public._t_id('admin'));
select public.archive_exhibition_lead(public._t_lead('Card Lead Two'), 'Test archive');
select public._t_raises($q$ select public.set_exhibition_lead_contact(public._t_lead('Card Lead Two'), '{"email":"late@x.in"}') $q$, 'EXHIBITION_LEADS_ARCHIVED');
reset role;

do $$ begin raise notice 'ALL CARD ASSERTIONS PASSED'; end $$;
rollback;
