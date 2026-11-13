// "WITH SALES" ON THE OPERATIONS QUEUE (owner, 2026-11-13): a PI returned to Sales is said apart on the
// Orders dashboard's Operations Review card and in the queue list it opens, and is never counted as
// waiting on Operations. Same rule as the Order page (salesReturnStage).
//
// Run with: npm run test:file -- src/lib/orders/opsWithSales.test.ts

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SupabaseClient } from '@supabase/supabase-js'
import { loadOrdersWithSales, type QueueHandoff } from './operationsHandoff'
import { NO_ORDER_DASHBOARD_COUNTS, orderDashboardCards } from './orderDashboard'
import type { OrdersCapabilities } from '@/lib/permissions/orders'

const FLAGGED = '2026-11-12T11:19:47Z'
const h = (over: Partial<QueueHandoff> = {}): QueueHandoff => ({
  id: 'h-547', order_id: 'o-547', status: 'clarification_needed', assigned_to: 'nitish',
  clarification_at: FLAGGED, clarification_responded_at: null, ...over,
})
const sendBack = (handoff: string, at: string, order = 'o-547') =>
  ({ order_id: order, created_at: at, payload: { handoff_id: handoff, comment: 'Revise it.' }, actor: { full_name: 'Nishant Soni' } })

/** A stand-in for the one history read (sentBackHistoryRead): records the Orders asked for. */
function fakeSupabase(rows: unknown[] | null, asked: string[][] = []): SupabaseClient {
  const chain = {
    select: () => chain, eq: () => chain,
    in: (_c: string, ids: string[]) => { asked.push(ids); return chain },
    order: () => Promise.resolve(rows === null ? { data: null, error: { message: 'denied' } } : { data: rows, error: null }),
  }
  return { from: () => chain } as unknown as SupabaseClient
}

describe('which Orders are with Sales', () => {
  test('sent back after the flag: with Sales; before it, or answered since: not', async () => {
    assert.deepEqual([...await loadOrdersWithSales(fakeSupabase([sendBack('h-547', '2026-11-12T12:34:32Z')]), [h()])], ['o-547'])
    assert.equal((await loadOrdersWithSales(fakeSupabase([sendBack('h-547', '2026-11-12T10:00:00Z')]), [h()])).size, 0)
    assert.equal((await loadOrdersWithSales(fakeSupabase([sendBack('h-547', '2026-11-12T12:34:32Z')]),
      [h({ status: 'awaiting', clarification_responded_at: '2026-11-12T13:00:00Z' })])).size, 0)
  })

  test('a send-back about another handoff does not count; a failed read or no handoffs means none, with no read', async () => {
    assert.equal((await loadOrdersWithSales(fakeSupabase([sendBack('h-old', '2026-11-12T12:34:32Z')]), [h()])).size, 0)
    assert.equal((await loadOrdersWithSales(fakeSupabase(null), [h()])).size, 0)
    const asked: string[][] = []
    assert.equal((await loadOrdersWithSales(fakeSupabase([], asked), [])).size, 0)
    assert.equal(asked.length, 0)
  })

  test('one read names each Order once', async () => {
    const asked: string[][] = []
    await loadOrdersWithSales(fakeSupabase([], asked), [h(), h({ id: 'h-2' }), h({ id: 'h-3', order_id: 'o-9' })])
    assert.deepEqual(asked, [['o-547', 'o-9']])
  })
})

describe('the Operations Review card', () => {
  const card = (over: Partial<typeof NO_ORDER_DASHBOARD_COUNTS>) =>
    orderDashboardCards({ counts: { ...NO_ORDER_DASHBOARD_COUNTS, ...over }, orders: {} as OrdersCapabilities })
      .find(c => c.key === 'operations_review')

  test('a PI with Sales is said apart and is not counted as flagged or waiting', () => {
    const c = card({ operationsReview: 0, operationsUnassigned: 0, operationsFlagged: 0, operationsWithSales: 1 })
    assert.equal(c?.sub, '1 with Sales: waiting for the revised PI')
    assert.equal(c?.value, 1)
    const mixed = card({ operationsReview: 2, operationsUnassigned: 0, operationsFlagged: 1, operationsWithSales: 1 })
    assert.equal(mixed?.value, 2)
    assert.match(mixed?.sub ?? '', /1 flagged: clarification needed · 1 with Sales/)
    assert.equal(card({ operationsReview: 0, operationsUnassigned: 0, operationsFlagged: 0, operationsWithSales: 0 }), undefined)
  })
})

describe('where it is read', () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n')

  test('the dashboard counts leave a PI with Sales out of "awaiting" and "flagged"', () => {
    const page = read('src/app/orders/page.tsx')
    assert.match(page, /const live = all \? all\.filter\(h => !withSales\.has\(h\.order_id\)\) : null/)
    assert.match(page, /operationsWithSales: {2}all \? withSales\.size : undefined,/)
  })

  test('the queue list shows With Sales in Factory Status, on the table and on a phone', () => {
    const list = read('src/app/orders/all/page.tsx')
    assert.equal((list.match(/withSalesOrders\.has\(o\.id\) \? WITH_SALES_FACTORY_VIEW : factoryView\(o, dispatch\.get\(o\.id\)\)/g) ?? []).length, 2)
    assert.match(list, /const WITH_SALES_FACTORY_VIEW: FactoryView = \{ tone: 'not_aligned', label: WITH_SALES_LABEL, note: WITH_SALES_NOTE \}/)
  })
})
