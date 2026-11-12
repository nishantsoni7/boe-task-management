// Database regression suite for 20270616000000 (order_line_flags: Operations flags PI lines before
// an Order is aligned).
//
// Applies the REAL migration file on an in-memory Postgres (PGlite). Stubbed, and said so: auth.uid(),
// assert_order_submission_actor(), can_read_order_detail() (hides the Orders listed in zz_hidden), the
// tables (only the columns the functions use) and decide_order_operations_handoff(). The stand-in decision
// refuses anyone but the assigned reviewer, can be told to refuse an acceptance the way the 40% rule does
// (test.refuse = 'advance'), records every call in zz_decisions and moves the handoff's status. So this
// proves what flag_order_lines() itself does: what it validates, the decision and reason it hands over, that
// a refused decision leaves nothing behind, and what it stores and lets people read. The REAL decision
// function is exercised by the rolled-back rehearsal against the linked database, not here.
//
// NOT part of npm test (PGlite is not an app dependency). Run:
//   node supabase/tests/order_line_flags_pglite.mjs <dir with @electric-sql/pglite installed>
// Expected last line: "all 13 checks passed".
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import assert from 'node:assert/strict'

const PGLITE_DIR = process.argv[2]
if (!PGLITE_DIR) { console.error('usage: node order_line_flags_pglite.mjs <dir with @electric-sql/pglite installed>'); process.exit(2) }
const require = createRequire(resolve(PGLITE_DIR) + '/')
const { PGlite } = require('@electric-sql/pglite')
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const MIGRATION = readFileSync(`${REPO}/supabase/migrations/20270616000000_order_line_flags.sql`, 'utf8').replace(/\r/g, '')

