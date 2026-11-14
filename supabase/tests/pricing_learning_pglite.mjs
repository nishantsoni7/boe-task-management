// Database regression suite for 20270715000000 (Price learning, piece 1). Runs the REAL migrations in an in-memory Postgres
// (PGlite) against small stubs of the platform objects they depend on, with Supabase's default grants to anon and
// authenticated in place first, so the migration's own revokes are what close the tables. Run:
//   node supabase/tests/pricing_learning_pglite.mjs <dir with @electric-sql/pglite installed>
// Expected last line: "all N checks passed".
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import assert from 'node:assert/strict'

const PGLITE_DIR = process.argv[2]
if (!PGLITE_DIR) { console.error('usage: node pricing_learning_pglite.mjs <dir with @electric-sql/pglite installed>'); process.exit(2) }
const require = createRequire(resolve(PGLITE_DIR) + '/')
const { PGlite } = require('@electric-sql/pglite')
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const mig = f => readFileSync(`${REPO}/supabase/migrations/${f}`, 'utf8').replace(/\r/g, '')

const U = {
  admin:   '00000000-0000-0000-0000-0000000000a1',
  sales:   '00000000-0000-0000-0000-0000000000b2', // view + create
  sales2:  '00000000-0000-0000-0000-0000000000b3', // view + create
  manager: '00000000-0000-0000-0000-0000000000c3', // view + view_all (reads everyone, edits nothing): NOT the pricing desk
  editor:  '00000000-0000-0000-0000-0000000000c4', // view + edit + view_all: the pricing desk
  nobody:  '00000000-0000-0000-0000-0000000000d4', // no grant
}

const db = new PGlite()
await db.exec(`
  create role anon nologin; create role authenticated nologin; create role service_role nologin;
  create schema auth; create schema storage;
  grant usage on schema public, auth, storage to anon, authenticated;
  alter default privileges in schema public grant all on tables to anon, authenticated;
  alter default privileges in schema public grant all on sequences to anon, authenticated;
  alter default privileges in schema public grant execute on functions to anon, authenticated;
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

  create table public.users (id uuid primary key, full_name text, role text not null default 'employee',
    is_active boolean not null default true, is_deleted boolean default false);
  create table public.grants (user_id uuid, module_key text, action_key text);
  create function public.resolve_permission(p_uid uuid, p_module text, p_action text) returns boolean
    language sql stable as $$ select exists (select 1 from public.grants g where g.user_id = p_uid and g.module_key = p_module and g.action_key = p_action) $$;
  create function public.module_entry_open(p text) returns boolean language sql stable security definer as
    $$ select exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'admin') or public.resolve_permission(auth.uid(), p, 'view') $$;
  create function public.set_updated_at() returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end $$;

  create table public.app_modules (module_key text primary key, module_name text, description text, route_path text,
    visibility_type text, allowed_department text, sort_order int);
  create table public.permission_modules (id uuid primary key default gen_random_uuid(), module_key text unique, display_name text, description text);
  create table public.permission_actions (id uuid primary key default gen_random_uuid(), action_key text unique);
  insert into public.permission_actions (action_key) values ('view'), ('create'), ('edit'), ('view_all'), ('delete');
  create table public.module_permission_actions (module_id uuid, action_id uuid, default_allowed boolean, unique (module_id, action_id));
  create table public.role_permissions (role text, module_id uuid, action_id uuid, allowed boolean, unique (role, module_id, action_id));

  create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner_id text);
  alter table storage.objects enable row level security;
  grant all on storage.objects to authenticated;

  insert into public.users (id, full_name, role) values
    ('${U.admin}', 'Admin Person', 'admin'), ('${U.sales}', 'Mohit Sharma', 'employee'), ('${U.sales2}', 'Prerna Purohit', 'employee'),
    ('${U.manager}', 'Manager', 'manager'), ('${U.editor}', 'Pricing Desk', 'employee'), ('${U.nobody}', 'No Access', 'employee');
  insert into public.grants values
    ('${U.sales}', 'quotations', 'view'), ('${U.sales}', 'quotations', 'create'),
    ('${U.sales2}', 'quotations', 'view'), ('${U.sales2}', 'quotations', 'create'),
    ('${U.manager}', 'quotations', 'view'), ('${U.manager}', 'quotations', 'view_all'),
    ('${U.editor}', 'quotations', 'view'), ('${U.editor}', 'quotations', 'edit'), ('${U.editor}', 'quotations', 'view_all');
`)
await db.exec(mig('20270614000000_quotations_module.sql'))
await db.exec(`create table public.order_submissions (id uuid primary key default gen_random_uuid(), created_by uuid,
  status text not null default 'draft', draft_reference text, approved_at timestamptz);
  create table public.order_submission_items (id uuid primary key default gen_random_uuid(), submission_id uuid references public.order_submissions(id) on delete cascade,
  product_name text, cost_per_piece numeric(12,2) not null, quantity numeric(12,2) not null default 1,
  dimensions text, material text, customization text);`)
