/**
 * The status workspace, rendered: the Main PI card and the PI history modal.
 *
 * Every component is a function of its props; these check what they SAY, that
 * nothing depends on colour alone, that no storage URL reaches the markup, and
 * that the dialog is a real dialog.
 *
 * Run:
 *   npx tsx --test "src/app/orders/**\/orderStatusWorkspace.render.test.tsx"
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  OrderDesignFilesDialog,
  OrderFabricFinishCard,
  OrderDocumentsPanel,
  OrderDocumentsRow,
  OrderEvidenceDialog,
  PiHistoryModal,
} from './OrderStatusWorkspace'
import { OrderApprovalModal } from './OrderApprovalModal'
import {
  CLIENT_PO_UNSUPPORTED_NOTE,
  DOCUMENTS_TITLE,
  DOC_CLIENT_PO_TITLE,
  DOC_DESIGN_FILES_TITLE,
  DOC_MAIN_PI_TITLE,
  DOC_VIEW_FILES_LABEL,
  DOC_NOT_ATTACHED,
  clientPoDocument,
  designFilesDocument,
  type ClientPoDocument,
  type DesignFilesDocument,
} from '@/lib/orders/orderDocumentsPanel'
import {
  EVIDENCE_FIELD_LABEL,
  EVIDENCE_NOT_VERIFIED_NOTE,
  EVIDENCE_SAME_FILE_MESSAGE,
  FABRIC_FINISH_READ_ONLY,
  FABRIC_FINISH_UPDATE_LABEL,
  approvalStanding,
  type PersistedApprovalEvent,
} from '@/lib/orders/orderApprovals'
import {
  MAIN_PI_APPROVED_LABEL,
  MAIN_PI_AWAITING,
  MAIN_PI_HISTORY_LABEL,
  MAIN_PI_NONE,
  MAIN_PI_UPLOADED_LABEL,
  PI_HISTORY_MODAL_TITLE,
  REMARK_NOT_RECORDED,
  mainPiCard,
  piVersionTimeline,
} from '@/lib/orders/orderMainPi'
import {
  describePiVersionHistory,
  type PersistedPiVersion,
} from '@/lib/orders/orderPiVersions'

const text = (html: string): string =>
  html.replace(/<[^>]*>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')

const NAMES = new Map([['u1', 'Nishant Soni'], ['u2', 'Ravi Menon']])
const when = (iso: string | null) => (iso ? iso.slice(0, 10) : '—')

function row(over: Partial<PersistedPiVersion> = {}): PersistedPiVersion {
  return {
    id: 'v1', order_id: 'o1', submission_id: 's1', version_number: 1, status: 'approved',
    workbook_path: 'submissions/s1/original/secret-key.xlsx', workbook_name: 'PI.xlsx',
    uploaded_by: 'u1', uploaded_at: '2026-09-02T05:34:00Z', revision_reason: null,
    decided_by: 'u2', decided_at: '2026-09-08T06:00:00Z', decision_reason: null,
    superseded_at: null,
    ...over,
  }
}
const history = (rows: PersistedPiVersion[]) => describePiVersionHistory(rows, NAMES, when)

const noop = () => {}

/** The compiled-from stylesheet, for the assertions about layout and space. */
const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8').replace(/\r\n/g, '\n')

/**
 * NOTHING THAT COULD OUTLIVE THE READER'S RIGHT TO IT is in the markup.
 *
 * Deliberately NOT a blanket `http` search: every lucide icon renders an SVG
 * carrying the SVG namespace URI, which is a constant in this bundle and not a
 * reference to anything. What must never appear is a storage key, a signed
 * Supabase URL or an anchor pointing at either.
 */
function assertNoFileReference(html: string, where: string) {
  for (const forbidden of [/secret-key/, /submissions\//, /supabase\.co/,
                           /storage\/v1/, /token=/, /<a\s/]) {
    assert.equal(forbidden.test(html), false, where + ' leaks ' + String(forbidden))
  }
}

/** The Documents box, rendered around whichever states the test names. */
const docs = (over: {
  rows?: PersistedPiVersion[]
  design?: DesignFilesDocument
  clientPo?: ClientPoDocument
} = {}) => renderToStaticMarkup(
  <OrderDocumentsPanel
    mainPi={mainPiCard(history(over.rows ?? [row()]))}
    design={over.design ?? designFilesDocument(
      { kind: 'ready', counts: { representative: 6, customization: 3 } }, 6,
    )}
    clientPo={over.clientPo ?? clientPoDocument()}
    onView={noop} onDownload={noop} onHistory={noop} onManageDesign={noop}
    viewing={false} downloading={false}
  />,
)