const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`
const REVIEWER = id(0xc1), SALES = id(0xa1), STRANGER = id(0xb1)
const O = n => id(0x100 + n), S = n => id(0x200 + n), V = n => id(0x300 + n), H = n => id(0x400 + n)
const I = n => id(0x500 + n)   // PI lines

const db = new PGlite()
let checks = 0
const check = async (name, fn) => { await fn(); checks += 1; console.log('ok -', name) }
const as = uid => db.exec(`select set_config('test.uid', '${uid ?? ''}', false)`)
const flag = (handoff, lines) => db.query(`select public.flag_order_lines($1::uuid, $2::jsonb) as r`, [handoff, JSON.stringify(lines)])
const refused = async (promise, pattern) => {
  let err = null
  try { await promise } catch (e) { err = e }
  assert.ok(err, 'the call was refused')
  assert.match(String(err.message), pattern)
}
const count = async (sql) => (await db.query(sql)).rows[0].n
const flagsOf = async handoff => count(`select count(*)::int as n from public.order_line_flags where handoff_id = '${handoff}'`)
const decisions = async () => count(`select count(*)::int as n from public.zz_decisions`)
const readFor = async order => (await db.query(`select public.order_line_flags_for('${order}') as r`)).rows[0].r

await db.exec(`
  create schema if not exists auth;
  create role anon nologin;
  create role authenticated nologin;
  create function auth.uid() returns uuid language sql stable
    as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
  create function public.assert_order_submission_actor() returns uuid language plpgsql stable as $$
    begin
      if auth.uid() is null then raise exception 'You must be signed in' using errcode = '42501'; end if;
      return auth.uid();
    end $$;

  create table public.users (id uuid primary key, full_name text);
  create table public.orders (id uuid primary key, display_number text);
  create table public.order_submissions (id uuid primary key);
  create table public.order_submission_items (id uuid primary key, submission_id uuid references public.order_submissions(id), product_name text);
  create table public.order_pi_versions (id uuid primary key);
  create table public.order_operations_handoffs (id uuid primary key, order_id uuid references public.orders(id),
    pi_version_id uuid, submission_id uuid, version_number int, status text, assigned_to uuid, superseded_at timestamptz);
  create table public.order_product_codes (order_id uuid, submission_item_id uuid, boe_sequence int);
  create table public.zz_hidden (order_id uuid);
  create table public.zz_decisions (handoff uuid, decision text, reason text, actor uuid);

  create function public.can_read_order_detail(uuid) returns boolean language sql stable
    as $$ select not exists (select 1 from public.zz_hidden h where h.order_id = $1) $$;

  -- The stand-in for the real decision (see the header).
  create function public.decide_order_operations_handoff(p_handoff_id uuid, p_decision text, p_reason text default null)
  returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
  declare h record;
  begin
    select * into h from public.order_operations_handoffs where id = p_handoff_id for update;
    if h.assigned_to is distinct from auth.uid() then
      raise exception 'Only the assigned operations reviewer can decide this handoff' using errcode = '42501';
    end if;
    if p_decision = 'accepted' and current_setting('test.refuse', true) = 'advance' then
      raise exception 'ORDER_ADVANCE_BELOW_THRESHOLD: stand-in refusal' using errcode = 'P0001';
    end if;
    if h.status = p_decision then
      raise exception 'ORDER_OPERATIONS_HANDOFF_ALREADY_%', upper(p_decision) using errcode = 'P0001';
    end if;
    if p_reason is not null and char_length(p_reason) > 1000 then
      raise exception 'ORDER_OPERATIONS_HANDOFF_REASON_TOO_LONG' using errcode = 'P0001';
    end if;
    insert into public.zz_decisions values (p_handoff_id, p_decision, p_reason, auth.uid());
    update public.order_operations_handoffs set status = p_decision where id = p_handoff_id;
    return jsonb_build_object('handoff_id', p_handoff_id, 'status', p_decision);
  end $$;

  insert into public.users values ('${REVIEWER}', 'Operations Reviewer'), ('${SALES}', 'Sales Person'), ('${STRANGER}', 'Someone Else');
  insert into public.orders values ('${O(1)}', '0700'), ('${O(2)}', '0701'), ('${O(3)}', '0702'), ('${O(4)}', '0703');
  insert into public.order_submissions values ('${S(1)}'), ('${S(2)}'), ('${S(3)}'), ('${S(4)}');
  insert into public.order_pi_versions values ('${V(1)}'), ('${V(2)}'), ('${V(3)}'), ('${V(4)}');
  insert into public.order_submission_items values
    ('${I(1)}', '${S(1)}', 'Lounge Sofa, 2-seater'), ('${I(2)}', '${S(1)}', 'Dining Chair'),
    ('${I(3)}', '${S(1)}', 'Outdoor Frame'), ('${I(5)}', '${S(1)}', 'Bench, 3-seater'),
    ('${I(21)}', '${S(2)}', 'Side Table'), ('${I(31)}', '${S(3)}', E'Lamp\\n  with   shade');
  insert into public.order_product_codes values
    ('${O(1)}', '${I(1)}', 1), ('${O(1)}', '${I(2)}', 2), ('${O(1)}', '${I(3)}', 3), ('${O(1)}', '${I(5)}', 5),
    ('${O(2)}', '${I(21)}', 1);
  insert into public.order_operations_handoffs values
    ('${H(1)}', '${O(1)}', '${V(1)}', '${S(1)}', 1, 'awaiting', '${REVIEWER}', null),
    ('${H(2)}', '${O(2)}', '${V(2)}', '${S(2)}', 1, 'awaiting', '${REVIEWER}', null),
    ('${H(3)}', '${O(3)}', '${V(3)}', '${S(3)}', 1, 'awaiting', '${REVIEWER}', null),
    ('${H(4)}', '${O(4)}', '${V(4)}', '${S(4)}', 1, 'awaiting', null, null);
