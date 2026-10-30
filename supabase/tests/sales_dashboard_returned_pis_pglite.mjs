// Database regression suite for 20270507000000, 20270508000000 and
// 20270509000000 (the sales team's Orders dashboard and the short returned-PI
// notice).
//
// Applies the REAL migration files on an in-memory Postgres (PGlite), after
// the REAL previous definitions (20270328000200 for the dashboard,
// 20270328000100 for the notice), so old and new answers are compared on the
// same rows. Stubbed, and said so: auth.uid(), module_entry_open,
// can_view_order_submission, is_eligible_order_assignee,
// assert_order_submission_actor, order_advance_position (fixed answers per
// order), users_with_module_permission, order_notify_users (records what it was
// asked to send), and the tables (only the columns the functions read).
//
// NOT part of npm test (PGlite is not an app dependency). Run:
//   node supabase/tests/sales_dashboard_returned_pis_pglite.mjs <dir with @electric-sql/pglite installed>
// Expected last line: "all 12 checks passed".
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import assert from 'node:assert/strict'

const PGLITE_DIR = process.argv[2]
if (!PGLITE_DIR) { console.error('usage: node sales_dashboard_returned_pis_pglite.mjs <dir with @electric-sql/pglite installed>'); process.exit(2) }
const require = createRequire(resolve(PGLITE_DIR) + '/')
const { PGlite } = require('@electric-sql/pglite')
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const mig = f => readFileSync(`${REPO}/supabase/migrations/${f}`, 'utf8').replace(/\r/g, '')