/** Just the Main PI subsection's own markup, for the assertions about it. */
const card = (rows: PersistedPiVersion[] = [row()]) => {
  const html = docs({ rows })
  const at = html.indexOf('aria-label="' + DOC_MAIN_PI_TITLE + '"')
  return html.slice(at, html.indexOf('aria-label="' + DOC_DESIGN_FILES_TITLE + '"'))
}

// ── The Main PI card ──────────────────────────────────────────────────────────

describe('the Main PI card', () => {
  test('states the version, its status and both dates', () => {
    const body = text(card())
    for (const s of [DOC_MAIN_PI_TITLE, 'PI V1', 'Approved',
                     MAIN_PI_UPLOADED_LABEL, '2026-09-02',
                     MAIN_PI_APPROVED_LABEL, '2026-09-08']) {
      assert.ok(body.includes(s), s)
    }
  })

  test('offers View, Download and View history', () => {
    const body = text(card())
    for (const s of ['View', 'Download', MAIN_PI_HISTORY_LABEL]) assert.ok(body.includes(s), s)
  })

  test('NO STORAGE PATH OR URL REACHES THE MARKUP', () => {
    // The file is signed on the press, through the reader's own session. A key
    // rendered into the page is a key that outlives the reader's right to it.
    assertNoFileReference(card(), 'the Main PI card')
  })

  test('a version with no stored file cannot be opened', () => {
    const html = card([row({ workbook_path: null })])
    // Both file actions are disabled; View history is not.
    assert.equal((html.match(/disabled/g) ?? []).length, 2)
  })

  test('while a file is being signed, both file actions say so and are held', () => {
    const html = renderToStaticMarkup(
      <OrderDocumentsPanel
        mainPi={mainPiCard(history([row()]))}
        design={{ kind: 'loading' }}
        clientPo={clientPoDocument()}
        onView={noop} onDownload={noop} onHistory={noop} onManageDesign={noop}
        viewing downloading
      />,
    )
    assert.ok(text(html).includes('Opening…'))
    assert.ok(text(html).includes('Preparing…'))
    assert.equal((html.match(/disabled/g) ?? []).length, 2, 'no double submission')
  })

  test('A PENDING REVISION IS A NOTE, NEVER THE HEADLINE', () => {
    const body = text(card([
      row(),
      row({ id: 'v2', version_number: 2, status: 'pending',
            revision_reason: 'Client added 6 chairs', decided_by: null, decided_at: null }),
    ]))
    assert.ok(body.includes('PI V1'), 'the approved version is still the headline')
    // SINCE 20270101000000 the proposal is NAMED — Sales, Admin and Operations
    // must tell the PI in force from a proposed V2 — but only inside its own
    // block, after the headline, marked as not in force and naming its owner.
    assert.ok(body.indexOf('PI V1') < body.indexOf('Proposed PI V2 — not in force yet'))
    assert.ok(body.includes('Waiting on: Admin'))
    assert.ok(body.includes('PI V1 stays in force'))
  })

  test('an Order with no PI says so and substitutes no other document', () => {
    const body = text(card([]))
    assert.ok(body.includes(MAIN_PI_NONE))
    // No version reference at all. (Not a bare `PI V` search: the card's own
    // title sits next to "View history", which spells those characters.)
    assert.equal(/PI V\d/.test(body), false)
  })

  test('an Order whose only version is pending reports the outstanding decision', () => {
    const body = text(card([row({ status: 'pending', decided_by: null, decided_at: null })]))
    assert.ok(body.includes(MAIN_PI_AWAITING))
    assert.equal(/PI V\d/.test(body), false, 'a pending upload is never shown as in force')
  })

  test('the card is labelled for a reader who is not seeing it', () => {
    assert.match(card(), /aria-label="Main PI"/)
  })
})


// ── THE ADVANCE RECEIVED CARD IS GONE ──
//
// Every figure it drew — the verified share of the Order value, over the Order
// value — is stated by the Payment section below the products, which is the one
// place on the page money is stated. Its builder and its own unit tests are
// untouched; this removed a second display of one answer.

