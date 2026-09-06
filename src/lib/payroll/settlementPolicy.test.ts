/**
 * Settlement policy: locking, privacy, and what a regeneration may touch.
 *
 * WHAT THESE PROVE, AND HOW
 * -------------------------
 * Three different kinds of assertion, deliberately kept apart:
 *
 *  1. Lock logic — pure, over lockGuard's own return shapes.
 *  2. Regeneration safety — materialiseSettlement driven against a fake
 *     Supabase client that RECORDS the writes it is asked to make, so "a
 *     regeneration must not clobber a manual override or a recorded payment"
 *     becomes an assertion about the actual update payload rather than a hope.
 *  3. The migration contract — the guarantees that live in SQL (RLS, CHECK
 *     constraints, the lock trigger) asserted against the migration text.
 *
 * (3) is a contract test, not a substitute for the database enforcing it: it
 * proves the migration SAYS these things, so a later edit cannot quietly drop
 * an employee-write restriction or the manual-remark requirement. Verifying the
 * behaviour in a live database needs the migration applied, which is a
 * deployment step and is called out in the handover rather than done here.
 *
 * Run:
 *   npx tsx --test src/lib/payroll/settlementPolicy.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isLocked, LOCKED_PERIOD_MESSAGE } from './lockGuard'
import { materialiseSettlement } from './settlementStore'

// ─── 1. Lock logic ────────────────────────────────────────────────────────────

describe('lock guard', () => {
  test('a locked period blocks the write', () => {
    assert.equal(isLocked({ found: true, periodId: 'p1', locked: true }), true)
  })

  test('an unlocked period allows it', () => {
    assert.equal(isLocked({ found: true, periodId: 'p1', locked: false }), false)
  })

  test('a month with no payroll period yet is not locked', () => {
    // Creating a pending adjustment before the period exists is normal use.
    // Treating "no period" as locked would break it.
    assert.equal(isLocked({ found: false }), false)
  })

  test('the refusal names the way back', () => {
    assert.match(LOCKED_PERIOD_MESSAGE, /Unlock it/)
  })
})

// ─── 2. Regeneration safety ───────────────────────────────────────────────────

type Recorded = { table: string; op: 'insert' | 'update'; payload: Record<string, unknown> }

/**
 * The smallest Supabase stand-in that materialiseSettlement can drive.
 *
 * It answers the two reads the function makes (the previous month's result, and
 * the existing settlement row) and records every write instead of performing
 * one. That is the whole point: the assertions below are about which COLUMNS a
 * regeneration writes, which no amount of reading the function can guarantee.
 */
function fakeSvc(opts: {
  existingSettlement?: Record<string, unknown> | null
  previousResult?: Record<string, unknown> | null
  previousSettlement?: Record<string, unknown> | null
}) {
  const writes: Recorded[] = []
  // fetchSettlement is called for BOTH the current period and (via
  // previousClosingBalance) the previous one. They are distinguished by call
  // order: the previous month is read first.
  let settlementReads = 0

  const builder = (table: string) => {
    const chain: Record<string, unknown> = {}
    const self = () => chain

    Object.assign(chain, {
      select: () => self(),
      eq:     () => self(),
      neq:    () => self(),
      // `is` is not decoration. buildSettlement reads the previous month's BOE
      // credit application, and that read ends `.is('reversal_transaction_id',
      // null)`. Without it the chain threw a TypeError which the caller's
      // `.catch` swallowed into "no prior application" — so these tests were
      // quietly exercising the degraded branch and printing a stack for every
      // one of them, while still reporting green.
      is:     () => self(),
      order:  () => self(),
      insert(payload: Record<string, unknown>) {
        writes.push({ table, op: 'insert', payload })
        return {
          select: () => ({ single: async () => ({ data: { id: 'new-settlement' }, error: null }) }),
        }
      },
      update(payload: Record<string, unknown>) {
        writes.push({ table, op: 'update', payload })
        return { eq: async () => ({ error: null }) }
      },
      async maybeSingle() {
        if (table === 'payroll_results') {
          return { data: opts.previousResult ?? null, error: null }
        }
        if (table === 'payroll_settlements') {
          settlementReads++
          return settlementReads === 1
            ? { data: opts.previousSettlement ?? null, error: null }
            : { data: opts.existingSettlement ?? null, error: null }
        }
        return { data: null, error: null }
      },
      async single() { return { data: null, error: null } },
    })

    return chain
  }

  return { svc: { from: builder }, writes }
}