`)

// The REAL migration, executed.
await db.exec(MIGRATION)

const chair = { item_id: I(2), kind: 'cannot_make', reasons: ['quantity_low', 'price_low'],
  note: 'No outside vendor will make 8 pieces, so it has to be made in-house.', suggested_price: 7000 }
const frame = { item_id: I(3), kind: 'cannot_make', reasons: ['size'], note: 'Too big: about 10 ft x 6.5 ft in metal.' }
const bench = { item_id: I(5), kind: 'comment', reasons: ['complicated_design'], note: 'We can make it; lead time may be longer.', suggested_price: null }

await check('the migration applies; signed-in people may call the two doors, anon may not; nobody reads the table or the helper directly', async () => {
  const q = await db.query(`select
      has_function_privilege('anon', 'public.flag_order_lines(uuid, jsonb)', 'execute') as fa,
      has_function_privilege('authenticated', 'public.flag_order_lines(uuid, jsonb)', 'execute') as fs,
      has_function_privilege('anon', 'public.order_line_flags_for(uuid)', 'execute') as ra,
      has_function_privilege('authenticated', 'public.order_line_flags_for(uuid)', 'execute') as rs,
      has_function_privilege('authenticated', 'public.order_line_flags_reason(text[], text[])', 'execute') as helper,
      has_table_privilege('authenticated', 'public.order_line_flags', 'select') as tbl,
      (select relrowsecurity from pg_class where relname = 'order_line_flags') as rls`)
  assert.deepEqual(q.rows[0], { fa: false, fs: true, ra: false, rs: true, helper: false, tbl: false, rls: true })
})

await check('anyone but the assigned reviewer is refused, and nothing is stored or decided', async () => {
  await as(SALES)
  await refused(flag(H(1), [chair]), /Only the assigned operations reviewer/)
  await as(null)
  await refused(flag(H(1), [chair]), /signed in/)
  await as(REVIEWER)
  await refused(flag(H(4), [chair]), /ORDER_OPERATIONS_HANDOFF_UNASSIGNED/)
  assert.equal(await flagsOf(H(1)), 0)
  assert.equal(await decisions(), 0)
})

await check('every malformed list is refused with its own marker, and nothing is stored or decided', async () => {
  await as(REVIEWER)
  await refused(flag(H(1), []), /ORDER_LINE_FLAGS_NONE/)
  await refused(flag(H(1), [{ ...chair, item_id: I(21) }]), /ORDER_LINE_FLAGS_UNKNOWN_LINE/)          // a line of another PI
  await refused(flag(H(1), [chair, { ...chair }]), /flagged twice/)
  await refused(flag(H(1), [{ ...chair, item_id: 'not-a-uuid' }]), /no valid item_id/)
  await refused(flag(H(1), [{ ...chair, kind: 'maybe' }]), /ORDER_LINE_FLAGS_KIND_UNKNOWN/)
  await refused(flag(H(1), [{ ...chair, reasons: [] }]), /ORDER_LINE_FLAGS_REASON_REQUIRED/)
  await refused(flag(H(1), [{ ...chair, reasons: undefined }]), /ORDER_LINE_FLAGS_REASON_REQUIRED/)
  await refused(flag(H(1), [{ ...chair, reasons: ['cheap'] }]), /unknown reason/)
  await refused(flag(H(1), [{ ...chair, note: '   ' }]), /ORDER_LINE_FLAGS_NOTE_REQUIRED/)
  await refused(flag(H(1), [{ ...chair, note: 'x'.repeat(1001) }]), /ORDER_LINE_FLAGS_NOTE_TOO_LONG/)
  await refused(flag(H(1), [{ ...chair, suggested_price: -5 }]), /ORDER_LINE_FLAGS_PRICE_INVALID/)
  await refused(flag(H(1), [{ ...chair, suggested_price: '7000' }]), /ORDER_LINE_FLAGS_PRICE_INVALID/)
  assert.equal(await flagsOf(H(1)), 0)
  assert.equal(await decisions(), 0)
})

await check('one Cannot make among the lines flags the version (clarification_needed) with a readable reason', async () => {
  await as(REVIEWER)
  const r = (await flag(H(1), [chair, frame, bench])).rows[0].r
  assert.equal(r.status, 'clarification_needed')
  assert.equal(r.cannot_make, 2)
  assert.equal(r.comments, 1)
  const d = (await db.query(`select * from public.zz_decisions`)).rows
  assert.equal(d.length, 1)
  assert.equal(d[0].decision, 'clarification_needed')
  assert.equal(d[0].actor, REVIEWER)
  assert.equal(d[0].reason,
    '2 lines cannot be made as quoted: 700-BE0002 Dining Chair (price too low, quantity too low, should be ₹7000); '
    + '700-BE0003 Outdoor Frame (size or dimension). 1 comment: 700-BE0005 Bench, 3-seater (complicated design). '
    + "The notes are on the Order's product lines.")
})

await check('the flags are stored as sent: codes, kinds, reasons, note, price, who', async () => {
  const rows = (await db.query(`select item_id, line_code, line_title, kind, reasons, note, suggested_price::text as price, flagged_by
                                  from public.order_line_flags where handoff_id = '${H(1)}' order by line_code`)).rows
  assert.equal(rows.length, 3)
  assert.deepEqual(rows.map(r => [r.line_code, r.kind]), [['700-BE0002', 'cannot_make'], ['700-BE0003', 'cannot_make'], ['700-BE0005', 'comment']])
  assert.deepEqual(rows[0].reasons.sort(), ['price_low', 'quantity_low'])
  assert.equal(rows[0].price, '7000.00')
  assert.equal(rows[1].price, null)
  assert.equal(rows[0].line_title, 'Dining Chair')
  assert.ok(rows.every(r => r.flagged_by === REVIEWER))
})

await check('comments only accept the version (accepted, the Order aligns) and say "Accepted with"', async () => {
  await as(REVIEWER)
  const r = (await flag(H(2), [{ item_id: I(21), kind: 'comment', reasons: ['other'], note: 'Height looks low for a side table.' }])).rows[0].r
  assert.equal(r.status, 'accepted')
  const d = (await db.query(`select reason from public.zz_decisions where handoff = '${H(2)}'`)).rows[0]
  assert.equal(d.reason, "Accepted with 1 comment: 701-BE0001 Side Table (other). The notes are on the Order's product lines.")
})

await check('a line with no product code is named by its product only, on one line even when the name has line breaks', async () => {
  await as(REVIEWER)
  await db.exec(`select set_config('test.refuse', '', false)`)
  await flag(H(3), [{ item_id: I(31), kind: 'cannot_make', reasons: ['material'], note: 'No brass in stock.' }])
  const d = (await db.query(`select reason from public.zz_decisions where handoff = '${H(3)}'`)).rows[0]
  assert.match(d.reason, /^1 line cannot be made as quoted: Lamp with shade \(material or finish\)\./)
})

await check('when the decision is refused (the 40% rule on an acceptance), nothing is stored and earlier flags stay', async () => {
  await db.exec(`update public.order_operations_handoffs set status = 'awaiting' where id = '${H(1)}'`)
  await db.exec(`select set_config('test.refuse', 'advance', false)`)
  await as(REVIEWER)
  const before = await decisions()
  await refused(flag(H(1), [bench]), /ORDER_ADVANCE_BELOW_THRESHOLD/)
  await db.exec(`select set_config('test.refuse', '', false)`)
  assert.equal(await flagsOf(H(1)), 3, 'the three earlier flags are untouched')
  assert.equal(await decisions(), before)
})

await check('flagging again after Sales answered replaces the earlier flags of that review', async () => {
  await as(REVIEWER)
  await flag(H(1), [{ ...frame, note: 'Still too big after the answer.' }])
  const rows = (await db.query(`select line_code, note from public.order_line_flags where handoff_id = '${H(1)}'`)).rows
  assert.deepEqual(rows, [{ line_code: '700-BE0003', note: 'Still too big after the answer.' }])
})

await check('a long list always fits the 1000-character limit and counts the lines it could not name', async () => {
  const entries = Array.from({ length: 40 }, (_, n) => `700-BE${String(n + 1).padStart(4, '0')} A product with a fairly long name (price too low, quantity too low)`)
  const text = (await db.query(`select public.order_line_flags_reason($1::text[], $2::text[]) as t`, [entries.slice(0, 30), entries.slice(30)])).rows[0].t
  assert.ok(text.length <= 1000, `length ${text.length}`)
  assert.match(text, /^30 lines cannot be made as quoted: 700-BE0001 /)
  assert.match(text, / And \d+ more lines\. The notes are on the Order's product lines\.$/)
  const named = (text.match(/700-BE\d{4}/g) ?? []).length
  const more = Number(text.match(/And (\d+) more lines/)[1])
  assert.equal(named + more, 40, 'every line is either named or counted')
  assert.equal((await db.query(`select public.order_line_flags_reason('{}'::text[], '{}'::text[]) as t`)).rows[0].t, null)
})

await check('readers of the Order see the live flags with the review status; others, and nobody signed in, see []', async () => {
  await as(SALES)
  const rows = await readFor(O(1))
  assert.equal(rows.length, 1)
  assert.equal(rows[0].line_code, '700-BE0003')
  assert.equal(rows[0].kind, 'cannot_make')
  assert.equal(rows[0].handoff_status, 'clarification_needed')
  assert.equal(rows[0].by_name, 'Operations Reviewer')
  assert.equal(rows[0].version_number, 1)
  await db.exec(`insert into public.zz_hidden values ('${O(1)}')`)
  assert.deepEqual(await readFor(O(1)), [])
  await db.exec(`delete from public.zz_hidden`)
  await as(null)
  assert.deepEqual(await readFor(O(1)), [])
})

await check('a revised PI (the review is superseded) takes the flags off the Order page and keeps them on record', async () => {
  await db.exec(`update public.order_operations_handoffs set superseded_at = now() where id = '${H(1)}'`)
  await as(SALES)
  assert.deepEqual(await readFor(O(1)), [])
  assert.equal(await flagsOf(H(1)), 1)
})

await check('rolling it back drops the three functions and the table and leaves everything else', async () => {
  await db.exec(`drop function public.order_line_flags_for(uuid);
                 drop function public.flag_order_lines(uuid, jsonb);
                 drop function public.order_line_flags_reason(text[], text[]);
                 drop table public.order_line_flags;`)
  assert.equal(await count(`select count(*)::int as n from pg_proc where proname like '%line_flags%'`), 0)
  assert.equal(await count(`select count(*)::int as n from public.order_operations_handoffs`), 4)
})

console.log(`all ${checks} checks passed`)
