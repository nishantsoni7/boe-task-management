/**
 * CORRECT ALLOCATION — the rules and the send path, without a browser.
 *
 * The screen is src/app/finance/received/CorrectAllocationModal.tsx; its rules
 * and its one network path are src/lib/finance/allocationCorrection.ts, tested
 * here against a fake client that records every call. The database half —
 * reverse_payment_allocation() refusing a caller without
 * finance.allocate_correct, refusing a blank reason, keeping the row — is
 * pinned from the migration text below and proved by
 * supabase/tests/finance_payment_allocation_assertions.sql.
 *
 * Amounts are deliberately not round (₹7,50,000.55 split 4,00,000.25 /
 * 2,00,000.20 / 1,50,000.10) so a sum taken from the wrong field, or in float,
 * cannot pass by coincidence.
 *
 * Run:
 *   npx tsx --test src/lib/finance/allocationCorrection.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  buildAllocationLedger,
  correctionBlockedReason,
  correctionPosition,
  ledgerTargetName,
  performAllocationReversal,
  reversalErrorMessage,
  staleAllocationReason,
  unallocatedAfterReversal,
  CORRECTION_REASON_MAX,
  type AllocationLedgerEntry,
  type LedgerAllocationRow,
} from './allocationCorrection'
import { deriveFinanceCapabilities } from '@/lib/permissions/finance'
import type { EffectivePermission } from '@/lib/permissions/types'

const ORDER_524 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ORDER_529 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const PI_019    = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

const PAYMENT_AMOUNT = '750000.55'

function row(id: string, amount: string, target: { order?: string; submission?: string }, extra: Partial<LedgerAllocationRow> = {}): LedgerAllocationRow {
  return {
    id,
    allocated_amount: amount,
    status: 'active',
    order_id: target.order ?? null,
    order_submission_id: target.submission ?? null,
    created_at: '2026-09-10T05:00:00.000Z',
    ...extra,
  }
}

const TARGETS = [
  { id: ORDER_524, reference: '0524', clientName: 'Hotel Aurum' },
  { id: ORDER_529, reference: '0529', clientName: 'Hotel Aurum' },
  { id: PI_019,    reference: '019',  clientName: 'Cafe Verde' },
]

/** A split payment: two Orders and one PI Draft, fully allocated. */
function splitLedger(): AllocationLedgerEntry[] {
  return buildAllocationLedger([
    row('alloc-1', '400000.25', { order: ORDER_524 }, { created_at: '2026-09-10T05:00:00.000Z' }),
    row('alloc-2', '200000.20', { order: ORDER_529 }, { created_at: '2026-09-10T06:00:00.000Z' }),
    row('alloc-3', '150000.10', { submission: PI_019 }, { created_at: '2026-09-10T07:00:00.000Z' }),
  ], TARGETS)
}

// ─────────────────────────────────────────────────────────────────────────────

