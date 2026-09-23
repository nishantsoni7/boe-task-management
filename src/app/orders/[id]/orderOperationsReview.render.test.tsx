/**
 * The Operations review card and its decision dialog (20261229000000), drawn.
 *
 * renderToStaticMarkup, no browser: what a reader sees for each state of the
 * version in force, and that the two controls appear ONLY when the rules
 * module says so — never from being an admin.
 *
 * Run:
 *   npx tsx --test "src/app/orders/[id]/orderOperationsReview.render.test.tsx"
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { OrderOperationsReviewCard } from './OrderStatusWorkspace'
import { OperationsHandoffDecisionModal } from './OrderRevisionModals'
import {
  describeOperationsHandoff,
  describeOperationsHandoffHistory,
  type PersistedOperationsHandoff,
} from '@/lib/orders/operationsHandoff'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

const NISHANT = 'aaaaaaaa-0000-0000-0000-000000000001'
const NITISH  = 'aaaaaaaa-0000-0000-0000-000000000002'
const NAMES = new Map([[NISHANT, 'Nishant'], [NITISH, 'Nitish']])
const when = (iso: string | null) => (iso ? `on ${iso.slice(0, 10)}` : '—')

function handoff(over: Partial<PersistedOperationsHandoff> = {}): PersistedOperationsHandoff {
  return {
    id: 'h1', order_id: 'o1', pi_version_id: 'v1', submission_id: 's1', version_number: 1,
    approved_by: NISHANT, approved_at: '2026-09-20T10:00:00Z',
    assigned_to: NITISH, assigned_at: '2026-09-20T10:00:00Z',
    production_alignment_at_approval: 'not_aligned', prior_handoff_status: null,
    status: 'awaiting',
    accepted_by: null, accepted_at: null, accepted_note: null,
    clarification_by: null, clarification_at: null, clarification_reason: null,
    superseded_at: null, superseded_by_version_id: null, created_at: '2026-09-20T10:00:00Z',
    ...over,
  }
}

const noop = () => {}
const view = (live: PersistedOperationsHandoff | null, viewerId: string | null, extra: Partial<Parameters<typeof describeOperationsHandoff>[0]> = {}) =>
  describeOperationsHandoff({
    live, hasSourcePi: true, namesById: NAMES, formatWhen: when,
    viewerId, viewingAs: false, orderStatus: 'running',
    productionAligned: false, productionAlignedAt: null, ...extra,
  })
const card = (v: ReturnType<typeof view>, history: PersistedOperationsHandoff[] = []) =>
  renderToStaticMarkup(
    <OrderOperationsReviewCard
      view={v}
      history={describeOperationsHandoffHistory({ history, namesById: NAMES, formatWhen: when })}
      busy={false}
      onAccept={noop}
      onCannotAccept={noop}
    />,
  )

describe('the card, state by state', () => {
  test('awaiting, for the reviewer: version, approver, reviewer, status, and BOTH controls', () => {
    const html = card(view(handoff(), NITISH))
    assert.match(html, /id="operations-review"/)
    assert.match(html, /Operations review/)
    assert.match(html, /PI V1/)
    assert.match(html, /Awaiting operations review/)
    assert.match(html, /Approved by Nishant · on 2026-09-20/)
    assert.match(html, /Nitish/)
    assert.match(html, /Accept for production/)
    assert.match(html, /Cannot accept/)
    assert.doesNotMatch(html, /Only the assigned operations reviewer/)
  })

  test('awaiting, for the approving admin: the same facts, NO controls, and why', () => {
    const html = card(view(handoff(), NISHANT))
    assert.match(html, /Awaiting operations review/)
    assert.doesNotMatch(html, /<button[^>]*>Accept for production/)
    assert.doesNotMatch(html, /<button[^>]*>Cannot accept/)
    assert.match(html, /Only the assigned operations reviewer can accept/)
  })

  test('unassigned: says so in words, points at Control Center, offers nobody a control', () => {
    const html = card(view(handoff({ assigned_to: null, assigned_at: null }), NISHANT))
    assert.match(html, /No operations reviewer assigned/)
    assert.match(html, /Control Center/)
    assert.doesNotMatch(html, /<button/)
    assert.doesNotMatch(html, /Accepted/)
  })

  test('accepted: who and when, no controls', () => {
    const html = card(view(handoff({ status: 'accepted', accepted_by: NITISH, accepted_at: '2026-09-21T09:00:00Z', accepted_note: 'Can proceed' }), NITISH))
    assert.match(html, /Accepted for production/)
    assert.match(html, /by Nitish · on 2026-09-21/)
    assert.match(html, /Can proceed/)
    assert.doesNotMatch(html, /<button/)
  })

  test('flagged: the reason, and only Accept remains for the reviewer', () => {
    const html = card(view(handoff({ status: 'clarification_needed', clarification_by: NITISH, clarification_at: '2026-09-21T09:00:00Z', clarification_reason: 'Which fabric?' }), NITISH))
    assert.match(html, /Clarification needed/)
    assert.match(html, /Which fabric\?/)
    assert.match(html, /<button[^>]*>Accept for production/)
    assert.doesNotMatch(html, /<button[^>]*>Cannot accept/)
  })

  test('a later version on an aligned Order: both warnings, and the earlier decision in history', () => {
    const v1 = handoff({ id: 'h1', status: 'accepted', accepted_by: NITISH, accepted_at: '2026-09-21T09:00:00Z', superseded_at: '2026-09-22T10:00:00Z', superseded_by_version_id: 'v2' })
    const v2 = handoff({ id: 'h2', version_number: 2, pi_version_id: 'v2', prior_handoff_status: 'accepted', approved_at: '2026-09-22T10:00:00Z', production_alignment_at_approval: 'aligned' })
    const html = card(view(v2, NITISH, { productionAligned: true, productionAlignedAt: '2026-09-21T12:00:00Z' }), [v1])
    assert.match(html, /PI V2/)
    assert.match(html, /An earlier version was accepted for production\. PI V2 has not been\./)
    assert.match(html, /Production was aligned before PI V2/)
    assert.match(html, /Earlier versions \(1\)/)
    assert.match(html, /PI V1: Accepted for production/)
    assert.match(html, /<button[^>]*>Accept for production/)
  })

  test('not recorded: an honest absence, no controls, no invented acceptance', () => {
    const html = card(view(null, NITISH))
    assert.match(html, /Not recorded/)
    assert.match(html, /approved before operations handoffs were recorded/)
    assert.doesNotMatch(html, /<button/)
    assert.doesNotMatch(html, /Accepted for production/)
  })
})

describe('the decision dialog', () => {
  test('accepting says what it records and what it does not claim', () => {
    const html = renderToStaticMarkup(
      <OperationsHandoffDecisionModal orderNumber="0524" versionLabel="PI V2" decision="accepted" saving={false} failure={null} onClose={noop} onConfirm={noop} />,
    )
    assert.match(html, /Accept this PI version for production/)
    assert.match(html, /Order 0524 · PI V2/)
    assert.match(html, /does not say any manufacturing work is done/)
    assert.match(html, /does not change production alignment/)
    assert.match(html, /Note \(optional\)/)
  })

  test('flagging asks for the reason and names the button honestly', () => {
    const html = renderToStaticMarkup(
      <OperationsHandoffDecisionModal orderNumber="0524" versionLabel="PI V2" decision="clarification_needed" saving={false} failure="A newer PI version has been approved since this page loaded. Refresh to review the current one." onClose={noop} onConfirm={noop} />,
    )
    assert.match(html, /Cannot accept this PI version/)
    assert.match(html, /What needs clarifying/)
    assert.match(html, /A newer PI version has been approved/)
    assert.match(html, /<button[^>]*>Cannot accept/)
  })
})

describe('the page states nothing while the read is in flight', () => {
  test('a skeleton, not a Not recorded claim, until handoffReady', () => {
    const page = read('src/app/orders/[id]/page.tsx')
    const body = page.slice(page.indexOf('<OrdersLayout'))
    assert.match(body, /\{!handoffReady \? \(\s*<SectionSkeleton rows=\{2\} label="Loading operations review" \/>\s*\) : operationsView && \(\s*<OrderOperationsReviewCard/)
  })
})
