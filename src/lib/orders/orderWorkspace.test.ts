/**
 * The Confirmed Order workspace rules: what needs attention, how the health
 * card reads, which header action is primary, and the relative day label.
 *
 * Pure functions over state the page already holds. No database, no network.
 *
 * Run:
 *   npx tsx --test src/lib/orders/orderWorkspace.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  ACTIVITY_PREVIEW_COUNT,
  activityToggleLabel,
  activityWindow,
  HEALTH_NO_PAYMENTS,
  HEALTH_NOT_SET,
  HEALTH_PAYMENT_LOADING,
  HEALTH_UNASSIGNED,
  arrangeOrderActions,
  attentionHeading,
  isOrderClosed,
  orderAttentionItems,
  orderHealthRows,
  relativeDayLabel,
  type OrderAttentionInput,
  type OrderHealthInput,
} from './orderWorkspace'

const quiet: OrderAttentionInput = {
  status: 'running',
  productionAligned: true,
  hasAssignee: true,
  hasDueDate: true,
  isOverdue: false,
  awaitingVerificationCount: 0,
  pendingChangeRequests: 0,
  pendingPiRevision: false,
  documentsFailed: false,
  documentsOutdated: false,
}

describe('the attention bar', () => {
  test('a fully in-order running Order has nothing to say, so the bar can hide', () => {
    assert.deepEqual(orderAttentionItems(quiet), [])
  })

  test('the three operational gaps are named, in a fixed order', () => {
    const items = orderAttentionItems({ ...quiet, productionAligned: false, hasAssignee: false, hasDueDate: false })
    assert.deepEqual(items.map(i => i.key), ['production', 'assignee', 'due_date'])
    assert.deepEqual(items.map(i => i.label), ['Production not aligned', 'No assignee', 'Due date not set'])
    assert.ok(items.every(i => i.tone === 'amber'))
  })

  test('overdue leads, and is the only red', () => {
    const items = orderAttentionItems({ ...quiet, isOverdue: true, productionAligned: false })
    assert.equal(items[0].key, 'overdue')
    assert.equal(items[0].tone, 'red')
    assert.equal(items.filter(i => i.tone === 'red').length, 1)
  })

  test('a partially paid Order is NOT an attention item', () => {
    // No existing rule calls a balance a problem. The bar must not invent one.
    const items = orderAttentionItems({ ...quiet })
    assert.ok(!items.some(i => /balance|outstanding|paid/i.test(i.label)))
  })

  test('money awaiting Finance is listed, with its count', () => {
    assert.equal(orderAttentionItems({ ...quiet, awaitingVerificationCount: 1 })[0].label,
      '1 payment awaiting Finance verification')
    assert.equal(orderAttentionItems({ ...quiet, awaitingVerificationCount: 3 })[0].label,
      '3 payments awaiting Finance verification')
  })

  test('pending decisions are listed: a revised PI and change requests', () => {
    const items = orderAttentionItems({ ...quiet, pendingPiRevision: true, pendingChangeRequests: 2 })
    assert.deepEqual(items.map(i => i.label), ['Revised PI awaiting decision', '2 change requests awaiting review'])
  })

  test('the document register\'s failed and outdated states are listed, never both', () => {
    assert.deepEqual(orderAttentionItems({ ...quiet, documentsFailed: true }).map(i => i.key), ['documents_failed'])
    assert.deepEqual(orderAttentionItems({ ...quiet, documentsOutdated: true }).map(i => i.key), ['documents_outdated'])
    assert.deepEqual(orderAttentionItems({ ...quiet, documentsFailed: true, documentsOutdated: true }).map(i => i.key),
      ['documents_failed'])
  })

  test('a closed Order carries no operational gaps, but money and decisions still show', () => {
    for (const status of ['dispatched', 'cancelled']) {
      const items = orderAttentionItems({
        ...quiet, status,
        productionAligned: false, hasAssignee: false, hasDueDate: false, isOverdue: true,
        documentsFailed: true, documentsOutdated: true,
        awaitingVerificationCount: 1, pendingChangeRequests: 1,
      })
      assert.deepEqual(items.map(i => i.key), ['change_requests', 'awaiting_verification'], status)
    }
  })

  test('the heading counts', () => {
    assert.equal(attentionHeading(1), '1 item needs attention')
    assert.equal(attentionHeading(3), '3 items need attention')
  })

  test('closed means exactly the two statuses the overdue rule always excluded', () => {
    assert.equal(isOrderClosed('dispatched'), true)
    assert.equal(isOrderClosed('cancelled'), true)
    for (const s of ['running', 'on_hold', 'ready_for_dispatch']) assert.equal(isOrderClosed(s), false)
  })
})

const healthy: OrderHealthInput = {
  status: 'running',
  statusLabel: 'Running',
  statusTone: 'blue',
  verifiedPercent: '47.95%',
  verified: '₹7,50,000.00',
  orderValue: '₹15,64,090.00',
  fullyPaid: false,
  paymentCount: 2,
  paymentsLoaded: true,
  productionAligned: true,
  productionLabel: 'Aligned',
  productionLine: 'Aligned by Ravi · 8 Sep 2026, 10:00 am',
  dueDate: '30 Oct 2026',
  isOverdue: false,
  ownerName: 'Nishant',
  confirmedDate: '8 Sep 2026',
}

describe('the health card', () => {
  test('reads six lines in a fixed order', () => {
    assert.deepEqual(orderHealthRows(healthy).map(r => r.key),
      ['status', 'payment', 'production', 'due', 'owner', 'confirmed'])
  })

  test('the payment line states the verified percentage over the money', () => {
    const row = orderHealthRows(healthy)[1]
    assert.equal(row.value, '47.95% verified')
    assert.equal(row.detail, '₹7,50,000.00 of ₹15,64,090.00')
    assert.equal(row.tone, 'neutral', 'a balance is not a warning')
  })

  test('fully paid is green; nothing recorded says so and states what is outstanding', () => {
    assert.equal(orderHealthRows({ ...healthy, fullyPaid: true, verifiedPercent: '100%' })[1].tone, 'green')
    const none = orderHealthRows({ ...healthy, paymentCount: 0 })[1]
    assert.equal(none.value, HEALTH_NO_PAYMENTS)
    assert.equal(none.detail, '₹15,64,090.00 outstanding')
  })

  test('while the payment reads are in flight the line says so rather than showing zero', () => {
    const row = orderHealthRows({ ...healthy, paymentsLoaded: false, paymentCount: 0 })[1]
    assert.equal(row.value, HEALTH_PAYMENT_LOADING)
    assert.ok(!/0/.test(row.value))
  })

  test('production, due date and owner are amber only when they are gaps on an open Order', () => {
    const gaps = orderHealthRows({
      ...healthy, productionAligned: false, productionLabel: 'Not Aligned', productionLine: null,
      dueDate: null, ownerName: null,
    })
    assert.equal(gaps[2].tone, 'amber')
    assert.equal(gaps[3].value, HEALTH_NOT_SET)
    assert.equal(gaps[3].tone, 'amber')
    assert.equal(gaps[4].value, HEALTH_UNASSIGNED)
    assert.equal(gaps[4].tone, 'amber')

    const aligned = orderHealthRows(healthy)
    assert.equal(aligned[2].tone, 'green')
    assert.equal(aligned[3].tone, 'neutral')
    assert.equal(aligned[4].tone, 'neutral')
  })

  test('the same gaps on a closed Order are neutral, not warnings', () => {
    const rows = orderHealthRows({
      ...healthy, status: 'dispatched', productionAligned: false, productionLabel: 'Not Aligned',
      productionLine: null, dueDate: null, ownerName: null,
    })
    assert.ok(rows.slice(2, 5).every(r => r.tone === 'neutral'))
  })

  test('overdue is the only red', () => {
    const rows = orderHealthRows({ ...healthy, isOverdue: true })
    assert.equal(rows[3].tone, 'red')
    assert.equal(rows[3].detail, 'Overdue')
    assert.equal(rows.filter(r => r.tone === 'red').length, 1)
  })
})

describe('the header actions', () => {
  test('Align for Production is primary whenever it is offered', () => {
    const layout = arrangeOrderActions({
      alignAction: 'align', canAmend: true, canRequest: false, canReviewChangeRequests: true, canCleanUp: true,
    })
    assert.equal(layout.primary, 'align')
    assert.deepEqual(layout.secondary, ['amend', 'review_change_request'])
    assert.deepEqual(layout.overflow, ['cleanup'])
  })

  test('a pending change request the reader may decide is primary when nothing else is', () => {
    const layout = arrangeOrderActions({
      alignAction: null, canAmend: true, canRequest: false, canReviewChangeRequests: true, canCleanUp: false,
    })
    assert.equal(layout.primary, 'review_change_request')
    assert.deepEqual(layout.secondary, ['amend'])
  })

  test('an ordinary aligned Order has no filled button', () => {
    const layout = arrangeOrderActions({
      alignAction: 'unalign', canAmend: true, canRequest: false, canReviewChangeRequests: false, canCleanUp: false,
    })
    assert.equal(layout.primary, null)
    assert.deepEqual(layout.secondary, ['amend'])
    assert.deepEqual(layout.overflow, ['unalign'])
  })

  test('a non-admin keeps both request doors: change beside, cancellation behind the overflow', () => {
    const layout = arrangeOrderActions({
      alignAction: null, canAmend: false, canRequest: true, canReviewChangeRequests: false, canCleanUp: false,
    })
    assert.equal(layout.primary, null)
    assert.deepEqual(layout.secondary, ['request_change'])
    assert.deepEqual(layout.overflow, ['request_cancel'])
  })

  test('nothing offered means nothing drawn, and nothing is ever dropped', () => {
    const none = arrangeOrderActions({
      alignAction: null, canAmend: false, canRequest: false, canReviewChangeRequests: false, canCleanUp: false,
    })
    assert.deepEqual(none, { primary: null, secondary: [], overflow: [] })

    const all = arrangeOrderActions({
      alignAction: 'align', canAmend: true, canRequest: true, canReviewChangeRequests: true, canCleanUp: true,
    })
    const placed = [all.primary, ...all.secondary, ...all.overflow]
    for (const key of ['align', 'amend', 'request_change', 'request_cancel', 'review_change_request', 'cleanup']) {
      assert.ok(placed.includes(key as typeof all.primary), `${key} must be placed somewhere`)
    }
  })
})

describe('the activity window', () => {
  test('five or fewer events are shown whole, with nothing hidden', () => {
    for (const total of [0, 1, 5]) {
      assert.deepEqual(activityWindow(total, false), { shown: total, hidden: 0 }, String(total))
    }
  })

  test('a longer trail shows the latest five and says how many are hidden', () => {
    assert.deepEqual(activityWindow(13, false), { shown: 5, hidden: 8 })
    assert.equal(ACTIVITY_PREVIEW_COUNT, 5)
  })

  test('expanded shows everything — nothing is ever dropped', () => {
    assert.deepEqual(activityWindow(13, true), { shown: 13, hidden: 0 })
  })

  test('the control names the whole count, then offers the way back', () => {
    assert.equal(activityToggleLabel(13, false), 'View all 13 events')
    assert.equal(activityToggleLabel(13, true), 'Show latest 5')
  })
})

describe('the relative day label', () => {
  const now = new Date(2026, 8, 8, 15, 30) // 8 Sep 2026, local

  test('today and yesterday by calendar day, not by 24 hours', () => {
    assert.equal(relativeDayLabel(new Date(2026, 8, 8, 0, 5).toISOString(), now), 'today')
    assert.equal(relativeDayLabel(new Date(2026, 8, 7, 23, 55).toISOString(), now), 'yesterday')
  })

  test('anything older prints as a date', () => {
    assert.equal(relativeDayLabel(new Date(2026, 8, 6, 12, 0).toISOString(), now), null)
  })

  test('missing or unparseable input is null', () => {
    assert.equal(relativeDayLabel(null, now), null)
    assert.equal(relativeDayLabel('not a date', now), null)
  })
})