await db.exec(mig('20270615000000_quotation_pi_link.sql'))
await db.exec(mig('20270617000000_quotation_pricing_desk.sql'))
await db.exec(mig('20270620000000_pricing_price_book.sql'))
await db.exec(mig('20270621000000_pricing_model_v2.sql'))
// One approved PI already in BOE One, so the pool has a point that did not come from learning.
await db.exec(`with s as (insert into public.order_submissions (status, approved_at) values ('approved', now() - interval '30 days') returning id)
  insert into public.order_submission_items (submission_id, product_name, cost_per_piece, quantity, dimensions, material, customization)
  select id, 'King bed with headboard', 51000, 40, '78 x 80', 'Teak wood', 'PU finish' from s`)
await db.exec(mig('20270715000000_pricing_learning.sql'))

let checks = 0
const ok = (name) => { checks++; console.log(`  ok - ${name}`) }
async function as(uid, sql, params = [], role = 'authenticated') {
  await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${uid ?? ''}', false); set role ${role};`)
  try { return await db.query(sql, params) } finally { await db.exec('reset role;') }
}
const fails = (uid, sql, params, pattern, role) => assert.rejects(() => as(uid, sql, params, role), pattern)
const rpc = async (uid, fn, ...args) => {
  const ph = args.map((_, i) => `$${i + 1}`).join(', ')
  const r = await as(uid, `select public.${fn}(${ph}) as r`, args)
  return r.rows[0].r
}

// A distinct valid 64-character hex string per letter and number.
const hex = (c, n) => `${c.repeat(64 - String(n).length)}${n}`
const line = (name, qty, price, over = {}) => ({ name, size: '78 x 84 x 42', material: 'Teak wood', customization: 'PU finish', qty, price, derived: false, left_out: false, ...over })
const pi = (n, over = {}) => ({
  label: `Client ${n} PI.xlsx`, file_hash: hex('a', n), content_print: hex('b', n), pi_date: '2025-02-12', date_source: 'file', client_type: null,
  pieces: 120, designs: 3, subtotal: 6000000, discount: 50000, value_before_gst: 5950000, left_out: false,
  lines: [line('King bed with headboard', 56, 54800), line('Bedside table, 2 drawers', 56, 11400), line('Writing desk', 8, 19600)], ...over,
})
const SCORE = { avg_miss: 24.8, hit_rate: 31, priced: 150, unpriced: 20 }
function batch(pis, over = {}) {
  return { client_type: null, note: null, score: SCORE, pis, ...over }
}

