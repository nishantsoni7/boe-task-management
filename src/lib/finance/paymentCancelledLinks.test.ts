/**
 * Rejected requests keep their original PI/Order in Against and in Total Before
 * GST — and the salesperson-list detection that goes with the same change.
 *
 * Run: npx tsx --test src/lib/finance/paymentCancelledLinks.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  REJECTION_CANCEL_REASON,
  loadCancelledLinks,
  needsHistoricalLink,
  pickHistoricalTarget,
  withCancelledLinks,
  type CancelledIntentRow,
} from './paymentCancelledLinks'
import { loadPaymentTotals } from './paymentCommercialTotals'
import { paymentAgainstDisplay, type PaymentDestination } from './paymentDestination'
import { isSalespersonPaymentView } from './paymentRequestsSalesView'
import { deriveFinanceCapabilities } from '@/lib/permissions/finance'
import type { EffectivePermission } from '@/lib/permissions/types'

const T1 = '2026-09-01T10:00:00Z'
const T2 = '2026-09-10T10:00:00Z'
const piRow = (payment: string, sub: string, at = T1): CancelledIntentRow =>
  ({ payment_request_id: payment, target_type: 'pi_draft', order_submission_id: sub, order_id: null, cancelled_at: at })
const orderRow = (payment: string, order: string, at = T1): CancelledIntentRow =>
  ({ payment_request_id: payment, target_type: 'confirmed_order', order_submission_id: null, order_id: order, cancelled_at: at })

describe('pickHistoricalTarget', () => {
  test('one cancelled intent names the original record', () => {
    assert.deepEqual(pickHistoricalTarget([piRow('p', 's1')]), { kind: 'pi_draft', submissionId: 's1' })
    assert.deepEqual(pickHistoricalTarget([orderRow('p', 'o1')]), { kind: 'confirmed_order', orderId: 'o1' })
  })
  test('several intents for the SAME record are still one record', () => {
    assert.deepEqual(pickHistoricalTarget([piRow('p', 's1'), piRow('p', 's1')]), { kind: 'pi_draft', submissionId: 's1' })
  })
  test('two different records in the same rejection: nothing is picked, nothing guessed', () => {
    assert.equal(pickHistoricalTarget([piRow('p', 's1'), piRow('p', 's2')]), null)
    assert.equal(pickHistoricalTarget([piRow('p', 's1'), orderRow('p', 'o1')]), null)
  })
  test('rejected, resubmitted to elsewhere, rejected again: the latest rejection decides', () => {
    assert.deepEqual(pickHistoricalTarget([piRow('p', 's1', T1), piRow('p', 's2', T2)]), { kind: 'pi_draft', submissionId: 's2' })
  })
  test('no rows, undated rows or an unreadable row give nothing', () => {
    assert.equal(pickHistoricalTarget([]), null)
    assert.equal(pickHistoricalTarget([{ ...piRow('p', 's1'), cancelled_at: null }]), null)
    assert.equal(pickHistoricalTarget([{ payment_request_id: 'p', target_type: 'pi_draft', order_submission_id: null, order_id: null, cancelled_at: T1 }]), null)
  })
})

/** A recording stand-in for the four tables read. */
function fake(tables: Record<string, Record<string, unknown>[]>) {
  const calls: { table: string; filters: Record<string, unknown>; ids: string[] }[] = []
  return {
    calls,
    client: {
      from(table: string) {
        const filters: Record<string, unknown> = {}
        let inCol = 'id'
        let inIds: string[] = []
        // Thenable, like a PostgREST builder: filters chain in any order and the
        // await runs the query.
        const q = {
          select: () => q,
          eq: (c: string, v: unknown) => { filters[c] = v; return q },
          in: (c: string, ids: string[]) => { inCol = c; inIds = ids; return q },
          then: (resolve: (v: { data: unknown[]; error: null }) => unknown) => {
            calls.push({ table, filters: { ...filters }, ids: [...inIds] })
            const rows = (tables[table] ?? [])
              .filter(r => inIds.includes(String(r[inCol])))
              .filter(r => Object.entries(filters).every(([k, v]) => r[k] === v))
            return Promise.resolve({ data: rows, error: null }).then(resolve)
          },
        }
        return q
      },
    },
  }
}