describe('Advance Received is not drawn on this page', () => {
  const page = readFileSync(join(process.cwd(), 'src/app/orders/[id]/page.tsx'), 'utf8')
  const source = readFileSync(join(process.cwd(), 'src/app/orders/[id]/OrderStatusWorkspace.tsx'), 'utf8')

  test('the card no longer exists and the page does not draw it', () => {
    assert.equal(/export function OrderAdvanceCard/.test(source), false)
    const code = page.replace(/\/\*[\s\S]*?\*\//g, ' ')
      .split('\n').filter(line => !line.trim().startsWith('//')).join('\n')
    assert.equal(code.includes('OrderAdvanceCard'), false)
    assert.equal(code.includes('advanceStanding'), false)
    assert.equal(/Advance Received/i.test(code), false)
  })

  test('BUT ITS BUILDER AND ITS RULES ARE UNTOUCHED', () => {
    // A display was removed, not a calculation. orderAdvance.ts still states
    // the classification rule and its own suite still holds it.
    const lib = readFileSync(join(process.cwd(), 'src/lib/orders/orderAdvance.ts'), 'utf8')
    assert.ok(lib.includes('export function advanceStanding'))
    assert.ok(readFileSync(join(process.cwd(), 'src/lib/orders/orderAdvance.test.ts'), 'utf8').length > 0)
  })
})

// ── The Documents box ─────────────────────────────────────────────────────────

describe('the Documents box holds all three kinds of paperwork', () => {
  test('one card, three subsections, in the agreed order', () => {
    const html = docs()
    assert.match(html, new RegExp('aria-label="' + DOCUMENTS_TITLE + '"'))
    assert.match(html, /<h2 class="order-docs-title">Documents<\/h2>/)
    const body = text(html)
    assert.ok(body.indexOf(DOC_MAIN_PI_TITLE) < body.indexOf(DOC_DESIGN_FILES_TITLE))
    assert.ok(body.indexOf(DOC_DESIGN_FILES_TITLE) < body.indexOf(DOC_CLIENT_PO_TITLE))
    // Each is a labelled section of its own, so a screen reader can jump to it.
    for (const title of [DOC_MAIN_PI_TITLE, DOC_DESIGN_FILES_TITLE, DOC_CLIENT_PO_TITLE]) {
      assert.ok(html.includes('aria-label="' + title + '"'), title)
    }
  })

  test('the subsections are separated by a rule, not by three outlines', () => {
    const html = docs()
    // ONE outer card.
    assert.equal((html.match(/class="order-docs"/g) ?? []).length, 1)
    assert.equal((html.match(/class="order-doc-section"/g) ?? []).length, 3)
    // And the rule between them is a border on the section, not a card each.
    assert.match(css, /\.order-doc-section \+ \.order-doc-section \{ border-top:/)
  })

  test('THE FABRIC AND FINISH APPROVALS ARE NOT RESTATED HERE', () => {
    // The Design Files card used to summarise them, a column away from the card
    // that states them in full. One home each.
    const body = text(docs())
    assert.equal(/Fully Approved|Partially Approved|Not Approved/.test(body), false)
    assert.equal(/screenshot on file/i.test(body), false)
  })

  test('THE DESIGN-FILE CONTROL IS NAMED FOR WHAT IT DOES', () => {
    // It said 'View / Manage' and manages nothing: the dialog previews the
    // pictures and offers no upload, replacement or deletion, because this
    // Order has no way to perform any of the three. A label promising
    // management where none exists sends somebody hunting for a control that
    // was never built.
    const html = docs()
    assert.equal(DOC_VIEW_FILES_LABEL, 'View files')
    assert.ok(text(html).includes(DOC_VIEW_FILES_LABEL))
    // Scoped to the Design Files subsection: 'Uploaded' is the Main PI's own
    // date label a few lines above, and is not a promise about anything.
    const design = text(html.slice(
      html.indexOf('aria-label="' + DOC_DESIGN_FILES_TITLE + '"'),
      html.indexOf('aria-label="' + DOC_CLIENT_PO_TITLE + '"')))
    assert.equal(/Manage|Upload|Replace|Delete/i.test(design), false,
      'the box must not promise an action the Order cannot perform')
  })

  test('Design Files says how many, and offers one action', () => {
    const body = text(docs())
    assert.ok(body.includes('9 files'))
    assert.ok(body.includes('6 representative · 3 customization · 6 product lines'))
    assert.ok(body.includes(DOC_VIEW_FILES_LABEL))
  })

  test('an EMPTY design record says so quietly, and offers no action', () => {
    const html = docs({
      design: designFilesDocument({ kind: 'ready', counts: { representative: 0, customization: 0 } }, 4),
    })
    const design = html.slice(html.indexOf('aria-label="' + DOC_DESIGN_FILES_TITLE + '"'))
    assert.ok(design.includes('order-doc-empty'), 'drawn in the muted empty style')
    // No View files control on a list with nothing in it.
    assert.equal(design.slice(0, design.indexOf('aria-label="' + DOC_CLIENT_PO_TITLE + '"'))
      .includes(DOC_VIEW_FILES_LABEL), false)
    // And it is not an alarm: no red, no warning word.
    assert.equal(/order-doc-unavailable/.test(design), false)
  })

  test('the four document states cannot be confused with one another', () => {
    const state = (d: DesignFilesDocument) => text(docs({ design: d }))
    const loading = state({ kind: 'loading' })
    const unavailable = state(designFilesDocument({ kind: 'unavailable' }, 4))
    const empty = state(designFilesDocument({ kind: 'ready', counts: { representative: 0, customization: 0 } }, 4))
    const ready = state(designFilesDocument({ kind: 'ready', counts: { representative: 2, customization: 0 } }, 2))

    // LOADING IS NOT NONE, and a refused read is not none either.
    assert.ok(loading.includes('Loading'))
    assert.equal(loading.includes('None recorded'), false)
    assert.ok(unavailable.includes('Unavailable'))
    assert.equal(unavailable.includes('None recorded'), false)
    assert.ok(empty.includes('None recorded'))
    assert.ok(ready.includes('2 files'))
    // Only the refused read is drawn as a problem.
    assert.ok(docs({ design: designFilesDocument({ kind: 'unavailable' }, 4) }).includes('order-doc-unavailable'))
    assert.equal(docs({ design: { kind: 'loading' } }).includes('order-doc-unavailable'), false)
  })

  test('an Order with NO SOURCE PI says so, in its own words', () => {
    // Not `None recorded`: nothing was expected, so nothing is missing.
    const body = text(docs({ design: designFilesDocument({ kind: 'no_source' }, 0) }))
    assert.ok(body.includes('No source PI'))
    assert.equal(body.includes('None recorded'), false)
  })

  test('Client PO states its absence and offers no control it cannot honour', () => {
    const html = docs()
    const po = html.slice(html.indexOf('aria-label="' + DOC_CLIENT_PO_TITLE + '"'))
    assert.ok(text(po).includes(DOC_NOT_ATTACHED))
    assert.ok(text(po).includes(CLIENT_PO_UNSUPPORTED_NOTE))
    // NO UPLOAD BUTTON. There is nowhere to keep a file, and a control that
    // could not keep what it took would be worse than none.
    assert.equal(/<button|<input|<form/.test(po), false)
  })

  test('NO ACTION IN THE BOX NAVIGATES ANYWHERE', () => {
    // Every control is a button; the two that hand over a file do it through a
    // URL signed on the press, which the page mints and this never renders.
    const html = docs()
    assert.equal(/<a |href=/.test(html), false)
  })
})

describe('Documents and Fabric & Finish sit side by side', () => {
  test('the row puts the paperwork first and the approvals second', () => {
    const html = renderToStaticMarkup(
      <OrderDocumentsRow><div>docs</div><div>fabric</div></OrderDocumentsRow>,
    )
    assert.match(html, /class="order-docs-row"/)
    const body = text(html)
    assert.ok(body.indexOf('docs') < body.indexOf('fabric'))
  })

  test('two thirds and one third on desktop, stacked below 900px', () => {
    assert.match(css, /\.order-docs-row \{[\s\S]*?grid-template-columns: minmax\(0, 2fr\) minmax\(0, 1fr\)/)
    assert.match(css, /@media \(max-width: 900px\)[\s\S]*?\.order-docs-row \{ grid-template-columns: minmax\(0, 1fr\); \}/)
    // ALIGNED TO THE TOP: the shorter card must not be handed a blank tail.
    assert.match(css.slice(css.indexOf('.order-docs-row {')), /align-items: start/)
    assert.equal(/\.order-docs-row \{[^}]*overflow-x/.test(css), false)
    // NO FIXED OR MINIMUM HEIGHT on the box or its subsections: content decides.
    // (Sliced to the box itself — the dialog rules below it size a thumbnail
    // and a screenshot frame, which are pictures and must be given a box.)
    const box = css.slice(css.indexOf('.order-docs {'), css.indexOf('/* ── The design-file dialog ──'))
    assert.equal(/min-height|(^|[^-])height:\s*\d/.test(box), false,
      'the box must take its content height')
  })
})

// ── Fabric & Finish ───────────────────────────────────────────────────────────

const ORDER = '11111111-2222-3333-4444-555555555555'

const approvalEvent = (over: Partial<PersistedApprovalEvent> = {}): PersistedApprovalEvent => ({
  id: 'e1', order_id: ORDER, approval_kind: 'fabric', status: 'partially_approved',
  evidence_path: `orders/${ORDER}/fabric/secret-proof.png`,
  actor_id: 'u1', created_at: '2026-09-10T05:00:00Z',
  ...over,
})

const approvals = (events: PersistedApprovalEvent[]) =>
  approvalStanding({ events, formatWhen: (iso: string) => iso.slice(0, 10) })

const fabricCard = (events: PersistedApprovalEvent[], canUpdate = false) =>
  renderToStaticMarkup(
    <OrderFabricFinishCard
      standing={approvals(events)}
      canUpdate={canUpdate}
      onUpdate={noop}
      onViewEvidence={noop}
      busyEvidence={null}
    />,
  )

describe('the Fabric & Finish card', () => {
  test('states both kinds, each with its status in words', () => {
    const body = text(fabricCard([]))
    for (const s of ['Fabric', 'Finish', 'Not Approved']) assert.ok(body.includes(s), s)
  })

  test('NOT APPROVED CARRIES NO DATE', () => {
    const html = fabricCard([])
    assert.equal(/order-status-approval-at/.test(html), false)
  })

  test('a Partial and a Full status each carry their date', () => {
    const html = fabricCard([
      approvalEvent(),
      approvalEvent({ id: 'e2', approval_kind: 'finish', status: 'fully_approved',
                      evidence_path: `orders/${ORDER}/finish/b.png` }),
    ])
    const body = text(html)
    assert.ok(body.includes('Partially Approved'))
    assert.ok(body.includes('Fully Approved'))
    assert.equal((html.match(/order-status-approval-at/g) ?? []).length, 2)
  })

  test('THE UPDATE CONTROL IS DRAWN ONLY FOR SOMEBODY WHO MAY PRESS IT', () => {
    assert.equal(text(fabricCard([])).includes(FABRIC_FINISH_UPDATE_LABEL), false)
    assert.ok(text(fabricCard([], true)).includes(FABRIC_FINISH_UPDATE_LABEL))
  })

  test('a read-only reader is told why, rather than shown a dead button', () => {
    assert.ok(text(fabricCard([])).includes(FABRIC_FINISH_READ_ONLY))
    assert.equal(text(fabricCard([], true)).includes(FABRIC_FINISH_READ_ONLY), false)
  })

  test('NO EVIDENCE PATH REACHES THE MARKUP — a proof is signed on the press', () => {
    assertNoFileReference(fabricCard([approvalEvent()]), 'the Fabric & Finish card')
    assert.equal(fabricCard([approvalEvent()]).includes('secret-proof'), false)
  })

  test('EVERY REQUIRED FACT IS ON THE CARD for an approved kind', () => {
    const body = text(fabricCard([
      approvalEvent({ status: 'fully_approved', actor_name: 'Nishant Soni' }),
      approvalEvent({ id: 'e2', approval_kind: 'finish', status: 'partially_approved',
                      actor_name: 'Ravi Menon',
                      evidence_path: `orders/${ORDER}/finish/b.png` }),
    ]))
    for (const required of [
      'Fabric', 'Fully Approved',          // status, in Partial/Full wording
      'Finish', 'Partially Approved',
      '2026-09-10',                        // the approval date
      'by Nishant Soni', 'by Ravi Menon',  // the approver
      'View proof',                        // evidence access
    ]) {
      assert.ok(body.includes(required), required)
    }
  })

  test('THE PERMANENT TRAIL IS VISIBLE when a kind has more than one event', () => {
    const html = fabricCard([
      approvalEvent({ id: 'e1', status: 'partially_approved', actor_name: 'Nishant Soni',
                      created_at: '2026-09-10T05:00:00Z',
                      evidence_path: `orders/${ORDER}/fabric/one.png` }),
      approvalEvent({ id: 'e2', status: 'fully_approved', actor_name: 'Ravi Menon',
                      created_at: '2026-09-20T05:00:00Z',
                      evidence_path: `orders/${ORDER}/fabric/two.png` }),
    ])
    // A native disclosure: keyboard-operable and announced, no script.
    assert.match(html, /<details class="order-approval-history"/)
    const body = text(html)
    assert.ok(body.includes('Earlier changes (1)'))
    assert.ok(body.includes('Partially Approved'), 'the superseded status is still readable')
    assert.ok(body.includes('Nishant Soni'), 'and still names who recorded it')
    // Two proofs are now reachable: the current one and the one it replaced.
    assert.equal((html.match(/View proof/g) ?? []).length, 2)
  })

  test('and there is NO trail to show when a kind has only one event', () => {
    assert.equal(/order-approval-history/.test(fabricCard([approvalEvent()])), false)
    assert.equal(/order-approval-history/.test(fabricCard([])), false)
  })

  test('NO EARLIER EVIDENCE PATH REACHES THE MARKUP either', () => {
    assertNoFileReference(fabricCard([
      approvalEvent({ id: 'e1', created_at: '2026-09-10T05:00:00Z' }),
      approvalEvent({ id: 'e2', status: 'fully_approved', created_at: '2026-09-20T05:00:00Z',
                      evidence_path: `orders/${ORDER}/fabric/secret-proof-two.png` }),
    ]), 'the Fabric & Finish trail')
  })

  test('but a proof that exists is offered', () => {
    assert.ok(text(fabricCard([approvalEvent()])).includes('View proof'))
    assert.equal(text(fabricCard([])).includes('View proof'), false)
  })
})

// ── The update dialog ────────────────────────────────────────────

const approvalModal = (events: PersistedApprovalEvent[] = [], over: Partial<{
  saving: boolean; failure: string | null
}> = {}) => renderToStaticMarkup(
  <OrderApprovalModal
    standing={approvals(events)}
    saving={over.saving ?? false}
    failure={over.failure ?? null}
    onClose={noop}
    onConfirm={noop}
  />,
)

describe('the Fabric & Finish update dialog', () => {
  test('is a real dialog, labelled and closable', () => {
    const html = approvalModal()
    assert.match(html, /role="dialog"/)
    assert.match(html, /aria-modal="true"/)
    assert.match(html, /aria-label="Update Fabric &amp; Finish"/)
    assert.match(html, /aria-label="Close"/)
  })

  test('SEPARATE SELECTORS, one per kind, each labelled and pre-filled', () => {
    const html = approvalModal([approvalEvent({ status: 'fully_approved' })])
    assert.match(html, /id="approval-fabric"/)
    assert.match(html, /id="approval-finish"/)
    assert.match(html, /for="approval-fabric"/)
    assert.match(html, /for="approval-finish"/)
    // Pre-filled with where each kind actually stands.
    // React marks the controlled value with selected on the matching option.
    const fabric = html.slice(html.indexOf('id="approval-fabric"'), html.indexOf('</select>'))
    assert.match(fabric, /<option value="fully_approved" selected="">/)
  })

  test('NO EVIDENCE INPUT UNTIL A CHANGE NEEDS ONE', () => {
    // Nothing has been changed yet, so neither kind is asking for a file.
    assert.equal(/type="file"/.test(approvalModal()), false)
  })

  test('SAVE IS DISABLED WHILE NOTHING HAS CHANGED', () => {
    const html = approvalModal()
    assert.match(html, /aria-disabled="true"/)
  })

  test('while saving, every control is held and the button says so', () => {
    const html = approvalModal([], { saving: true })
    assert.ok(text(html).includes('Saving…'))
    assert.ok((html.match(/disabled/g) ?? []).length >= 3, 'no double submission')
  })

  test('a server refusal is one quiet line, announced', () => {
    const html = approvalModal([], { failure: EVIDENCE_SAME_FILE_MESSAGE })
    assert.match(html, /role="alert"/)
    assert.ok(text(html).includes(EVIDENCE_SAME_FILE_MESSAGE))
  })

  test('THE FILE FIELD ASKS FOR AN ERP APPROVAL SCREENSHOT, and says what is NOT checked', () => {
    // Fabric is already Fully Approved here, so moving Finish to Partially
    // Approved is the change that asks for a file. The dialog opens pre-filled,
    // so drive it through a standing where Finish is behind.
    const html = renderToStaticMarkup(
      <OrderApprovalModal
        standing={approvals([
          approvalEvent({ status: 'partially_approved' }),
        ])}
        saving={false} failure={null} onClose={noop} onConfirm={noop}
      />,
    )
    // Nothing has changed yet, so no input is drawn — that is the rule tested
    // above. What must be true is that the WORDS the field would use are the
    // ones the business asked for.
    assert.equal(EVIDENCE_FIELD_LABEL, 'ERP approval screenshot')
    assert.match(EVIDENCE_NOT_VERIFIED_NOTE, /not checked against the ERP/i)
    assert.equal(/type="file"/.test(html), false)
  })

  test('THERE IS NO MANDATORY REASON BOX — no existing rule asks for one', () => {
    const html = approvalModal()
    assert.equal(/<textarea/.test(html), false)
  })
})

// ── The workspace ─────────────────────────────────────────────────────────────

describe('the design-file dialog', () => {
  const items = [
    { key: 'r-1', row: 1, role: 'representative' as const, roleLabel: 'Representative image',
      sequence: '1', name: 'Chair', url: 'https://example.test/a.png?token=x', label: 'Representative image of 1 Chair' },
  ]
  const dialog = (rows = items) =>
    renderToStaticMarkup(<OrderDesignFilesDialog items={rows} onOpen={noop} onClose={noop} />)

  test('opens over the page as a real dialog', () => {
    const html = dialog()
    assert.match(html, /role="dialog"/)
    assert.match(html, /aria-modal="true"/)
    assert.match(html, /aria-label="Design files"/)
    assert.match(html, /aria-label="Close"/)
  })

  test('IT DOES NOT NAVIGATE. Every picture is a button, not a link', () => {
    const html = dialog()
    assert.equal(/<a /.test(html), false)
    assert.match(html, /<button[^>]*class="order-file-thumb"/)
  })

  test('each picture says what it is, and carries its own accessible name', () => {
    const html = dialog()
    assert.ok(text(html).includes('Representative image'))
    assert.match(html, /aria-label="Representative image of 1 Chair"/)
    // The alt is empty because the button already names it.
    assert.match(html, /alt=""/)
  })

  test('thumbnails are lazy, so a long list does not fetch what nobody scrolls to', () => {
    assert.match(dialog(), /loading="lazy"/)
  })

  test('IT IS READ-ONLY, AND SAYS WHERE THE FILES COME FROM', () => {
    // These are the approved PI's own product images, inherited at conversion;
    // the PI screen is where one is added or removed. Order-level design
    // documents do not exist, so nothing here offers to manage one.
    const html = dialog()
    assert.ok(text(html).includes('These files come from the approved PI'))
    for (const control of ['<input', '<form', 'Upload', 'Replace', 'Delete']) {
      assert.equal(html.includes(control), false, control + ' is offered by a read-only dialog')
    }
  })

  test('an empty list says so rather than showing an empty grid', () => {
    const body = text(dialog([]))
    assert.ok(body.includes('No design files are recorded against this Order.'))
    assert.equal(dialog([]).includes('order-file-grid'), false)
  })
})

describe('the approval-evidence dialog', () => {
  test('shows the picture over this page instead of in a new tab', () => {
    const html = renderToStaticMarkup(
      <OrderEvidenceDialog url="https://example.test/proof.png?token=x" failure={null} onClose={noop} />,
    )
    assert.match(html, /role="dialog"/)
    assert.match(html, /class="order-evidence-frame"/)
    assert.equal(/<a |target="_blank"/.test(html), false)
  })

  test('says it is opening before the URL exists, and says so plainly if it fails', () => {
    const pending = renderToStaticMarkup(<OrderEvidenceDialog url={null} failure={null} onClose={noop} />)
    assert.match(pending, /role="status"/)
    assert.equal(/<img/.test(pending), false, 'nothing is fetched until there is a URL')

    const failed = renderToStaticMarkup(
      <OrderEvidenceDialog url={null} failure="That file is not available to you right now." onClose={noop} />,
    )
    assert.match(failed, /role="alert"/)
    assert.ok(text(failed).includes('not available'))
  })
})

// ── The PI history modal ──// ── The PI history modal ──────────────────────────────────────────────────────

const modal = (rows: PersistedPiVersion[], over: Partial<{
  canPropose: boolean; canDecide: boolean; busyId: string | null; error: string | null
}> = {}) => renderToStaticMarkup(
  <PiHistoryModal
    entries={piVersionTimeline(history(rows))}
    onClose={noop} onView={noop} onDownload={noop}
    busyId={over.busyId ?? null}
    canPropose={over.canPropose ?? false}
    onPropose={noop}
    canDecide={over.canDecide ?? false}
    onApprove={noop} onReject={noop}
    error={over.error ?? null}
  />,
)

const FOUR = [
  row({ status: 'superseded', superseded_at: '2026-09-10T05:00:00Z' }),
  row({ id: 'v2', version_number: 2, status: 'rejected',
        revision_reason: null, decision_reason: 'Figures did not match' }),
  row({ id: 'v3', version_number: 3, status: 'approved',
        revision_reason: 'Client changed chair quantity from 30 to 36' }),
  row({ id: 'v4', version_number: 4, status: 'pending',
        revision_reason: 'Delivery address updated', decided_by: null, decided_at: null }),
]

describe('the PI history modal', () => {
  test('is a real dialog: labelled, modal, and closable', () => {
    const html = modal(FOUR)
    assert.match(html, /role="dialog"/)
    assert.match(html, /aria-modal="true"/)
    assert.match(html, new RegExp(`aria-label="${PI_HISTORY_MODAL_TITLE}"`))
    assert.match(html, /aria-label="Close"/)
  })

  test('lists every version, newest first', () => {
    const body = text(modal(FOUR))
    for (const s of ['PI V4', 'PI V3', 'PI V2', 'PI V1']) assert.ok(body.includes(s), s)
    assert.ok(body.indexOf('PI V4') < body.indexOf('PI V3'))
    assert.ok(body.indexOf('PI V3') < body.indexOf('PI V2'))
    assert.ok(body.indexOf('PI V2') < body.indexOf('PI V1'))
  })

  test('each row states its status, who uploaded it and when', () => {
    const body = text(modal(FOUR))
    for (const s of ['Approved', 'Pending approval', 'Rejected', 'Superseded',
                     'Nishant Soni', '2026-09-02']) {
      assert.ok(body.includes(s), s)
    }
  })

  test('the current version is marked ONCE, quietly', () => {
    const html = modal(FOUR)
    assert.equal((html.match(/order-history-row--current/g) ?? []).length, 1)
    assert.ok(text(html).includes('Current'))
  })

  test('a recorded remark is printed and a missing one says `Not recorded`', () => {
    const body = text(modal(FOUR))
    assert.ok(body.includes('Client changed chair quantity from 30 to 36'))
    assert.ok(body.includes(REMARK_NOT_RECORDED))
    assert.match(modal(FOUR), /order-history-remark-missing/)
  })

  test('the initial PI is labelled as such rather than as a missing remark', () => {
    const body = text(modal([row()]))
    assert.ok(body.includes('Initial PI'))
    assert.ok(!body.includes(REMARK_NOT_RECORDED))
  })

  test('a refusal reason is shown on the version it refused', () => {
    assert.ok(text(modal(FOUR)).includes('Figures did not match'))
  })

  test('NO STORAGE PATH OR URL REACHES THE MARKUP, for any version', () => {
    // Four versions, four stored keys, none of them rendered.
    assertNoFileReference(modal(FOUR), 'the PI history modal')
  })

  test('the upload control appears only for somebody who may press it', () => {
    assert.ok(!text(modal(FOUR)).includes('Upload revised PI'))
    assert.ok(text(modal(FOUR, { canPropose: true })).includes('Upload revised PI'))
  })

  test('the decision controls appear only on the PENDING version, and only for a decider', () => {
    assert.ok(!text(modal(FOUR)).includes('Approve revision'))
    const html = modal(FOUR, { canDecide: true })
    const body = text(html)
    assert.ok(body.includes('Approve revision'))
    assert.ok(body.includes('Reject revision'))
    // One pending row, so one pair of controls.
    assert.equal((html.match(/Approve revision/g) ?? []).length, 1)
  })

  test('the row being signed is held, and no other row is', () => {
    const html = modal(FOUR, { busyId: 'v3' })
    assert.ok(text(html).includes('Opening…'))
    // Two controls on the busy row; every other row's pair stays live.
    assert.equal((html.match(/Opening…/g) ?? []).length, 1)
  })

  test('a failure is one quiet line, announced', () => {
    const html = modal(FOUR, { error: 'That file is not available to you right now.' })
    assert.match(html, /role="alert"/)
    assert.ok(text(html).includes('That file is not available to you right now.'))
  })

  test('an Order with no versions says so', () => {
    assert.ok(text(modal([])).includes('No PI versions are recorded for this Order.'))
  })
})

// ── What the page must keep doing ─────────────────────────────────────────────

describe('/orders/[id] wires the workspace the way the module intends', () => {
  const page = readFileSync(join(process.cwd(), 'src/app/orders/[id]/page.tsx'), 'utf8')

  test('the Main PI card is fed by mainPiCard, and the modal by the timeline', () => {
    assert.ok(page.includes('const mainPi = mainPiCard(piHistory)'))
    assert.ok(page.includes('const piTimeline = piVersionTimeline(piHistory)'))
    assert.ok(page.includes('mainPi={mainPi}'))
    assert.ok(page.includes('entries={piTimeline}'))
  })

  test('every version file is signed ON THE PRESS, never at load', () => {
    const at = page.indexOf('const openVersionFile')
    assert.ok(at > 0)
    assert.ok(page.slice(at, at + 1200).includes('createSignedUrl('))
    assert.ok(page.includes('ORDER_PI_WORKBOOK_URL_TTL_SECONDS'))
    assert.equal(page.includes('getPublicUrl'), false)
  })

  test('the history modal is mounted only while it is open', () => {
    assert.ok(page.includes('{historyOpen && ('))
  })

  test('THE GENERIC DOCUMENTS SECTION DID NOT COME BACK', () => {
    for (const gone of ['OrderDocumentsCard', 'buildOrderDocumentsView',
                        'order_document_versions', 'mayGenerateDocuments']) {
      assert.equal(page.includes(gone), false, gone)
    }
  })

  test('the PI history is stated ONCE — in the modal, not also in Order records', () => {
    assert.equal(page.includes('<OrderPiHistoryCard'), false)
    assert.equal((page.match(/<PiHistoryModal/g) ?? []).length, 1)
  })
})
