// "WITH SALES" ON THE OPERATIONS QUEUE (owner, 2026-11-13): a PI returned to Sales is said apart in the queue list, and is never counted as
// waiting on Operations. Same rule as the Order page (salesReturnStage).
//
// Run with: npm run test:file -- src/lib/orders/opsWithSales.test.ts

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ordersWithSales, type QueueHandoff } from './operationsHandoff'

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