const cancelledPi = (payment: string, sub: string) => ({
  payment_request_id: payment, target_type: 'pi_draft', order_submission_id: sub, order_id: null,
  cancelled_at: T1, status: 'cancelled', cancelled_reason: REJECTION_CANCEL_REASON,
})
const cancelledOrder = (payment: string, order: string) => ({
  payment_request_id: payment, target_type: 'confirmed_order', order_submission_id: null, order_id: order,
  cancelled_at: T1, status: 'cancelled', cancelled_reason: REJECTION_CANCEL_REASON,
})

describe('loadCancelledLinks', () => {
  const tables = {
    finance_payment_allocation_intents: [
      cancelledPi('rej-a', 'pi-1'), cancelledPi('rej-b', 'pi-1'),          // two requests, one PI
      cancelledOrder('rej-o', 'ord-1'),                                     // a Confirmed Order
      { ...cancelledPi('edited', 'pi-9'), cancelled_reason: 'replaced by an edit' }, // NOT a rejection
      { ...cancelledPi('withdrawn', 'pi-9'), status: 'pending', cancelled_reason: null },
    ],
    order_submissions: [{ id: 'pi-1', draft_reference: 'PID-90001' }],
    orders: [{ id: 'ord-1', display_number: 'BOE/2026/0042', source_order_submission_id: 'pi-4' }],
  }

  test('PI Draft and Confirmed Order links come back, marked cancelled, with their own names', async () => {
    const f = fake(tables)
    const links = await loadCancelledLinks(f.client as never, ['rej-a', 'rej-b', 'rej-o', 'edited', 'withdrawn'])
    assert.equal(links.get('rej-a')?.submissionId, 'pi-1')
    assert.equal(links.get('rej-a')?.reference, 'PID-90001')
    assert.equal(links.get('rej-a')?.cancelled, true)
    assert.equal(links.get('rej-b')?.submissionId, 'pi-1', 'two requests on one PI resolve to the same PI')
    assert.equal(links.get('rej-o')?.kind, 'confirmed_order')
    assert.equal(links.get('rej-o')?.orderId, 'ord-1')
    assert.equal(links.get('rej-o')?.reference, 'BOE/2026/0042')
  })

  test('only intents the REJECTION cancelled are read', async () => {
    const f = fake(tables)
    const links = await loadCancelledLinks(f.client as never, ['edited', 'withdrawn'])
    assert.equal(links.size, 0)
    assert.equal(f.calls[0].filters.status, 'cancelled')
    assert.equal(f.calls[0].filters.cancelled_reason, REJECTION_CANCEL_REASON)
  })

  test('one batched read per table for the whole page', async () => {
    const f = fake(tables)
    await loadCancelledLinks(f.client as never, ['rej-a', 'rej-b', 'rej-o'])
    assert.deepEqual(f.calls.map(c => c.table), ['finance_payment_allocation_intents', 'order_submissions', 'orders'])
  })

  test('nothing to look up asks nothing', async () => {
    const f = fake(tables)
    assert.equal((await loadCancelledLinks(f.client as never, [])).size, 0)
    assert.equal(f.calls.length, 0)
  })

  test("a record the reader can't name keeps its kind and has no reference", async () => {
    const f = fake({ finance_payment_allocation_intents: [cancelledPi('rej-x', 'pi-hidden')] })
    const link = (await loadCancelledLinks(f.client as never, ['rej-x'])).get('rej-x')!
    assert.equal(link.kind, 'pi_draft')
    assert.equal(link.reference, null)
  })
})

