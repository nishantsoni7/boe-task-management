/**
 * EDIT PI AND THE VERSION STRIP (20270115000000), rendered.
 *
 * What an Admin reads before authorizing a version, and what each version card
 * says. The data paths (propose → authorize → accept) are proved in
 * supabase/tests/order_pi_edit_revisions_assertions.sql.
 *
 * Run:
 *   npx tsx --test src/components/orders/piEditor.render.test.tsx
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { diffPi, normalizePi, type PiContent } from '@/lib/orders/piEdit'
import { EDIT_PI_PROPOSE_NOTE, EDIT_PI_WORKBOOK_NOTE, PiDiffView } from './PiEditor'
import { EDIT_PI_BLOCKED_NOTE, PiVersionHistory, VERSION_STATUS_LABEL, isOpenRevision, normalizeVersionContent, versionSummary, type PiVersionRow } from './PiVersionsPanel'
import type { SupabaseClient } from '@supabase/supabase-js'

const content = (over: { name?: string; qty?: number; rate?: number; city?: string; extra?: boolean } = {}): PiContent => ({
  submission: { client_name: 'Meridian Hotels', client_city: over.city ?? 'Coimbatore', grand_total: (over.qty ?? 10) * (over.rate ?? 1000) + (over.extra ? 5000 : 0) },
  items: [
    { id: 'a', source_row: 32, item_sequence: null, source_product_code: 'B001', product_name: over.name ?? 'Lounge chair',
      quantity: over.qty ?? 10, dimensions: null, material: 'Teak', customization: null, cost_per_piece: over.rate ?? 1000,
      total_amount: (over.qty ?? 10) * (over.rate ?? 1000), sort_order: 0 },
    ...(over.extra ? [{ id: 'b', source_row: 33, item_sequence: null, source_product_code: null, product_name: 'Side table',
      quantity: 1, dimensions: null, material: null, customization: null, cost_per_piece: 5000, total_amount: 5000, sort_order: 1 }] : []),
  ],
  images: [],
})

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ')

describe('the comparison an Admin reads', () => {
  const html = renderToStaticMarkup(<PiDiffView diff={diffPi(normalizePi(content()),
    normalizePi(content({ name: 'Lounge chair, walnut', rate: 1200, city: 'Chennai', extra: true })))} />)
  const t = text(html)

  test('a changed field shows its current and proposed values', () => {
    assert.ok(t.includes('Client city') && t.includes('Coimbatore') && t.includes('Chennai'))
    assert.ok(html.includes('line-through'), 'the current value is visibly the one going away')
  })
  test('added, removed and modified products, with their money', () => {
    assert.ok(t.includes('Added') && t.includes('Side table'))
    assert.ok(t.includes('Lounge chair, walnut'))
    assert.ok(t.includes('Price') && t.includes('Name'))
    assert.ok(/\+\s?₹2,000/.test(t), 'the line total delta: 10 × ₹200')
  })
  test('and the grand total delta', () => {
    assert.ok(/Grand total \+\s?₹7,000/.test(t), t)
  })
  test('nothing changed says so, rather than drawing an empty table', () => {
    assert.ok(text(renderToStaticMarkup(<PiDiffView diff={diffPi(normalizePi(content()), normalizePi(content()))} />)).includes('No changes'))
  })
})

describe('each version card says what it is', () => {
  const v = (over: Partial<PiVersionRow>): PiVersionRow => ({
    id: 'v', version_number: 2, status: 'pending', source_kind: 'edit', uploaded_by: null, uploaded_at: '2026-09-24T10:00:00Z',
    decided_by: null, decided_at: null, revision_reason: 'r', decision_reason: null, operations_reason: null, proposal: null, ...over,
  })
  test('V1 is the original; an edit names its changes; a workbook says it is one', () => {
    assert.equal(versionSummary(v({ version_number: 1 })), 'Original PI')
    assert.equal(versionSummary(v({ proposal: { change_summary: ['1 product added', 'Grand total +₹5,000'] } })),
      '1 product added · Grand total +₹5,000')
    assert.equal(versionSummary(v({ source_kind: 'workbook', proposal: null })), 'New workbook uploaded')
  })
  test('a pending or rejected version never reads as current', () => {
    assert.equal(VERSION_STATUS_LABEL.approved, 'Current')
    for (const s of ['pending', 'admin_approved', 'rejected', 'superseded'] as const) {
      assert.notEqual(VERSION_STATUS_LABEL[s], 'Current')
    }
  })
  test('every kind of stored content reads into the one shape', () => {
    const captured = normalizeVersionContent({ source: 'captured', content: {
      submission: { client_name: 'X', grand_total: 10 }, items: content().items, images: [] } })
    assert.equal(captured?.lines[0].name, 'Lounge chair')
    const snapshot = normalizeVersionContent({ source: 'snapshot', content: {
      order: { client_name: 'X', total_value: 99 }, items: content().items, images: [] } })
    assert.equal(snapshot?.grandTotal, 99)
    assert.equal(normalizeVersionContent({ source: 'live', content: null }), null)
    assert.equal(normalizeVersionContent({ source: 'none', content: null }), null)
  })
})

describe('what the editor promises', () => {
  test('an edit of an approved PI is a proposal; the current PI stays in force', () => {
    assert.match(EDIT_PI_PROPOSE_NOTE, /stays in force until an Admin approves/)
  })
  test('the original workbook is never passed off as the revised PI', () => {
    assert.match(EDIT_PI_WORKBOOK_NOTE, /uploaded workbook stays V1's file and is never changed/)
    assert.match(EDIT_PI_WORKBOOK_NOTE, /no workbook of its own/)
  })
  test('the browser never prices the PI for the server, and never proposes directly', () => {
    const editor = readFileSync('src/components/orders/PiEditor.tsx', 'utf8')
    assert.ok(editor.includes("fetch('/api/orders/pi-edits'"))
    assert.ok(!editor.includes("rpc('propose_order_pi_edit_revision'"))
    assert.ok(!editor.includes("rpc('replace_order_submission_parse'"))
  })
  test('the draft page draws one Edit PI, and no per-field edit doors', () => {
    const page = readFileSync('src/app/orders/drafts/[submissionId]/page.tsx', 'utf8')
    assert.ok(page.includes('canEditBilling={false}') && page.includes('canEditDetails={false}'))
    assert.ok(page.includes('onEditTerms={null}'))
    assert.ok(page.includes('const canEditProducts = false'))
    // The one editor is a page: every entry navigates to it.
    assert.ok(page.includes('router.push(draftEditPiPageHref(submissionId))'))
    const route = readFileSync('src/app/orders/drafts/[submissionId]/edit-pi/page.tsx', 'utf8')
    assert.ok(route.includes('mode="apply"'))
  })
})

describe('PI history — the versions popup that replaced the standalone strip', () => {
  const base = {
    supabase: {} as SupabaseClient, orderId: 'o1', submissionId: 's1', isAdmin: false,
    onClose: () => {},
    notice: null, onNotice: () => {}, onChanged: () => {},
  }
  test('closed: nothing on the page — no strip, no request', () => {
    assert.equal(renderToStaticMarkup(<PiVersionHistory {...base} mayEdit open={false} />), '')
  })
  test('open: a labelled dialog with its close control — and no Edit PI (it moved to the Main PI row)', () => {
    const html = renderToStaticMarkup(<PiVersionHistory {...base} open />)
    assert.match(html, /role="dialog" aria-modal="true" aria-label="PI history"/)
    assert.match(html, /aria-label="Close"/)
    assert.doesNotMatch(html, /Edit PI/)
    assert.doesNotMatch(renderToStaticMarkup(<PiVersionHistory {...base} mayEdit open hasOpenRevision />), /Edit PI/, 'not even for somebody allowed to propose')
  })
  test('each version is one compact strip: version and status together, the decision date beside them, View at the end', () => {
    const source = readFileSync('src/components/orders/PiVersionsPanel.tsx', 'utf8')
    assert.ok(source.includes('className="pi-version-strip"'))
    const row = source.slice(source.indexOf('<li key={v.id}'), source.indexOf('</li>', source.indexOf('<li key={v.id}')))
    assert.ok(row.indexOf('pi-version-id') < row.indexOf('pi-version-when') && row.indexOf('pi-version-when') < row.indexOf('pi-version-action'))
    assert.ok(row.slice(row.indexOf('pi-version-id'), row.indexOf('pi-version-when')).includes('VERSION_STATUS_LABEL'), 'the version and its status are in one group')
    assert.ok(row.includes('View V') && row.includes('Review changes'), 'the existing doors are kept')
    const css = readFileSync('src/app/globals.css', 'utf8')
    assert.match(css, /\.pi-version-row \{[^}]*grid-template-areas: 'id when action' 'detail detail detail';/)
    assert.match(css, /@media \(max-width: 560px\) \{\s*\.pi-version-row \{[^}]*'id action' 'when when' 'detail detail'/, 'the metadata drops beneath on a phone')
    assert.doesNotMatch(css, /\.pi-history-intro \{[^}]*flex: 1 1 240px/, 'no flex-basis that becomes a 240px-tall gap in a column')
  })
  test('the open-revision rule is unchanged (it now gates the Main PI row\'s Edit PI)', () => {
    assert.ok(EDIT_PI_BLOCKED_NOTE.includes('waiting for a decision'))
    assert.ok(isOpenRevision('pending') && isOpenRevision('admin_approved'))
    assert.ok(!isOpenRevision('approved') && !isOpenRevision('rejected') && !isOpenRevision('superseded'))
  })
  test('the Order page opens it from Documents; the standalone PI versions strip is gone', () => {
    const page = readFileSync('src/app/orders/[id]/page.tsx', 'utf8')
    assert.ok(!page.includes('<PiVersionsPanel'))
    assert.ok(page.includes('<PiVersionHistory'))
    assert.ok(page.includes('piVersions={piVersionsSource ? {'))
    const workspace = readFileSync('src/app/orders/[id]/OrderStatusWorkspace.tsx', 'utf8')
    assert.ok(!workspace.includes('section[aria-label="PI versions"]'), 'nothing scrolls to a section that no longer exists')
  })
})