// ── closed to every client role ───────────────────────────────────────────
{
  for (const t of ['pricing_learning_batches', 'pricing_learning_pis', 'pricing_learning_lines', 'pricing_feedback']) {
    await fails(U.admin, `select * from public.${t}`, [], /permission denied/)
    await fails(U.sales, `insert into public.${t} default values`, [], /permission denied/)
    await fails(null, `select * from public.${t}`, [], /permission denied/, 'anon')
  }
  for (const fn of ['pricing_learning_home()', 'pricing_learning_save(\'{}\'::jsonb)', 'pricing_feedback_add(\'{}\'::jsonb)', 'pricing_pool(array[\'bed\'], null)']) {
    await fails(null, `select public.${fn}`, [], /permission denied/, 'anon')
  }
  await fails(U.admin, `select public.pricing_learning_require_desk()`, [], /permission denied/)
  await fails(U.admin, `select * from public.pricing_all_points(null)`, [], /permission denied/)
  ok('the four tables and the internal functions are closed to anon and to signed-in users; the public functions are closed to anon')
}

// ── who is the pricing desk ───────────────────────────────────────────────
{
  assert.deepEqual(await rpc(U.admin, 'pricing_learning_access'), { desk: true })
  assert.deepEqual(await rpc(U.editor, 'pricing_learning_access'), { desk: true })
  assert.deepEqual(await rpc(U.sales, 'pricing_learning_access'), { desk: false })
  assert.deepEqual(await rpc(U.manager, 'pricing_learning_access'), { desk: false }, 'see-all without edit is not the desk')
  await fails(U.nobody, `select public.pricing_learning_access()`, [], /QUOTATIONS_FORBIDDEN/)
  for (const who of [U.sales, U.manager]) {
    await fails(who, `select public.pricing_learning_home()`, [], /PRICING_LEARNING_FORBIDDEN/)
    await fails(who, `select public.pricing_learning_save($1::jsonb)`, [JSON.stringify(batch([pi(90)]))], /PRICING_LEARNING_FORBIDDEN/)
    await fails(who, `select public.pricing_feedback_list()`, [], /PRICING_LEARNING_FORBIDDEN/)
  }
  ok('Admin and edit + see-all are the pricing desk; salespeople and see-all-only managers are refused everything but sending feedback; no grant at all is refused')
}

// ── saving a batch ────────────────────────────────────────────────────────
let batchId
{
  const empty = await rpc(U.editor, 'pricing_learning_home')
  assert.deepEqual(empty, { batches: [], totals: { pis: 0, lines: 0 }, open_feedback: 0 })
  const usd = pi(2, { label: 'Dollar client PI.xlsx', left_out: true, left_out_reason: 'The prices are in US dollars', lines: [line('Console', 10, 220)] })
  const saved = await rpc(U.editor, 'pricing_learning_save', batch([pi(1), usd, pi(3, { discount: null })], { client_type: 'property_owner' }))
  assert.equal(saved.batch_no, 1)
  assert.equal(saved.pis_learned, 2)
  assert.equal(saved.pis_left_out, 1)
  assert.equal(saved.lines_learned, 6)
  batchId = saved.id
  const home = await rpc(U.admin, 'pricing_learning_home')
  assert.equal(home.batches.length, 1)
  assert.deepEqual([home.batches[0].avg_miss, home.batches[0].hit_rate, home.batches[0].priced_lines, home.batches[0].unpriced_lines], [24.8, 31, 150, 20])
  assert.deepEqual(home.totals, { pis: 2, lines: 6 })
  ok('a batch saves in one step: two PIs learned, one left out with its reason, 6 lines, and the blind-test score kept')
}
{
  const d = await rpc(U.editor, 'pricing_learning_batch', batchId)
  assert.equal(d.batch.batch_no, 1)
  assert.equal(d.batch.created_by_name, 'Pricing Desk')
  assert.deepEqual(d.pis.map(p => [p.seq, p.label, p.left_out, p.lines]), [[1, 'Client 1 PI.xlsx', false, 3], [2, 'Dollar client PI.xlsx', true, 1], [3, 'Client 3 PI.xlsx', false, 3]])
  assert.equal(d.pis[1].left_out_reason, 'The prices are in US dollars')
  assert.equal(d.pis[2].discount, null)
  await fails(U.editor, `select public.pricing_learning_batch('00000000-0000-0000-0000-00000000dead')`, [], /PRICING_LEARNING_NOT_FOUND/)
  ok('the desk sees each PI with its file name, date, order facts and reason for being left out')
}

