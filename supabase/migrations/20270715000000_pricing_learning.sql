-- 20270715000000_pricing_learning.sql
--
-- Price learning, piece 1 (owner approved 2026-11-13): a place in Quotations to feed the price model with the PIs BOE
-- has already made, 25 at a time, with an honest score for every batch, and a doorway for feedback and corrections on
-- every suggested price.
--
-- ADDS FOUR TABLES, so take a backup before applying (owner rule). Nothing existing is altered except two read-only
-- functions that are re-created to include the learned lines:
--   pricing_learning_batches   one row per batch of up to 25 PIs: when, who, how many, and the blind-test score
--   pricing_learning_pis       one row per PI: its date, order facts (pieces, designs, value) and its fingerprints
--   pricing_learning_lines     the product lines of each PI: name, size, material, customization, quantity, price
--   pricing_feedback           feedback or a correction on a suggested price, from a salesperson or the pricing desk
-- All four are closed to every client role (RLS on, no policy, no grant): only the SECURITY DEFINER functions below
-- read or write them.
--
-- WHO: the learning functions are for the pricing desk, the same rule as price approval (Admin, or Quotations edit AND
-- see-all). Feedback can be SENT by anyone who may open Quotations, and READ by the desk only.
--
-- PRIVACY: a PI's file name (source_label) can carry a client's name, so it is returned to the desk only. pricing_pool
-- and pricing_all_points, which every quotation maker's screen calls, return prices, sizes and materials, never a label.
--
-- LEARNED PRICES count like approved PIs (kind 'order', last three years, by the PI's own date): they ARE the PIs BOE
-- already made. A PI left out (a sample price, a US-dollar file, an older version of the same project) is kept with its
-- reason so it is not asked about again, and never reaches the pool.
--
-- pricing_pool (20270621000000) had a cap of 800 points, which a few batches would pass: raised to 2,500.
--
-- ROLLBACK: drop the six pricing_learning_* / pricing_feedback_* functions and the four tables; re-create
-- pricing_all_points from 20270620000000 and pricing_pool from 20270621000000.

-- ═══ 1. Tables ═══════════════════════════════════════════════════════════════

create table public.pricing_learning_batches (
  id              uuid primary key default gen_random_uuid(),
  batch_no        integer not null unique,
  created_by      uuid references public.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  client_type     text check (client_type in ('architect', 'interior_designer', 'property_owner', 'fnb_consultant', 'other')),
  pis_learned     integer not null default 0 check (pis_learned >= 0),
  pis_left_out    integer not null default 0 check (pis_left_out >= 0),
  lines_learned   integer not null default 0 check (lines_learned >= 0),
  priced_lines    integer not null default 0 check (priced_lines >= 0),
  unpriced_lines  integer not null default 0 check (unpriced_lines >= 0),
  -- The blind test: the average distance of the model's price from the PI's price, and the share of lines within 10%.
  avg_miss        numeric(6,2) check (avg_miss is null or avg_miss >= 0),
  hit_rate        numeric(5,2) check (hit_rate is null or hit_rate between 0 and 100),
  note            text check (char_length(note) <= 500)
);

create table public.pricing_learning_pis (
  id                uuid primary key default gen_random_uuid(),
  batch_id          uuid not null references public.pricing_learning_batches(id) on delete cascade,
  seq               integer not null check (seq between 1 and 25),
  source_label      text check (char_length(source_label) <= 260),
  file_hash         text not null unique check (file_hash ~ '^[0-9a-f]{64}$'),
  content_print     text not null unique check (content_print ~ '^[0-9a-f]{64}$'),
  pi_date           date not null check (pi_date between date '2015-01-01' and date '2100-01-01'),
  date_source       text not null default 'file' check (date_source in ('file', 'saved', 'typed')),
  client_type       text check (client_type in ('architect', 'interior_designer', 'property_owner', 'fnb_consultant', 'other')),
  pieces            numeric(14,2) not null default 0 check (pieces >= 0),
  designs           integer not null default 0 check (designs >= 0),
  subtotal          numeric(14,2) not null default 0,
  discount          numeric(14,2) check (discount is null or discount >= 0),
  value_before_gst  numeric(14,2) not null default 0,
  left_out          boolean not null default false,
  left_out_reason   text check (char_length(left_out_reason) <= 300),
  created_at        timestamptz not null default now(),
  unique (batch_id, seq)
);

create table public.pricing_learning_lines (
  id               uuid primary key default gen_random_uuid(),
  pi_id            uuid not null references public.pricing_learning_pis(id) on delete cascade,
  line_no          integer not null,
  name             text not null check (char_length(btrim(name)) between 1 and 240),
  size_text        text check (char_length(size_text) <= 160),
  material         text check (char_length(material) <= 200),
  customization    text check (char_length(customization) <= 600),
  qty              numeric(12,2) not null check (qty > 0),
  unit_price       numeric(12,2) not null check (unit_price > 0),
  derived          boolean not null default false,
  left_out         boolean not null default false,
  left_out_reason  text check (char_length(left_out_reason) <= 200)
);
create index pricing_learning_lines_pi_idx on public.pricing_learning_lines (pi_id);

create table public.pricing_feedback (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  created_by      uuid references public.users(id) on delete set null,
  source          text not null check (source in ('quotation', 'learning')),
  kind            text not null check (kind in ('too_high', 'too_low', 'wrong_type', 'misread', 'other', 'correction')),
  comment         text check (char_length(comment) <= 1000),
  expected_price  numeric(12,2) check (expected_price is null or expected_price > 0),
  line_name       text check (char_length(line_name) <= 240),
  line_size       text check (char_length(line_size) <= 160),
  line_material   text check (char_length(line_material) <= 200),
  line_finish     text check (char_length(line_finish) <= 600),
  line_qty        numeric(12,2),
  client_type     text check (char_length(client_type) <= 40),
  -- What the model said when the feedback was given: price, range, confidence, the reasons it showed, its basis.
  suggestion      jsonb,
  quotation_id    uuid references public.quotations(id) on delete set null,
  status          text not null default 'new' check (status in ('new', 'seen', 'done', 'declined')),
  handled_by      uuid references public.users(id) on delete set null,
  handled_at      timestamptz,
  handled_note    text check (char_length(handled_note) <= 500)
);
create index pricing_feedback_status_idx on public.pricing_feedback (status, created_at desc);

alter table public.pricing_learning_batches enable row level security;
alter table public.pricing_learning_pis     enable row level security;
alter table public.pricing_learning_lines   enable row level security;
alter table public.pricing_feedback         enable row level security;
revoke all on public.pricing_learning_batches, public.pricing_learning_pis, public.pricing_learning_lines, public.pricing_feedback
  from public, anon, authenticated;

-- ═══ 2. Access ═══════════════════════════════════════════════════════════════

-- Internal: the pricing desk's caller, or an error. Not callable by clients.
create or replace function public.pricing_learning_require_desk()
returns uuid language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare a record;
begin
  select * into a from public.quotation_actor();
  if not (a.p_admin or (a.p_edit and a.p_view_all)) then
    raise exception 'PRICING_LEARNING_FORBIDDEN: only the pricing desk may use price learning' using errcode = '42501';
  end if;
  return a.p_uid;
end $$;
revoke all on function public.pricing_learning_require_desk() from public, anon, authenticated;

-- What the screens may SHOW: is the caller on the pricing desk? (Anyone who may open Quotations may ask.)
create or replace function public.pricing_learning_access()
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare a record;
begin
  select * into a from public.quotation_actor();
  return jsonb_build_object('desk', (a.p_admin or (a.p_edit and a.p_view_all)));
end $$;
revoke all on function public.pricing_learning_access() from public, anon;
grant execute on function public.pricing_learning_access() to authenticated;

-- ═══ 3. The learning functions (pricing desk) ════════════════════════════════

-- The home page: every batch, newest first, with its score.
create or replace function public.pricing_learning_home()
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  perform public.pricing_learning_require_desk();
  return jsonb_build_object(
    'batches', coalesce((select jsonb_agg(jsonb_build_object(
        'id', b.id, 'batch_no', b.batch_no, 'created_at', b.created_at, 'pis_learned', b.pis_learned, 'pis_left_out', b.pis_left_out,
        'lines_learned', b.lines_learned, 'priced_lines', b.priced_lines, 'unpriced_lines', b.unpriced_lines,
        'avg_miss', b.avg_miss, 'hit_rate', b.hit_rate, 'client_type', b.client_type) order by b.batch_no desc)
      from public.pricing_learning_batches b), '[]'::jsonb),
    'totals', jsonb_build_object(
      'pis', (select count(*) from public.pricing_learning_pis where not left_out),
      'lines', (select count(*) from public.pricing_learning_lines l join public.pricing_learning_pis p on p.id = l.pi_id where not l.left_out and not p.left_out)),
    'open_feedback', (select count(*) from public.pricing_feedback where status in ('new', 'seen')));
end $$;
revoke all on function public.pricing_learning_home() from public, anon;
grant execute on function public.pricing_learning_home() to authenticated;

-- Which of these files, or which of these sets of lines, were already seen? Matches by file hash or content fingerprint.
create or replace function public.pricing_learning_known(p_hashes text[], p_prints text[])
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  perform public.pricing_learning_require_desk();
  if coalesce(array_length(p_hashes, 1), 0) > 100 or coalesce(array_length(p_prints, 1), 0) > 100 then
    raise exception 'PRICING_LEARNING_INVALID: ask about at most 100 files' using errcode = '22023';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('file_hash', p.file_hash, 'content_print', p.content_print,
                     'batch_no', b.batch_no, 'left_out', p.left_out, 'reason', p.left_out_reason))
    from public.pricing_learning_pis p join public.pricing_learning_batches b on b.id = p.batch_id
    where p.file_hash = any (coalesce(p_hashes, '{}')) or p.content_print = any (coalesce(p_prints, '{}'))), '[]'::jsonb);