describe('the ledger this screen shows', () => {
  test('a split payment lists every active allocation with its target, customer and amount', () => {
    const ledger = splitLedger()
    assert.deepEqual(
      ledger.map(e => [ledgerTargetName(e), e.clientName, e.amount, e.status]),
      [
        ['Order 0524',   'Hotel Aurum', '400000.25', 'active'],
        ['Order 0529',   'Hotel Aurum', '200000.20', 'active'],
        ['PI Draft 019', 'Cafe Verde',  '150000.10', 'active'],
      ])
  })

  test('mixed PI Draft and Order allocations keep their own kind', () => {
    const kinds = splitLedger().map(e => e.kind)
    assert.deepEqual(kinds, ['order', 'order', 'submission'])
  })

  test('a reversed allocation stays in the ledger, after the active ones, with actor, time and reason', () => {
    const ledger = buildAllocationLedger([
      row('alloc-old', '100000.00', { order: ORDER_524 }, {
        status: 'reversed',
        reversed_at: '2026-09-12T09:30:00.000Z',
        reversal_reason: 'Customer asked to adjust against Order 529',
        reverser: { full_name: 'Asha Finance' },
      }),
      row('alloc-new', '100000.00', { order: ORDER_529 }),
    ], TARGETS)
    assert.deepEqual(ledger.map(e => e.status), ['active', 'reversed'])
    const reversed = ledger[1]
    assert.equal(reversed.reversedByName, 'Asha Finance')
    assert.equal(reversed.reversedAt, '2026-09-12T09:30:00.000Z')
    assert.equal(reversed.reversalReason, 'Customer asked to adjust against Order 529')
    assert.equal(ledgerTargetName(reversed), 'Order 0524', 'the original target is still named')
  })

  test('a target the reader may not open is named by its kind, never by a uuid', () => {
    const [entry] = buildAllocationLedger([row('x', '10.00', { order: ORDER_524 })], [])
    assert.equal(ledgerTargetName(entry), 'A Confirmed Order')
    assert.equal(entry.clientName, null)
  })

  test('the reverser embed may arrive as an array (PostgREST to-one quirk)', () => {
    const [entry] = buildAllocationLedger([row('x', '10.00', { order: ORDER_524 }, {
      status: 'reversed', reverser: [{ full_name: 'Ravi' }],
    })], TARGETS)
    assert.equal(entry.reversedByName, 'Ravi')
  })
})

describe('the payment position before and after a reversal', () => {
  test('a fully allocated split payment shows zero unallocated, exactly', () => {
    const pos = correctionPosition(PAYMENT_AMOUNT, splitLedger())
    assert.equal(pos.allocated, '750000.55')
    assert.equal(pos.unallocated, '0.00')
    assert.equal(pos.activeCount, 3)
  })

  test('reversing releases the WHOLE allocation into the unallocated balance', () => {
    assert.equal(unallocatedAfterReversal(PAYMENT_AMOUNT, splitLedger(), 'alloc-2'), '200000.20')
  })

  test('reversed allocations never count as allocated', () => {
    const ledger = splitLedger().map(e => e.allocationId === 'alloc-1' ? { ...e, status: 'reversed' as const } : e)
    const pos = correctionPosition(PAYMENT_AMOUNT, ledger)
    assert.equal(pos.allocated, '350000.30')
    assert.equal(pos.unallocated, '400000.25')
  })

  test('the payment amount is an input only — nothing here produces a new amount', () => {
    // The figures are derived from the unchanged payment amount minus active
    // allocations, the same derivation the database uses. There is no field
    // on any outcome that could carry a changed payment amount.
    const before = correctionPosition(PAYMENT_AMOUNT, splitLedger())
    const after = correctionPosition(PAYMENT_AMOUNT, splitLedger().filter(e => e.allocationId !== 'alloc-3'))
    assert.deepEqual([before.allocated, before.unallocated], ['750000.55', '0.00'])
    assert.deepEqual([after.allocated, after.unallocated], ['600000.45', '150000.10'])
  })
})

describe('what stops the person before anything is sent', () => {
  const [first] = splitLedger()

  test('an allocation must be chosen', () => {
    assert.match(correctionBlockedReason({ selected: null, reason: 'x' }) ?? '', /Choose the allocation/)
  })

  test('the reason is mandatory, and whitespace is not a reason', () => {
    assert.match(correctionBlockedReason({ selected: first, reason: '' }) ?? '', /reason/)
    assert.match(correctionBlockedReason({ selected: first, reason: '   \n ' }) ?? '', /reason/)
    assert.equal(correctionBlockedReason({ selected: first, reason: 'Wrong Order' }), null)
  })

  test('an over-long reason is refused before it reaches the server', () => {
    assert.match(correctionBlockedReason({ selected: first, reason: 'x'.repeat(CORRECTION_REASON_MAX + 1) }) ?? '', /under/)
  })

  test('a reversed allocation cannot be chosen again', () => {
    assert.match(correctionBlockedReason({ selected: { ...first, status: 'reversed' }, reason: 'x' }) ?? '', /already been reversed/)
  })

  test('a fully allocated payment can still be corrected', () => {
    // Allocate Funds is not offered on a "full" payment; correction must be.
    assert.equal(correctionPosition(PAYMENT_AMOUNT, splitLedger()).unallocated, '0.00')
    assert.equal(correctionBlockedReason({ selected: first, reason: 'Wrong Order' }), null)
  })
})