describe('what the list shows', () => {
  const live: PaymentDestination = {
    paymentId: 'live', source: 'intent', kind: 'pi_draft', orderCount: 0, submissionCount: 1, customerCount: 1,
    orderId: null, orderNumber: null, submissionId: 'pi-live', reference: 'PID-1',
  }
  const suspense: PaymentDestination = { ...live, paymentId: 'rej', source: 'none', kind: 'suspense', submissionCount: 0, submissionId: null, reference: null }
  const hist: PaymentDestination = { ...live, paymentId: 'rej', submissionId: 'pi-1', reference: 'PID-90001', cancelled: true }

  test('Against names the original record and says the link is cancelled', () => {
    assert.equal(paymentAgainstDisplay(hist), 'PI Draft PID-90001 (cancelled)')
    assert.equal(paymentAgainstDisplay(live), 'PI Draft PID-1', 'a live link is unmarked')
  })

  test('only an empty destination is filled in; a live one is never overridden', () => {
    assert.equal(needsHistoricalLink(suspense), true)
    assert.equal(needsHistoricalLink(undefined), true)
    assert.equal(needsHistoricalLink(live), false)
    const merged = withCancelledLinks(new Map([['rej', suspense], ['live', live]]), new Map([['rej', hist], ['live', { ...hist, paymentId: 'live' }]]))
    assert.equal(merged.get('rej')?.submissionId, 'pi-1')
    assert.equal(merged.get('live')?.submissionId, 'pi-live')
  })

  test('the total comes from the same record: PI Draft and Confirmed Order → source PI', async () => {
    const f = fake({
      orders: [{ id: 'ord-1', source_order_submission_id: 'pi-4' }],
      order_submissions: [{ id: 'pi-1', total_before_gst: '132500.00' }, { id: 'pi-4', total_before_gst: '190000.00' }],
    })
    const merged = new Map<string, PaymentDestination>([
      ['rej-a', { ...hist, paymentId: 'rej-a', submissionId: 'pi-1' }],
      ['rej-b', { ...hist, paymentId: 'rej-b', submissionId: 'pi-1' }],
      ['rej-o', { ...hist, paymentId: 'rej-o', kind: 'confirmed_order', submissionId: null, orderId: 'ord-1' }],
      ['unresolved', suspense],
    ])
    const totals = await loadPaymentTotals(f.client as never, merged)
    assert.equal(totals.get('rej-a'), 132500)
    assert.equal(totals.get('rej-b'), 132500, 'multiple requests against the same PI show the same total')
    assert.equal(totals.get('rej-o'), 190000, 'the Order resolves through its source PI')
    assert.equal(totals.get('unresolved'), null, 'Unavailable only when the record genuinely cannot be resolved')
  })

  test('the list wires it: history first, totals after, rejected rows only', () => {
    const page = readFileSync(join(process.cwd(), 'src/app/finance/page.tsx'), 'utf8').replace(/\r/g, '')
    assert.ok(page.includes("r.status === 'rejected' && needsHistoricalLink"))
    assert.ok(page.includes('destinations={shownDestinations}'))
    assert.ok(page.includes('if (!salesView || !shownDestinations || !historySettled) return'))
  })
})

describe('who gets the salesperson list', () => {
  const perms = (...keys: string[]): EffectivePermission[] =>
    keys.map(actionKey => ({ actionKey, allowed: true }) as unknown as EffectivePermission)
  const sales = (role: string, ...keys: string[]) =>
    isSalespersonPaymentView(role === 'admin', deriveFinanceCapabilities(role, perms(...keys)))

  test('a plain salesperson, and one who can create/edit/export, get the sales list', () => {
    assert.equal(sales('member', 'view'), true)
    assert.equal(sales('member', 'view', 'create', 'edit'), true)
    assert.equal(sales('member', 'view', 'create', 'edit', 'export'), true)
  })
  test('company-wide visibility alone does NOT make a reviewer', () => {
    assert.equal(sales('member', 'view', 'view_all'), true)
    assert.equal(sales('member', 'view', 'create', 'view_all'), true)
    assert.equal(sales('manager', 'view', 'view_all'), true)
  })
  test('anyone who can approve keeps the review columns — including a Manager level and a custom grant', () => {
    assert.equal(sales('member', 'view', 'approve'), false)
    assert.equal(sales('manager', 'view', 'create', 'edit', 'approve', 'export'), false)
    assert.equal(sales('member', 'view', 'view_all', 'approve'), false)
  })
  test('an approve grant without module entry confers nothing (the helper gates on view)', () => {
    assert.equal(sales('member', 'approve'), true)
  })
  test('an admin always keeps the review columns', () => {
    assert.equal(sales('admin'), false)
  })
})