// ── duplicates and bad values: nothing is half saved ─────────────────────
{
  const count = async () => (await db.query(`select (select count(*) from public.pricing_learning_batches)::int b, (select count(*) from public.pricing_learning_pis)::int p, (select count(*) from public.pricing_learning_lines)::int l`)).rows[0]
  const before = await count()
  await fails(U.editor, `select public.pricing_learning_save($1::jsonb)`, [JSON.stringify(batch([pi(10), pi(1, { content_print: hex('c', 1) })]))], /PRICING_LEARNING_DUPLICATE/)
  await fails(U.editor, `select public.pricing_learning_save($1::jsonb)`, [JSON.stringify(batch([pi(11, { file_hash: hex('d', 11) }), pi(12, { content_print: hex('b', 1) })]))], /PRICING_LEARNING_DUPLICATE/)
  assert.deepEqual(await count(), before, 'a duplicate leaves nothing behind, not even the PIs before it')
  await fails(U.editor, `select public.pricing_learning_save($1::jsonb)`, [JSON.stringify(batch([pi(13, { lines: [line('Free chair', 4, 0)] })]))], /PRICING_LEARNING_INVALID/)
  await fails(U.editor, `select public.pricing_learning_save($1::jsonb)`, [JSON.stringify(batch([pi(14, { pi_date: '2031-01-01' })]))], /PRICING_LEARNING_INVALID/)
  await fails(U.editor, `select public.pricing_learning_save($1::jsonb)`, [JSON.stringify(batch([pi(15, { lines: [] })]))], /PRICING_LEARNING_INVALID/)
  await fails(U.editor, `select public.pricing_learning_save($1::jsonb)`, [JSON.stringify(batch(Array.from({ length: 26 }, (_, i) => pi(100 + i))))], /PRICING_LEARNING_INVALID.*1 to 25/)
  await fails(U.editor, `select public.pricing_learning_save($1::jsonb)`, [JSON.stringify(batch([pi(16, { file_hash: 'not-a-hash' })]))], /PRICING_LEARNING_INVALID/)
  assert.deepEqual(await count(), before)
  ok('the same file or the same lines twice are refused as duplicates; a zero price, a future date, no lines, 26 PIs and a bad hash are refused; nothing is half saved')
}
{
  const second = await rpc(U.admin, 'pricing_learning_save', batch([pi(20)], { score: { avg_miss: 17.6, hit_rate: 44, priced: 40, unpriced: 2 } }))
  assert.equal(second.batch_no, 2, 'a refused save does not use up a batch number')
  const home = await rpc(U.admin, 'pricing_learning_home')
  assert.deepEqual(home.batches.map(b => b.batch_no), [2, 1], 'newest first')
  ok('batch numbers continue 1, 2 after refused saves, and the home list is newest first')
}

// ── which files were seen before ─────────────────────────────────────────
{
  const known = await rpc(U.editor, 'pricing_learning_known', [hex('a', 1), hex('a', 2), hex('f', 9)], [hex('b', 3), hex('b', 77)])
  const by = Object.fromEntries(known.map(k => [k.file_hash.slice(-1) + k.content_print.slice(-1), k]))
  assert.equal(known.length, 3)
  assert.equal(by['11'].batch_no, 1)
  assert.equal(by['22'].left_out, true)
  assert.equal(by['22'].reason, 'The prices are in US dollars')
  assert.equal(by['33'].left_out, false)
  await fails(U.sales, `select public.pricing_learning_known(array['x'], array['y'])`, [], /PRICING_LEARNING_FORBIDDEN/)
  ok('files already seen are found by file hash or by their lines, with the batch and the reason when they were left out')
}