describe('stale screens and concurrent corrections', () => {
  const [shown] = splitLedger()
  const fresh = { id: shown.allocationId, status: 'active', order_id: ORDER_524, order_submission_id: null, allocated_amount: '400000.25' }

  test('an unchanged allocation is not stale', () => {
    assert.equal(staleAllocationReason(shown, fresh), null)
  })

  test('already reversed by somebody else', () => {
    assert.match(staleAllocationReason(shown, { ...fresh, status: 'reversed' }) ?? '', /Someone else has already reversed/)
  })

  test('moved from its PI Draft onto the Order the PI became', () => {
    const [, , pi] = splitLedger()
    const moved = { id: pi.allocationId, status: 'active', order_id: ORDER_529, order_submission_id: null, allocated_amount: pi.amount }
    assert.match(staleAllocationReason(pi, moved) ?? '', /different record/)
  })

  test('no longer readable', () => {
    assert.match(staleAllocationReason(shown, null) ?? '', /can no longer be found/)
  })

  test('every stale message says nothing was changed', () => {
    for (const msg of [
      staleAllocationReason(shown, null),
      staleAllocationReason(shown, { ...fresh, status: 'reversed' }),
      staleAllocationReason(shown, { ...fresh, order_id: ORDER_529 }),
      staleAllocationReason(shown, { ...fresh, allocated_amount: '1.00' }),
    ]) {
      assert.match(msg ?? '', /Nothing was changed/)
    }
  })
})

describe('server refusals are worded, and say that nothing changed', () => {
  test('permission refused (42501)', () => {
    const msg = reversalErrorMessage('You do not have permission to correct payment allocations', '42501')
    assert.match(msg, /do not have permission/)
    assert.match(msg, /Nothing was changed/)
    assert.match(msg, /Correct Payment Allocations/, 'names the permission as the Access Control screen does')
  })
  test('blank reason', () => assert.match(reversalErrorMessage('ALLOCATION_REASON_REQUIRED: …'), /reason is required/))
  test('not found', () => assert.match(reversalErrorMessage('ALLOCATION_NOT_FOUND: allocation x not found'), /can no longer be found/))
  test('unknown text never leaks', () => {
    const msg = reversalErrorMessage('relation "finance_payment_allocations" does not exist')
    assert.ok(!msg.includes('relation'))
    assert.match(msg, /Nothing was changed/)
  })
})

// ── The send path, against a fake client that records every call ────────────

type Call = { kind: 'select' | 'rpc'; table?: string; fn?: string; args?: unknown }

function fakeClient(opts: {
  fresh?: Record<string, unknown> | null
  readError?: boolean
  rpcData?: unknown
  rpcError?: { message: string; code?: string } | null
}) {
  const calls: Call[] = []
  const client = {
    from(table: string) {
      const builder = {
        select() { calls.push({ kind: 'select', table }); return builder },
        eq() { return builder },
        maybeSingle: async () => opts.readError
          ? { data: null, error: { message: 'boom' } }
          : { data: opts.fresh === undefined ? null : opts.fresh, error: null },
        // Any write method would be a defect; make it visible.
        insert() { throw new Error(`insert into ${table}`) },
        update() { throw new Error(`update on ${table}`) },
        delete() { throw new Error(`delete on ${table}`) },
      }
      return builder
    },
    async rpc(fn: string, args: unknown) {
      calls.push({ kind: 'rpc', fn, args })
      return { data: opts.rpcData ?? null, error: opts.rpcError ?? null }
    },
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: client as any, calls }
}

