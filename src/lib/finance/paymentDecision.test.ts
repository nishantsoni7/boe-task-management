/**
 * A PAYMENT DECIDED ON A PI DRAFT IS DECIDED BY SERVER-GATED DOORS.
 *
 * The PI Draft page offers Approve and Reject on a pending payment to somebody
 * holding finance.approve. These tests hold the helper behind those controls to
 * three promises:
 *
 *   1. each decision is exactly ONE RPC — approve_finance_payment_request with
 *      Finance's two arguments, reject_finance_payment_request with the payment
 *      and the trimmed reason — and the helper never writes the status column
 *      itself; the notifications are Finance's own, with the same payloads;
 *   2. it refuses early, and in fixed sentences, whatever it can see is wrong,
 *      and never reports a decision the database refused;
 *   3. the authority it relies on is the database's, and still says what it
 *      says: finance.approve for both RPCs, and a guard that confines every
 *      direct status change to the people allowed to make it.
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
  loadOwnPaymentIds,
  type PaymentDecisionNotifiers,
} from './paymentDecision'

type Call =
  | { kind: 'from'; table: string }
  | { kind: 'select'; columns: string }
  | { kind: 'update'; values: Record<string, unknown> }
  | { kind: 'eq'; column: string; value: unknown }
  | { kind: 'rpc'; fn: string; args: Record<string, unknown> }
  | { kind: 'in'; column: string; values: unknown[] }

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
  ownRows?: { id: string }[] | null
  ownError?: { code?: string; message?: string } | null
} = {}) {
  const calls: Call[] = []
  const chain = () => {
    const c = {
      select(columns: string) { calls.push({ kind: 'select', columns }); return c },
      // Recorded so a direct write would be caught, not because one is expected.
      update(values: Record<string, unknown>) { calls.push({ kind: 'update', values }); return c },
      eq(column: string, value: unknown) { calls.push({ kind: 'eq', column, value }); return c },
      in(column: string, values: unknown[]) { calls.push({ kind: 'in', column, values }); return c },
      // Awaiting the chain itself is the id read loadOwnPaymentIds makes.
      then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
        return Promise.resolve({ data: opts.ownRows === undefined ? [] : opts.ownRows, error: opts.ownError ?? null })
          .then(resolve, reject)
      },
      maybeSingle() {
        return Promise.resolve({ data: opts.row === undefined ? PENDING : opts.row, error: opts.readError ?? null })
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

describe('reject goes through the rejection RPC, never a direct write', () => {
  test('one read of the payment, then the one rejection RPC with the trimmed reason', async () => {
    const { client, calls } = stub()
    const { n, finance } = notifiers()
    const result = await decidePayment(client, { paymentId: 'pay-1', decision: 'reject', note: ' Duplicate entry ' }, n)

    assert.deepEqual(result, { ok: true, decision: 'reject', requestNumber: 'PAY-REQ-2026-0042' })
    const rpcs = calls.filter(c => c.kind === 'rpc') as Extract<Call, { kind: 'rpc' }>[]
    assert.equal(rpcs.length, 1)
    assert.equal(rpcs[0].fn, 'reject_finance_payment_request')
    assert.deepEqual(rpcs[0].args, { p_request_id: 'pay-1', p_reason: 'Duplicate entry' })
    assert.equal(calls.filter(c => c.kind === 'update').length, 0,
      'the status column is never written from the browser')
    assert.deepEqual(finance, [{
      event: 'finance_rejected', requestNumber: 'PAY-REQ-2026-0042', entityId: 'pay-1',
      creatorId: 'sales-1', clientName: 'Kalyan Interiors',
    }])
  })

  test('a rejection the database refuses is NOT reported, and nobody is told', async () => {
    const cases: [{ code: string; message: string }, string][] = [
      [{ code: 'P0001', message: 'Only a pending payment request can be rejected (PAY-REQ-2026-0042 is rejected)' },
        PAYMENT_DECISION_MESSAGE.notPending],
      [{ code: '42501', message: 'Only a payment verifier may reject a payment request' },
        PAYMENT_DECISION_MESSAGE.notPermitted],
      [{ code: '22023', message: 'PAYMENT_REJECTION_REASON_REQUIRED: enter a reason before rejecting this payment.' },
        PAYMENT_DECISION_MESSAGE.reasonRequired],
      [{ code: '42501', message: 'PAYMENT_SELF_DECISION_FORBIDDEN: payment PAY-REQ-2026-0042 was recorded by you; another payment verifier must decide it' },
        PAYMENT_DECISION_MESSAGE.selfDecision],
    ]
    for (const [rpcError, expected] of cases) {
      const { n, finance, orders } = notifiers()
      const result = await decidePayment(stub({ rpcError, row: { ...PENDING, order_id: 'ord-9' } }).client,
        { paymentId: 'pay-1', decision: 'reject', note: 'x' }, n)
      assert.deepEqual(result, { ok: false, message: expected }, rpcError.message)
      assert.equal(finance.length + orders.length, 0, 'nobody is told about a decision that did not happen')
    }
  })

  test('a rejection that names an Order tells the Order, as Finance does', async () => {
    const row = { ...PENDING, order_id: 'ord-9' }
    const { n, orders } = notifiers()
    await decidePayment(stub({ row }).client, { paymentId: 'pay-1', decision: 'reject', note: 'x' }, n)
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

  test('a verifier deciding a payment they recorded is told why, and nobody is notified', async () => {
    for (const decision of ['approve', 'reject'] as const) {
      const { client } = stub({ rpcError: { code: '42501',
        message: 'PAYMENT_SELF_DECISION_FORBIDDEN: payment PAY-REQ-2026-0042 was recorded by you; another payment verifier must decide it' } })
      const { n, finance, orders } = notifiers()
      const result = await decidePayment(client, { paymentId: 'pay-1', decision, note: 'x' }, n)
      assert.deepEqual(result, { ok: false, message: PAYMENT_DECISION_MESSAGE.selfDecision }, decision)
      assert.equal(finance.length + orders.length, 0)
    }
  })

  test('every database refusal maps to a fixed sentence, never the raw message', () => {
    const cases: [{ code?: string; message?: string }, string][] = [
      [{ code: '42501', message: 'Only an admin may approve a payment request' }, PAYMENT_DECISION_MESSAGE.notPermitted],
      [{ code: '42501', message: 'Only a payment verifier may reject a payment request' }, PAYMENT_DECISION_MESSAGE.notPermitted],
      [{ code: '42501', message: 'PAYMENT_SELF_DECISION_FORBIDDEN: payment X was recorded by you; another payment verifier must decide it' }, PAYMENT_DECISION_MESSAGE.selfDecision],
      [{ code: '42501', message: 'FINANCE_NOTE_PROTECTED: the Finance note on payment X changes only with a Finance decision or correction' }, PAYMENT_DECISION_MESSAGE.notPermitted],
      [{ code: '42501', message: 'Payment X can be rejected or sent back only by a payment verifier while it awaits verification' }, PAYMENT_DECISION_MESSAGE.notPermitted],
      [{ message: 'new row violates row-level security policy' }, PAYMENT_DECISION_MESSAGE.notPermitted],
      [{ code: 'P0001', message: 'Only a pending payment request can be approved (X is rejected)' }, PAYMENT_DECISION_MESSAGE.notPending],
      [{ code: 'P0001', message: 'Only a pending payment request can be rejected (X is approved_unlinked)' }, PAYMENT_DECISION_MESSAGE.notPending],
      [{ code: '22023', message: 'PAYMENT_REJECTION_REASON_REQUIRED: enter a reason before rejecting this payment.' }, PAYMENT_DECISION_MESSAGE.reasonRequired],
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
      assert.ok(!said.includes(error.message ?? ' '), 'the database message never reaches the screen')
    }
  })
})

describe('which payments the viewer recorded', () => {
  test('nothing to ask about, or nobody asking, reads nothing', async () => {
    const cases: [readonly string[], string | null][] = [[[], 'v-1'], [['pay-1'], null], [['pay-1'], '']]
    for (const [ids, viewer] of cases) {
      const { client, calls } = stub()
      const own = await loadOwnPaymentIds(client, ids, viewer)
      assert.equal(own.size, 0)
      assert.equal(calls.length, 0)
    }
  })

  test('one read of ids, narrowed to these payments and this submitter', async () => {
    const { client, calls } = stub({ ownRows: [{ id: 'pay-2' }] })
    const own = await loadOwnPaymentIds(client, ['pay-1', 'pay-2'], 'v-1')
    assert.deepEqual([...own], ['pay-2'])
    assert.deepEqual(calls, [
      { kind: 'from', table: 'finance_payment_requests' },
      { kind: 'select', columns: 'id' },
      { kind: 'in', column: 'id', values: ['pay-1', 'pay-2'] },
      { kind: 'eq', column: 'submitted_by', value: 'v-1' },
    ])
  })

  test('a failed read resolves to no ids — the database still refuses the decision', async () => {
    const { client } = stub({ ownError: { code: '42501', message: 'denied' }, ownRows: null })
    assert.equal((await loadOwnPaymentIds(client, ['pay-1'], 'v-1')).size, 0)
  })
})

// ── 3. The doors, and nothing written directly ────────────────────────────────

describe('the helper opens only the two decision RPCs', () => {
  const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')
  const helper = read('src/lib/finance/paymentDecision.ts')
  const code = helper.replace(/\/\/.*$/gm, '')
  const finance = read('src/app/finance/page.tsx')
  const reviewModal = finance.slice(finance.indexOf('function AdminReviewModal('),
    finance.indexOf('// ── Delete confirm modal (admin only)'))

  test('approval: the same RPC as Finance, with the same two named arguments', () => {
    for (const source of [helper, reviewModal]) {
      assert.ok(source.includes("rpc('approve_finance_payment_request', {"))
      assert.ok(/p_request_id:\s*r\.id/.test(source))
      assert.ok(/p_admin_note:/.test(source))
    }
  })

  test('rejection: the rejection RPC with the reason, and exactly these two RPCs', () => {
    assert.ok(code.includes("rpc('reject_finance_payment_request', {"))
    assert.ok(/p_reason:\s*note/.test(code))
    const rpcs = [...code.matchAll(/\.rpc\('([^']+)'/g)].map(m => m[1]).sort()
    assert.deepEqual(rpcs, ['approve_finance_payment_request', 'reject_finance_payment_request'],
      'no second approval door and no third decision door')
  })

  test('the helper writes nothing directly — it only reads the payment', () => {
    for (const write of ['.update(', '.insert(', '.upsert(', '.delete(']) {
      assert.ok(!code.includes(write), `the helper must not call ${write}`)
    }
    assert.ok(!/\bstatus\s*:\s*['"`]/.test(code), 'the helper must not name a status to write')
    const tables = [...code.matchAll(/\.from\('([^']+)'\)/g)].map(m => m[1])
    assert.deepEqual([...new Set(tables)], ['finance_payment_requests'])
    assert.ok(code.includes('.select(PAYMENT_DECISION_COLUMNS)'))
  })

  test('the same notification events as Finance', () => {
    for (const event of ['finance_approved_suspense', 'finance_approved_linked', 'finance_rejected']) {
      assert.ok(helper.includes(`'${event}'`), `${event} missing from the helper`)
      assert.ok(reviewModal.includes(`'${event}'`), `${event} missing from Finance`)
    }
    assert.ok(helper.includes("notifyOrderUpdate({ orderId: r.order_id, event: 'payment' })"))
  })

  test('the helper decides nothing about who may act', () => {
    for (const forbidden of ['role', 'canApprovePayment', 'getEffectivePermissions', 'actor_has']) {
      assert.ok(!code.includes(forbidden), `the helper must not consult ${forbidden}`)
    }
  })
})

describe('the authority both decisions rely on is still the database’s', () => {
  const MIGRATIONS = 'supabase/migrations'
  const DECISIONS = '20261211000000_finance_payment_decisions_belong_to_verifiers.sql'
  const migration = (name: string) => readFileSync(join(process.cwd(), MIGRATIONS, name), 'utf8').replace(/\r\n/g, '\n')
  const files = readdirSync(join(process.cwd(), MIGRATIONS)).sort()

  test('approval is gated on finance.approve, with module entry, and nothing wider', () => {
    // The latest body of the approval RPC.
    const defining = files.filter(f => migration(f).includes('create or replace function public.approve_finance_payment_request('))
    const latest = migration(defining[defining.length - 1])
    const body = latest.slice(latest.indexOf('create or replace function public.approve_finance_payment_request('))
    assert.ok(body.includes("actor_has_module_permission('finance', 'approve')"))
    assert.ok(body.includes("if v_req.status <> 'pending_approval' then"), 'and only a pending payment')
  })

  test('rejection is gated exactly like approval, needs a reason, and decides only a pending payment', () => {
    const sql = migration(DECISIONS)
    const body = sql.slice(sql.indexOf('create or replace function public.reject_finance_payment_request('),
      sql.indexOf('comment on function public.reject_finance_payment_request'))
    assert.ok(body.includes('security definer'))
    assert.ok(body.includes("actor_has_module_permission('finance', 'approve')"))
    for (const wider of ["'view_all'", "'manage'", "'allocate'"]) {
      assert.ok(!body.includes(wider), `rejection must not consult ${wider}`)
    }
    assert.ok(body.includes('PAYMENT_REJECTION_REASON_REQUIRED'))
    assert.ok(body.includes('PAYMENT_SELF_DECISION_FORBIDDEN'), 'never the person who recorded the payment')
    assert.ok(body.includes('for update'))
    assert.ok(body.includes("if v_req.status <> 'pending_approval' then"))
    assert.ok(body.includes("set status     = 'rejected'"))
    assert.ok(body.includes('v_actor  uuid := auth.uid();'), 'the actor is the caller, never an argument')
    assert.ok(sql.includes('revoke execute on function public.reject_finance_payment_request(uuid, text) from public, anon;'))
    assert.ok(sql.includes('grant  execute on function public.reject_finance_payment_request(uuid, text) to authenticated;'))

    for (const file of files.filter(f => f > DECISIONS)) {
      assert.ok(!migration(file).includes('create or replace function public.reject_finance_payment_request('),
        `${file} restates the rejection RPC`)
    }
  })

  test('a direct status write is confined to the people allowed to make it', () => {
    const sql = migration(DECISIONS)
    assert.ok(sql.includes('create trigger finance_payment_requests_guard_decision_status\n  before insert or update on public.finance_payment_requests'))
    const guard = sql.slice(sql.indexOf('create or replace function public.finance_payment_requests_guard_decision_status('),
      sql.indexOf('comment on function public.finance_payment_requests_guard_decision_status'))
    assert.ok(guard.includes("new.status is distinct from 'pending_approval'"), 'a new payment is born pending')
    assert.ok(guard.includes('public.in_finance_payment_verification(old.id)'), 'verifying is the approval RPC alone')
    assert.ok(guard.includes('if v_was_verified and not v_is_verified then'), 'a verified payment is not un-verified')
    assert.ok(guard.includes("if old.status is distinct from 'pending_approval'\n         or not public.actor_has_module_permission('finance', 'approve') then"),
      'rejecting or sending back is a verifier deciding a pending payment')
    assert.ok(guard.includes('PAYMENT_REJECTION_REASON_REQUIRED'), 'a direct rejection needs a reason too')
    const self = guard.indexOf('PAYMENT_SELF_DECISION_FORBIDDEN')
    assert.ok(self > 0 && self < guard.indexOf('public.in_finance_payment_verification(old.id)'),
      'nobody decides their own payment — checked before the approval marker admits a verification')
    assert.ok(guard.includes('v_self         := old.submitted_by = v_actor or new.submitted_by = v_actor;'))
    assert.ok(guard.includes('if new.admin_note is distinct from old.admin_note then'), 'the Finance note is guarded')
    assert.ok(guard.includes('FINANCE_NOTE_PROTECTED'))
    // The policies are not what changed: no policy is created, dropped or altered.
    assert.ok(!/create policy|drop policy|alter policy/i.test(sql))
  })

  test('the approver-decide policy is still the one 20260901000000 created', () => {
    const later = files.filter(f => f > '20260901000000_finance_orders_permission_enforcement.sql')
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
