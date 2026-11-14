// "WITH SALES" ON THE OPERATIONS QUEUE (owner, 2026-11-13): a PI returned to Sales is said apart on the
// Orders dashboard's Operations Review card and in the queue list it opens, and is never counted as
// waiting on Operations. Same rule as the Order page (salesReturnStage).
//
// Run with: npm run test:file -- src/lib/orders/opsWithSales.test.ts

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ordersWithSales, type QueueHandoff } from './operationsHandoff'
import { NO_ORDER_DASHBOARD_COUNTS, orderDashboardCards } from './orderDashboard'
import type { OrdersCapabilities } from '@/lib/permissions/orders'

const h = (over: Partial<QueueHandoff> = {}): QueueHandoff => ({
  id: 'h-547', order_id: 'o-547', status: 'clarification_needed', assigned_to: 'nitish', chain_holder: 'sales', ...over,
})

describe('which Orders are with Sales', () => {
  test('the Orders whose live handoff Sales holds (the stored holder), flagged or not yet decided', () => {
    assert.deepEqual([...ordersWithSales([h()])], ['o-547'])
    assert.deepEqual([...ordersWithSales([h({ status: 'awaiting' })])], ['o-547'], 'sent back before Operations decided')
  })

  test('not with Sales: the approver or Operations holds it, nobody does, or it is accepted', () => {
    for (const over of [{ chain_holder: 'coordinator' as const }, { chain_holder: 'operations' as const }, { chain_holder: null }, { status: 'accepted' }]) {
      assert.equal(ordersWithSales([h(over)]).size, 0, JSON.stringify(over))
    }
  })

  test('each Order once; no handoffs, none', () => {
    assert.deepEqual([...ordersWithSales([h(), h({ id: 'h-2' }), h({ id: 'h-3', order_id: 'o-9' })])], ['o-547', 'o-9'])
    assert.equal(ordersWithSales([]).size, 0)
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
