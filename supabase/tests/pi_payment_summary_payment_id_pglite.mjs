// Database regression suite for 20270505000000 (the PI payments popup names
// each payment by its Payment ID).
//
// Applies the REAL migration on an in-memory Postgres (PGlite), and the REAL
// 20270227000000 definition before it (extracted, never retyped), so the two
// answers can be compared on the same rows. Stubbed, and said so: auth.uid(),
// can_view_order_submission (yes), actor_has_module_permission (no), the
// advance helpers (fixed answers), and the tables (only the columns the
// function reads).
//
// NOT part of npm test (PGlite is not an app dependency). Run:
//   node supabase/tests/pi_payment_summary_payment_id_pglite.mjs <dir with @electric-sql/pglite installed>
// Expected last line: "all 6 checks passed".
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import assert from 'node:assert/strict'

const PGLITE_DIR = process.argv[2]
if (!PGLITE_DIR) { console.error('usage: node pi_payment_summary_payment_id_pglite.mjs <dir with @electric-sql/pglite installed>'); process.exit(2) }
const require = createRequire(resolve(PGLITE_DIR) + '/')
const { PGlite } = require('@electric-sql/pglite')
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const mig = f => readFileSync(`${REPO}/supabase/migrations/${f}`, 'utf8').replace(/\r/g, '')

function extractSummary(text) {
  const start = text.indexOf('CREATE OR REPLACE FUNCTION public.pi_submission_payment_summary(p_submission_id uuid)')
  const end = text.indexOf('\n$function$;\n', start)
  if (start < 0 || end < 0) throw new Error('cannot extract pi_submission_payment_summary')
  return text.slice(start, end + '\n$function$;\n'.length)
}

const ADMIN = '00000000-0000-0000-0000-00000000000a'
const SUB = '00000000-0000-0000-0000-000000000051'

const db = new PGlite()
let checks = 0
const check = async (name, fn) => { await fn(); checks += 1; console.log('ok -', name) }

await db.exec(`
  create schema auth;
  create function auth.uid() returns uuid language sql stable
    as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;

  create table public.users (id uuid primary key, full_name text, role text,
    is_active boolean default true, is_deleted boolean default false);
  create table public.order_submissions (id uuid primary key, status text,
    grand_total numeric, total_before_gst numeric, advance_condition text,
    advance_exception_status text, advance_exception_decided_grand_total numeric,
    advance_exception_decided_workbook_sha256 text, advance_exception_decided_payment_terms text,
    advance_exception_decided_billing_terms text, advance_exception_reason text,
    advance_exception_rejection_reason text, source_workbook_sha256 text,
    payment_terms text, billing_terms text, pi_approved_at timestamptz, pi_approved_by uuid,
    pi_approved_submission_at timestamptz, submitted_at timestamptz);
  create table public.finance_payment_requests (id uuid primary key, request_number text,
    human_payment_id text, amount numeric, payment_date date, payment_mode text,
    proof_note text, sales_note text, status text, admin_note text, submitted_by uuid,
    approved_by uuid, created_at timestamptz, approved_at timestamptz, rejected_at timestamptz);
  create table public.finance_payment_allocations (id uuid primary key, order_submission_id uuid,
    payment_request_id uuid, allocated_amount numeric, status text);
  create table public.payment_proof_attachments (id uuid primary key, payment_request_id uuid);

  create function public.can_view_order_submission(uuid) returns boolean language sql as $$ select true $$;
  create function public.actor_has_module_permission(text, text) returns boolean language sql as $$ select false $$;
  create function public.finance_payment_status_is_verified(text) returns boolean language sql
    as $$ select $1 in ('approved_unlinked', 'approved_linked') $$;
  create function public.order_submission_required_payment(numeric) returns numeric language sql
    as $$ select round($1 * 0.4, 2) $$;
  create function public.order_submission_payment_shortfall(numeric, numeric) returns numeric language sql
    as $$ select case when $1 is null then null else greatest(round($1 * 0.4, 2) - $2, 0) end $$;
  create function public.order_submission_exception_current(text, numeric, numeric, text, text, text, text, text, text)
    returns boolean language sql as $$ select false $$;
  create function public.order_submission_pi_approved(timestamptz, timestamptz, timestamptz)
    returns boolean language sql as $$ select false $$;
  create function public.order_submission_standard_advance_percent() returns numeric language sql
    as $$ select 40::numeric $$;

  insert into public.users values
    ('${ADMIN}', 'Admin One', 'admin', true, false),
    ('00000000-0000-0000-0000-00000000000b', 'Prerna Purohit', 'sales', true, false);
  insert into public.order_submissions (id, status, grand_total, total_before_gst, submitted_at)
    values ('${SUB}', 'submitted', 895254.20, 758690, '2026-10-29T11:02:00Z');
  insert into public.finance_payment_requests values
    ('00000000-0000-0000-0000-0000000000f1', 'PAY-REQ-2026-0084', 'P-AA-0084', 100000, '2026-10-24', 'hdfc',
     'UTR1', null, 'approved_unlinked', null, '00000000-0000-0000-0000-00000000000b', '${ADMIN}',
     '2026-10-24T05:00:00Z', '2026-10-25T05:00:00Z', null),
    ('00000000-0000-0000-0000-0000000000f2', 'PAY-REQ-2026-0090', 'P-AA-0090', 25000, '2026-10-26', 'cash',
     null, 'part payment', 'pending_approval', null, '00000000-0000-0000-0000-00000000000b', null,
     '2026-10-26T05:00:00Z', null, null),
    ('00000000-0000-0000-0000-0000000000f3', 'PAY-REQ-2026-0091', 'P-AA-0091', 5000, '2026-10-27', 'hdfc',
     null, null, 'rejected', 'Duplicate', '00000000-0000-0000-0000-00000000000b', null,
     '2026-10-27T05:00:00Z', null, '2026-10-28T05:00:00Z');
  insert into public.finance_payment_allocations values
    ('00000000-0000-0000-0000-0000000000a1', '${SUB}', '00000000-0000-0000-0000-0000000000f1', 100000, 'active'),
    ('00000000-0000-0000-0000-0000000000a2', '${SUB}', '00000000-0000-0000-0000-0000000000f2', 25000, 'active'),
    ('00000000-0000-0000-0000-0000000000a3', '${SUB}', '00000000-0000-0000-0000-0000000000f3', 5000, 'reversed');
  insert into public.payment_proof_attachments values
    ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000f1');
`)

