/**
 * Revised PI promotion (20270113000000), rendered: the proposal beside the PI
 * in force, and the operations review dialog.
 *
 * Run:
 *   npx tsx --test "src/app/orders/**\/orderPiRevisionPromotion.render.test.tsx"
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { OrderDocumentsPanel } from './OrderStatusWorkspace'
import { RevisionOperationsReviewModal } from './RevisionOperationsReviewModal'
import { clientPoDocument, designFilesDocument } from '@/lib/orders/orderDocumentsPanel'
import { mainPiCard } from '@/lib/orders/orderMainPi'
import { describePiVersionHistory, type PersistedPiVersion, type RevisionDifferences } from '@/lib/orders/orderPiVersions'

const text = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ')
const noop = () => {}
const when = (iso: string | null) => (iso ? iso.slice(0, 10) : '—')
const NAMES = new Map([['sales', 'Rohan'], ['admin', 'Meera'], ['ops', 'Kavya']])
const row = (over: Partial<PersistedPiVersion>): PersistedPiVersion => ({
  id: 'v1', order_id: 'o', submission_id: 's', version_number: 1, status: 'approved',
  workbook_path: 'k1', workbook_name: 'v1.xlsx', uploaded_by: 'sales', uploaded_at: '2026-09-01T00:00:00Z',
  revision_reason: null, decided_by: 'admin', decided_at: '2026-09-02T00:00:00Z', decision_reason: null, superseded_at: null,
  operations_reviewer: null, operations_decided_by: null, operations_decided_at: null, operations_reason: null, ...over,
})
const history = describePiVersionHistory([
  row({ id: 'v2', version_number: 2, status: 'admin_approved', workbook_path: 'k2', revision_reason: 'client changed qty',
        decided_at: '2026-09-20T00:00:00Z', operations_reviewer: 'ops' }),
  row({}),
], NAMES, when)

const panel = (onReview?: () => void) => renderToStaticMarkup(
  <OrderDocumentsPanel
    mainPi={mainPiCard(history)}
    design={designFilesDocument({ kind: 'ready', counts: { representative: 1, customization: 0 } }, 1)}
    clientPo={clientPoDocument()}
    onView={noop} onDownload={noop} onHistory={noop} onManageDesign={noop}
    viewing={false} downloading={false}
    onReviewRevision={onReview} onOpenProposal={noop}
  />,
)

describe('the Main PI section keeps V1 in force and shows V2 apart', () => {
  test('V1 is the headline; V2 is a proposal with its stage and owner', () => {
    const t = text(panel())
    assert.ok(t.indexOf('PI V1') < t.indexOf('Proposed PI V2 — not in force yet'))
    assert.ok(t.includes('Approved by Admin — awaiting Operations'))
    assert.ok(t.includes('Waiting on: Operations — Kavya · Next: Operations to accept or reject'))
    assert.ok(t.includes('PI V1 stays in force'))
    assert.ok(t.includes('Open PI V2'))
  })
  test('the review control is drawn only when the page offers it (the reviewer)', () => {
    assert.equal(panel().includes('Review PI V2 — Accept or Reject'), false)
    assert.ok(panel(noop).includes('Review PI V2 — Accept or Reject'))
  })
})

describe('the approving admin is no longer active (§6b)', () => {
  const reapprovePanel = (confirming: boolean, error: string | null = null) => renderToStaticMarkup(
    <OrderDocumentsPanel
      mainPi={mainPiCard(history)}
      design={designFilesDocument({ kind: 'ready', counts: { representative: 1, customization: 0 } }, 1)}
      clientPo={clientPoDocument()}
      onView={noop} onDownload={noop} onHistory={noop} onManageDesign={noop}
      viewing={false} downloading={false} onOpenProposal={noop}
      revisionApproverInactive
      reapprove={{ confirming, busy: false, error, onStart: noop, onConfirm: noop, onCancel: noop }}
    />,
  )
  test('the stage says why it waits, and the admin is offered Re-approve', () => {
    const t = text(reapprovePanel(false))
    assert.ok(t.includes('Waiting on: Admin — the approving administrator is no longer active · Next: An active admin to re-approve it, or Operations to reject it'))
    assert.ok(t.includes('Re-approve PI V2'))
    assert.equal(t.includes('Confirm re-approval'), false, 'one press only opens the confirmation')
  })
  test('confirming says exactly what re-approval does, and a refusal is shown', () => {
    const t = text(reapprovePanel(true, 'PI V2 was approved by an administrator who is still active'))
    assert.ok(t.includes('Re-approving records your approval of the same file; nothing in force changes until Operations accepts it.'))
    assert.ok(t.includes('Confirm re-approval') && t.includes('Cancel'))
    assert.ok(t.includes('still active'))
  })
  test('without the page offering it, no control is drawn', () => {
    assert.equal(text(panel()).includes('Re-approve'), false)
  })
})

const diff = (blocking: RevisionDifferences['blocking']): RevisionDifferences => ({
  staged: true, blocking, applied: false,
  lines: { added: [], removed: [], changed: [{ seq: '1', name: 'Chair', from: { name: 'Chair', qty: 1, rate: 500000, total: 500000 }, to: { name: 'Chair', qty: 2, rate: 250000, total: 500000 } }] },
  billing_percentage: { order: null, pi: null },
})
const modal = (d: RevisionDifferences | null | 'unavailable') => renderToStaticMarkup(
  <RevisionOperationsReviewModal orderNumber="0001" current={history.current} proposal={history.pending!}
    differences={d} saving={false} failure={null} onOpen={noop} onClose={noop} onDecide={noop} />,
)

describe('the operations review dialog', () => {
  test('a matching V2: both PIs, the line change, and Accept', () => {
    const t = text(modal(diff([])))
    assert.ok(t.includes('In force: PI V1') && t.includes('Proposed: PI V2'))
    assert.ok(t.includes('The Order already matches PI V2'))
    assert.ok(t.includes('Line 1 changes: Chair ×1'))
    assert.ok(t.includes('Accept PI V2'))
  })
  test('a materially different V2: the differences, the reconciliation path, and NO Accept', () => {
    const t = text(modal(diff([{ field: 'total_value', label: 'Order value', order_value: 600000, pi_value: 750000 }])))
    assert.ok(t.includes('Order value ₹6,00,000 ₹7,50,000'))
    assert.ok(t.includes('Request a Change'))
    assert.equal(t.includes('Accept PI V2'), false)
    assert.ok(t.includes('Reject'))
  })
  test('while the comparison loads, Accept cannot be pressed', () => {
    const html = modal(null)
    assert.ok(text(html).includes('Comparing the two PIs'))
    assert.match(html, /<button[^>]*disabled=""[^>]*>Accept PI V2/)
  })
})

describe('the PI history names the operations decision', () => {
  test('an accepted revision says who accepted it; a staged one says it is not in force', async () => {
    const { PiHistoryModal } = await import('./OrderStatusWorkspace')
    const { piVersionTimeline } = await import('@/lib/orders/orderMainPi')
    const accepted = describePiVersionHistory([
      row({ id: 'v2', version_number: 2, status: 'approved', decided_at: '2026-09-20T00:00:00Z',
            operations_decided_by: 'ops', operations_decided_at: '2026-09-21T00:00:00Z', revision_reason: 'qty' }),
      row({ status: 'superseded', superseded_at: '2026-09-21T00:00:00Z' }),
    ], NAMES, when)
    const t = text(renderToStaticMarkup(
      <PiHistoryModal entries={piVersionTimeline(accepted)} onClose={noop} onView={noop} onDownload={noop} busyId={null}
        canPropose={false} onPropose={noop} canDecide={false} onApprove={noop} onReject={noop} error={null} />))
    assert.ok(t.includes('Accepted by Operations — Kavya · 2026-09-21'))
    const staged = text(renderToStaticMarkup(
      <PiHistoryModal entries={piVersionTimeline(history)} onClose={noop} onView={noop} onDownload={noop} busyId={null}
        canPropose={false} onPropose={noop} canDecide={true} onApprove={noop} onReject={noop} error={null} />))
    assert.ok(staged.includes('Awaiting operations acceptance by Kavya. Not in force yet.'))
    assert.equal(staged.includes('Approve revision'), false, 'the admin decision is over once staged')
  })
})
