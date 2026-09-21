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
  OrderMainPiCard,
  OrderStatusWorkspace,
  PiHistoryModal,
} from './OrderStatusWorkspace'
import {
  MAIN_PI_APPROVED_LABEL,
  MAIN_PI_AWAITING,
  MAIN_PI_HISTORY_LABEL,
  MAIN_PI_NONE,
  MAIN_PI_TITLE,
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

const card = (rows: PersistedPiVersion[] = [row()]) => renderToStaticMarkup(
  <OrderMainPiCard
    card={mainPiCard(history(rows))}
    onView={noop} onDownload={noop} onHistory={noop}
    viewing={false} downloading={false}
  />,
)

// ── The Main PI card ──────────────────────────────────────────────────────────

describe('the Main PI card', () => {
  test('states the version, its status and both dates', () => {
    const body = text(card())
    for (const s of [MAIN_PI_TITLE, 'PI V1', 'Approved',
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
      <OrderMainPiCard
        card={mainPiCard(history([row()]))}
        onView={noop} onDownload={noop} onHistory={noop}
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
    assert.ok(!body.includes('PI V2'))
    assert.ok(/waiting for a decision/i.test(body))
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

// ── The workspace ─────────────────────────────────────────────────────────────

describe('the status workspace', () => {
  test('is a labelled group its children sit inside, in order', () => {
    const html = renderToStaticMarkup(
      <OrderStatusWorkspace>
        <div>one</div><div>two</div><div>three</div>
      </OrderStatusWorkspace>,
    )
    assert.match(html, /class="order-status-workspace"/)
    assert.match(html, /aria-label="Order status"/)
    const body = text(html)
    assert.ok(body.indexOf('one') < body.indexOf('two'))
    assert.ok(body.indexOf('two') < body.indexOf('three'))
  })

  test('its CSS stacks the three in the SAME order, with no horizontal scroll', () => {
    const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8')
    assert.match(css, /\.order-status-workspace \{[\s\S]*?grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/)
    // Two-plus-one, then a single column. A grid never scrolls sideways.
    assert.match(css, /@media \(max-width: 1180px\)[\s\S]*?\.order-status-workspace \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/)
    assert.match(css, /@media \(max-width: 820px\)[\s\S]*?\.order-status-workspace \{ grid-template-columns: minmax\(0, 1fr\); \}/)
    assert.equal(/\.order-status-workspace \{[^}]*overflow-x/.test(css), false)
  })
})

// ── The PI history modal ──────────────────────────────────────────────────────

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
    assert.ok(page.includes('card={mainPi}'))
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
