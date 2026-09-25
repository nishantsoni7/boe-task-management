/**
 * Order document submissions (20270112000000), rendered: the Documents card and
 * the separation between what is CURRENT (the rows) and what is only PROPOSED
 * (the changes panel, drawn only when something is pending or rejected).
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
import { SubmissionHistoryList, uploadAvailability } from './OrderDocumentSubmissions'
import { designFilesDocument } from '@/lib/orders/orderDocumentsPanel'
import { mainPiCard } from '@/lib/orders/orderMainPi'
import { describePiVersionHistory, type PersistedPiVersion } from '@/lib/orders/orderPiVersions'
import {
  documentChanges,
  supportingRow,
  type DocumentViewer,
  type PersistedDocumentSubmission,
} from '@/lib/orders/orderDocumentSubmissions'

const text = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/\s+/g, ' ')
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
const NAMES = new Map([['sales', 'Asha'], ['ops', 'Ravi'], ['admin', 'Nishant']])
const api = (rows: PersistedDocumentSubmission[]) => ({ rows, state: 'ready' as const, names: NAMES })
const nameOf = (id: string | null) => (id ? NAMES.get(id) ?? null : null)

const V1: PersistedPiVersion = {
  id: 'v1', order_id: 'o1', submission_id: 's', version_number: 1, status: 'approved',
  workbook_path: 'k1', workbook_name: 'PI-771.xlsx', uploaded_by: 'sales', uploaded_at: '2026-09-01T00:00:00Z',
  revision_reason: null, decided_by: 'admin', decided_at: '2026-09-02T00:00:00Z', decision_reason: null, superseded_at: null,
  operations_reviewer: null, operations_decided_by: null, operations_decided_at: null, operations_reason: null,
}

/** The whole card, as the page composes it, for one viewer and one set of rows. */
const card = (rows: PersistedDocumentSubmission[], v = viewer(), over: { absence?: string | null; updateMenu?: React.ReactNode } = {}) =>
  renderToStaticMarkup(
    <OrderDocumentsPanel
      mainPi={mainPiCard(describePiVersionHistory([V1], NAMES, when))}
      design={designFilesDocument({ kind: 'ready', counts: { representative: 2, customization: 0 } }, 2)}
      onView={noop} onDownload={noop} onHistory={noop} onManageDesign={noop}
      onOpenPdf={noop}
      viewing={false} downloading={false}
      updateMenu={over.updateMenu}
      supporting={{
        design: supportingRow(api(rows), 'design_files', null),
        clientPo: supportingRow(api(rows), 'client_po', over.absence ?? null),
        formatWhen: when,
      }}
      changes={documentChanges(rows, v, nameOf, when)}
      onReviewChange={noop} onResubmitChange={noop} onOpenFile={noop}
    />,
  )
/** Only the rows of CURRENT documents, below the changes panel. */
const rowsOf = (html: string) => text(html.slice(html.indexOf('class="order-docs-rows"')))
/** Only the changes panel. */
const changesOf = (html: string) => {
  const at = html.indexOf('class="order-doc-changes')
  return at < 0 ? '' : text(html.slice(at, html.indexOf('class="order-docs-rows"')))
}