const ACTOR = { id: 'admin-1', name: 'Admin' }

describe('regeneration must not clobber settlement', () => {
  test('a MANUAL carry-forward survives a regeneration untouched', async () => {
    const { svc, writes } = fakeSvc({
      existingSettlement: {
        id: 's1',
        carry_forward_is_manual: true,
        carry_forward_amount: 5_000,
        proposed_carry_forward: 2_000,
        payroll_result_id: 'old-result',
      },
      previousResult: { gross_salary: 25_000, total_deductions: 0, pending_adjustment_total: 0, days_present: 24 },
      previousSettlement: { carry_forward_amount: 0, amount_paid: 23_000 },
    })

    await materialiseSettlement(svc, {
      periodId: 'p2', employeeId: 'e1', resultId: 'new-result',
      previousPeriodId: 'p1', actor: ACTOR,
    })

    const updates = writes.filter(w => w.table === 'payroll_settlements' && w.op === 'update')
    assert.equal(updates.length, 1, 'exactly one write, and only to relink the result')

    const payload = updates[0].payload
    assert.equal(payload.payroll_result_id, 'new-result')
    assert.equal('carry_forward_amount'   in payload, false, 'must not overwrite a manual balance')
    assert.equal('proposed_carry_forward' in payload, false, 'must not lose the original proposal')
    assert.equal('carry_forward_is_manual' in payload, false)
    assert.equal('carry_forward_remark'   in payload, false)
  })

  test('an AUTOMATIC carry-forward is refreshed from the previous month', async () => {
    const { svc, writes } = fakeSvc({
      existingSettlement: {
        id: 's1',
        carry_forward_is_manual: false,
        carry_forward_amount: 0,
        proposed_carry_forward: 0,
        payroll_result_id: 'old-result',
      },
      // Previous month: payable 25,000, paid 23,000 → closing +2,000.
      previousResult: { gross_salary: 25_000, total_deductions: 0, pending_adjustment_total: 0, days_present: 24 },
      previousSettlement: { carry_forward_amount: 0, amount_paid: 23_000 },
    })

    await materialiseSettlement(svc, {
      periodId: 'p2', employeeId: 'e1', resultId: 'new-result',
      previousPeriodId: 'p1', actor: ACTOR,
    })

    const update = writes.find(w => w.table === 'payroll_settlements' && w.op === 'update')
    assert.ok(update, 'the automatic balance should be refreshed')
    assert.equal(update.payload.carry_forward_amount, 2_000)
    assert.equal(update.payload.proposed_carry_forward, 2_000)
    assert.equal(update.payload.carry_forward_source_period_id, 'p1')
  })

  test('NO regeneration path ever writes a payment field', async () => {
    // The requirement in its strongest form: recording what was paid is a human
    // act, and payroll generation must never touch it.
    for (const isManual of [true, false]) {
      const { svc, writes } = fakeSvc({
        existingSettlement: {
          id: 's1',
          carry_forward_is_manual: isManual,
          carry_forward_amount: 1_000,
          proposed_carry_forward: 1_000,
          payroll_result_id: 'old-result',
        },
        previousResult: { gross_salary: 25_000, total_deductions: 0, pending_adjustment_total: 0, days_present: 24 },
        previousSettlement: { carry_forward_amount: 0, amount_paid: 24_000 },
      })

      await materialiseSettlement(svc, {
        periodId: 'p2', employeeId: 'e1', resultId: 'new-result',
        previousPeriodId: 'p1', actor: ACTOR,
      })

      for (const w of writes.filter(w => w.table === 'payroll_settlements')) {
        for (const field of ['amount_paid', 'payment_date', 'payment_remark', 'payment_recorded_by']) {
          assert.equal(field in w.payload, false, `${field} written with is_manual=${isManual}`)
        }
      }
    }
  })

  test('a first generation inserts the proposal with its source period recorded', async () => {
    const { svc, writes } = fakeSvc({
      existingSettlement: null,
      previousResult: { gross_salary: 25_000, total_deductions: 0, pending_adjustment_total: 0, days_present: 24 },
      previousSettlement: { carry_forward_amount: 0, amount_paid: 23_000 },
    })

    await materialiseSettlement(svc, {
      periodId: 'p2', employeeId: 'e1', resultId: 'r2',
      previousPeriodId: 'p1', actor: ACTOR,
    })

    const insert = writes.find(w => w.table === 'payroll_settlements' && w.op === 'insert')
    assert.ok(insert)
    assert.equal(insert.payload.carry_forward_amount, 2_000)
    assert.equal(insert.payload.proposed_carry_forward, 2_000)
    assert.equal(insert.payload.carry_forward_source_period_id, 'p1', 'lineage must be recorded')
    assert.equal(insert.payload.carry_forward_is_manual, false)
  })

  test('the very first payroll month proposes zero, with no source', async () => {
    const { svc, writes } = fakeSvc({ existingSettlement: null })

    await materialiseSettlement(svc, {
      periodId: 'p1', employeeId: 'e1', resultId: 'r1',
      previousPeriodId: null, actor: ACTOR,
    })

    const insert = writes.find(w => w.table === 'payroll_settlements' && w.op === 'insert')
    assert.ok(insert)
    assert.equal(insert.payload.carry_forward_amount, 0)
    assert.equal(insert.payload.carry_forward_source_period_id, null)
  })

  test('an UNRESOLVED prior month materialises a zero proposal, not an invented debt', async () => {
    // The prior period is payable ₹25,000 with NO recorded payment. Treating the
    // missing figure as ₹0 paid would write a ₹25,000 carry-forward into this
    // month — a debt nobody reviewed, produced by an admin simply not having
    // filled in the payment yet. The source period is still recorded, so the
    // trail explains why the proposal is zero.
    const { svc, writes } = fakeSvc({
      existingSettlement: null,
      previousResult: { gross_salary: 25_000, total_deductions: 0, pending_adjustment_total: 0, days_present: 24 },
      previousSettlement: { carry_forward_amount: 0, amount_paid: null },
    })

    await materialiseSettlement(svc, {
      periodId: 'p2', employeeId: 'e1', resultId: 'r2',
      previousPeriodId: 'p1', actor: ACTOR,
    })

    const insert = writes.find(w => w.table === 'payroll_settlements' && w.op === 'insert')
    assert.ok(insert)
    assert.equal(insert.payload.carry_forward_amount, 0, 'no financial carry-forward from an unresolved month')
    assert.equal(insert.payload.proposed_carry_forward, 0)
    assert.equal(insert.payload.carry_forward_source_period_id, 'p1', 'the source is kept to explain the zero')

    // And the audit row says WHY, rather than logging an ordinary zero.
    const event = writes.find(w => w.table === 'payroll_settlement_events')
    assert.match(String(event?.payload.remark), /no recorded payment/i)
  })

  test('a prior month with a recorded ₹0 DOES carry its full payable forward', async () => {
    // The contrast: ₹0 recorded is a statement that nothing was paid, so the
    // whole amount really is owed and must follow the employee forward.
    const { svc, writes } = fakeSvc({
      existingSettlement: null,
      previousResult: { gross_salary: 25_000, total_deductions: 0, pending_adjustment_total: 0, days_present: 24 },
      previousSettlement: { carry_forward_amount: 0, amount_paid: 0 },
    })

    await materialiseSettlement(svc, {
      periodId: 'p2', employeeId: 'e1', resultId: 'r2',
      previousPeriodId: 'p1', actor: ACTOR,
    })

    const insert = writes.find(w => w.table === 'payroll_settlements' && w.op === 'insert')
    assert.equal(insert?.payload.carry_forward_amount, 25_000)
  })

  test('an employee with no result last month carries nothing forward', async () => {
    const { svc, writes } = fakeSvc({ existingSettlement: null, previousResult: null })

    await materialiseSettlement(svc, {
      periodId: 'p2', employeeId: 'new-joiner', resultId: 'r2',
      previousPeriodId: 'p1', actor: ACTOR,
    })

    const insert = writes.find(w => w.table === 'payroll_settlements' && w.op === 'insert')
    assert.equal(insert?.payload.carry_forward_amount, 0)
  })
})