describe('performAllocationReversal', () => {
  const [target] = splitLedger()
  const freshRow = { id: target.allocationId, status: 'active', order_id: ORDER_524, order_submission_id: null, allocated_amount: '400000.25' }

  test('success is reported only from the server answer, with the server balance', async () => {
    const { client, calls } = fakeClient({
      fresh: freshRow,
      rpcData: { already_reversed: false, unallocated_balance: 400000.25, reversed_at: '2026-09-18T10:00:00Z' },
    })
    const out = await performAllocationReversal(client, { allocation: target, reason: '  Wrong Order  ' })
    assert.deepEqual(out, { kind: 'reversed', unallocatedBalance: '400000.25', reversedAt: '2026-09-18T10:00:00Z' })
    // Exactly one read and one reversal — no payment write, no new allocation,
    // no copy of anything.
    assert.deepEqual(calls, [
      { kind: 'select', table: 'finance_payment_allocations' },
      { kind: 'rpc', fn: 'reverse_payment_allocation', args: { p_allocation_id: 'alloc-1', p_reason: 'Wrong Order' } },
    ])
  })

  test('a missing reason never reaches the server', async () => {
    const { client, calls } = fakeClient({ fresh: freshRow })
    const out = await performAllocationReversal(client, { allocation: target, reason: '  ' })
    assert.equal(out.kind, 'refused')
    assert.equal(calls.length, 0)
  })

  test('a stale allocation is refused before the RPC', async () => {
    const { client, calls } = fakeClient({ fresh: { ...freshRow, status: 'reversed' } })
    const out = await performAllocationReversal(client, { allocation: target, reason: 'Wrong Order' })
    assert.equal(out.kind, 'stale')
    assert.ok(!calls.some(c => c.kind === 'rpc'), 'nothing may be sent for a stale allocation')
  })

  test('a race lost in the last milliseconds is reported as already reversed, not as success', async () => {
    const { client } = fakeClient({ fresh: freshRow, rpcData: { already_reversed: true } })
    const out = await performAllocationReversal(client, { allocation: target, reason: 'Wrong Order' })
    assert.equal(out.kind, 'already_reversed')
    assert.match((out as { message: string }).message, /Nothing was changed by you/)
  })

  test('the server refusing the permission is shown as a refusal', async () => {
    const { client } = fakeClient({
      fresh: freshRow,
      rpcError: { message: 'You do not have permission to correct payment allocations', code: '42501' },
    })
    const out = await performAllocationReversal(client, { allocation: target, reason: 'Wrong Order' })
    assert.equal(out.kind, 'refused')
    assert.match((out as { message: string }).message, /do not have permission/)
  })

  test('a failed pre-check read sends nothing', async () => {
    const { client, calls } = fakeClient({ readError: true })
    const out = await performAllocationReversal(client, { allocation: target, reason: 'Wrong Order' })
    assert.equal(out.kind, 'refused')
    assert.ok(!calls.some(c => c.kind === 'rpc'))
  })
})

// ── Who may see the control ──────────────────────────────────────────────────

function perm(actionKey: string): EffectivePermission {
  return { actionKey, allowed: true } as unknown as EffectivePermission
}