// ── the learned lines reach the price pool, without a file name ──────────
{
  const pool = await rpc(U.sales, 'pricing_pool', ['bed', 'cot', 'divan'], null)
  const beds = pool.filter(p => /^King bed/.test(p.name))
  assert.equal(beds.length, 4, 'the approved PI plus the three learned PIs that are not left out (PIs 1, 3 and 20)')
  const learned = beds.filter(p => Number(p.p) === 54800)
  assert.equal(learned.length, 3)
  assert.deepEqual(learned[0], { name: 'King bed with headboard', p: 54800, at: learned[0].at, k: 'order', q: 56, dims: '78 x 84 x 42', material: 'Teak wood', finish: 'PU finish', client_type: null })
  assert.ok(learned[0].at.startsWith('2025-02-12'), 'dated by the PI, not by the day it was learned')
  assert.ok(!pool.some(p => p.name === 'Console'), 'a left-out PI never reaches the pool')
  const keys = new Set(pool.flatMap(p => Object.keys(p)))
  assert.deepEqual([...keys].sort(), ['at', 'client_type', 'dims', 'finish', 'k', 'material', 'name', 'p', 'q'], 'prices, sizes and materials only: no label, no client')
  assert.ok(!JSON.stringify(pool).includes('Client 1'), 'no file name anywhere in the pool')
  ok('every quotation maker\'s price pool includes the learned lines as PI prices, dated by the PI, and never a file name or a left-out PI')
}
{
  const hints = await rpc(U.sales, 'quotation_price_hints', ['King bed with headboard'], null)
  assert.ok(hints[0].points.filter(p => Number(p.p) === 54800).length >= 3, 'the v1 history points carry the learned lines too')
  await db.query(`insert into public.pricing_learning_batches (batch_no) values (99)`)
  const b99 = (await db.query(`select id from public.pricing_learning_batches where batch_no = 99`)).rows[0].id
  await db.query(`insert into public.pricing_learning_pis (batch_id, seq, file_hash, content_print, pi_date) values ('${b99}', 1, '${hex('e', 1)}', '${hex('e', 2)}', '2026-06-01')`)
  const p99 = (await db.query(`select id from public.pricing_learning_pis where batch_id = '${b99}'`)).rows[0].id
  await db.query(`insert into public.pricing_learning_lines (pi_id, line_no, name, qty, unit_price) select '${p99}', g, 'Chair type ' || g || ' stool', 2, 1000 + g from generate_series(1, 2600) g`)
  const big = await rpc(U.sales, 'pricing_pool', ['stool'], null)
  assert.equal(big.length, 2500, 'the pool is capped at the 2,500 newest points')
  await db.query(`delete from public.pricing_learning_batches where id = '${b99}'`)
  assert.equal((await db.query(`select count(*)::int n from public.pricing_learning_lines where pi_id = '${p99}'`)).rows[0].n, 0, 'deleting a batch deletes its PIs and lines')
  ok('the v1 history points include the learned lines; the pool cap is 2,500 (was 800); deleting a batch cascades')
}