const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`
const A = id(0xa1), B = id(0xb1), N = id(0xee), OUT = id(0xc1)
const O = n => id(0x100 + n)
const S = n => id(0x200 + n)

const db = new PGlite()
let checks = 0
const check = async (name, fn) => { await fn(); checks += 1; console.log('ok -', name) }
const as = uid => db.exec(`select set_config('test.uid', '${uid ?? ''}', false)`)
const ordersOpen = yes => db.exec(`select set_config('test.orders_open', '${yes ? 'yes' : 'no'}', false)`)

await db.exec(`
  create schema if not exists auth;
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin;
  -- test.uid for these checks; the JWT claim for the rehearsal footer at the end.
  create function auth.uid() returns uuid language sql stable
    as $$ select coalesce(nullif(current_setting('test.uid', true), '')::uuid,
                          (nullif(current_setting('request.jwt.claims', true), '')::json ->> 'sub')::uuid) $$;
  create type notification_type as enum ('pi_review_requested', 'pi_review_decided');

  create table public.users (id uuid primary key, full_name text, role text, team text,
    is_active boolean default true, is_deleted boolean default false);
  create table public.orders (id uuid primary key, display_number text, client_name text, status text,
    confirm_date date, due_date date, created_at timestamptz default now(), total_value numeric,
    total_product_value numeric, assigned_to uuid, is_test_data boolean default false,
    source_order_submission_id uuid);
  create table public.order_submissions (id uuid primary key, draft_reference text, client_name text,
    review_note text, status text, salesperson_id uuid, submitted_by uuid, created_by uuid,
    deletion_claim_token text, submitted_at timestamptz, updated_at timestamptz default now(),
    rejected_at timestamptz, rejected_by uuid, gross_product_amount numeric, discount_amount numeric,
    subtotal_after_discount numeric);
  create table public.order_pi_versions (order_id uuid, submission_id uuid, status text, version_number int);
  create table public.order_submission_activity (submission_id uuid, new_status text, created_at timestamptz, actor_id uuid);
  create table public.order_approval_events (id uuid default gen_random_uuid(), order_id uuid, approval_kind text,
    status text, created_at timestamptz default now());
  create table public.orders_dashboard_settings (id boolean primary key default true, fabric_finish_tracking_from timestamptz);
  insert into public.orders_dashboard_settings values (true, '2026-01-01');
  create table public.order_activity_log (order_id uuid, event_type text, payload jsonb, created_at timestamptz);
  create table public.zz_pos (order_id uuid primary key, pos jsonb);
  create table public.zz_notices (users uuid[], actor uuid, entity uuid, type text, title text, body text);

  create function public.module_entry_open(text) returns boolean language sql stable
    as $$ select coalesce(current_setting('test.orders_open', true), 'yes') = 'yes' $$;
  create function public.assert_order_submission_actor() returns uuid language plpgsql as $$
    begin if auth.uid() is null then raise exception 'Authentication required'; end if; return auth.uid(); end $$;
  create function public.is_eligible_order_assignee(uuid) returns boolean language sql stable
    as $$ select exists (select 1 from public.users u where u.id = $1 and u.team = 'sales') $$;
  create function public.can_view_order_submission(uuid) returns boolean language sql stable
    as $$ select $1 <> '${S(2)}'::uuid $$;
  create function public.order_advance_base(uuid) returns numeric language sql as $$ select null::numeric $$;
  -- answers carry the key advance_base, which the dashboard's dependency check looks for
  create function public.order_advance_position(p uuid) returns jsonb language sql stable as $$
    select coalesce((select z.pos from public.zz_pos z where z.order_id = p),
      '{"value_known": true, "shortfall": 0, "percent": 50, "verified": 1, "advance_base": 2}'::jsonb) $$;
  create function public.users_with_module_permission(text, text) returns table (user_id uuid)
    language sql as $$ select '${N}'::uuid $$;
  create function public.order_notify_actor_suffix(p_actor uuid) returns text language sql stable as $$
    select coalesce((select ' by ' || u.full_name from public.users u
                      where u.id = p_actor and nullif(btrim(u.full_name), '') is not null), '') $$;
  create function public.order_notify_users(p_users uuid[], p_actor uuid, p_entity uuid,
    p_type notification_type, p_title text, p_body text) returns integer language sql as $$
    insert into public.zz_notices values (p_users, p_actor, p_entity, p_type::text, p_title, p_body) returning 1 $$;

  create function public.order_submission_review_notify() returns trigger language plpgsql as $$ begin return null; end $$;
  create trigger order_submissions_review_notify after update of status on public.order_submissions
    for each row execute function public.order_submission_review_notify();

  insert into public.users values
    ('${A}', 'Ashok Choudhary', 'member', 'sales'),
    ('${B}', 'Other Seller', 'member', 'sales'),
    ('${N}', 'Nishant Soni', 'admin', 'management'),
    ('${OUT}', 'Purchase Person', 'member', 'purchase');
