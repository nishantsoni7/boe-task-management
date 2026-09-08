/**
 * THE FOUR FIELDS A CONFIRMED ORDER CANNOT BE BUILT WITHOUT.
 *
 * Two halves, tested together because they must agree:
 *
 *   the rule      validateOrderConfirmation, which the dialog runs so the
 *                 person filling it in is told which field is missing
 *   the authority approve_order_submission (20261201000000), which re-derives
 *                 all four before any conversion-side state change or Order
 *                 creation — read here from the migration's own text
 *
 * Reads repository files only. No database, no network.
 *
 * Run:
 *   npx tsx --test src/lib/orders/orderConfirmation.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ORDER_CONFIRMATION_MESSAGE,
  ORDER_LEAD_SOURCES,
  SALESPERSON_LABEL,
  CLIENT_UPDATE_REQUIRED_MESSAGE,
  describeConfirmationFailure,
  isOrderLeadSource,
  leadSourceLabel,
  validateOrderConfirmation,
  type OrderConfirmationDraft,
} from './orderConfirmation'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

const MIGRATION = 'supabase/migrations/20261201000000_order_submission_confirmation_required_fields.sql'
const MODAL = 'src/components/orders/piReviewModals.tsx'
const PI_PAGE = 'src/app/orders/drafts/[submissionId]/page.tsx'
const ORDER_PAGE = 'src/app/orders/[id]/page.tsx'

const complete: OrderConfirmationDraft = {
  salesperson: '11111111-1111-4111-8111-111111111111',
  confirmDate: '2026-09-08',
  dueDate: '2026-10-30',
  leadSource: 'reference',
}

// ══ 1. The rule ═══════════════════════════════════════════════════════════════

describe('the four fields are each required, and each says so in its own words', () => {
  test('a complete draft passes, and hands back exactly what was chosen', () => {
    const check = validateOrderConfirmation(complete)
    assert.equal(check.ok, true)
    if (check.ok) assert.deepEqual(check.values, {
      salesperson: complete.salesperson,
      confirmDate: '2026-09-08',
      dueDate: '2026-10-30',
      leadSource: 'reference',
    })
  })

  test('each missing field is named, and the sentence tells the reader what to do', () => {
    const cases: [Partial<OrderConfirmationDraft>, string][] = [
      [{ salesperson: null }, 'salesperson'],
      [{ confirmDate: null }, 'confirm_date'],
      [{ dueDate: null }, 'due_date'],
      [{ leadSource: null }, 'lead_source'],
    ]
    for (const [patch, field] of cases) {
      const check = validateOrderConfirmation({ ...complete, ...patch })
      assert.equal(check.ok, false, field)
      if (!check.ok) {
        assert.equal(check.field, field)
        assert.equal(check.message, ORDER_CONFIRMATION_MESSAGE[check.field])
        assert.match(check.message, /before confirming this Order\.$/)
        // NEVER a generic sentence: every one names its own field.
        assert.ok(!/required fields|complete the form/i.test(check.message))
      }
    }
  })

  test('blank and whitespace are as missing as null', () => {
    for (const value of ['', '   ']) {
      assert.equal(validateOrderConfirmation({ ...complete, salesperson: value }).ok, false, value)
      assert.equal(validateOrderConfirmation({ ...complete, leadSource: value }).ok, false, value)
    }
  })

  test('a date must be a real calendar day, not merely date-shaped', () => {
    for (const bad of ['2026-02-30', '2026-13-01', '08-09-2026', '2026-9-8', 'soon']) {
      assert.equal(validateOrderConfirmation({ ...complete, confirmDate: bad }).ok, false, bad)
      assert.equal(validateOrderConfirmation({ ...complete, dueDate: bad }).ok, false, bad)
    }
    assert.equal(validateOrderConfirmation({ ...complete, dueDate: '2028-02-29' }).ok, true, 'a leap day is a day')
  })

  test('the fields are checked in the order they are asked for, so one is named at a time', () => {
    const empty = validateOrderConfirmation({ salesperson: null, confirmDate: null, dueDate: null, leadSource: null })
    assert.equal(empty.ok, false)
    if (!empty.ok) assert.equal(empty.field, 'salesperson')
  })
})

describe('lead source reuses the five values the Orders table has always accepted', () => {
  test('the list is exactly the CHECK constraint\'s', () => {
    assert.deepEqual(ORDER_LEAD_SOURCES.map(s => s.value),
      ['reference', 'repeat_customer', 'whatsapp', 'instagram', 'website'])
    // The same five, in the table that has carried them since 20260655.
    const table = read('supabase/migrations/20260655_create_orders.sql')
    assert.match(table, /lead_source[\s\S]{0,200}'reference', 'repeat_customer', 'whatsapp', 'instagram', 'website'/)
  })

  test('nothing outside the five is accepted', () => {
    assert.equal(isOrderLeadSource('exhibition'), false)
    assert.equal(validateOrderConfirmation({ ...complete, leadSource: 'exhibition' }).ok, false)
  })

  test('a stored value BOE no longer offers still reads as itself, never as a blank', () => {
    assert.equal(leadSourceLabel('reference'), 'Reference')
    assert.equal(leadSourceLabel('trade_show'), 'trade_show')
    assert.equal(leadSourceLabel(null), null)
    assert.equal(leadSourceLabel('  '), null)
  })
})

describe('a refusal from the database is said in the same words', () => {
  test('every code the migration raises has a sentence here', () => {
    const sql = read(MIGRATION)
    const codes = [...sql.matchAll(/'(ORDER_CONFIRMATION_[A-Z_]+):/g)].map(m => m[1])
    assert.ok(codes.length >= 6, 'the migration raises the codes this maps')
    for (const code of new Set(codes)) {
      const named = describeConfirmationFailure(`${code}: whatever the server said`)
      assert.ok(named, `${code} has no sentence`)
      assert.ok(named && named.message.length > 0)
    }
  })

  test('the refusal marks the field it is about', () => {
    assert.equal(describeConfirmationFailure('ORDER_CONFIRMATION_SALESPERSON_REQUIRED: x')?.field, 'salesperson')
    assert.equal(describeConfirmationFailure('ORDER_CONFIRMATION_DUE_DATE_REQUIRED: x')?.field, 'due_date')
    assert.equal(describeConfirmationFailure('ORDER_CONFIRMATION_LEAD_SOURCE_INVALID: x')?.field, 'lead_source')
  })

  test('a failure about something else is NOT claimed', () => {
    // The payment gate, the diagnostics and a permission refusal all belong to
    // the caller's existing error handling.
    for (const other of [
      'ORDER_SUBMISSION_PAYMENT_INSUFFICIENT: more is required',
      'You do not have permission to approve order submissions',
      'ORDER_SUBMISSION_BLOCKED: 3 issues',
    ]) {
      assert.equal(describeConfirmationFailure(other), null, other)
    }
  })

  test('a stale client is told to refresh, and that refusal names no field', () => {
    // The rollout window: the migration applied, this frontend not yet
    // deployed. A tab that was already open calls the one-argument form, which
    // exists only to refuse. It is not about one field — the whole call comes
    // from a client that predates all four.
    const named = describeConfirmationFailure(
      'ORDER_CONFIRMATION_CLIENT_UPDATE_REQUIRED: Refresh this page before confirming the Order.')
    assert.ok(named)
    assert.equal(named?.field, null)
    assert.equal(named?.message, CLIENT_UPDATE_REQUIRED_MESSAGE)
    assert.match(named?.message ?? '', /[Rr]efresh/)
  })

  test('the server\'s own prose never reaches the screen', () => {
    const named = describeConfirmationFailure('ORDER_CONFIRMATION_DUE_DATE_REQUIRED: raw server text 42')
    assert.ok(named && !named.message.includes('raw server text'))
  })
})

// ══ 2. The authority ══════════════════════════════════════════════════════════

describe('the conversion RPC refuses an incomplete Order itself', () => {
  const sql = read(MIGRATION)

  test('it is the SAME function that creates an Order, not a second path', () => {
    assert.match(sql, /create or replace function public\.approve_order_submission\(/)
    assert.match(sql, /insert into public\.orders \(/)
    assert.equal((sql.match(/insert into public\.orders \(/g) ?? []).length, 1,
      'exactly one Order is created, by the one function')
  })

  test('BOTH signatures exist after it — the rollout is database-first and safe', () => {
    // CASE A, which this prevents: the migration is applied first and the
    // DEPLOYED frontend still calls the one-argument form. Dropping it would
    // break every approval in the window between the two deploys.
    assert.equal(/drop function if exists public\.approve_order_submission\(uuid\)/.test(sql), false,
      'the one-argument form must NOT be dropped by this migration')
    assert.match(sql, /create or replace function public\.approve_order_submission\(p_submission_id uuid\)/)
    assert.match(sql, /create or replace function public\.approve_order_submission\(\s*\n\s*p_submission_id uuid,/)
    // Both are proved to exist when it applies, and only those two.
    assert.match(sql, /ASSERTION FAILED: approve_order_submission\(uuid, uuid, date, date, text\) does not exist/)
    assert.match(sql, /ASSERTION FAILED: the one-argument approve_order_submission is missing/)
    assert.match(sql, /expected exactly 2/)
  })

  test('the one-argument form REFUSES, and creates nothing', () => {
    // It is kept only so a stale tab is told what to do. It must never become a
    // second, laxer way to create an Order.
    assert.match(sql, /ORDER_CONFIRMATION_CLIENT_UPDATE_REQUIRED: Refresh this page before confirming the Order/)
    const blocker = sql.slice(
      sql.indexOf('create or replace function public.approve_order_submission(p_submission_id uuid)'),
      sql.indexOf('$blocker$;') + 10)
    assert.match(blocker, /raise exception/)
    for (const forbidden of [/insert\s+into/i, /delete\s+from/i, /\bselect\b/i, /\bperform\b/i, /coalesce/i]) {
      assert.equal(forbidden.test(blocker), false, `the blocker must not match ${forbidden}`)
    }
  })

  test('and the migration proves the blocker cannot write or delegate, on apply', () => {
    assert.match(sql, /ASSERTION FAILED: the one-argument form does not carry the update-required refusal/)
    assert.match(sql, /ASSERTION FAILED: the one-argument form can still create a row/)
    assert.match(sql, /ASSERTION FAILED: the one-argument form reads or delegates/)
  })

  test('NEITHER overload declares a DEFAULT — this is what keeps PostgREST unambiguous', () => {
    // PostgREST picks an overload by matching the SET OF ARGUMENT NAMES in the
    // request body, and a candidate is eligible only when every parameter
    // without a default was supplied. A DEFAULT on any of the four would make
    // the five-argument function eligible for a {p_submission_id} body too, and
    // every approval would answer PGRST203 instead of resolving. The same rule
    // and the same guard are already deployed for accept_employee_asset.
    const firstBody = sql.indexOf('  -- ── 1. Authorization, server-side, before anything is read ──')
    assert.ok(firstBody > 0, 'the five-argument body is where this expects it')
    // DECLARATIONS ONLY: the prose in between legitimately uses the word
    // "default", and a comment is not a parameter.
    const signatures = sql
      .slice(sql.indexOf('create or replace function public.approve_order_submission(p_submission_id uuid)'), firstBody)
      .split('\n').map(line => line.replace(/--.*$/, '')).join('\n')
    assert.equal(/\bdefault\b/i.test(signatures), false, 'no parameter may carry a DEFAULT')
    assert.match(sql, /p\.pronargdefaults > 0/)
    assert.match(sql, /PGRST203/)
    // The precedent it follows, so a reader can check the claim.
    const precedent = read('supabase/migrations/20261029000000_asset_handover_acknowledgement.sql')
    assert.match(precedent, /pronargdefaults > 0/)
    assert.match(precedent, /PGRST203/)
  })

  test('the frontend calls the FIVE-argument signature, by name', () => {
    const page = read(PI_PAGE)
    const call = page.slice(page.indexOf("supabase.rpc('approve_order_submission'"),
                            page.indexOf("supabase.rpc('approve_order_submission'") + 420)
    for (const key of ['p_submission_id:', 'p_assigned_to:', 'p_confirm_date:', 'p_due_date:', 'p_lead_source:']) {
      assert.ok(call.includes(key), `the call must send ${key}`)
    }
    // Five keys resolve to the five-argument candidate alone; the one-argument
    // candidate cannot satisfy a body carrying four parameters it does not have.
    assert.equal((call.match(/p_[a-z_]+:/g) ?? []).length, 5, 'exactly the five it declares')
  })

  test('all four are validated, each with its own code', () => {
    for (const code of [
      'ORDER_CONFIRMATION_SALESPERSON_REQUIRED',
      'ORDER_CONFIRMATION_CONFIRM_DATE_REQUIRED',
      'ORDER_CONFIRMATION_DUE_DATE_REQUIRED',
      'ORDER_CONFIRMATION_LEAD_SOURCE_REQUIRED',
    ]) {
      assert.ok(sql.includes(code), code)
    }
    // And the two that catch a value that is present but wrong.
    assert.ok(sql.includes('ORDER_CONFIRMATION_SALESPERSON_UNKNOWN'))
    assert.ok(sql.includes('ORDER_CONFIRMATION_LEAD_SOURCE_INVALID'))
  })

  test('the salesperson must be a real user, checked against public.users', () => {
    assert.match(sql, /select id into v_salesperson from public\.users where id = p_assigned_to;/)
  })

  test('the gate runs BEFORE any money is read or moved', () => {
    const gateAt = sql.indexOf('ORDER_CONFIRMATION_SALESPERSON_REQUIRED')
    const paymentAt = sql.indexOf('v_verified   := public.order_submission_verified_payment')
    const insertAt = sql.indexOf('insert into public.orders (')
    const moveAt = sql.indexOf('update public.finance_payment_allocations')
    assert.ok(gateAt > 0 && paymentAt > 0 && insertAt > 0 && moveAt > 0)
    assert.ok(gateAt < paymentAt, 'a refusal must not have read the payment position')
    assert.ok(gateAt < insertAt, 'nor created anything')
    assert.ok(gateAt < moveAt, 'nor moved an allocation')
  })

  test('the four values are written onto the Order', () => {
    const insert = sql.slice(sql.indexOf('insert into public.orders ('), sql.indexOf('returning id, display_number'))
    for (const column of ['assigned_to', 'confirm_date', 'due_date', 'lead_source']) {
      assert.ok(insert.includes(column), column)
    }
    for (const param of ['p_assigned_to', 'p_confirm_date', 'p_due_date', 'v_lead_source']) {
      assert.ok(insert.includes(param), param)
    }
  })

  test('the confirm date no longer falls back to the day of approval', () => {
    // A date nobody chose is exactly what this change exists to stop.
    assert.equal(sql.includes('coalesce(v_sub.order_confirmation_date, v_now::date)'), false)
    assert.match(sql, /ASSERTION FAILED: the confirm date still falls back to today/)
  })

  test('HISTORICAL ORDERS ARE NOT BROKEN: no column is made NOT NULL', () => {
    assert.equal(/alter table public\.orders[\s\S]{0,200}set not null/i.test(sql), false)
    assert.equal(/not null/i.test(sql.slice(sql.indexOf('insert into public.orders ('), sql.indexOf('returning id'))), false)
    // And the migration refuses to apply if one ever were.
    assert.match(sql, /ASSERTION FAILED: a required column was made NOT NULL, which would break historical Orders/)
  })

  test('every rule the conversion already had is still there', () => {
    // The body is the deployed text with three edits; these are the checks that
    // must not have been lost in the rewrite.
    for (const kept of [
      'actor_has_module_permission',
      'ORDER_SUBMISSION_NOT_UNDER_REVIEW',
      'ORDER_SUBMISSION_FINANCE_NOT_VERIFIED',
      'ORDER_SUBMISSION_PAYMENT_INSUFFICIENT',
      'ORDER_SUBMISSION_BLOCKED',
      'ORDER_SUBMISSION_WORKBOOK_NOT_STORED',
      'ORDER_SUBMISSION_ALLOCATION_NOT_MOVED',
      'assign_order_product_codes',
      'order_created_from_pi_submission',
      'for update',
    ]) {
      assert.ok(sql.includes(kept), `${kept} must survive`)
    }
  })

  test('it is still executable by an authenticated caller, and by nobody else', () => {
    assert.match(sql, /revoke execute on function public\.approve_order_submission\(uuid, uuid, date, date, text\) from public, anon;/)
    assert.match(sql, /grant  execute on function public\.approve_order_submission\(uuid, uuid, date, date, text\) to authenticated;/)
  })
})

// ══ 3. The screens ════════════════════════════════════════════════════════════

describe('the approval dialog asks for all four, and the page sends them', () => {
  const modal = read(MODAL)
  const page = read(PI_PAGE)

  test('the dialog offers a control for each', () => {
    assert.ok(modal.includes('{SALESPERSON_LABEL} *'))
    assert.ok(modal.includes('Confirm date *'))
    assert.ok(modal.includes('Due date *'))
    assert.ok(modal.includes('Lead source *'))
    assert.ok(modal.includes('ORDER_LEAD_SOURCES.map'), 'the lead source list is the shared one')
  })

  test('it asks only where an Order is actually created', () => {
    assert.match(modal, /const asksForOrderFields = mode !== 'approve_pi'/)
  })

  test('the refused field is focused, not merely reddened', () => {
    assert.match(modal, /if \(confirmationField\) fieldRefs\.current\[confirmationField\]\?\.focus\(\)/)
    assert.ok(modal.includes('aria-invalid={confirmationField ==='))
  })

  test('the page validates before it calls, and sends all four', () => {
    assert.ok(page.includes('const check = validateOrderConfirmation(confirmation)'))
    for (const param of ['p_assigned_to:', 'p_confirm_date:', 'p_due_date:', 'p_lead_source:']) {
      assert.ok(page.includes(param), param)
    }
  })

  test('a database refusal that names a field marks and says that field', () => {
    assert.ok(page.includes('describeConfirmationFailure(error)'))
    assert.match(page, /error => describeConfirmationFailure\(error\)\?\.message \?\? null/)
  })

  test('the two dates start from what the PI already states, and are still required', () => {
    assert.match(page, /confirmDate: prev\.confirmDate \?\? \(row\.order_confirmation_date \?\? null\)/)
    assert.match(page, /dueDate:     prev\.dueDate     \?\? \(row\.due_date \?\? null\)/)
  })
})

describe('the Order flow says Salesperson, and never Owner or Assignee', () => {
  test('the label is one constant', () => {
    assert.equal(SALESPERSON_LABEL, 'Salesperson')
  })

  test('the Confirmed Order screen shows no Owner and no Assignee field', () => {
    const code = read(ORDER_PAGE)
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .split('\n').filter(line => !line.trim().startsWith('//')).join('\n')
    assert.equal(/label="Assignee"/.test(code), false)
    assert.equal(/label="Owner"/.test(code), false)
    assert.equal(/\bOwner\b/.test(code), false)
  })

  test('the column underneath is UNCHANGED — no rename migration was written', () => {
    // A database rename to change a label would move every policy, index and
    // query that reads it, for nothing.
    const sql = read(MIGRATION)
    assert.equal(/rename column/i.test(sql), false)
    assert.equal(/alter table public\.orders[\s\S]{0,120}rename/i.test(sql), false)
    assert.ok(sql.includes('assigned_to'), 'the existing column is what carries the salesperson')
  })
})
