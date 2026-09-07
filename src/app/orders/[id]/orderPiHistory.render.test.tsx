/**
 * The PI History card on a Confirmed Order (20261119000000), rendered.
 *
 * Current, pending and past versions in three named places; controls drawn
 * only for the people the RPCs will admit; no storage URL in the markup.
 *
 * Run:
 *   npx tsx --test "src/app/orders/[id]/orderPiHistory.render.test.tsx"
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { OrderPiHistoryCard } from './OrderPiSections'
import {
  APPROVE_REVISION_BUTTON_LABEL,
  PI_HISTORY_CURRENT_HEADING,
  PI_HISTORY_EMPTY,
  PI_HISTORY_PAST_HEADING,
  PI_HISTORY_PENDING_HEADING,
  PI_HISTORY_TITLE,
  REJECT_REVISION_BUTTON_LABEL,
  UPLOAD_REVISION_BUTTON_LABEL,
  describePiVersionHistory,
  type PersistedPiVersion,
} from '@/lib/orders/orderPiVersions'

const text = (html: string): string =>
  html.replace(/<[^>]*>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')

const SUBMISSION = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'
const RAVI = '11111111-1111-4111-8111-111111111111'
const names = new Map([[RAVI, 'Ravi Menon']])

const row = (over: Partial<PersistedPiVersion>): PersistedPiVersion => ({
  id: over.id ?? `v${over.version_number ?? 1}`,
  order_id: 'order-1', submission_id: SUBMISSION,
  version_number: 1, status: 'approved',
  workbook_path: `submissions/${SUBMISSION}/original/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.xlsx`,
  workbook_name: 'kalyan.xlsx',
  uploaded_by: RAVI, uploaded_at: '2026-09-01T09:00:00Z', revision_reason: null,
  decided_by: RAVI, decided_at: '2026-09-01T10:00:00Z', decision_reason: null, superseded_at: null,
  ...over,
})

function render(rows: PersistedPiVersion[], over: { canPropose?: boolean; canDecide?: boolean } = {}): string {
  return renderToStaticMarkup(
    <OrderPiHistoryCard
      history={describePiVersionHistory(rows, names, iso => (iso ? `on ${iso.slice(0, 10)}` : '—'))}
      canPropose={over.canPropose ?? false}
      canDecide={over.canDecide ?? false}
      onPropose={() => {}}
      onApprove={() => {}}
      onReject={() => {}}
      onOpen={() => {}}
      opening={null}
      busy={false}
      error={null}
    />,
  )
}

describe('the PI History card', () => {
  test('is headed PI History and says so when there is nothing recorded', () => {
    const html = render([])
    assert.ok(text(html).includes(PI_HISTORY_TITLE))
    assert.ok(text(html).includes(PI_HISTORY_EMPTY))
  })

  test('shows the current version under Current, with its approval line and an Open control', () => {
    const html = render([row({})])
    const body = text(html)
    assert.ok(body.includes(PI_HISTORY_CURRENT_HEADING))
    assert.ok(body.includes('PI V1'))
    assert.ok(body.includes('Approved by Ravi Menon'))
    assert.ok(body.includes(' Open '), 'the Open control')
    assert.ok(!body.includes(PI_HISTORY_PENDING_HEADING))
    // The card's own title is "PI History", so the past-versions heading is
    // looked for as its own element rather than as a substring of the text.
    assert.ok(!html.includes(`>${PI_HISTORY_PAST_HEADING}<`))
  })

  test('a pending revision sits under its own heading, with its reason, while V1 stays current', () => {
    const html = render([
      row({}),
      row({ version_number: 2, status: 'pending', decided_by: null, decided_at: null, revision_reason: 'client changed line 3' }),
    ])
    const body = text(html)
    assert.ok(body.indexOf(PI_HISTORY_CURRENT_HEADING) < body.indexOf('PI V1'))
    assert.ok(body.indexOf(PI_HISTORY_PENDING_HEADING) < body.indexOf('PI V2'))
    assert.ok(body.includes('Pending approval'))
    assert.ok(body.includes('client changed line 3'))
  })

  test('superseded and rejected versions are listed under History, the rejection with its reason', () => {
    const html = render([
      row({ status: 'superseded', superseded_at: '2026-09-05T10:00:00Z' }),
      row({ version_number: 2, status: 'rejected', revision_reason: 'r', decision_reason: 'wrong quantity on line 3', decided_at: '2026-09-04T10:00:00Z' }),
      row({ version_number: 3, status: 'approved', revision_reason: 'r', decided_at: '2026-09-05T10:00:00Z' }),
    ])
    const body = text(html)
    assert.ok(body.includes(PI_HISTORY_PAST_HEADING))
    assert.ok(body.indexOf('PI V3') < body.indexOf('PI V2'), 'the current version leads')
    assert.ok(body.includes('Rejected'))
    assert.ok(body.includes('wrong quantity on line 3'))
    assert.ok(body.includes('Superseded'))
  })

  test('the upload control appears only for somebody who may propose', () => {
    assert.ok(!text(render([row({})])).includes(UPLOAD_REVISION_BUTTON_LABEL))
    assert.ok(text(render([row({})], { canPropose: true })).includes(UPLOAD_REVISION_BUTTON_LABEL))
  })

  test('approve and reject appear only on a pending revision, and only for a decider', () => {
    const rows = [row({}), row({ version_number: 2, status: 'pending', decided_by: null, decided_at: null, revision_reason: 'r' })]
    const without = text(render(rows))
    assert.ok(!without.includes(APPROVE_REVISION_BUTTON_LABEL))
    assert.ok(!without.includes(REJECT_REVISION_BUTTON_LABEL))
    const withDecider = text(render(rows, { canDecide: true }))
    assert.ok(withDecider.includes(APPROVE_REVISION_BUTTON_LABEL))
    assert.ok(withDecider.includes(REJECT_REVISION_BUTTON_LABEL))
    assert.ok(!text(render([row({})], { canDecide: true })).includes(APPROVE_REVISION_BUTTON_LABEL),
      'nothing to decide on an Order with no pending revision')
  })

  test('NO storage key and NO URL reaches the markup', () => {
    const html = render([row({})])
    assert.ok(!html.includes('submissions/'))
    assert.ok(!/href=/.test(html))
  })
})