describe('the Documents card', () => {
  const accepted = sub({ id: 'a', status: 'accepted', admin_decided_by: 'admin', admin_decided_at: '2026-09-21T00:00:00Z', operations_decided_by: 'ops', operations_decided_at: '2026-09-22T00:00:00Z' })

  test('Main PI, Design Files, Client PO — one row each, in that order, full width', () => {
    const html = card([accepted])
    assert.ok(html.includes('id="documents"'), 'the anchor the queue links to')
    const t = rowsOf(html)
    assert.ok(t.indexOf('Main PI · V1') < t.indexOf('Design Files'))
    assert.ok(t.indexOf('Design Files') < t.indexOf('Client PO'))
    assert.equal((html.match(/class="order-doc-section[ "]/g) ?? []).length, 3)
    // No split grid inside the card any more.
    assert.equal(/order-docs-grid|order-docs-main|order-docs-side/.test(html), false)
  })

  test('the Main PI row: one status, the two dates, the PI PDF and the uploaded workbook', () => {
    const t = rowsOf(card([accepted]))
    assert.ok(t.includes('Main PI · V1 Current'))
    assert.ok(t.includes('Uploaded 2026-09-01') && t.includes('Approved 2026-09-02'))
    // Each action says what it opens (20270116000000): the PI itself is the
    // PDF generated from V1's details; the .xlsx is the file Sales uploaded.
    assert.ok(t.includes('View PI V1 (PDF)'))
    assert.ok(t.includes('Uploaded workbook'))
    // ONE vocabulary: the current file is never labelled three ways at once.
    assert.equal(/Accepted for production|Approved by Admin/.test(t), false)
  })

  test('a supporting row names the accepted file, which is the link that opens it', () => {
    const html = card([accepted])
    const t = rowsOf(html)
    assert.ok(t.includes('PO-771.pdf'))
    assert.match(html, /<button type="button" class="order-doc-file"[^>]*title="Open PO-771.pdf"/)
    assert.equal(/<a |href=|order-documents\//.test(html), false, 'no URL or storage key reaches the markup')
  })

  test('NOTHING PENDING: calm — no changes panel at all', () => {
    const html = card([accepted])
    assert.equal(html.includes('order-doc-changes'), false)
    assert.equal(/Needs your action|Document changes/.test(text(html)), false)
  })

  test('an absent file says "on file", and never implies one was accepted', () => {
    const t = rowsOf(card([], viewer(), { absence: 'Not provided — Asha confirmed sending the PI without a client PO on 2026-09-20.' }))
    assert.ok(t.includes('No client PO on file'))
    assert.ok(t.includes('No design files on file'))
    assert.ok(t.includes('Not provided — Asha confirmed'))
  })

  test('the PI product pictures are a quiet secondary link on the Design Files row', () => {
    const t = rowsOf(card([accepted]))
    assert.ok(t.includes('PI product pictures (2)'))
  })

  test('one Update documents control, supplied by the page; none for a reader who may not submit', () => {
    assert.ok(text(card([accepted], viewer(), { updateMenu: <button type="button">Update documents</button> })).includes('Update documents'))
    assert.equal(text(card([accepted], viewer({ canSubmit: false }))).includes('Update documents'), false)
    // No per-row upload buttons.
    assert.equal(/Upload Design Files|Upload Client PO|Upload New PI/.test(text(card([accepted]))), false)
  })

  test('full width, stacked; three aligned columns on desktop; one column on a phone', () => {
    assert.match(css, /\.order-docs-row \{\n  display: grid;\n  grid-template-columns: minmax\(0, 1fr\);/)
    assert.match(css, /\.order-doc-section \{\n  display: grid;\n  grid-template-columns: minmax\(0, 1fr\) minmax\(0, 330px\) minmax\(170px, auto\);/)
    assert.match(css, /@media \(max-width: 560px\) \{[\s\S]*?\.order-doc-section \{ grid-template-columns: minmax\(0, 1fr\);/)
  })
})

describe('proposed is never drawn as current', () => {
  test('a pending upload is only in the changes panel, with its stage and owner', () => {
    const html = card([sub({ status: 'pending_admin' })])
    assert.ok(rowsOf(html).includes('No client PO on file'))
    assert.equal(rowsOf(html).includes('PO-771.pdf'), false, 'the proposed file is not a current row')
    const c = changesOf(html)
    assert.ok(c.includes('New Client PO Waiting for Admin'))
    assert.ok(c.includes('Would be the first client PO (1 file)'))
    assert.ok(c.includes('With: Admin · Next: Admin to approve or reject'))
    assert.ok(c.includes('PO-771.pdf'))
  })

  test('awaiting Operations names the reviewer and is still not current', () => {
    const html = card([sub({ status: 'awaiting_operations', admin_decided_by: 'admin', admin_decided_at: '2026-09-21T00:00:00Z', operations_reviewer: 'ops' })])
    const c = changesOf(html)
    assert.ok(c.includes('Waiting for Operations'))
    assert.ok(c.includes('With: Operations — Ravi'))
    assert.ok(c.includes('approved by Nishant, 2026-09-21'))
    assert.ok(rowsOf(html).includes('No client PO on file'))
  })

  test('the accepted file stays current and usable while a newer proposal is reviewed', () => {
    const accepted = sub({ id: 'a', status: 'accepted', admin_decided_at: 't', operations_decided_at: '2026-09-22T00:00:00Z' })
    const pending = sub({ id: 'p', status: 'pending_admin', files: [{ id: 'f2', category: 'client_po', storage_path: 'k', file_name: 'PO-772.pdf', mime_type: 'application/pdf', size_bytes: 10 }] })
    const html = card([pending, accepted])
    assert.ok(rowsOf(html).includes('PO-771.pdf') && !rowsOf(html).includes('PO-772.pdf'))
    assert.ok(changesOf(html).includes('PO-772.pdf') && changesOf(html).includes('Would replace the current client PO with 1 file'))
  })

  test('a submission covering both categories is ONE entry, not one per category', () => {
    const both = sub({ includes_design_files: true, design_mode: 'replace', files: [
      { id: 'd', category: 'design_files', storage_path: 'k1', file_name: 'front.png', mime_type: 'image/png', size_bytes: 10 },
      { id: 'p', category: 'client_po', storage_path: 'k2', file_name: 'PO.pdf', mime_type: 'application/pdf', size_bytes: 10 },
    ] })
    const c = changesOf(card([both]))
    assert.equal((c.match(/New Design Files \+ Client PO/g) ?? []).length, 1)
  })
})

describe('who is offered what', () => {
  const pending = sub({ status: 'pending_admin' })
  const awaiting = sub({ status: 'awaiting_operations', admin_decided_at: 't', operations_reviewer: 'ops' })

  test('Admin gets Review change on a submission awaiting Admin; Sales does not', () => {
    assert.equal(changesOf(card([pending])).includes('Review change'), false, 'not for Sales')
    assert.ok(changesOf(card([pending], viewer({ viewerId: 'admin', isAdmin: true }))).includes('Review change'))
    assert.ok(changesOf(card([pending], viewer({ viewerId: 'admin', isAdmin: true }))).includes('Needs your action'))
    assert.equal(changesOf(card([pending], viewer({ viewerId: 'admin', isAdmin: true, viewingAs: true }))).includes('Review change'), false, 'never under View As')
  })

  test('only the assigned Operations reviewer gets Review change at the Operations stage', () => {
    assert.ok(changesOf(card([awaiting], viewer({ viewerId: 'ops' }))).includes('Review change'))
    assert.equal(changesOf(card([awaiting], viewer({ viewerId: 'admin', isAdmin: true }))).includes('Review change'), false, 'an admin is not the reviewer')
    // Sales sees where it stands, headed as changes — not as their action.
    const s = changesOf(card([awaiting]))
    assert.ok(s.includes('Document changes') && !s.includes('Needs your action'))
  })

  test('a rejection shows its reason and Correct and resubmit to Sales', () => {
    const t = changesOf(card([sub({ status: 'rejected_operations', admin_decided_at: 't', operations_decided_by: 'ops', operations_decided_at: '2026-09-22T00:00:00Z', operations_reason: 'Wrong revision of the PO' })]))
    assert.ok(t.includes('Rejected by Operations'))
    assert.ok(t.includes('Reason: Wrong revision of the PO — Ravi (Operations), 2026-09-22'))
    assert.ok(t.includes('Correct and resubmit'))
    assert.ok(t.includes('Needs your action'))
  })

  test('a rejection is not shown to an unrelated reader, and a corrected one is gone', () => {
    const rejected = sub({ id: 'r', status: 'rejected_admin', admin_decided_by: 'admin', admin_decided_at: 't', admin_reason: 'unsigned' })
    assert.equal(card([rejected], viewer({ viewerId: 'ops' })).includes('order-doc-changes'), false)
    const corrected = sub({ id: 'c', status: 'pending_admin', resubmission_of: 'r' })
    assert.equal(changesOf(card([corrected, rejected])).includes('unsigned'), false)
  })

  test('documents sent with the PI are labelled as such, and have no decision of their own', () => {
    const initial = sub({ stage: 'initial', pi_submission_id: 'pi', status: 'awaiting_operations', operations_reviewer: 'ops', admin_decided_at: 't', includes_design_files: true, includes_client_po: false, design_mode: 'add',
      files: [{ id: 'f', category: 'design_files', storage_path: 'k', file_name: 'drawing.pdf', mime_type: 'application/pdf', size_bytes: 10 }] })
    const c = changesOf(card([initial], viewer({ viewerId: 'ops' })))
    assert.ok(c.includes('Design Files sent with the PI'))
    assert.ok(c.includes("with PI V1's operations review"))
    assert.equal(c.includes('Would add'), false)
    assert.equal(c.includes('Review change'), false, 'the handoff decides it')
  })
})

describe('the permanent trail and the upload menu', () => {
  test('the history keeps every submission with who decided, when and why', () => {
    const rejected = sub({ id: 'r', status: 'rejected_admin', admin_decided_by: 'admin', admin_decided_at: '2026-09-21T00:00:00Z', admin_reason: 'PO number mismatch' })
    const accepted = sub({ id: 'a', status: 'accepted', admin_decided_by: 'admin', admin_decided_at: '2026-09-22T00:00:00Z', operations_decided_by: 'ops', operations_decided_at: '2026-09-23T00:00:00Z' })
    const t = text(renderToStaticMarkup(<SubmissionHistoryList api={api([rejected, accepted])} formatWhen={when} onOpenFile={noop} />))
    assert.ok(t.includes('Admin: rejected by Nishant, 2026-09-21 — PO number mismatch'))
    assert.ok(t.includes('Operations: accepted by Ravi, 2026-09-23'))
    assert.equal((t.match(/PO-771\.pdf/g) ?? []).length, 2, 'each submission keeps its own files')
  })

  test('a category with a submission under review is offered, disabled, with the reason', () => {
    const blocked = uploadAvailability('client_po', api([sub({})]), viewer())
    assert.equal(blocked.offered, true)
    assert.match(blocked.blockedReason ?? '', /already has a submission under review/)
    assert.deepEqual(uploadAvailability('client_po', api([]), viewer()), { offered: true, blockedReason: null })
    assert.equal(uploadAvailability('client_po', api([]), viewer({ canSubmit: false })).offered, false)
    assert.equal(uploadAvailability('client_po', api([]), viewer({ viewingAs: true })).offered, false)
  })
})