// ─── 3. The migration contract ────────────────────────────────────────────────

const MIGRATION = readFileSync(
  join(process.cwd(), 'supabase', 'migrations', '20260826000000_payroll_settlements.sql'),
  'utf8',
)

describe('migration contract', () => {
  test('settlements carry row level security', () => {
    assert.match(MIGRATION, /ALTER TABLE public\.payroll_settlements ENABLE ROW LEVEL SECURITY/)
    assert.match(MIGRATION, /ALTER TABLE public\.payroll_settlement_events ENABLE ROW LEVEL SECURITY/)
  })

  test('an employee may read ONLY their own settlement', () => {
    assert.match(MIGRATION, /CREATE POLICY "employees_read_own_settlement"[\s\S]*?FOR SELECT[\s\S]*?USING \(employee_id = auth\.uid\(\)\)/)
  })

  test('an employee has NO write policy of any kind', () => {
    // The privacy requirement stated as an absence. Every employee-facing policy
    // in the file must be FOR SELECT; anything else would be a write grant.
    const employeePolicies = MIGRATION.match(/CREATE POLICY "employees_[\s\S]*?;/g) ?? []
    assert.ok(employeePolicies.length > 0, 'expected at least one employee policy')
    for (const policy of employeePolicies) {
      assert.match(policy, /FOR SELECT/, `employee policy grants more than SELECT: ${policy.slice(0, 80)}`)
    }
  })

  test('the event log is append-only — no update or delete policy for anybody', () => {
    const eventPolicies = MIGRATION.match(/CREATE POLICY "[^"]*settlement_events"[\s\S]*?;/g) ?? []
    for (const policy of eventPolicies) {
      assert.equal(/FOR (UPDATE|DELETE|ALL)/.test(policy), false, 'the audit trail must not be rewritable')
    }
  })

  test('a manual carry-forward cannot be saved without a reason', () => {
    assert.match(MIGRATION, /payroll_settlements_manual_needs_remark[\s\S]*?CHECK[\s\S]*?carry_forward_is_manual = false/)
  })

  test('a payment cannot be negative', () => {
    assert.match(MIGRATION, /payroll_settlements_amount_paid_non_negative[\s\S]*?amount_paid >= 0/)
  })

  test('one settlement per employee per period', () => {
    assert.match(MIGRATION, /payroll_settlements_period_employee_unique[\s\S]*?UNIQUE \(payroll_period_id, employee_id\)/)
  })

  test('a locked period is enforced by a trigger, not only by the route', () => {
    assert.match(MIGRATION, /CREATE TRIGGER payroll_settlements_lock_guard/)
    assert.match(MIGRATION, /BEFORE INSERT OR UPDATE OR DELETE ON public\.payroll_settlements/)
    assert.match(MIGRATION, /target_status = 'locked'[\s\S]*?RAISE EXCEPTION/)
  })

  test('no settlement total is stored — they are computed from the primitives', () => {
    // Storing salary_payable or closing_balance would create a second copy of a
    // figure that can drift from payroll_results. The whole model depends on
    // these NOT existing as columns.
    for (const forbidden of ['salary_payable', 'closing_balance', 'salary_after_attendance', 'net_adjustments']) {
      assert.equal(
        new RegExp(`^\\s+${forbidden}\\s+numeric`, 'm').test(MIGRATION), false,
        `${forbidden} must be computed, never stored`,
      )
    }
  })

  test('the adjustment void trail is added without changing how adjustments apply', () => {
    assert.match(MIGRATION, /ADD COLUMN IF NOT EXISTS voided_by/)
    assert.match(MIGRATION, /ADD COLUMN IF NOT EXISTS void_reason/)
    // Nothing may alter the amount or type columns the engine reads.
    assert.equal(/ALTER COLUMN (amount|adjustment_type)/.test(MIGRATION), false)
  })

  test('no existing payroll table is dropped or rewritten', () => {
    assert.equal(/DROP TABLE(?! *public\.payroll_settlement)/.test(MIGRATION), false)
    assert.equal(/DELETE FROM/.test(MIGRATION), false)
    assert.equal(/UPDATE public\.payroll_results/.test(MIGRATION), false)
  })
})