// ── feedback and corrections ──────────────────────────────────────────────
let fbId
{
  const qid = await rpc(U.sales, 'quotation_create', { client_name: 'Feedback Hotel' })
  const sug = { price: 59700, low: 54600, high: 65400, confidence: 'medium', reasons: ['+18% Teak instead of Mango'], basis: 'the price model for Bed (92 prices)' }
  const mk = (over = {}) => ({ source: 'quotation', kind: 'too_high', comment: 'Teak beds sold at 56,000 last month', expected_price: 56000, line: { name: 'King bed with headboard', size: '78 x 84', material: 'Teak', finish: 'PU', qty: 56 }, client_type: 'property_owner', suggestion: sug, quotation_id: qid, ...over })
  fbId = await rpc(U.sales, 'pricing_feedback_add', mk())
  assert.ok(fbId)
  const other = await rpc(U.sales2, 'pricing_feedback_add', mk({ kind: 'correction', comment: 'Teak should be +25%', expected_price: null }))
  const list = await rpc(U.editor, 'pricing_feedback_list')
  assert.deepEqual(list.map(f => [f.kind, f.from_name, f.status]), [['correction', 'Prerna Purohit', 'new'], ['too_high', 'Mohit Sharma', 'new']])
  const mine = list.find(f => f.id === fbId)
  assert.equal(mine.quote_no.startsWith('QT-'), true, 'the quotation it came from is named')
  assert.deepEqual([mine.line_name, mine.expected_price, mine.suggestion.price, mine.suggestion.reasons[0]], ['King bed with headboard', 56000, 59700, '+18% Teak instead of Mango'])
  assert.equal(list.find(f => f.id === other).quote_no, null, 'a quotation the sender cannot see is not linked')
  assert.equal((await rpc(U.admin, 'pricing_learning_home')).open_feedback, 2)
  ok('anyone who may open Quotations can send feedback or a correction with the suggestion it is about; the desk reads it with the sender and the quotation')
}
{
  await rpc(U.editor, 'pricing_feedback_set', fbId, 'seen', null)
  await rpc(U.admin, 'pricing_feedback_set', fbId, 'done', 'Pinned in the logic from 20 Nov')
  const open = await rpc(U.editor, 'pricing_feedback_list', true)
  assert.equal(open.length, 1, 'a handled one leaves the open list')
  const all = await rpc(U.editor, 'pricing_feedback_list', false)
  const done = all.find(f => f.id === fbId)
  assert.deepEqual([done.status, done.handled_note], ['done', 'Pinned in the logic from 20 Nov'])
  await fails(U.sales, `select public.pricing_feedback_set($1::uuid, 'done', null)`, [fbId], /PRICING_LEARNING_FORBIDDEN/)
  await fails(U.editor, `select public.pricing_feedback_set($1::uuid, 'maybe', null)`, [fbId], /PRICING_FEEDBACK_INVALID/)
  await fails(U.editor, `select public.pricing_feedback_set('00000000-0000-0000-0000-00000000dead', 'done', null)`, [], /PRICING_LEARNING_NOT_FOUND/)
  ok('the desk marks feedback seen, done or declined with a note; only the desk may; an unknown status or id is refused')
}
{
  const f = (over = {}) => ({ source: 'learning', kind: 'other', comment: 'x', ...over })
  await fails(U.sales, `select public.pricing_feedback_add($1::jsonb)`, [JSON.stringify(f({ kind: 'rude' }))], /PRICING_FEEDBACK_INVALID/)
  await fails(U.sales, `select public.pricing_feedback_add($1::jsonb)`, [JSON.stringify(f({ source: 'email' }))], /PRICING_FEEDBACK_INVALID/)
  await fails(U.sales, `select public.pricing_feedback_add($1::jsonb)`, [JSON.stringify(f({ comment: 'y'.repeat(1001) }))], /PRICING_FEEDBACK_INVALID/)
  await fails(U.sales, `select public.pricing_feedback_add($1::jsonb)`, [JSON.stringify(f({ expected_price: -5 }))], /PRICING_FEEDBACK_INVALID/)
  await fails(U.nobody, `select public.pricing_feedback_add($1::jsonb)`, [JSON.stringify(f())], /QUOTATIONS_FORBIDDEN/)
  for (let i = 0; i < 57; i++) await rpc(U.manager, 'pricing_feedback_add', f({ comment: `note ${i}` }))
  await rpc(U.manager, 'pricing_feedback_add', f({ comment: 'the 58th' }))
  await rpc(U.manager, 'pricing_feedback_add', f({ comment: 'the 59th' }))
  await rpc(U.manager, 'pricing_feedback_add', f({ comment: 'the 60th' }))
  await fails(U.manager, `select public.pricing_feedback_add($1::jsonb)`, [JSON.stringify(f({ comment: 'the 61st' }))], /PRICING_FEEDBACK_LIMIT/)
  ok('a bad kind, source, comment length or price is refused, no grant is refused, and one person is limited to 60 notes a day')
}

console.log(`all ${checks} checks passed`)