const summary = async () => {
  await db.query(`select set_config('test.uid', $1, false)`, [ADMIN])
  const { rows } = await db.query('select public.pi_submission_payment_summary($1) as s', [SUB])
  return rows[0].s
}

// The answer the popup got before: the REAL 20270227000000 definition.
await db.exec(extractSummary(mig('20270227000000_order_submission_advance_on_total_before_gst.sql')))
const before = await summary()

// The whole new migration file, as it will be applied.
await db.exec(mig('20270505000000_pi_payment_summary_payment_id.sql'))
const after = await summary()

await check('the migration applies, and the old answer had no Payment ID', async () => {
  assert.equal(before.payments.length, 3)
  for (const p of before.payments) assert.ok(!('human_payment_id' in p))
})

await check('every payment row carries its own Payment ID', async () => {
  const byId = Object.fromEntries(after.payments.map(p => [p.payment_id, p.human_payment_id]))
  assert.deepEqual(byId, {
    '00000000-0000-0000-0000-0000000000f1': 'P-AA-0084',
    '00000000-0000-0000-0000-0000000000f2': 'P-AA-0090',
    '00000000-0000-0000-0000-0000000000f3': 'P-AA-0091',
  })
})

await check('the request number is still sent, for a page built before this migration', async () => {
  assert.deepEqual(after.payments.map(p => p.request_number).sort(),
    ['PAY-REQ-2026-0084', 'PAY-REQ-2026-0090', 'PAY-REQ-2026-0091'])
})

await check('take the new key away and the answer is exactly the old one', async () => {
  const stripped = { ...after, payments: after.payments.map(({ human_payment_id: _id, ...rest }) => rest) }
  assert.deepEqual(stripped, before)
})

await check('the totals are untouched: 1,00,000 verified, 25,000 awaiting, the reversed one in neither', async () => {
  assert.equal(Number(after.verified_amount), 100000)
  assert.equal(Number(after.unverified_amount), 25000)
})

await check('nobody signed in is still refused', async () => {
  await db.query(`select set_config('test.uid', '', false)`)
  await assert.rejects(db.query('select public.pi_submission_payment_summary($1)', [SUB]), /Authentication required/)
})

console.log(`all ${checks} checks passed`)
