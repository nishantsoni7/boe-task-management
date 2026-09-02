/**
 * BOE Credits — the service layer, against a fake Supabase client.
 *
 * What this proves: the service refuses what the database would refuse
 * BEFORE making a round trip (zero credits, unknown kind, missing reason,
 * missing source), calls the posting RPC with exactly the arguments the
 * function takes, maps the database's BOE_CREDITS_* markers to HTTP statuses,
 * reads the balance from the VIEW rather than computing it, and never inserts
 * into the ledger table directly.
 *
 * Same technique as src/lib/orders/testDataResetServer.test.ts: a hand-rolled
 * client object cast to the Supabase type, recording every call.
 *
 * Run:
 *   npx tsx --test src/lib/boeCredits/service.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  CreditServiceError,
  creditErrorFrom,
  creditErrorStatus,
  fetchActiveCreditSettings,
  getAllCreditBalances,
  getCreditBalance,
  getCreditTransactions,
  postAdminAdjustment,
  postCreditTransaction,
  reverseCreditTransaction,
  saveCreditSettings,
  type Svc,
} from './service'
import { DEFAULT_BOE_CREDIT_SETTINGS } from './settings'

// ─── The fake ─────────────────────────────────────────────────────────────────

type Call = { table: string; op: string; args: unknown[] }
type TableResult = { data: unknown; error: { message: string; code?: string } | null }

function fakeClient(opts: {
  tables?: Record<string, TableResult | ((calls: Call[]) => TableResult)>
  rpc?: (name: string, args: Record<string, unknown>) => { data: unknown; error: { message: string; code?: string } | null }
} = {}) {
  const calls: Call[] = []
  const rpcCalls: { name: string; args: Record<string, unknown> }[] = []

  const builder = (table: string) => {
    const chain: Record<string, unknown> = {}
    const resolve = (): TableResult => {
      const t = opts.tables?.[table]
      if (t == null) return { data: null, error: null }
      return typeof t === 'function' ? t(calls.filter(c => c.table === table)) : t
    }
    for (const op of ['select', 'eq', 'in', 'order', 'limit', 'insert', 'update', 'delete']) {
      chain[op] = (...args: unknown[]) => { calls.push({ table, op, args }); return chain }
    }
    chain.maybeSingle = () => { calls.push({ table, op: 'maybeSingle', args: [] }); return Promise.resolve(resolve()) }
    chain.single      = () => { calls.push({ table, op: 'single', args: [] });      return Promise.resolve(resolve()) }
    // Awaiting the builder itself resolves the query (PostgREST's thenable).
    chain.then = (onOk: (v: TableResult) => unknown, onErr?: (e: unknown) => unknown) =>
      Promise.resolve(resolve()).then(onOk, onErr)
    return chain
  }

  const svc = {
    from: (table: string) => builder(table),
    rpc: (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args })
      return Promise.resolve(opts.rpc ? opts.rpc(name, args) : { data: 'rpc-id', error: null })
    },
  } as unknown as Svc

  return { svc, calls, rpcCalls }
}

const EMP   = '11111111-1111-4111-8111-111111111111'
const ADMIN = '22222222-2222-4222-8222-222222222222'
const TX    = '33333333-3333-4333-8333-333333333333'

// ─── Reads ────────────────────────────────────────────────────────────────────

describe('getCreditBalance reads the derived view', () => {
  test('an employee with no ledger rows has zero', async () => {
    const { svc, calls } = fakeClient()
    assert.equal(await getCreditBalance(svc, EMP), 0)
    assert.equal(calls[0].table, 'boe_credit_balances', 'the VIEW, not the ledger table')
    assert.deepEqual(calls.find(c => c.op === 'eq')?.args, ['employee_id', EMP])
  })

  test('the view row is returned as a number', async () => {
    const { svc } = fakeClient({ tables: { boe_credit_balances: { data: { available_credits: '150' }, error: null } } })
    assert.equal(await getCreditBalance(svc, EMP), 150)
  })

  test('a read failure is a CreditServiceError, not a silent zero', async () => {
    const { svc } = fakeClient({ tables: { boe_credit_balances: { data: null, error: { message: 'boom', code: '42P01' } } } })
    await assert.rejects(() => getCreditBalance(svc, EMP), (e: unknown) => e instanceof CreditServiceError && e.sqlstate === '42P01')
  })
})

describe('getCreditTransactions', () => {
  test('is pinned to the employee, newest first, and clamps the limit', async () => {
    const { svc, calls } = fakeClient({ tables: { boe_credit_transactions: { data: [], error: null } } })
    await getCreditTransactions(svc, EMP, { limit: 9_999 })
    assert.deepEqual(calls.find(c => c.op === 'eq')?.args, ['employee_id', EMP])
    assert.deepEqual(calls.filter(c => c.op === 'order').map(c => c.args), [
      ['created_at', { ascending: false }],
      ['id', { ascending: false }],
    ])
    assert.deepEqual(calls.find(c => c.op === 'limit')?.args, [500])
  })

  test('a type filter becomes an IN, and the default limit is 100', async () => {
    const { svc, calls } = fakeClient({ tables: { boe_credit_transactions: { data: [], error: null } } })
    await getCreditTransactions(svc, EMP, { types: ['admin_adjustment'] })
    assert.deepEqual(calls.find(c => c.op === 'in')?.args, ['transaction_type', ['admin_adjustment']])
    assert.deepEqual(calls.find(c => c.op === 'limit')?.args, [100])
  })
})

describe('getAllCreditBalances', () => {
  test('active employees with no rows show zero; inactive ones appear only with history; sorted by name', async () => {
    const { svc } = fakeClient({
      tables: {
        boe_credit_balances: {
          data: [
            { employee_id: 'u-zed', available_credits: 40, transaction_count: 2, last_transaction_at: '2026-09-01T00:00:00Z' },
            { employee_id: 'u-gone', available_credits: 5, transaction_count: 1, last_transaction_at: '2026-08-01T00:00:00Z' },
          ],
          error: null,
        },
        users: {
          data: [
            { id: 'u-zed',   full_name: 'Zed',   employee_code: 'BOE-002', is_active: true,  is_deleted: false },
            { id: 'u-amy',   full_name: 'Amy',   employee_code: null,      is_active: true,  is_deleted: false },
            { id: 'u-gone',  full_name: 'Gone',  employee_code: 'BOE-009', is_active: false, is_deleted: false },
            { id: 'u-never', full_name: 'Never', employee_code: null,      is_active: false, is_deleted: false },
          ],
          error: null,
        },
      },
    })
    const rows = await getAllCreditBalances(svc)
    assert.deepEqual(rows.map(r => [r.full_name, r.available_credits, r.transaction_count]), [
      ['Amy', 0, 0],
      ['Gone', 5, 1],
      ['Zed', 40, 2],
    ])
  })
})

// ─── Writes ───────────────────────────────────────────────────────────────────

describe('postCreditTransaction refuses before the round trip', () => {
  const base = {
    employeeId: EMP, transactionType: 'admin_adjustment' as const, credits: 10,
    sourceType: 'manual', sourceId: null, description: 'Missed August reward', actorId: ADMIN,
  }

  test('zero credits', async () => {
    const { svc, rpcCalls } = fakeClient()
    await assert.rejects(
      () => postCreditTransaction(svc, { ...base, credits: 0 }),
      (e: unknown) => e instanceof CreditServiceError && e.marker === 'BOE_CREDITS_ZERO',
    )
    assert.equal(rpcCalls.length, 0)
  })

  test('an unknown kind', async () => {
    const { svc, rpcCalls } = fakeClient()
    await assert.rejects(
      () => postCreditTransaction(svc, { ...base, transactionType: 'bonus' as never }),
      (e: unknown) => e instanceof CreditServiceError && e.marker === 'BOE_CREDITS_TYPE',
    )
    assert.equal(rpcCalls.length, 0)
  })

  test('an adjustment without a reason', async () => {
    const { svc, rpcCalls } = fakeClient()
    await assert.rejects(
      () => postCreditTransaction(svc, { ...base, description: '   ' }),
      (e: unknown) => e instanceof CreditServiceError && e.marker === 'BOE_CREDITS_REASON',
    )
    assert.equal(rpcCalls.length, 0)
  })

  test('an adjustment that smuggles a source id', async () => {
    const { svc } = fakeClient()
    await assert.rejects(
      () => postCreditTransaction(svc, { ...base, sourceId: TX }),
      (e: unknown) => e instanceof CreditServiceError && e.marker === 'BOE_CREDITS_SOURCE',
    )
  })

  test('a reward without a source', async () => {
    const { svc } = fakeClient()
    await assert.rejects(
      () => postCreditTransaction(svc, { ...base, transactionType: 'review_reward', sourceType: 'manual', sourceId: null, description: null }),
      (e: unknown) => e instanceof CreditServiceError && e.marker === 'BOE_CREDITS_SOURCE',
    )
  })
})

describe('postCreditTransaction calls the one write path', () => {
  test('with exactly the arguments post_boe_credit_transaction() takes, and never an INSERT', async () => {
    const { svc, calls, rpcCalls } = fakeClient()
    const out = await postAdminAdjustment(svc, { employeeId: EMP, credits: -25, reason: 'Duplicate reward', actorId: ADMIN })
    assert.equal(out.id, 'rpc-id')
    assert.equal(rpcCalls.length, 1)
    assert.equal(rpcCalls[0].name, 'post_boe_credit_transaction')
    assert.deepEqual(rpcCalls[0].args, {
      p_employee_id: EMP,
      p_transaction_type: 'admin_adjustment',
      p_credits: -25,
      p_source_type: 'manual',
      p_source_id: null,
      p_description: 'Duplicate reward',
      p_actor_id: ADMIN,
      p_payroll_period_id: null,
    })
    assert.equal(calls.filter(c => c.op === 'insert').length, 0, 'the service never inserts into the ledger')
  })

  test('a future review reward carries its source', async () => {
    const { svc, rpcCalls } = fakeClient()
    await postCreditTransaction(svc, {
      employeeId: EMP, transactionType: 'review_reward', credits: 100,
      sourceType: 'customer_review', sourceId: TX, description: null, actorId: null,
    })
    assert.equal(rpcCalls[0].args.p_source_type, 'customer_review')
    assert.equal(rpcCalls[0].args.p_source_id, TX)
    assert.equal(rpcCalls[0].args.p_actor_id, null, 'a system actor is null')
  })

  test("the database's refusal is surfaced with its marker and a status", async () => {
    const { svc } = fakeClient({
      rpc: () => ({ data: null, error: { message: 'BOE_CREDITS_DUPLICATE_SOURCE: this review_reward has already been recorded for this source', code: '23505' } }),
    })
    await assert.rejects(
      () => postCreditTransaction(svc, {
        employeeId: EMP, transactionType: 'review_reward', credits: 100,
        sourceType: 'customer_review', sourceId: TX, description: null, actorId: null,
      }),
      (e: unknown) => {
        assert.ok(e instanceof CreditServiceError)
        assert.equal(e.marker, 'BOE_CREDITS_DUPLICATE_SOURCE')
        assert.equal(e.sqlstate, '23505')
        assert.equal(e.message, 'this review_reward has already been recorded for this source')
        assert.equal(creditErrorStatus(e), 409)
        return true
      },
    )
  })
})

describe('reverseCreditTransaction', () => {
  test('needs a reason, then calls reverse_boe_credit_transaction() with the actor', async () => {
    const { svc, rpcCalls } = fakeClient()
    await assert.rejects(
      () => reverseCreditTransaction(svc, { transactionId: TX, reason: '', actorId: ADMIN }),
      (e: unknown) => e instanceof CreditServiceError && e.marker === 'BOE_CREDITS_REASON',
    )
    assert.equal(rpcCalls.length, 0)

    await reverseCreditTransaction(svc, { transactionId: TX, reason: 'Posted to the wrong person', actorId: ADMIN })
    assert.deepEqual(rpcCalls[0], {
      name: 'reverse_boe_credit_transaction',
      args: { p_transaction_id: TX, p_actor_id: ADMIN, p_reason: 'Posted to the wrong person' },
    })
  })
})

describe('error mapping', () => {
  test('every marker has a status, and an unmarked failure is a 500', () => {
    const cases: [string, number][] = [
      ['BOE_CREDITS_DENIED', 403],
      ['BOE_CREDITS_APPEND_ONLY', 403],
      ['BOE_CREDITS_EMPLOYEE', 404],
      ['BOE_CREDITS_ACTOR', 404],
      ['BOE_CREDITS_DUPLICATE_SOURCE', 409],
      ['BOE_CREDITS_INSUFFICIENT', 409],
      ['BOE_CREDITS_ZERO', 422],
      ['BOE_CREDITS_REASON', 422],
      ['BOE_CREDITS_REVERSAL', 422],
    ]
    for (const [marker, status] of cases) {
      assert.equal(creditErrorStatus(creditErrorFrom({ message: `${marker}: x` }, 'f')), status, marker)
    }
    const plain = creditErrorFrom({ message: 'connection reset' }, 'fallback')
    assert.equal(plain.marker, null)
    assert.equal(creditErrorStatus(plain), 500)
    assert.equal(creditErrorFrom(null, 'fallback').message, 'fallback')
  })
})

// ─── Settings ─────────────────────────────────────────────────────────────────

describe('settings', () => {
  test('the active row is the newest, parsed; a missing table falls back to the defaults and says so', async () => {
    const { svc, calls } = fakeClient({
      tables: { boe_credit_settings: { data: { id: 's1', review_reward_credits: '150', credit_value: '2.00', created_at: 't', created_by: ADMIN }, error: null } },
    })
    const active = await fetchActiveCreditSettings(svc)
    assert.deepEqual(active.settings, { review_reward_credits: 150, credit_value: 2 })
    assert.equal(active.fell_back, false)
    assert.deepEqual(calls.find(c => c.op === 'order')?.args, ['created_at', { ascending: false }])

    const empty = await fetchActiveCreditSettings(fakeClient().svc)
    assert.deepEqual(empty.settings, DEFAULT_BOE_CREDIT_SETTINGS)
    assert.equal(empty.fell_back, true)
  })

  test('saving is an INSERT of a new row, never an UPDATE, and refuses invalid values', async () => {
    const { svc, calls } = fakeClient({ tables: { boe_credit_settings: { data: { id: 's2', created_at: 't2' }, error: null } } })
    const saved = await saveCreditSettings(svc, { review_reward_credits: 120, credit_value: 1.5 }, ADMIN, 'Raised for Q4')
    assert.deepEqual(saved, { id: 's2', created_at: 't2' })
    const insert = calls.find(c => c.op === 'insert')
    assert.deepEqual(insert?.args, [{ review_reward_credits: 120, credit_value: 1.5, created_by: ADMIN, note: 'Raised for Q4' }])
    assert.equal(calls.some(c => c.op === 'update'), false)

    await assert.rejects(
      () => saveCreditSettings(svc, { review_reward_credits: 0, credit_value: 1 }, ADMIN),
      (e: unknown) => e instanceof CreditServiceError && e.marker === 'BOE_CREDITS_SETTINGS',
    )
  })
})