`)

// Dates, in India time, as the function sees them.
await db.exec(`
  create temp table d as
  select date_trunc('month', timezone('Asia/Kolkata', now()))::date as this_first,
         (date_trunc('month', timezone('Asia/Kolkata', now())) - interval '1 month')::date as prev_first;

  insert into public.orders (id, display_number, client_name, status, confirm_date, due_date, total_product_value, assigned_to)
  select * from (values
    ('${O(1)}'::uuid, '518', 'Kapoor Interiors', 'running',            (select this_first from d),          null::date, 100000::numeric, '${A}'::uuid),
    ('${O(2)}'::uuid, '497', 'Sharma Villa',     'dispatched',         (select this_first - 1 from d),      null,       250000,          '${A}'),
    ('${O(3)}'::uuid, '501', 'Meraki Cafe',      'ready_for_dispatch', (select prev_first from d),          '2026-11-02', 50000,         '${A}'),
    ('${O(4)}'::uuid, '480', 'Too Old',          'running',            (select prev_first - 1 from d),      null,       999999,          '${A}'),
    ('${O(5)}'::uuid, '490', 'Cancelled Co',     'cancelled',          (select this_first - 1 from d),      null,       77777,           '${A}'),
    ('${O(6)}'::uuid, '495', 'No Value',         'running',            (select prev_first + 3 from d),      null,       null,            '${A}'),
    ('${O(7)}'::uuid, '512', 'The Oak Room',     'ready_for_dispatch', (select this_first from d),          null,       40000,           '${A}'),
    ('${O(8)}'::uuid, '600', 'Not Ashoks',       'running',            (select this_first - 1 from d),      null,       123456,          '${B}')
  ) v;

  insert into public.zz_pos values
    ('${O(1)}', '{"value_known": true, "verified": 30000, "percent": 12, "shortfall": 186400, "advance_base": 2, "exception": null}'),
    ('${O(7)}', '{"value_known": false, "verified": 0, "percent": null, "shortfall": null, "advance_base": null}');

  -- 501 went ready, back to running, and ready again three days ago: the LAST time counts.
  insert into public.order_activity_log values
    ('${O(3)}', 'status_changed', '{"from": "running", "to": "ready_for_dispatch"}', now() - interval '10 days'),
    ('${O(3)}', 'status_changed', '{"from": "ready_for_dispatch", "to": "running"}', now() - interval '8 days'),
    ('${O(3)}', 'status_changed', '{"from": "running", "to": "ready_for_dispatch"}', now() - interval '3 days'),
    ('${O(3)}', 'note_added',     '{"to": "ready_for_dispatch"}',                    now() - interval '1 day');

  insert into public.order_submissions (id, draft_reference, client_name, review_note, status, salesperson_id,
    submitted_by, created_by, deletion_claim_token, submitted_at, rejected_at, rejected_by) values
    ('${S(1)}', 'PID-00021', 'IBC', 'In 003 and 004 ... nine paragraphs', 'needs_changes', '${A}', '${A}', '${A}', null, now() - interval '4 days', null, null),
    ('${S(2)}', 'PID-00022', 'Made By A', 'Fix the GST', 'needs_changes', '${B}', '${B}', '${A}', null, now() - interval '2 days', null, null),
    ('${S(3)}', 'PID-00023', 'Being Deleted', null, 'needs_changes', '${A}', '${A}', '${A}', 'claim', now(), null, null),
    ('${S(4)}', 'PID-00024', 'Nest Studio', null, 'submitted', '${A}', '${A}', '${A}', null, now() - interval '2 days', null, null),
    ('${S(5)}', 'PID-00019', 'Studio Arc', 'Client went elsewhere', 'rejected', '${A}', '${A}', '${A}', null, now() - interval '3 days', now() - interval '1 day', '${N}'),
    ('${S(6)}', 'PID-00025', 'Only B', null, 'needs_changes', '${B}', '${B}', '${B}', null, now(), null, null),
    ('${S(7)}', 'PID-00026', 'A Draft', null, 'draft', '${A}', '${A}', '${A}', null, null, null, null),
    ('${S(8)}', 'PID-00030', 'Casa Bella', null, 'submitted', '${A}', '${A}', '${A}', null, now(), null, null),
    ('${S(9)}', '', 'No Reference', null, 'submitted', '${A}', '${A}', '${A}', null, now(), null, null);

  insert into public.order_submission_activity values
    ('${S(1)}', 'needs_changes', now() - interval '6 days', '${B}'),
    ('${S(1)}', 'needs_changes', now() - interval '3 days', '${N}'),
    ('${S(2)}', 'needs_changes', now() - interval '1 day',  '${N}');