describe('who is offered Correct Allocation', () => {
  test('nobody without finance.allocate_correct', () => {
    assert.equal(deriveFinanceCapabilities('employee', []).canCorrectPaymentAllocation, false)
    assert.equal(deriveFinanceCapabilities('employee', [perm('view')]).canCorrectPaymentAllocation, false)
  })

  test('finance.allocate alone does not confer it', () => {
    const caps = deriveFinanceCapabilities('employee', [perm('view'), perm('allocate')])
    assert.equal(caps.canAllocatePayment, true)
    assert.equal(caps.canCorrectPaymentAllocation, false)
  })

  test('finance.allocate_correct with module entry does', () => {
    const caps = deriveFinanceCapabilities('employee', [perm('view'), perm('allocate_correct')])
    assert.equal(caps.canCorrectPaymentAllocation, true)
    assert.equal(caps.canAllocatePayment, false, 'and it does not confer allocating')
  })

  test('a leftover allocate_correct grant without Finance entry draws nothing', () => {
    assert.equal(deriveFinanceCapabilities('employee', [perm('allocate_correct')]).canCorrectPaymentAllocation, false)
  })

  test('an administrator is offered it, matching actor_has_module_permission', () => {
    assert.equal(deriveFinanceCapabilities('admin', []).canCorrectPaymentAllocation, true)
  })

  test('the page passes the control only to a holder of the capability', () => {
    const view = readFileSync(join('src', 'app', 'finance', 'received', 'ReceivedPaymentsView.tsx'), 'utf8')
    assert.ok(/onCorrectAllocation=\{caps\.canCorrectPaymentAllocation\s*\?/.test(view),
      'the Correct Allocation door must be gated on canCorrectPaymentAllocation')
  })
})

// ── The database is the final authority ──────────────────────────────────────

describe('reverse_payment_allocation() is the only path, and it decides', () => {
  const sql = readFileSync(join('supabase', 'migrations', '20260918000000_finance_payment_allocations.sql'), 'utf8')
    .split('\r\n').join('\n')
  const body = sql.slice(
    sql.indexOf('create or replace function public.reverse_payment_allocation('),
    sql.indexOf('comment on function public.reverse_payment_allocation('))

  test('it is SECURITY DEFINER with a fixed search path', () => {
    assert.ok(body.includes('security definer'))
    assert.ok(body.includes('set search_path = public, pg_temp'))
  })

  test('it requires finance.allocate_correct, not finance.allocate', () => {
    assert.ok(body.includes("actor_has_module_permission('finance', 'allocate_correct')"))
    assert.ok(!body.includes("'allocate')"), 'finance.allocate must not be an alternative route')
  })

  test('it refuses a blank reason', () => assert.ok(body.includes('ALLOCATION_REASON_REQUIRED')))

  test('it locks the payment, then the allocation', () => {
    const pay = body.indexOf('from public.finance_payment_requests')
    const alloc = body.lastIndexOf('from public.finance_payment_allocations\n  where id = p_allocation_id\n  for update')
    assert.ok(pay > 0 && body.slice(pay, pay + 120).includes('for update'), 'the payment is locked')
    assert.ok(alloc > pay, 'the allocation is locked after the payment')
  })

  test('it keeps the row — an UPDATE to reversed, never a DELETE, never an INSERT', () => {
    assert.ok(body.includes("set status          = 'reversed'"))
    assert.ok(!/\bdelete\s+from\b/i.test(body))
    assert.ok(!/\binsert\s+into\b/i.test(body))
    assert.ok(!/update\s+public\.finance_payment_requests/i.test(body), 'the payment row is not written')
  })

  test('it is idempotent and says so', () => assert.ok(body.includes("'already_reversed',     true")))

  test('only authenticated callers may execute it', () => {
    assert.ok(sql.includes('revoke execute on function public.reverse_payment_allocation(uuid, text) from public, anon;'))
    assert.ok(sql.includes('grant  execute on function public.reverse_payment_allocation(uuid, text) to authenticated;'))
  })

  test('the SQL suite proves an allocate-only caller is refused', () => {
    const suite = readFileSync(join('supabase', 'tests', 'finance_payment_allocation_assertions.sql'), 'utf8')
    assert.ok(suite.includes("'finance.allocate alone must not be able to reverse an allocation'"))
    assert.ok(suite.includes("'reversal must PRESERVE the row — nothing may be deleted'"))
    assert.ok(suite.includes("'reversing a 400 allocation must return 400 to the unallocated balance'"))
  })

  test('PI and Order totals count ACTIVE allocations only, so a reversal moves them', () => {
    const order = readFileSync(join('supabase', 'migrations', '20261012000000_allocation_ledger_as_single_source.sql'), 'utf8')
    const orderFn = order.slice(order.indexOf('create or replace function public.order_linked_payment_total'))
    assert.ok(orderFn.slice(0, 2000).includes("a.status = 'active'"))
    const pi = readFileSync(join('supabase', 'migrations', '20261119000000_order_submission_pi_review_gate_versions_and_production.sql'), 'utf8')
    const piFn = pi.slice(pi.indexOf('create or replace function public.pi_submission_payment_summary'))
    assert.ok(piFn.slice(0, 6000).includes("a.status = 'active'"))
  })
})
