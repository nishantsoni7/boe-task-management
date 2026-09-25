/**
 * Order document submissions (20270112000000), rendered: the Documents layout
 * and the separation between what is accepted and what is only proposed.
 *
 * Run:
 *   npx tsx --test "src/app/orders/**\/orderDocumentSubmissions.render.test.tsx"
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { OrderDocumentsPanel } from './OrderStatusWorkspace'
import { DocumentCategoryBody, DocumentUploadAction } from './OrderDocumentSubmissions'
import { clientPoDocument, designFilesDocument } from '@/lib/orders/orderDocumentsPanel'
import { mainPiCard } from '@/lib/orders/orderMainPi'
import { describePiVersionHistory } from '@/lib/orders/orderPiVersions'
import type { DocumentViewer, PersistedDocumentSubmission } from '@/lib/orders/orderDocumentSubmissions'

const text = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ')
const noop = () => {}
const when = (iso: string | null) => (iso ? iso.slice(0, 10) : '—')
const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8').replace(/\r\n/g, '\n')

const sub = (over: Partial<PersistedDocumentSubmission>): PersistedDocumentSubmission => ({
  id: 's1', stage: 'amendment', order_id: 'o1', pi_submission_id: null, includes_design_files: false, includes_client_po: true, design_mode: null, note: null,
  status: 'pending_admin', snapshot_sha256: 'a'.repeat(64), file_count: 1, resubmission_of: null,
  submitted_by: 'sales', submitted_at: '2026-09-20T10:00:00Z',
  admin_decided_by: null, admin_decided_at: null, admin_reason: null,
  operations_reviewer: null, operations_decided_by: null, operations_decided_at: null, operations_reason: null,
  files: [{ id: 'f1', category: 'client_po', storage_path: 'order-documents/o1/s1/client_po/x.pdf', file_name: 'PO-771.pdf', mime_type: 'application/pdf', size_bytes: 2048 }],
  ...over,
})
const viewer = (over: Partial<DocumentViewer> = {}): DocumentViewer =>
  ({ viewerId: 'sales', isAdmin: false, canSubmit: true, viewingAs: false, ...over })
const api = (rows: PersistedDocumentSubmission[]) =>
  ({ rows, state: 'ready' as const, names: new Map([['sales', 'Asha'], ['ops', 'Ravi'], ['admin', 'Nishant']]) })

const body = (rows: PersistedDocumentSubmission[], v = viewer()) => renderToStaticMarkup(
  <DocumentCategoryBody category="client_po" api={api(rows)} viewer={v} formatWhen={when}
    onReview={noop} onResubmit={noop} onOpenFile={noop} />,
)

describe('the Documents layout', () => {
  const html = renderToStaticMarkup(
    <OrderDocumentsPanel
      mainPi={mainPiCard(describePiVersionHistory([], new Map(), when))}
      design={designFilesDocument({ kind: 'ready', counts: { representative: 2, customization: 0 } }, 2)}
      clientPo={clientPoDocument()}
      onView={noop} onDownload={noop} onHistory={noop} onManageDesign={noop}
      viewing={false} downloading={false}
      mainPiUpload={<button type="button">Upload New PI</button>}
      clientPoSubmissions={<p>PO body</p>}
    />,
  )

  test('Main PI is the left column; Design Files then Client PO stack on the right', () => {
    const main = html.indexOf('order-docs-main')
    const side = html.indexOf('order-docs-side')
    assert.ok(main > 0 && side > main)
    assert.ok(html.indexOf('aria-label="Main PI"') > main && html.indexOf('aria-label="Main PI"') < side)
    assert.ok(html.indexOf('aria-label="Design Files"') > side)
    assert.ok(html.indexOf('aria-label="Client PO"') > html.indexOf('aria-label="Design Files"'))
    assert.ok(html.includes('id="documents"'), 'the anchor the queue links to')
    assert.ok(text(html).includes('Upload New PI'))
  })

  test('about 40 / 60 on desktop, one column on a phone', () => {
    assert.match(css, /\.order-docs-grid \{\n  display: grid;\n  grid-template-columns: minmax\(0, 2fr\) minmax\(0, 3fr\);/)
    assert.match(css, /@media \(max-width: 720px\) \{\n  \.order-docs-grid \{ grid-template-columns: minmax\(0, 1fr\); \}/)
  })
})

describe('accepted and proposed are never confused', () => {
  test('a pending upload is not drawn as accepted', () => {
    const t = text(body([sub({ status: 'pending_admin' })]))
    assert.ok(t.includes('No client PO accepted on this Order yet'))
    assert.ok(t.includes('Proposed change — not in use yet'))
    assert.ok(t.includes('Pending Admin Review'))
    assert.ok(t.includes('Waiting on: Admin'))
    assert.equal(/\bAccepted\b/.test(t.replace('No client PO accepted', '')), false)
  })

  test('awaiting operations names the reviewer and still is not accepted', () => {
    const t = text(body([sub({ status: 'awaiting_operations', admin_decided_by: 'admin', admin_decided_at: '2026-09-21T00:00:00Z', operations_reviewer: 'ops' })]))
    assert.ok(t.includes('Awaiting Operations Acceptance'))
    assert.ok(t.includes('Waiting on: Operations — Ravi'))
    assert.ok(t.includes('No client PO accepted on this Order yet'))
  })

  test('accepted files show as accepted, and a newer proposal sits separately', () => {
    const accepted = sub({ id: 'a', status: 'accepted', admin_decided_at: 't', operations_decided_at: '2026-09-22T00:00:00Z' })
    const pending = sub({ id: 'p', status: 'pending_admin', files: [{ id: 'f2', category: 'client_po', storage_path: 'k', file_name: 'PO-772.pdf', mime_type: 'application/pdf', size_bytes: 10 }] })
    const t = text(body([pending, accepted]))
    assert.ok(t.indexOf('1 accepted file') < t.indexOf('Proposed change'))
    assert.ok(t.indexOf('PO-771.pdf') < t.indexOf('Proposed change') && t.indexOf('PO-772.pdf') > t.indexOf('Proposed change'))
  })

  test('the review control is drawn only for the owner of the stage', () => {
    const pending = sub({ status: 'pending_admin' })
    assert.equal(body([pending]).includes('Review — Approve or Reject'), false, 'not for Sales')
    assert.ok(body([pending], viewer({ viewerId: 'admin', isAdmin: true })).includes('Review — Approve or Reject'))
    assert.equal(body([pending], viewer({ viewerId: 'admin', isAdmin: true, viewingAs: true })).includes('Review —'), false, 'never under View As')
    const awaiting = sub({ status: 'awaiting_operations', admin_decided_at: 't', operations_reviewer: 'ops' })
    assert.ok(body([awaiting], viewer({ viewerId: 'ops' })).includes('Review — Accept or Reject'))
    assert.equal(body([awaiting], viewer({ viewerId: 'admin', isAdmin: true })).includes('Review —'), false, 'an admin is not the reviewer')
  })

  test('a rejection shows its reason and the correction control to Sales', () => {
    const t = text(body([sub({ status: 'rejected_operations', admin_decided_at: 't', operations_decided_by: 'ops', operations_decided_at: '2026-09-22T00:00:00Z', operations_reason: 'Wrong revision of the PO' })]))
    assert.ok(t.includes('Rejected by Operations'))
    assert.ok(t.includes('Operations reason: Wrong revision of the PO'))
    assert.ok(t.includes('Correct and resubmit'))
  })

  test('the history keeps every submission with who decided, when and why', () => {
    const rejected = sub({ id: 'r', status: 'rejected_admin', admin_decided_by: 'admin', admin_decided_at: '2026-09-21T00:00:00Z', admin_reason: 'PO number mismatch' })
    const accepted = sub({ id: 'a', status: 'accepted', admin_decided_by: 'admin', admin_decided_at: '2026-09-22T00:00:00Z', operations_decided_by: 'ops', operations_decided_at: '2026-09-23T00:00:00Z' })
    const t = text(body([rejected, accepted]))
    assert.ok(t.includes('Submission history (2)'))
    assert.ok(t.includes('Admin: rejected by Nishant, 2026-09-21 — PO number mismatch'))
    assert.ok(t.includes('Operations: accepted by Ravi, 2026-09-23'))
  })

  test('documents sent with the PI are labelled as such, with no add/replace wording', () => {
    const initial = sub({ stage: 'initial', pi_submission_id: 'pi', status: 'awaiting_operations', operations_reviewer: 'ops', admin_decided_at: 't', includes_design_files: true, includes_client_po: false, design_mode: 'add',
      files: [{ id: 'f', category: 'design_files', storage_path: 'k', file_name: 'drawing.pdf', mime_type: 'application/pdf', size_bytes: 10 }] })
    const html = renderToStaticMarkup(
      <DocumentCategoryBody category="design_files" api={api([initial])} viewer={viewer({ viewerId: 'ops' })} formatWhen={when}
        onReview={noop} onResubmit={noop} onOpenFile={noop} />)
    const t = text(html)
    assert.ok(t.includes('Sent with the PI — not in use yet'))
    assert.ok(t.includes("with PI V1's operations review"))
    assert.equal(t.includes('adds to the current design files'), false)
    assert.equal(html.includes('Review —'), false, 'no separate decision: the handoff decides it')
  })

  test('an acknowledged absence reads as not provided, never as attached', () => {
    const html = renderToStaticMarkup(
      <DocumentCategoryBody category="client_po" api={api([])} viewer={viewer()} formatWhen={when}
        onReview={noop} onResubmit={noop} onOpenFile={noop}
        absence="Not provided — Asha confirmed sending the PI without a client PO on 2026-09-20." />)
    const t = text(html)
    assert.ok(t.includes('Not provided — Asha confirmed'))
    assert.equal(/Attached|Accepted/.test(t), false)
  })

  test('beside the Order’s own design files, the PI pictures are a named secondary line', () => {
    const html = renderToStaticMarkup(
      <OrderDocumentsPanel
        mainPi={mainPiCard(describePiVersionHistory([], new Map(), when))}
        design={designFilesDocument({ kind: 'ready', counts: { representative: 2, customization: 0 } }, 2)}
        clientPo={clientPoDocument()}
        onView={noop} onDownload={noop} onHistory={noop} onManageDesign={noop}
        viewing={false} downloading={false}
        designSubmissions={<p>order files</p>}
      />)
    const t = text(html)
    assert.ok(t.includes('PI product pictures: 2 files'))
    assert.equal(t.includes('Attached'), false, 'no second "Attached" headline')
  })

  test('the upload control is disabled while that category has a submission under review', () => {
    const html = renderToStaticMarkup(<DocumentUploadAction category="client_po" api={api([sub({})])} viewer={viewer()} onUpload={noop} />)
    assert.ok(html.includes('disabled'))
    assert.ok(html.includes('already has a submission under review'))
    assert.equal(renderToStaticMarkup(<DocumentUploadAction category="client_po" api={api([])} viewer={viewer({ canSubmit: false })} onUpload={noop} />), '')
  })
})