end $$;
revoke all on function public.pricing_learning_known(text[], text[]) from public, anon;
grant execute on function public.pricing_learning_known(text[], text[]) to authenticated;

-- Saves a batch in one step: the batch, its PIs and their lines, with the blind-test score the browser worked out.
-- p_doc: { client_type, note, score: { avg_miss, hit_rate, priced, unpriced },
--          pis: [ { label, file_hash, content_print, pi_date, date_source, client_type, pieces, designs, subtotal, discount,
--                   value_before_gst, left_out, left_out_reason,
--                   lines: [ { name, size, material, customization, qty, price, derived, left_out, left_out_reason } ] } ] }
create or replace function public.pricing_learning_save(p_doc jsonb)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare
  v_uid uuid := public.pricing_learning_require_desk();
  v_batch uuid; v_no integer; v_pi jsonb; v_pi_id uuid; v_seq integer := 0; v_n_lines integer := 0; v_total_lines integer := 0;
  v_learned integer := 0; v_left integer := 0; v_lines_learned integer := 0;
begin
  if jsonb_typeof(p_doc->'pis') is distinct from 'array' or jsonb_array_length(p_doc->'pis') not between 1 and 25 then
    raise exception 'PRICING_LEARNING_INVALID: a batch holds 1 to 25 PIs' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('pricing_learning_batch'));
  select coalesce(max(batch_no), 0) + 1 into v_no from public.pricing_learning_batches;
  begin
    insert into public.pricing_learning_batches (batch_no, created_by, client_type, note, avg_miss, hit_rate, priced_lines, unpriced_lines)
    values (v_no, v_uid, nullif(p_doc->>'client_type', ''), nullif(left(coalesce(p_doc->>'note', ''), 500), ''),
            nullif(p_doc#>>'{score,avg_miss}', '')::numeric, nullif(p_doc#>>'{score,hit_rate}', '')::numeric,
            coalesce(nullif(p_doc#>>'{score,priced}', '')::integer, 0), coalesce(nullif(p_doc#>>'{score,unpriced}', '')::integer, 0))
    returning id into v_batch;
    for v_pi in select * from jsonb_array_elements(p_doc->'pis') loop
      v_seq := v_seq + 1;
      -- A table CHECK cannot ask for today's date, so the "not in the future" rule lives here.
      if (v_pi->>'pi_date')::date > current_date + 2 then
        raise exception 'PRICING_LEARNING_INVALID: a PI date is in the future' using errcode = '22023';
      end if;
      insert into public.pricing_learning_pis (batch_id, seq, source_label, file_hash, content_print, pi_date, date_source, client_type,
          pieces, designs, subtotal, discount, value_before_gst, left_out, left_out_reason)
      values (v_batch, v_seq, nullif(left(coalesce(v_pi->>'label', ''), 260), ''), v_pi->>'file_hash', v_pi->>'content_print',
          (v_pi->>'pi_date')::date, coalesce(nullif(v_pi->>'date_source', ''), 'file'), nullif(v_pi->>'client_type', ''),
          coalesce((v_pi->>'pieces')::numeric, 0), coalesce((v_pi->>'designs')::integer, 0), coalesce((v_pi->>'subtotal')::numeric, 0),
          nullif(v_pi->>'discount', '')::numeric, coalesce((v_pi->>'value_before_gst')::numeric, 0),
          coalesce((v_pi->>'left_out')::boolean, false), nullif(left(coalesce(v_pi->>'left_out_reason', ''), 300), ''))
      returning id into v_pi_id;
      if jsonb_typeof(v_pi->'lines') is distinct from 'array' or jsonb_array_length(v_pi->'lines') not between 1 and 600 then
        raise exception 'PRICING_LEARNING_INVALID: a PI holds 1 to 600 lines' using errcode = '22023';
      end if;
      insert into public.pricing_learning_lines (pi_id, line_no, name, size_text, material, customization, qty, unit_price, derived, left_out, left_out_reason)
      select v_pi_id, t.ord::integer, btrim(t.x->>'name'), nullif(t.x->>'size', ''), nullif(t.x->>'material', ''), nullif(t.x->>'customization', ''),
             (t.x->>'qty')::numeric, (t.x->>'price')::numeric, coalesce((t.x->>'derived')::boolean, false),
             coalesce((t.x->>'left_out')::boolean, false), nullif(left(coalesce(t.x->>'left_out_reason', ''), 200), '')
      from jsonb_array_elements(v_pi->'lines') with ordinality as t(x, ord);
      get diagnostics v_n_lines = row_count;
      v_total_lines := v_total_lines + v_n_lines;
      if v_total_lines > 6000 then raise exception 'PRICING_LEARNING_INVALID: too many lines in one batch' using errcode = '22023'; end if;
      if coalesce((v_pi->>'left_out')::boolean, false) then v_left := v_left + 1;
      else
        v_learned := v_learned + 1;
        v_lines_learned := v_lines_learned + (select count(*) from public.pricing_learning_lines where pi_id = v_pi_id and not left_out);
      end if;
    end loop;
  exception
    when unique_violation then
      raise exception 'PRICING_LEARNING_DUPLICATE: one of these PIs was already learned (same file or same lines). Check the files again.' using errcode = '23505';
    when check_violation or numeric_value_out_of_range or string_data_right_truncation or invalid_text_representation or datetime_field_overflow then
      raise exception 'PRICING_LEARNING_INVALID: a value in the batch is out of range (%)', sqlerrm using errcode = '22023';
  end;
  update public.pricing_learning_batches set pis_learned = v_learned, pis_left_out = v_left, lines_learned = v_lines_learned where id = v_batch;
  return jsonb_build_object('id', v_batch, 'batch_no', v_no, 'pis_learned', v_learned, 'pis_left_out', v_left, 'lines_learned', v_lines_learned);
end $$;
revoke all on function public.pricing_learning_save(jsonb) from public, anon;
grant execute on function public.pricing_learning_save(jsonb) to authenticated;

-- One batch with its PIs (labels included: the desk only).
create or replace function public.pricing_learning_batch(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare b record;
begin
  perform public.pricing_learning_require_desk();
  select * into b from public.pricing_learning_batches where id = p_id;
  if b.id is null then raise exception 'PRICING_LEARNING_NOT_FOUND' using errcode = 'P0002'; end if;
  return jsonb_build_object(
    'batch', to_jsonb(b) - 'created_by' || jsonb_build_object('created_by_name', (select u.full_name from public.users u where u.id = b.created_by)),
    'pis', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'seq', p.seq, 'label', p.source_label, 'pi_date', p.pi_date, 'date_source', p.date_source,
        'client_type', p.client_type, 'pieces', p.pieces, 'designs', p.designs, 'subtotal', p.subtotal, 'discount', p.discount,
        'value_before_gst', p.value_before_gst, 'left_out', p.left_out, 'left_out_reason', p.left_out_reason,
        'lines', (select count(*) from public.pricing_learning_lines l where l.pi_id = p.id and not l.left_out)) order by p.seq)
      from public.pricing_learning_pis p where p.batch_id = b.id), '[]'::jsonb));
end $$;
revoke all on function public.pricing_learning_batch(uuid) from public, anon;
grant execute on function public.pricing_learning_batch(uuid) to authenticated;

-- ═══ 4. Feedback and corrections ═════════════════════════════════════════════

-- Anyone who may open Quotations can say a suggested price looks wrong. The desk reads it.
-- p_doc: { source, kind, comment, expected_price, line: { name, size, material, finish, qty }, client_type, suggestion, quotation_id }
create or replace function public.pricing_feedback_add(p_doc jsonb)
returns uuid language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare a record; v_id uuid;
begin
  select * into a from public.quotation_actor();
  if (select count(*) from public.pricing_feedback where created_by = a.p_uid and created_at > now() - interval '1 day') >= 60 then
    raise exception 'PRICING_FEEDBACK_LIMIT: that is a lot of feedback for one day; the pricing desk has your earlier notes' using errcode = '53400';
  end if;
  begin
    insert into public.pricing_feedback (created_by, source, kind, comment, expected_price, line_name, line_size, line_material, line_finish, line_qty,
                                         client_type, suggestion, quotation_id)
    values (a.p_uid, p_doc->>'source', p_doc->>'kind', nullif(btrim(coalesce(p_doc->>'comment', '')), ''), nullif(p_doc->>'expected_price', '')::numeric,
            nullif(p_doc#>>'{line,name}', ''), nullif(p_doc#>>'{line,size}', ''), nullif(p_doc#>>'{line,material}', ''), nullif(p_doc#>>'{line,finish}', ''),
            nullif(p_doc#>>'{line,qty}', '')::numeric, nullif(p_doc->>'client_type', ''),
            case when jsonb_typeof(p_doc->'suggestion') = 'object' then p_doc->'suggestion' end,
            (select q.id from public.quotations q where q.id = nullif(p_doc->>'quotation_id', '')::uuid
               and public.quotation_sees(q.owner_id, q.created_by, a.p_uid, a.p_admin, a.p_view_all)))
    returning id into v_id;
  exception when check_violation or numeric_value_out_of_range or string_data_right_truncation or invalid_text_representation then
    raise exception 'PRICING_FEEDBACK_INVALID: check the feedback (%)', sqlerrm using errcode = '22023';
  end;
  return v_id;
end $$;
revoke all on function public.pricing_feedback_add(jsonb) from public, anon;
grant execute on function public.pricing_feedback_add(jsonb) to authenticated;

-- The desk's list: open ones (new, seen) or every one, newest first.
create or replace function public.pricing_feedback_list(p_open_only boolean default true)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  perform public.pricing_learning_require_desk();
  return coalesce((select jsonb_agg(to_jsonb(f) order by f.created_at desc) from (
    select x.id, x.created_at, x.source, x.kind, x.comment, x.expected_price, x.line_name, x.line_size, x.line_material, x.line_finish, x.line_qty,
           x.client_type, x.suggestion, x.quotation_id, (select q.quote_no from public.quotations q where q.id = x.quotation_id) as quote_no,
           x.status, x.handled_at, x.handled_note, (select u.full_name from public.users u where u.id = x.created_by) as from_name
    from public.pricing_feedback x
    where (not coalesce(p_open_only, true)) or x.status in ('new', 'seen')
    order by x.created_at desc limit 200) f), '[]'::jsonb);
end $$;
revoke all on function public.pricing_feedback_list(boolean) from public, anon;
grant execute on function public.pricing_feedback_list(boolean) to authenticated;

create or replace function public.pricing_feedback_set(p_id uuid, p_status text, p_note text default null)
returns void language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare v_uid uuid := public.pricing_learning_require_desk();
begin
  if p_status not in ('new', 'seen', 'done', 'declined') then
    raise exception 'PRICING_FEEDBACK_INVALID: unknown status' using errcode = '22023';
  end if;
  update public.pricing_feedback set status = p_status, handled_by = v_uid, handled_at = now(), handled_note = nullif(left(btrim(coalesce(p_note, '')), 500), '')
  where id = p_id;
  if not found then raise exception 'PRICING_LEARNING_NOT_FOUND' using errcode = 'P0002'; end if;
end $$;
revoke all on function public.pricing_feedback_set(uuid, text, text) from public, anon;
grant execute on function public.pricing_feedback_set(uuid, text, text) to authenticated;

-- ═══ 5. The learned lines join the price points ═════════════════════════════
-- Both functions are the latest definitions (20270620000000 and 20270621000000) plus one branch for the learned lines.

create or replace function public.pricing_all_points(p_exclude uuid)
returns table (name text, w text[], p numeric, at timestamptz, k text, q numeric)
language sql stable security definer set search_path = public, pg_temp
as $$
  select i.product_name, public.quotation_name_words(i.product_name), i.cost_per_piece::numeric, s.approved_at, 'order', i.quantity::numeric
  from public.order_submission_items i join public.order_submissions s on s.id = i.submission_id
  where s.status = 'approved' and s.approved_at > now() - interval '3 years' and i.product_name is not null
  union all
  select l.name, public.quotation_name_words(l.name), l.unit_price::numeric, p.pi_date::timestamptz, 'order', l.qty::numeric
  from public.pricing_learning_lines l join public.pricing_learning_pis p on p.id = l.pi_id
  where not l.left_out and not p.left_out and p.pi_date > (now() - interval '3 years')::date
  union all
  select l.name, public.quotation_name_words(l.name), l.unit_price::numeric, q.updated_at,
         case q.status when 'confirmed' then 'won' when 'lost' then 'lost' else 'quote' end,
         coalesce(l.qty_fixed, l.qty_per_unit * coalesce(ar.multiplier, 1))
  from public.quotation_lines l join public.quotations q on q.id = l.quotation_id
  left join public.quotation_areas ar on ar.id = l.area_id
  where q.status in ('sent', 'negotiating', 'confirmed', 'lost') and l.unit_price > 0 and not l.is_optional
    and q.id is distinct from p_exclude
$$;
revoke all on function public.pricing_all_points(uuid) from public, anon, authenticated;

create or replace function public.pricing_pool(p_words text[], p_exclude uuid default null)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null or not (public.module_entry_open('quotations') or public.module_entry_open('pricing')) then
    raise exception 'PRICING_FORBIDDEN: neither Quotations nor Pricing is open to you' using errcode = '42501';
  end if;
  if coalesce(array_length(p_words, 1), 0) = 0 or array_length(p_words, 1) > 40 then
    raise exception 'PRICING_INVALID: ask for 1 to 40 words' using errcode = '22023';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('name', x.name, 'p', x.p, 'at', x.at, 'k', x.k, 'q', x.q, 'dims', x.dims,
                                        'material', x.material, 'finish', x.finish, 'client_type', x.client_type) order by x.at desc)
    from (
      select * from (
        select i.product_name as name, i.cost_per_piece::numeric as p, s.approved_at as at, 'order' as k, i.quantity::numeric as q,
               i.dimensions as dims, i.material, i.customization as finish, null::text as client_type
        from public.order_submission_items i join public.order_submissions s on s.id = i.submission_id
        where s.status = 'approved' and s.approved_at > now() - interval '3 years' and i.product_name is not null
          and public.quotation_name_words(i.product_name) && p_words
        union all
        select l.name, l.unit_price::numeric, p.pi_date::timestamptz, 'order', l.qty::numeric, l.size_text, l.material, l.customization, p.client_type
        from public.pricing_learning_lines l join public.pricing_learning_pis p on p.id = l.pi_id
        where not l.left_out and not p.left_out and p.pi_date > (now() - interval '3 years')::date
          and public.quotation_name_words(l.name) && p_words
        union all
        select l.name, l.unit_price::numeric, q.updated_at,
               case when q.status = 'confirmed' then 'won' when q.status = 'lost' then 'lost'
                    when exists (select 1 from public.quotation_price_reviews r where r.quotation_id = q.id and r.decision = 'approved')
                         and public.quotation_price_state(q.id)->>'state' = 'approved' then 'approved'
                    else 'quote' end,
               coalesce(l.qty_fixed, l.qty_per_unit * coalesce(ar.multiplier, 1)),
               l.size_text, l.material, concat_ws(' ', l.finish, l.spec), q.client_type
        from public.quotation_lines l join public.quotations q on q.id = l.quotation_id
        left join public.quotation_areas ar on ar.id = l.area_id
        where q.status in ('sent', 'negotiating', 'confirmed', 'lost') and l.unit_price > 0 and not l.is_optional
          and q.id is distinct from p_exclude and public.quotation_name_words(l.name) && p_words
      ) u order by u.at desc limit 2500
    ) x), '[]'::jsonb);
end $$;
revoke all on function public.pricing_pool(text[], uuid) from public, anon;
grant execute on function public.pricing_pool(text[], uuid) to authenticated;

-- ═══ 6. Self-check ═══════════════════════════════════════════════════════════

do $$
declare t text;
begin
  foreach t in array array['pricing_learning_batches', 'pricing_learning_pis', 'pricing_learning_lines', 'pricing_feedback'] loop
    if has_table_privilege('anon', 'public.' || t, 'select') or has_table_privilege('authenticated', 'public.' || t, 'select')
       or has_table_privilege('authenticated', 'public.' || t, 'insert') then
      raise exception 'PRICING_LEARNING: % must stay closed to every client role', t;
    end if;
  end loop;
  if has_function_privilege('anon', 'public.pricing_learning_save(jsonb)', 'execute')
     or has_function_privilege('anon', 'public.pricing_feedback_add(jsonb)', 'execute')
     or has_function_privilege('anon', 'public.pricing_pool(text[], uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.pricing_learning_require_desk()', 'execute')
     or has_function_privilege('authenticated', 'public.pricing_all_points(uuid)', 'execute') then
    raise exception 'PRICING_LEARNING: a function is open to a role it must not be open to';
  end if;
end $$;
