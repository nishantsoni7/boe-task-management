/**
 * ALLOCATING TO AN OLD ORDER THAT IS NOT IN THE SYSTEM (20270407000000).
 *
 * The pure rules: how an old order number is normalised (the same way the
 * database does), what stops a row before it is sent, what goes over the wire,
 * and how an old-order allocation reads on every surface that lists allocations.
 * The SQL itself is executed by supabase/tests/run_allocate_old_order_suite.sh
 * on a disposable database.
 *
 * Offline and pure.
 *
 * Run:
 *   npx tsx --test src/lib/finance/legacyOrderAllocation.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  LEGACY_CLIENT_NAME_MAX,
  LEGACY_ORDER_NO_MAX,
  legacyAllocationErrorMessage,
  legacyOrderLabel,
  legacyRowProblem,
  legacyTargetKey,
  normalizeLegacyClientName,
  normalizeLegacyOrderNo,
  toLegacyRpcTarget,
} from './legacyOrderAllocation'
import {
  EMPTY_ALLOCATION_ROW,
  duplicateTargetKeys,
  splitPaymentBlockedReason,
  splitPaymentIsDirty,
  splitPaymentRowsChanged,
  targetKey,
  toRpcAllocationsWithLegacy,
  type SplitAllocationRow,
} from './splitPaymentEntry'
import { allocateFundsBlockedReason } from '@/app/finance/received/AllocateFundsModal'
import { allocationErrorMessage } from '@/app/finance/received/AllocatePaymentModal'
import {
  buildAllocatedAgainst,
  allocatedAgainstText,
  completeAllocationSummary,
  type AllocationTargetRow,
} from './allocatedAgainst'
import { buildAllocationLedger, ledgerTargetName, type LedgerRpcRow } from './allocationCorrection'
import { summarizePaymentAllocations } from './paymentAllocations'
import { paymentLinks } from './paymentLinks'
import { paymentActivityLabel } from './paymentActivityLabels'
import { describePaymentAllocations } from './paymentDeletion'
import { customerTargetLabel, mixedCustomerCheck, rowCustomerTargets } from './mixedCustomers'

const legacyRow = (patch: Partial<SplitAllocationRow> = {}): SplitAllocationRow => ({
  ...EMPTY_ALLOCATION_ROW('k'),
  legacy: true,
  legacyOrderNo: 'ab-12',
  clientName: 'Old Client',
  amount: '1000',
  ...patch,
})

describe('the old order number and client, as the database stores them', () => {
  test('an order number is trimmed, spaces collapsed, upper-cased', () => {
    assert.equal(normalizeLegacyOrderNo('  ab   12 '), 'AB 12')
    assert.equal(normalizeLegacyOrderNo('ab-12'), 'AB-12')
    assert.equal(normalizeLegacyOrderNo(null), '')
  })

  test('"ab-12" and " AB-12 " are one old order, so one claim per payment', () => {
    assert.equal(legacyTargetKey('ab-12'), legacyTargetKey(' AB-12 '))
    assert.equal(legacyTargetKey('  '), null)
    const dup = duplicateTargetKeys([legacyRow(), legacyRow({ key: 'k2', legacyOrderNo: ' AB-12 ' })])
    assert.deepEqual([...dup], ['legacy:AB-12'])
  })

  test('an old order never collides with an Order or a PI Draft that has the same text', () => {
    const order: SplitAllocationRow = { ...EMPTY_ALLOCATION_ROW('o'), kind: 'order', targetId: 'AB-12', amount: '1' }
    assert.equal(duplicateTargetKeys([order, legacyRow()]).size, 0)
    assert.equal(targetKey(legacyRow()), 'legacy:AB-12')
    assert.equal(targetKey(legacyRow({ legacyOrderNo: '' })), null)
  })

  test('a client name is trimmed and its spaces collapsed, never re-cased', () => {
    assert.equal(normalizeLegacyClientName('  Hotel   Aurum '), 'Hotel Aurum')
  })

  test('the label names the order and, when known, the client', () => {
    assert.equal(legacyOrderLabel('ab-12', ' Old Client '), 'Old order AB-12 · Old Client')
    assert.equal(legacyOrderLabel('ab-12'), 'Old order AB-12')
    assert.equal(legacyOrderLabel(''), 'Old order')
  })
})

describe('what stops an old-order row before it is sent', () => {
  test('both facts are required, each named by its row', () => {
    assert.match(legacyRowProblem({ legacyOrderNo: ' ', clientName: 'C' }, 2) ?? '', /Allocation 2: enter the old order number/)
    assert.match(legacyRowProblem({ legacyOrderNo: 'A', clientName: '  ' }, 3) ?? '', /Allocation 3: enter the client/)
    assert.equal(legacyRowProblem({ legacyOrderNo: 'A', clientName: 'C' }, 1), null)
  })

  test('the database limits are the form limits', () => {
    assert.ok(legacyRowProblem({ legacyOrderNo: 'X'.repeat(LEGACY_ORDER_NO_MAX + 1), clientName: 'C' }, 1))
    assert.equal(legacyRowProblem({ legacyOrderNo: 'X'.repeat(LEGACY_ORDER_NO_MAX), clientName: 'C' }, 1), null)
    assert.ok(legacyRowProblem({ legacyOrderNo: 'A', clientName: 'C'.repeat(LEGACY_CLIENT_NAME_MAX + 1) }, 1))
    const sql = readFileSync(join(process.cwd(), 'supabase/migrations/20270407000000_finance_allocate_to_old_order.sql'), 'utf8')
    assert.ok(sql.includes(`length(legacy_order_no) <= ${LEGACY_ORDER_NO_MAX}`))
    assert.ok(sql.includes(`length(legacy_client_name) <= ${LEGACY_CLIENT_NAME_MAX}`))
  })

  test('Allocate Funds accepts a lone old-order row and refuses an incomplete one', () => {
    const payment = { id: 'p', human_payment_id: 'P-AA-0021', amount: 300000, allocated_total: 0 }
    assert.equal(allocateFundsBlockedReason({ payment, rows: [legacyRow({ amount: '300000' })] }), null)
    assert.match(
      allocateFundsBlockedReason({ payment, rows: [legacyRow({ clientName: '' })] }) ?? '',
      /enter the client/,
    )
    // an untouched "Old order" row (nothing typed yet) is a row, not nothing
    assert.match(
      allocateFundsBlockedReason({ payment, rows: [legacyRow({ legacyOrderNo: '', clientName: '', amount: '' })] }) ?? '',
      /enter the old order number/,
    )
  })

  test('the spending rule is unchanged: an old order cannot take more than is left', () => {
    const payment = { id: 'p', human_payment_id: 'P-AA-0021', amount: 100, allocated_total: 40 }
    assert.match(
      allocateFundsBlockedReason({ payment, rows: [legacyRow({ amount: '60.01' })] }) ?? '',
      /more than this payment has left/,
    )
    assert.equal(allocateFundsBlockedReason({ payment, rows: [legacyRow({ amount: '60' })] }), null)
  })

  test('the same old order twice is the duplicate refusal', () => {
    const payment = { id: 'p', human_payment_id: 'P', amount: 1000, allocated_total: 0 }
    assert.match(
      allocateFundsBlockedReason({
        payment,
        rows: [legacyRow({ amount: '10' }), legacyRow({ key: 'k2', legacyOrderNo: 'AB-12', amount: '10' })],
      }) ?? '',
      /listed twice/,
    )
  })

  test('an old order and an Order can share one submission', () => {
    const payment = { id: 'p', human_payment_id: 'P', amount: 1000, allocated_total: 0 }
    const order: SplitAllocationRow = { ...EMPTY_ALLOCATION_ROW('o'), kind: 'order', targetId: 'o1', amount: '100' }
    assert.equal(allocateFundsBlockedReason({ payment, rows: [order, legacyRow({ amount: '100' })] }), null)
  })
})

describe('Record Payment: an old order under a Confirmed Order entry', () => {
  const base = { amount: '5000', paymentDate: '2026-10-22', paymentMode: 'hdfc' }
  const order: SplitAllocationRow = { ...EMPTY_ALLOCATION_ROW('o'), kind: 'order', targetId: 'o1', amount: '1000' }

  test('a lone old-order row is a complete entry', () => {
    assert.equal(splitPaymentBlockedReason({ ...base, destination: 'confirmed_order', rows: [legacyRow({ amount: '5000' })] }), null)
  })

  test('an old order and an Order together are allowed, and the total still has to fit', () => {
    assert.equal(splitPaymentBlockedReason({ ...base, destination: 'confirmed_order', rows: [order, legacyRow({ amount: '4000' })] }), null)
    assert.match(
      splitPaymentBlockedReason({ ...base, destination: 'confirmed_order', rows: [order, legacyRow({ amount: '4000.01' })] }) ?? '',
      /total more than the 5000/,
    )
  })

  test('both typed fields are required, and the same old order twice is refused', () => {
    assert.match(splitPaymentBlockedReason({ ...base, destination: 'confirmed_order', rows: [legacyRow({ clientName: '' })] }) ?? '', /enter the client/)
    assert.match(splitPaymentBlockedReason({ ...base, destination: 'confirmed_order', rows: [legacyRow({ legacyOrderNo: '' })] }) ?? '', /enter the old order number/)
    assert.match(
      splitPaymentBlockedReason({ ...base, destination: 'confirmed_order', rows: [legacyRow({ amount: '1' }), legacyRow({ key: 'k2', legacyOrderNo: ' AB-12', amount: '1' })] }) ?? '',
      /listed twice/,
    )
  })

  test('an old order is a Confirmed Order that is not in the system: refused under PI Draft and Suspense', () => {
    assert.match(splitPaymentBlockedReason({ ...base, destination: 'pi_draft', rows: [legacyRow()] }) ?? '', /only be added to a Confirmed Order entry/)
    assert.match(splitPaymentBlockedReason({ ...base, destination: 'suspense', rows: [legacyRow()] }) ?? '', /Suspense Entry holds no allocations/)
  })

  test('what is sent keeps the listed order and carries no record id for an old order', () => {
    assert.deepEqual(toRpcAllocationsWithLegacy([order, legacyRow({ legacyOrderNo: ' ab-12 ', clientName: ' Old   Client ', amount: '250.5' })]), [
      { kind: 'order', id: 'o1', amount: 1000 },
      { kind: 'legacy', order_no: 'AB-12', client_name: 'Old Client', amount: 250.5 },
    ])
    assert.deepEqual(toRpcAllocationsWithLegacy([legacyRow({ amount: '' })]), [])
  })

  test('an old-order row is something entered, so closing asks first', () => {
    assert.equal(splitPaymentRowsChanged([EMPTY_ALLOCATION_ROW('k')], { initialTarget: null }), false)
    assert.equal(splitPaymentRowsChanged([{ ...EMPTY_ALLOCATION_ROW('k'), legacy: true, legacyOrderNo: '' }], { initialTarget: null }), true)
    assert.equal(splitPaymentIsDirty({
      destination: 'confirmed_order', emptyDestination: 'confirmed_order', amount: '', paymentDate: '', paymentMode: 'hdfc',
      defaultPaymentMode: 'hdfc', reference: '', remarks: '', custodyCount: 0, hasAttachment: false,
      rows: [{ ...EMPTY_ALLOCATION_ROW('k'), legacy: true, legacyOrderNo: '' }], baseline: { initialTarget: null },
    }), true)
  })

  test('the form sends the list it builds, offers the option only under Confirmed Order, and the migration reads {kind:legacy}', () => {
    const modal = readFileSync(join(process.cwd(), 'src/app/finance/received/RecordSplitPaymentModal.tsx'), 'utf8')
    assert.match(modal, /targetKind \? toRpcAllocationsWithLegacy\(rows\) : \[\]/)
    assert.match(modal, /kind === 'order' && \(/)
    const sql = readFileSync(join(process.cwd(), 'supabase/migrations/20270407000000_finance_allocate_to_old_order.sql'), 'utf8')
    assert.ok(sql.includes("'legacy'"))
    assert.ok(sql.includes('v_row->>\'order_no\''))
    assert.ok(sql.includes('v_row->>\'client_name\''))
  })
})

describe('what is sent', () => {
  test('an old-order target carries the normalised number, the client and the amount — no ids', () => {
    assert.deepEqual(
      toLegacyRpcTarget({ legacyOrderNo: ' ab-12 ', clientName: ' Old   Client ', amount: '300000.50' }),
      { legacy_order_no: 'AB-12', legacy_client_name: 'Old Client', allocated_amount: 300000.5 },
    )
  })

  test('the modal sends each row in order and sends only what the RPC reads', () => {
    const src = readFileSync(join(process.cwd(), 'src/app/finance/received/AllocateFundsModal.tsx'), 'utf8')
    assert.match(src, /supabase\.rpc\('allocate_payment_to_targets'/)
    assert.match(src, /toLegacyRpcTarget\(r\)/)
    assert.match(src, /order_submission_id: r\.kind === 'submission' \? r\.targetId : null/)
  })
})

describe('the server\'s refusals, in words', () => {
  test('each old-order refusal has its own sentence, and says nothing was allocated', () => {
    for (const code of [
      'ALLOCATION_LEGACY_ORDER_REQUIRED', 'ALLOCATION_LEGACY_ORDER_TOO_LONG',
      'ALLOCATION_LEGACY_CLIENT_REQUIRED', 'ALLOCATION_LEGACY_CLIENT_TOO_LONG',
    ]) {
      const message = legacyAllocationErrorMessage(`${code}: x`)
      assert.ok(message && /Nothing was allocated/.test(message), code)
      assert.equal(allocationErrorMessage(`${code}: x`), message)
    }
    assert.equal(legacyAllocationErrorMessage('ALLOCATION_DUPLICATE'), null)
  })

  test('every one of those codes is raised by the migration', () => {
    const sql = readFileSync(join(process.cwd(), 'supabase/migrations/20270407000000_finance_allocate_to_old_order.sql'), 'utf8')
    for (const code of [
      'ALLOCATION_LEGACY_ORDER_REQUIRED', 'ALLOCATION_LEGACY_ORDER_TOO_LONG',
      'ALLOCATION_LEGACY_CLIENT_REQUIRED', 'ALLOCATION_LEGACY_CLIENT_TOO_LONG',
    ]) assert.ok(sql.includes(code), code)
  })
})

describe('the customer warning treats the old order\'s client like any other', () => {
  test('a typed client that differs from the payment\'s existing customers warns', () => {
    const chosen = rowCustomerTargets([legacyRow({ clientName: 'Zeta' })])
    assert.deepEqual(chosen, [{ clientName: 'Zeta', label: 'Old order AB-12' }])
    const check = mixedCustomerCheck({
      existing: { state: 'complete', targets: [{ clientName: 'Acme', label: 'Order 100001' }] },
      chosen,
      paymentHasAllocations: true,
    })
    assert.equal(check.warn, true)
  })

  test('a row whose number is not typed yet is not yet a target', () => {
    assert.deepEqual(rowCustomerTargets([legacyRow({ legacyOrderNo: ' ' })]), [])
  })

  test('the target label never shows a uuid', () => {
    assert.equal(customerTargetLabel('legacy', 'AB-12'), 'Old order AB-12')
    assert.equal(customerTargetLabel('legacy', ''), 'An old order')
  })
})

describe('how an old-order allocation reads wherever allocations are listed', () => {
  const rows: AllocationTargetRow[] = [
    { payment_request_id: 'p', allocation_id: 'a1', target_type: 'legacy_order', target_id: null,
      target_reference: 'AB-12', reserved_order_number: null, allocated_amount: '300000.00', target_client_name: 'Old Client' },
    { payment_request_id: 'p', allocation_id: 'a2', target_type: 'order', target_id: 'o1',
      target_reference: '100001', reserved_order_number: null, allocated_amount: '100000' },
  ]

  test('the Allocated Against cell lists it, counts it, and gives it no link target', () => {
    const view = buildAllocatedAgainst({ id: 'p', amount: '500000' }, rows)
    assert.equal(view.kind, 'targets')
    if (view.kind !== 'targets') return
    assert.equal(view.status, 'partial')
    assert.equal(view.unallocated, '100000.00')
    const legacy = view.lines.find(l => l.targetType === 'legacy_order')
    assert.equal(legacy?.label, 'Old order AB-12 · Old Client')
    assert.equal(legacy?.targetId, null)
    assert.equal(legacy?.amount, '300000.00')
    assert.match(allocatedAgainstText(view, v => `₹${v}`), /Old order AB-12 · Old Client · ₹300000.00/)
  })

  test('an old-order payment on its own is no longer "Not allocated"', () => {
    const view = buildAllocatedAgainst({ id: 'p', amount: '300000' }, [rows[0]])
    assert.equal(view.kind, 'targets')
    if (view.kind === 'targets') assert.equal(view.status, 'full')
  })

  test('two rows for one old order are one line; two different old orders are two', () => {
    const second: AllocationTargetRow = { ...rows[0], allocation_id: 'a3', target_reference: 'CD-9', allocated_amount: '10' }
    const view = buildAllocatedAgainst({ id: 'p', amount: '500000' }, [rows[0], second])
    assert.equal(view.kind === 'targets' ? view.lines.length : 0, 2)
  })

  test('the detail summary names it, with its client, by its own kind', () => {
    const summary = completeAllocationSummary({ id: 'p', amount: '500000' }, rows, { covered: true })
    const legacy = summary?.targets.find(t => t.kind === 'legacy')
    assert.equal(legacy?.label, 'AB-12 · Old Client')
    assert.equal(legacy?.targetId, 'legacy:AB-12')
  })

  test('a direct read of the allocation table summarises it the same way', () => {
    const map = summarizePaymentAllocations(
      [{ id: 'p', amount: '500000' }],
      [{ id: 'a1', payment_request_id: 'p', allocated_amount: '300000', status: 'active',
         order_id: null, order_submission_id: null, legacy_order_no: 'AB-12', legacy_client_name: 'Old Client' }],
      { emptyIsConclusive: true },
    )
    const summary = map.get('p')!
    assert.equal(summary.state, 'partial')
    assert.equal(summary.allocated, '300000')
    assert.equal(summary.targets[0].kind, 'legacy')
    assert.equal(summary.targets[0].label, 'AB-12 · Old Client')
  })

  test('it is a destination the row draws, and never a door', () => {
    const map = summarizePaymentAllocations(
      [{ id: 'p', amount: '500000' }],
      [{ id: 'a1', payment_request_id: 'p', allocated_amount: '300000', status: 'active',
         order_id: null, order_submission_id: null, legacy_order_no: 'AB-12', legacy_client_name: 'Old Client' }],
      { emptyIsConclusive: true },
    )
    const links = paymentLinks({ summary: map.get('p')!, directOrder: null, labels: new Map(), canOpenOrders: true })
    assert.equal(links.length, 1)
    assert.equal(links[0].kind, 'legacy')
    assert.equal(links[0].href, null)
    assert.equal(links[0].label, 'AB-12 · Old Client')
  })

  test('Correct Allocation lists it as an old order and can reverse it like any other', () => {
    const ledger: LedgerRpcRow[] = [{
      allocation_id: 'a1', status: 'active', allocated_amount: '300000', order_id: null, order_submission_id: null,
      target_reference: 'AB-12', client_name: 'Old Client', created_at: '2027-01-01T00:00:00Z',
      reversed_at: null, reversal_reason: null, reversed_by_name: null,
    }]
    const entries = buildAllocationLedger(ledger)
    assert.equal(entries.length, 1)
    assert.equal(entries[0].kind, 'legacy')
    assert.equal(entries[0].targetId, 'legacy:AB-12')
    assert.equal(entries[0].clientName, 'Old Client')
    assert.equal(ledgerTargetName(entries[0]), 'Old order AB-12')
  })

  test('a ledger row with no target at all is still skipped', () => {
    assert.equal(buildAllocationLedger([{
      allocation_id: 'x', status: 'active', allocated_amount: '1', order_id: null, order_submission_id: null,
      target_reference: null, client_name: null, created_at: null, reversed_at: null,
      reversal_reason: null, reversed_by_name: null,
    }]).length, 0)
  })

  test('the payment\'s history names it by what was typed', () => {
    const payload = {
      target_type: 'legacy_order', target_id: null, legacy_order_no: 'AB-12', legacy_client_name: 'Old Client',
      reversal_reason: 'Wrong client',
    }
    assert.equal(
      paymentActivityLabel({ event_type: 'allocation_created', payload }),
      'Payment allocated to Old order AB-12 · Old Client',
    )
    assert.equal(
      paymentActivityLabel({ event_type: 'allocation_reversed', payload }),
      'Allocation to Old order AB-12 · Old Client reversed. Reason: Wrong client',
    )
    assert.equal(
      paymentActivityLabel({ event_type: 'allocation_created', payload: { target_type: 'legacy_order' } }),
      'Payment allocated to an old order',
    )
  })

  test('Delete Payment says it, in counts only', () => {
    assert.equal(
      describePaymentAllocations([{ kind: 'legacy' }]),
      'This payment is currently allocated to 1 old order.',
    )
    assert.equal(
      describePaymentAllocations([{ kind: 'order' }, { kind: 'submission' }, { kind: 'legacy' }, { kind: 'legacy' }]),
      'This payment is currently allocated to 1 Order, 1 PI Draft and 2 old orders.',
    )
    // the two-kind sentence is unchanged
    assert.equal(
      describePaymentAllocations([{ kind: 'order' }, { kind: 'submission' }]),
      'This payment is currently allocated to 1 Order and 1 PI Draft.',
    )
  })
})

describe('the migration keeps its promises', () => {
  const sql = readFileSync(join(process.cwd(), 'supabase/migrations/20270407000000_finance_allocate_to_old_order.sql'), 'utf8')

  test('it never redefines a view or an Order total: a legacy row cannot reach either', () => {
    assert.doesNotMatch(sql, /create\s+(or\s+replace\s+)?view/i)
    assert.doesNotMatch(sql, /order_linked_payment_total/)
  })

  test('creating an allocation still needs finance.allocate and the implementation stays closed', () => {
    assert.match(sql, /actor_has_module_permission\('finance', 'allocate'\)/)
    assert.match(sql, /revoke execute on function public\.allocate_payment_to_legacy_order_internal\(uuid, text, text, numeric\)\s+from public, anon, authenticated;/)
  })

  test('the legacy columns are frozen after insert, like every other allocation fact', () => {
    assert.match(sql, /new\.legacy_order_no\s+is distinct from old\.legacy_order_no/)
    assert.match(sql, /new\.legacy_client_name\s+is distinct from old\.legacy_client_name/)
  })
})
