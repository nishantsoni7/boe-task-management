// "RETURNED TO SALES" (owner, 2026-11-12): sending a PI back to the salesperson puts it in a status every
// screen shows, until the salesperson resubmits a revised PI that is approved (or Operations decides again).
//
// Run with: npm run test:file -- src/lib/orders/returnedToSales.test.tsx

import '@/lib/testing/cssModuleStub'
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { FlaggedPiStripView } from '@/components/orders/dashboard/FlaggedPiStrip'
import { SALES_RETURN_SUMMARY, salesReturnStage } from './operationsHandoff'
import { orderAttentionItems } from './orderWorkspace'
import { flaggedRow } from './adminDashboard'
import { RETURNED_TO_SALES_LABEL, isReturnedToSales, readFlaggedPis } from './flaggedPis'

const FLAGGED_AT = '2026-11-12T11:19:47Z'
const SENT_AT = '2026-11-12T12:34:32Z'
const live = { status: 'clarification_needed' as const, superseded_at: null, clarification_at: FLAGGED_AT }
const stage = (over: Partial<Parameters<typeof salesReturnStage>[0]> = {}) =>
  salesReturnStage({ live, sent: { atIso: SENT_AT }, answer: null, pendingRevision: false, ...over })

describe('the status a send-back puts the PI in', () => {
  test('sent back after Operations flagged it: with Sales; a revised PI waiting for approval: resubmitted', () => {
    assert.equal(stage(), 'with_sales')
    assert.equal(stage({ pendingRevision: true }), 'resubmitted')
    assert.equal(stage({ live: { ...live, status: 'awaiting', clarification_at: null } }), 'with_sales', 'sent back before Operations decided')
  })

  test('it ends by itself: nothing sent, Operations flagged again since, the owner answered Operations since, accepted, replaced', () => {
    assert.equal(stage({ sent: null }), null)
    assert.equal(stage({ live: { ...live, clarification_at: '2026-11-12T13:00:00Z' } }), null)
    assert.equal(stage({ answer: { atIso: '2026-11-12T13:00:00Z' } }), null)
    assert.equal(stage({ answer: { atIso: '2026-11-12T12:00:00Z' } }), 'with_sales', 'an answer older than the send-back does not end it')
    assert.equal(stage({ live: { ...live, status: 'accepted' } }), null)
    assert.equal(stage({ live: { ...live, superseded_at: '2026-11-13T00:00:00Z' } }), null)
    assert.equal(stage({ live: null }), null)
  })

  test('the Order banner says it is with Sales and what they must do, before Operations\' reason', () => {
    const base = {
      status: 'running', productionAligned: false, hasSalesperson: true, hasDueDate: true, hasLeadSource: true, isOverdue: false,
      awaitingVerificationCount: 0, pendingChangeRequests: 0, pendingPiRevision: false,
    }
    const item = (returned: 'with_sales' | 'resubmitted' | null) => orderAttentionItems({ ...base, operationsReview: {
      versionNumber: 1, status: 'clarification_needed', unassigned: false, reasonLine: 'Price too low.', returned,
    } } as Parameters<typeof orderAttentionItems>[0]).find(i => i.key === 'operations_review')
    const withSales = item('with_sales')
    assert.equal(withSales?.title, 'PI V1 returned to Sales')
    assert.equal(withSales?.tone, 'amber')
    assert.match(withSales?.detail ?? '', /^The approved PI cannot be edited in place\. The salesperson makes the requested changes with Edit PI and resubmits.* Price too low\.$/)
    assert.equal(item('resubmitted')?.title, 'PI V1 returned to Sales: revised PI waiting for approval')
    assert.equal(item(null)?.title, 'PI V1 flagged by operations')
    assert.equal(item(null)?.tone, 'red')
    assert.equal(SALES_RETURN_SUMMARY.with_sales, 'Returned to Sales for changes.')
  })
})

describe('the two dashboards', () => {
  const [pi] = readFlaggedPis([{ handoff_id: 'h-547', order_id: 'o-547', order_number: '0547', client_name: 'Suresh Ji',
    version_number: 1, reason: 'Price too low.', by_name: 'Nitish Bansal', since: FLAGGED_AT, waiting_seconds: 3600 }])
  const sent = { by: 'Nishant Soni', atIso: SENT_AT, text: 'Check the details and resubmit.' }

  test('a send-back counts only when it is newer than the flag', () => {
    assert.equal(isReturnedToSales(pi, sent), true)
    assert.equal(isReturnedToSales(pi, { ...sent, atIso: '2026-11-12T10:00:00Z' }), false)
    assert.equal(isReturnedToSales(pi, undefined), false)
  })

  test('the approver\'s row stops asking for a decision and says it waits on Sales, with the comment', () => {
    const row = flaggedRow(pi, sent)
    assert.equal(row.chip?.label, RETURNED_TO_SALES_LABEL)
    assert.equal(row.chip?.tone, 'info')
    assert.match(row.chip?.sub ?? '', /Nishant Soni: “Check the details and resubmit\.”/)
    assert.equal(flaggedRow(pi).chip?.label, 'Operations cannot accept PI V1')
    assert.equal(flaggedRow(pi).chip?.tone, 'danger')
  })

  test('the salesperson\'s card says it is returned to them and what to do', () => {
    const out = renderToStaticMarkup(createElement(FlaggedPiStripView, { state: { kind: 'ready', rows: [pi], sent: { 'h-547': sent } } }))
    assert.match(out, /data-returned="true"[^>]*>Returned to you: make the changes and resubmit PI V1 with Edit PI/)
    assert.match(out, /Nishant Soni sent it back to you: “Check the details and resubmit\.”/)
    assert.doesNotMatch(out, /Flagged by Nitish Bansal/)
    const plain = renderToStaticMarkup(createElement(FlaggedPiStripView, { state: { kind: 'ready', rows: [pi] } }))
    assert.match(plain, /Flagged by Nitish Bansal/)
    assert.doesNotMatch(plain, /Returned to you/)
  })
})