`)

const dashboard = async () => (await db.query('select public.salesperson_orders_dashboard() as d')).rows[0].d
const returnedPis = async () => (await db.query('select public.my_returned_pis() as r')).rows[0].r

// ── Old and new dashboard on the same rows, in one transaction (one now()) ──
await as(A)
await db.exec('begin')
await db.exec(mig('20270328000200_order_submission_returned_rejected_dashboard.sql'))
const before = await dashboard()
await db.exec(mig('20270507000000_returned_pis_for_sales.sql'))
await db.exec(mig('20270508000000_salesperson_dashboard_last_month.sql'))
const after = await dashboard()
await db.exec('commit')

await check('the two migrations apply after the previous definition, and their own checks pass', async () => {
  assert.equal(before.applicable, true)
  assert.equal(after.applicable, true)
  assert.ok(!('revenue_last_month' in before))
})

await check('take the new keys away and the answer is exactly the old one', async () => {
  const strip = d => {
    const { revenue_last_month: _r, ...rest } = d
    return {
      ...rest,
      advance: d.advance.map(({ shortfall: _s, days_since_confirmation: _d, ...a }) => a),
      ready_for_dispatch: d.ready_for_dispatch.map(({ ready_since: _s, ready_days: _d, ...r }) => r),
    }
  }
  assert.deepEqual(strip(after), before)
})

await check('this month and last month are split at the first of the month, India time', async () => {
  assert.equal(Number(after.revenue.amount), 140000, '518 (1st of this month) + 512')
  assert.equal(after.revenue.orders, 2)
  assert.equal(Number(after.revenue_last_month.amount), 300000, '497 (last day of last month) + 501 (first day)')
  assert.equal(after.revenue_last_month.orders, 2)
  assert.equal(after.revenue_last_month.no_product_value, 1, 'an order with no value is said, not counted')
  const { rows } = await db.query('select prev_first::text as p from d')
  assert.equal(after.revenue_last_month.month_from, rows[0].p)
})

await check('cancelled orders, older months and another salesperson\'s orders are not in last month', async () => {
  // 480 (the day before last month), 490 (cancelled) and 600 (salesperson B) would each move the total.
  assert.equal(Number(after.revenue_last_month.amount), 300000)
})

await check('the rupees short of 40% are the advance rule\'s own figure', async () => {
  assert.equal(after.advance.length, 1)
  assert.equal(after.advance[0].display_number, '518')
  assert.equal(Number(after.advance[0].shortfall), 186400)
  assert.equal(Number(after.advance[0].percent), 12)
  assert.ok(Number.isInteger(after.advance[0].days_since_confirmation) && after.advance[0].days_since_confirmation >= 0)
  assert.deepEqual(after.advance_unchecked.map(r => r.display_number), ['512'], 'no value: listed apart, never cleared')
})

await check('ready since: the LAST move to ready, and nothing guessed without a history entry', async () => {
  const byNo = Object.fromEntries(after.ready_for_dispatch.map(r => [r.display_number, r]))
  assert.equal(byNo['501'].ready_days, 3)
  assert.ok(byNo['501'].ready_since)
  assert.equal(byNo['512'].ready_since, null)
  assert.equal(byNo['512'].ready_days, null)
})

await check('returned to you: salesperson or creator, not being deleted, not someone else\'s', async () => {
  assert.deepEqual(after.returned.map(r => r.reference), ['PID-00021', 'PID-00022'])
  assert.equal(after.returned_total, 2)
  const s1 = after.returned[0]
  assert.equal(s1.by_name, 'Nishant Soni', 'the newest return names who did it')
  assert.equal(after.returned[1].can_open, false)
})

await check('the Modules card reads the same PIs as the dashboard, oldest first', async () => {
  await as(A)
  const mine = await returnedPis()
  assert.deepEqual(mine.map(r => r.submission_id), after.returned.map(r => r.submission_id))
  assert.equal(mine[0].reference, 'PID-00021')
  assert.equal(mine[0].client_name, 'IBC')
  assert.equal(mine[0].by_name, 'Nishant Soni')
  assert.equal(mine[0].can_open, true)
  assert.equal(mine[1].can_open, false)
  assert.ok(mine[0].waiting_seconds >= 3 * 86400 - 5)
  assert.ok(!('note' in mine[0]) && !('review_note' in mine[0]), 'the note never reaches the card')
  await as(B)
  assert.deepEqual((await returnedPis()).map(r => r.reference).sort(), ['PID-00022', 'PID-00025'])
  await as(OUT)
  assert.deepEqual(await returnedPis(), [])
})

await check('the Modules card never breaks the launcher: nothing without Orders, nothing signed out', async () => {
  await as(A)
  await ordersOpen(false)
  assert.deepEqual(await returnedPis(), [])
  await ordersOpen(true)
  await as(null)
  assert.deepEqual(await returnedPis(), [])
  const priv = (await db.query(`select
      has_function_privilege('anon', 'public.my_returned_pis()', 'execute') as anon_card,
      has_function_privilege('authenticated', 'public.my_returned_pis()', 'execute') as auth_card,
      has_function_privilege('authenticated', 'public.order_submissions_returned_to(uuid)', 'execute') as auth_rule`)).rows[0]
  assert.deepEqual(priv, { anon_card: false, auth_card: true, auth_rule: false })
})

// ── The notice: old words, then new words, on the same kind of decision ──
const decide = async (sub, status) => {
  await as(N)
  await db.exec('delete from public.zz_notices')
  await db.query('update public.order_submissions set status = $2 where id = $1', [sub, status])
  return (await db.query('select * from public.zz_notices')).rows
}

await check('before: the whole note was copied into the notice', async () => {
  await db.exec(mig('20270328000100_order_submission_review_notify_salesperson.sql'))
  await db.exec(`update public.order_submissions set review_note = 'Make the legs four-sided' where id = '${S(4)}'`)
  const [n] = await decide(S(4), 'needs_changes')
  assert.equal(n.title, 'Changes were requested on the PI for Nest Studio by Nishant Soni.')
  assert.equal(n.body, 'Make the legs four-sided')
})

await check('after: one line, no note, same people, same type', async () => {
  await db.exec(mig('20270509000000_pi_review_notice_short.sql'))
  await db.exec(`update public.order_submissions set review_note = 'A long note' where id in ('${S(8)}', '${S(9)}')`)

  const [returned] = await decide(S(8), 'needs_changes')
  assert.equal(returned.title, 'PID-00030 · Casa Bella was returned to you by Nishant Soni.')
  assert.equal(returned.body, null)
  assert.equal(returned.type, 'pi_review_decided')
  assert.equal(returned.actor, N)
  assert.deepEqual(returned.users, [A, A, A], 'submitter, creator, salesperson — as before')

  await db.exec(`update public.order_submissions set status = 'submitted' where id = '${S(8)}'`)
  const [closed] = await decide(S(8), 'rejected')
  assert.equal(closed.title, 'PID-00030 · Casa Bella was closed (deal lost) by Nishant Soni.')
  assert.equal(closed.body, null)

  const [noRef] = await decide(S(9), 'needs_changes')
  assert.equal(noRef.title, 'The PI for No Reference was returned to you by Nishant Soni.')

  // Submitting is untouched: the approvers still hear about it.
  await as(A)
  await db.exec('delete from public.zz_notices')
  await db.exec(`update public.order_submissions set status = 'submitted' where id = '${S(9)}'`)
  const sent = (await db.query('select * from public.zz_notices')).rows
  assert.equal(sent.length, 1)
  assert.equal(sent[0].type, 'pi_review_requested')
  assert.equal(sent[0].title, 'The PI for No Reference was sent for approval by Ashok Choudhary.')
})

await check('the live-database rehearsal footer runs as written and ends REHEARSAL OK', async () => {
  // The same file the owner runs against the linked database, inside the same begin … rollback.
  await as(null)
  const footer = readFileSync(`${REPO}/supabase/tests/sales_dashboard_rehearsal_footer.sql`, 'utf8').replace(/\r/g, '')
  const results = await db.exec(`begin;\n${footer}\nrollback;`)
  const rows = results.flatMap(r => r.rows)
  assert.equal(rows.at(-1)?.result, 'REHEARSAL OK')
  const seen = rows.find(r => 'dashboards_read' in r)
  assert.ok(Number(seen.dashboards_read) >= 2, 'both salespeople were read')
  assert.ok(Number(seen.returned_pi_cards) >= 3, 'their returned PIs were checked against the card')
})

console.log(`all ${checks} checks passed`)
