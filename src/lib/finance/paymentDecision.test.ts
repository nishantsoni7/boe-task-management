/**
 * A PAYMENT DECIDED ON A PI DRAFT IS DECIDED BY FINANCE'S OWN DOORS.
 *
 * The PI Draft page offers Approve and Reject on a pending payment to somebody
 * holding finance.approve. These tests hold the helper behind those controls to
 * three promises:
 *
 *   1. it sends EXACTLY what Finance's review dialog sends — the same RPC with
 *      the same two arguments, the same three-column status write, the same
 *      notifications — so the resulting status and activity entry are the same;
 *   2. it refuses early, and in fixed sentences, whatever it can see is wrong,
 *      and never reports a rejection that RLS silently filtered out;
 *   3. the authority it relies on is the database's, and still says what it
 *      says: finance.approve for the RPC, the approver-decide policy for the
 *      rejection.
 *
 * Offline: a stub client records every call; nothing reaches a database.
 *
 * Run:
 *   npx tsx --test src/lib/finance/paymentDecision.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import {
  PAYMENT_DECISION_MESSAGE,
  decidePayment,
  describePaymentDecisionError,
  type PaymentDecisionNotifiers,
} from './paymentDecision'

type Call =
  | { kind: 'from'; table: string }
  | { kind: 'select'; columns: string }
  | { kind: 'update'; values: Record<string, unknown>; options: unknown }
  | { kind: 'eq'; column: string; value: unknown }
  | { kind: 'rpc'; fn: string; args: Record<string, unknown> }

const PENDING = {
  id: 'pay-1',
  request_number: 'PAY-REQ-2026-0042',
  status: 'pending_approval',
  submitted_by: 'sales-1',
  client_name: 'Kalyan Interiors',
  payment_against: 'new_order',
  order_id: null as string | null,
  order_number: null as string | null,
}

function stub(opts: {
  row?: Record<string, unknown> | null
  readError?: { code?: string; message?: string } | null
  rpcError?: { code?: string; message?: string } | null
  updateCount?: number | null
  updateError?: { code?: string; message?: string } | null
} = {}) {
  const calls: Call[] = []
  const chain = () => {
    const c = {
      select(columns: string) { calls.push({ kind: 'select', columns }); return c },
      update(values: Record<string, unknown>, options: unknown) {
        calls.push({ kind: 'update', values, options }); return c
      },
      eq(column: string, value: unknown) { calls.push({ kind: 'eq', column, value }); return c },
      maybeSingle() {
        return Promise.resolve({ data: opts.row === undefined ? PENDING : opts.row, error: opts.readError ?? null })
      },
      then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
        return Promise.resolve({ count: opts.updateCount ?? null, error: opts.updateError ?? null })
          .then(resolve, reject)
      },
    }
    return c
  }
  const client = {
    from(table: string) { calls.push({ kind: 'from', table }); return chain() },
    rpc(fn: string, args: Record<string, unknown>) {
      calls.push({ kind: 'rpc', fn, args })
      return Promise.resolve({ data: {}, error: opts.rpcError ?? null })
    },
  }
  return { client: client as never, calls }
}

function notifiers() {
  const finance: unknown[] = []
  const orders: unknown[] = []
  const n: PaymentDecisionNotifiers = {
    notifyFinance: async payload => { finance.push(payload) },
    notifyOrderUpdate: async payload => { orders.push(payload) },
  }
  return { n, finance, orders }
}

const writes = (calls: Call[]) => calls.filter(c => c.kind === 'rpc' || c.kind === 'update')

// ── 1. What is sent ───────────────────────────────────────────────────────────

describe('approve sends exactly what Finance sends', () => {
  test('one read of the payment, then the one approval RPC with its two arguments', async () => {
    const { client, calls } = stub()
    const { n } = notifiers()
    const result = await decidePayment(client, { paymentId: 'pay-1', decision: 'approve', note: '  ' }, n)

    assert.deepEqual(result, { ok: true, decision: 'approve', requestNumber: 'PAY-REQ-2026-0042' })
    assert.deepEqual(calls.filter(c => c.kind === 'from').map(c => (c as { table: string }).table),
      ['finance_payment_requests'], 'the payment row is read once, from the payment table')
    const rpc = calls.find(c => c.kind === 'rpc') as Extract<Call, { kind: 'rpc' }>
    assert.equal(rpc.fn, 'approve_finance_payment_request')
    assert.deepEqual(rpc.args, { p_request_id: 'pay-1', p_admin_note: null },
      'a blank note is sent as null, exactly as Finance trims it')
    assert.equal(calls.filter(c => c.kind === 'update').length, 0, 'approval never writes the row directly')
  })

  test('a typed note travels, trimmed', async () => {
    const { client, calls } = stub()
    await decidePayment(client, { paymentId: 'pay-1', decision: 'approve', note: '  matched HDFC statement ' }, notifiers().n)
    const rpc = calls.find(c => c.kind === 'rpc') as Extract<Call, { kind: 'rpc' }>
    assert.equal(rpc.args.p_admin_note, 'matched HDFC statement')
  })

  test('a new_order payment is announced as Suspense, anything else as linked', async () => {
    const one = notifiers()
    await decidePayment(stub().client, { paymentId: 'pay-1', decision: 'approve', note: null }, one.n)
    assert.deepEqual(one.finance, [{
      event: 'finance_approved_suspense', requestNumber: 'PAY-REQ-2026-0042', entityId: 'pay-1',
      creatorId: 'sales-1', clientName: 'Kalyan Interiors',
    }])
    assert.deepEqual(one.orders, [], 'no Order named, no Order told')

    const two = notifiers()
    const linked = { ...PENDING, payment_against: 'existing_order', order_id: 'ord-9', order_number: '0413' }
    await decidePayment(stub({ row: linked }).client, { paymentId: 'pay-1', decision: 'approve', note: null }, two.n)
    assert.deepEqual(two.finance, [{
      event: 'finance_approved_linked', requestNumber: 'PAY-REQ-2026-0042', entityId: 'pay-1',
      creatorId: 'sales-1', clientName: 'Kalyan Interiors', orderNumber: '0413',
    }])
    assert.deepEqual(two.orders, [{ orderId: 'ord-9', event: 'payment' }])
  })
})

describe('reject sends exactly what Finance sends', () => {
  test('the three decision columns, on the pending row only, counting what changed', async () => {
    const { client, calls } = stub({ updateCount: 1 })
    const { n, finance } = notifiers()
    const result = await decidePayment(client, { paymentId: 'pay-1', decision: 'reject', note: ' Duplicate entry ' }, n)

    assert.deepEqual(result, { ok: true, decision: 'reject', requestNumber: 'PAY-REQ-2026-0042' })
    const update = calls.find(c => c.kind === 'update') as Extract<Call, { kind: 'update' }>
    assert.deepEqual(Object.keys(update.values).sort(), ['admin_note', 'status', 'updated_at'],
      'exactly the columns the pending-decision guard admits')
    assert.equal(update.values.status, 'rejected')
    assert.equal(update.values.admin_note, 'Duplicate entry')
    assert.ok(!Number.isNaN(Date.parse(String(update.values.updated_at))))
    assert.deepEqual(update.options, { count: 'exact' },
      'a COUNT, not a returned row — RETURNING would need a read policy the approver may not hold')
    const filters = calls.filter(c => c.kind === 'eq').map(c => [(c as { column: string }).column, (c as { value: unknown }).value])
    assert.deepEqual(filters.slice(-2), [['id', 'pay-1'], ['status', 'pending_approval']])
    assert.equal(calls.filter(c => c.kind === 'rpc').length, 0, 'rejection has no RPC in Finance either')
    assert.deepEqual(finance, [{
      event: 'finance_rejected', requestNumber: 'PAY-REQ-2026-0042', entityId: 'pay-1',
      creatorId: 'sales-1', clientName: 'Kalyan Interiors',
    }])
  })

  test('an update that RLS filtered out is NOT reported as a rejection', async () => {
    const { client } = stub({ updateCount: 0 })
    const { n, finance, orders } = notifiers()
    const result = await decidePayment(client, { paymentId: 'pay-1', decision: 'reject', note: 'x' }, n)
    assert.deepEqual(result, { ok: false, message: PAYMENT_DECISION_MESSAGE.notPending })
    assert.equal(finance.length + orders.length, 0, 'nobody is told about a decision that did not happen')
  })

  test('a rejection that names an Order tells the Order, as Finance does', async () => {
    const row = { ...PENDING, order_id: 'ord-9' }
    const { n, orders } = notifiers()
    await decidePayment(stub({ row, updateCount: 1 }).client, { paymentId: 'pay-1', decision: 'reject', note: 'x' }, n)
    assert.deepEqual(orders, [{ orderId: 'ord-9', event: 'payment' }])
  })
})

// ── 2. What is refused, and how it is said ────────────────────────────────────

describe('refusals are early, silent on the database, and worded', () => {
  test('a rejection without a reason sends nothing at all', async () => {
    const { client, calls } = stub()
    const result = await decidePayment(client, { paymentId: 'pay-1', decision: 'reject', note: '   ' }, notifiers().n)
    assert.deepEqual(result, { ok: false, message: PAYMENT_DECISION_MESSAGE.reasonRequired })
    assert.equal(calls.length, 0)
  })

  test('a payment this viewer cannot read is not decided', async () => {
    const { client, calls } = stub({ row: null })
    const result = await decidePayment(client, { paymentId: 'pay-1', decision: 'approve', note: null }, notifiers().n)
    assert.deepEqual(result, { ok: false, message: PAYMENT_DECISION_MESSAGE.unavailable })
    assert.equal(writes(calls).length, 0)
  })

  for (const status of ['approved_unlinked', 'approved_linked', 'rejected', 'needs_clarification']) {
    test(`a payment already ${status} is not decided again`, async () => {
      for (const decision of ['approve', 'reject'] as const) {
        const { client, calls } = stub({ row: { ...PENDING, status } })
        const result = await decidePayment(client, { paymentId: 'pay-1', decision, note: 'x' }, notifiers().n)
        assert.deepEqual(result, { ok: false, message: PAYMENT_DECISION_MESSAGE.notPending })
        assert.equal(writes(calls).length, 0, `${decision} wrote to a ${status} payment`)
      }
    })
  }

  test('an unauthorised approver is told so, and nobody is notified', async () => {
    const { client } = stub({ rpcError: { code: '42501', message: 'Only an admin may approve a payment request' } })
    const { n, finance } = notifiers()
    const result = await decidePayment(client, { paymentId: 'pay-1', decision: 'approve', note: null }, n)
    assert.deepEqual(result, { ok: false, message: PAYMENT_DECISION_MESSAGE.notPermitted })
    assert.equal(finance.length, 0)
  })

  test('every database refusal maps to a fixed sentence, never the raw message', () => {
    const cases: [{ code?: string; message?: string }, string][] = [
      [{ code: '42501', message: 'Only an admin may approve a payment request' }, PAYMENT_DECISION_MESSAGE.notPermitted],
      [{ message: 'new row violates row-level security policy' }, PAYMENT_DECISION_MESSAGE.notPermitted],
      [{ code: 'P0001', message: 'Only a pending payment request can be approved (X is rejected)' }, PAYMENT_DECISION_MESSAGE.notPending],
      [{ code: 'P0001', message: 'PAYMENT_TARGET_CHANGED: The target changed' }, PAYMENT_DECISION_MESSAGE.targetChanged],
      [{ code: 'P0001', message: 'ORDER_REQUEST_CONVERTED: Order Request R-1 has already been converted' }, PAYMENT_DECISION_MESSAGE.needsFinance],
      [{ code: 'P0002', message: 'Payment request x not found' }, PAYMENT_DECISION_MESSAGE.unavailable],
      [{ code: 'XX000', message: 'connection reset with secret internals' }, PAYMENT_DECISION_MESSAGE.failed],
    ]
    const sentences = new Set<string>(Object.values(PAYMENT_DECISION_MESSAGE))
    for (const [error, expected] of cases) {
      const said = describePaymentDecisionError(error)
      assert.equal(said, expected, JSON.stringify(error))
      assert.ok(sentences.has(said))
      assert.ok(!said.includes(error.message ?? ' '), 'the database message never reaches the screen')
    }
  })
})

// ── 3. The same doors as Finance, and the same authority ──────────────────────

describe('parity with the Finance review dialog', () => {
  const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')
  const helper = read('src/lib/finance/paymentDecision.ts')
  const finance = read('src/app/finance/page.tsx')
  const reviewModal = finance.slice(finance.indexOf('function AdminReviewModal('),
    finance.indexOf('// ── Delete confirm modal (admin only)'))

  test('the same RPC, with the same two named arguments', () => {
    for (const source of [helper, reviewModal]) {
      assert.ok(source.includes("rpc('approve_finance_payment_request', {"))
      assert.ok(/p_request_id:\s*r\.id/.test(source))
      assert.ok(/p_admin_note:/.test(source))
    }
    const rpcs = [...helper.matchAll(/\.rpc\('([^']+)'/g)].map(m => m[1])
    assert.deepEqual(rpcs, ['approve_finance_payment_request'], 'and no second approval door')
  })

  test('the same status write, on the same table', () => {
    assert.ok(reviewModal.includes("status:     action === 'needs_clarification' ? 'needs_clarification' : 'rejected'"))
    assert.ok(helper.includes("status:     'rejected'"))
    for (const source of [helper, reviewModal]) {
      assert.ok(source.includes(".from('finance_payment_requests')"))
      assert.ok(source.includes('admin_note:') && source.includes('updated_at: new Date().toISOString()'))
    }
    const tables = [...helper.matchAll(/\.from\('([^']+)'\)/g)].map(m => m[1])
    assert.deepEqual([...new Set(tables)], ['finance_payment_requests'])
  })

  test('the same notification events', () => {
    for (const event of ['finance_approved_suspense', 'finance_approved_linked', 'finance_rejected']) {
      assert.ok(helper.includes(`'${event}'`), `${event} missing from the helper`)
      assert.ok(reviewModal.includes(`'${event}'`), `${event} missing from Finance`)
    }
    assert.ok(helper.includes("notifyOrderUpdate({ orderId: r.order_id, event: 'payment' })"))
  })

  test('the helper decides nothing about who may act', () => {
    for (const forbidden of ['role', 'canApprovePayment', 'getEffectivePermissions', 'actor_has']) {
      assert.ok(!helper.replace(/\/\/.*$/gm, '').includes(forbidden), `the helper must not consult ${forbidden}`)
    }
  })
})

describe('the authority both decisions rely on is still the database’s', () => {
  const MIGRATIONS = 'supabase/migrations'
  const migration = (name: string) => readFileSync(join(process.cwd(), MIGRATIONS, name), 'utf8')

  test('approval is gated on finance.approve, with module entry, and nothing wider', () => {
    // The latest body of the approval RPC.
    const files = readdirSync(join(process.cwd(), MIGRATIONS)).sort()
    const defining = files.filter(f => migration(f).includes('create or replace function public.approve_finance_payment_request('))
    const latest = migration(defining[defining.length - 1])
    const body = latest.slice(latest.indexOf('create or replace function public.approve_finance_payment_request('))
    assert.ok(body.includes("actor_has_module_permission('finance', 'approve')"))
    assert.ok(body.includes("if v_req.status <> 'pending_approval' then"), 'and only a pending payment')
  })

  test('rejection is admitted only on a pending row, for finance.approve, into a decision status', () => {
    const sql = migration('20260901000000_finance_orders_permission_enforcement.sql')
    const policy = sql.slice(sql.indexOf('create policy "finance_payment_requests_approver_decide"'))
    const clause = policy.slice(0, policy.indexOf(');') + 2)
    assert.ok(clause.includes("status = 'pending_approval'"))
    assert.ok(clause.includes("actor_has_permission('finance', 'approve')"))
    assert.ok(clause.includes("status in ('rejected', 'needs_clarification')"))

    // No later migration re-creates or widens it.
    const later = readdirSync(join(process.cwd(), MIGRATIONS)).sort()
      .filter(f => f > '20260901000000_finance_orders_permission_enforcement.sql')
    for (const file of later) {
      assert.ok(!/create policy "finance_payment_requests_approver_decide"/.test(migration(file)),
        `${file} re-creates the approver-decide policy`)
    }
  })

  test('every status change still writes the activity trail, whichever screen made it', () => {
    const sql = migration('20260675_finance_payment_request_activity_log_trigger.sql')
    assert.ok(/create trigger finance_payment_requests_log_activity\s+after insert or update on public\.finance_payment_requests/.test(sql))
  })
})
