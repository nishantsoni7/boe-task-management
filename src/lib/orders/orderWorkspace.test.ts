/**
 * The Confirmed Order rules: the six Order Summary facts, what needs
 * attention, which header action is primary, the activity window and the
 * relative day label.
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
  SUMMARY_NOT_SET,
  SUMMARY_UNASSIGNED,
  arrangeOrderActions,
  attentionHeading,
  isOrderClosed,
  orderAttentionItems,
  orderSummaryFacts,
  relativeDayLabel,
  type OrderAttentionInput,
  type OrderSummaryInput,
} from './orderWorkspace'

const quiet: OrderAttentionInput = {
  status: 'running',
  productionAligned: true,
  hasSalesperson: true, hasLeadSource: true,
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
    const items = orderAttentionItems({ ...quiet, productionAligned: false, hasSalesperson: false, hasDueDate: false })
    assert.deepEqual(items.map(i => i.key), ['production', 'salesperson', 'due_date'])
    assert.deepEqual(items.map(i => i.label), ['Production not aligned', 'Salesperson not set', 'Due date not set'])
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

  test('lead source is listed when it is missing, and is amber like the rest', () => {
    // Required at conversion since 20261201000000, so a NEW Order cannot arrive
    // without one — the Orders that predate that rule legitimately can.
    const items = orderAttentionItems({ ...quiet, hasLeadSource: false })
    assert.deepEqual(items.map(i => i.key), ['lead_source'])
    assert.equal(items[0].label, 'Lead source not set')
    assert.equal(items[0].tone, 'amber')
  })

  test('the four mandatory-field gaps read in the order they are asked for', () => {
    const items = orderAttentionItems({
      ...quiet, productionAligned: false, hasSalesperson: false, hasDueDate: false, hasLeadSource: false,
    })
    assert.deepEqual(items.map(i => i.key),
      ['production', 'salesperson', 'due_date', 'lead_source'])
  })

  test('a closed Order carries no operational gaps, but money and decisions still show', () => {
    for (const status of ['dispatched', 'cancelled']) {
      const items = orderAttentionItems({
        ...quiet, status,
        productionAligned: false, hasSalesperson: false, hasDueDate: false, isOverdue: true,
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

const summary: OrderSummaryInput = {
  status: 'running',
  statusLabel: 'Running',
  statusTone: 'blue',
  productionAligned: true,
  productionLabel: 'Aligned',
  productionLine: 'Aligned by Ravi · 8 Sep 2026, 10:00 am',
  salespersonName: 'Nishant',
  confirmDate: '8 Sep 2026',
  dueDate: '30 Oct 2026',
  isOverdue: false,
  leadSource: 'Reference',
}

describe('the Order Summary facts', () => {
  test('states the six management facts, in reading order', () => {
    assert.deepEqual(orderSummaryFacts(summary).map(f => f.key),
      ['status', 'production', 'salesperson', 'confirm_date', 'due_date', 'lead_source'])
    assert.deepEqual(orderSummaryFacts(summary).map(f => f.label),
      ['Status', 'Production', 'Salesperson', 'Confirm date', 'Due date', 'Lead source'])
  })

  test('carries NO payment figure — payment has its own section', () => {
    const facts = orderSummaryFacts(summary)
    for (const fact of facts) {
      assert.ok(!/verified|₹|%|balance|awaiting/i.test(fact.value), fact.key)
      assert.ok(!/verified|₹|balance|awaiting/i.test(fact.detail ?? ''), fact.key)
    }
    assert.ok(!facts.some(f => (f.key as string) === 'payment'))
  })

  test('never says Owner or Assignee — the Order flow has one word', () => {
    const said = orderSummaryFacts(summary).map(f => f.label).join(' ')
    assert.ok(!/owner|assignee/i.test(said))
    assert.ok(said.includes('Salesperson'))
  })

  test('a gap on an OPEN Order is amber and names itself', () => {
    const gaps = orderSummaryFacts({
      ...summary, productionAligned: false, productionLabel: 'Not Aligned', productionLine: null,
      salespersonName: null, confirmDate: null, dueDate: null, leadSource: null,
    })
    assert.equal(gaps[1].tone, 'amber')
    assert.equal(gaps[2].value, SUMMARY_UNASSIGNED)
    assert.equal(gaps[2].tone, 'amber')
    assert.equal(gaps[3].value, SUMMARY_NOT_SET)
    assert.equal(gaps[4].value, SUMMARY_NOT_SET)
    assert.equal(gaps[5].value, SUMMARY_NOT_SET)
    assert.ok(gaps.slice(2).every(f => f.tone === 'amber'))
  })

  test('the same gaps on a closed Order are neutral, not warnings', () => {
    const facts = orderSummaryFacts({
      ...summary, status: 'dispatched', productionAligned: false, productionLabel: 'Not Aligned',
      productionLine: null, salespersonName: null, confirmDate: null, dueDate: null, leadSource: null,
    })
    assert.ok(facts.slice(1).every(f => f.tone === 'neutral'))
  })

  test('a settled Order is quiet: production green, everything else neutral', () => {
    const facts = orderSummaryFacts(summary)
    assert.equal(facts[1].tone, 'green')
    assert.ok(facts.slice(2).every(f => f.tone === 'neutral'))
  })

  test('overdue is the only red', () => {
    const facts = orderSummaryFacts({ ...summary, isOverdue: true })
    assert.equal(facts[4].tone, 'red')
    assert.equal(facts[4].detail, 'Overdue')
    assert.equal(facts.filter(f => f.tone === 'red').length, 1)
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
