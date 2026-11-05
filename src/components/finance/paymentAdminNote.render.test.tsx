/**
 * THE ADMIN'S NOTE ICON, THE POPUP AND THE PAYMENT-POPUP BOX, ACTUALLY RENDERED.
 *
 * What the screen SAYS is pinned here: the icon exists for an admin and for
 * nobody else, says "loading" or "failed" rather than "no note" while the read has
 * not landed, tells a note from no note, and sits in the first action slot. What
 * the DATABASE refuses is proved by running the migration
 * (supabase/tests/payment_admin_notes_pglite.mjs); the save logic by
 * src/lib/finance/paymentAdminNotes.test.ts.
 *
 * Run: npm run test:file -- src/components/finance/paymentAdminNote.render.test.tsx
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'

import { PaymentsTable, type PaymentRequest } from '@/app/finance/page'
import type { PaymentAdminNote } from '@/lib/finance/paymentAdminNotes'
import { ADMIN_NOTE_PRIVACY_LINE, PaymentAdminNoteDialog, PaymentAdminNoteSlot } from './PaymentAdminNote'

const USER = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'
const PAYMENT = 'a1b2c3d4-0000-4000-8000-000000000001'

function row(over: Partial<PaymentRequest> = {}): PaymentRequest {
  return {
    id: PAYMENT, request_number: 'REQ-1', human_payment_id: 'P-AA-0089', client_name: null, amount: 1338565,
    payment_date: '2026-11-05', payment_mode: 'hdfc', received_in: null,
    collected_by_user_id: null, collected_from_text: null, handed_over_to_user_id: null, handed_over_at: null,
    collection_handover_note: null, proof_note: null, order_number: null, order_id: null, order_request_id: null,
    order_request_number: null, sales_note: null, payment_against: 'new_order', payment_target_type: 'order',
    status: 'pending_approval', submitted_by: USER, submitted_by_name: 'Nishant Soni', admin_note: null,
    created_at: '2026-11-05T09:00:00Z', updated_at: '2026-11-05T09:00:00Z', rejected_at: null, clarification_requested_at: null,
    ...over,
  }
}

const noop = () => {}

function table(opts: {
  isAdmin: boolean
  adminNotes?: ReadonlyMap<string, PaymentAdminNote> | 'loading' | 'failed'
  withHandler?: boolean
}): string {
  return renderToStaticMarkup(
    <PaymentsTable
      rows={[row()]}
      destinations={null}
      isAdmin={opts.isAdmin}
      userId={USER}
      cutoff={Date.parse('2026-11-05T00:00:00Z')}
      highlightId={null}
      onRowClick={noop}
      onEdit={noop}
      onDelete={noop}
      adminNotes={opts.adminNotes}
      onAdminNote={opts.withHandler === false ? undefined : noop}
    />,
  )
}

const NOTE = new Map<string, PaymentAdminNote>([[PAYMENT, { note: 'Called the client.\nMoney comes on Monday.', updatedAt: '2026-11-05T10:00:00Z' }]])

/** The note button's own tag, or null. */
const noteButton = (markup: string) => /<button[^>]*boe-row-icon--note[^>]*>/.exec(markup)?.[0] ?? null

describe('the note icon in the list', () => {
  test('is drawn for an admin, and says "add" when there is no note', () => {
    const button = noteButton(table({ isAdmin: true, adminNotes: new Map() }))
    assert.ok(button, 'an admin gets the icon')
    assert.match(button, /aria-label="Add admin note for P-AA-0089"/)
    assert.match(button, /title="Add admin note"/)
    assert.equal(button.includes('boe-row-icon--note-has'), false)
    assert.equal(/disabled=""/.test(button), false)
  })

  test('is amber and carries the first words when the payment has a note', () => {
    const button = noteButton(table({ isAdmin: true, adminNotes: NOTE }))
    assert.ok(button)
    assert.match(button, /boe-row-icon--note-has/)
    assert.match(button, /title="Admin note: Called the client\. Money comes on Monday\."/)
    assert.match(button, /aria-label="Admin note for P-AA-0089: Called the client\. Money comes on Monday\."/)
  })

  test('is switched off, with its reason, while the notes are read or when they could not be', () => {
    const loading = noteButton(table({ isAdmin: true, adminNotes: 'loading' }))
    assert.ok(loading && /disabled=""/.test(loading) && /Reading admin notes/.test(loading))
    assert.equal(loading.includes('boe-row-icon--note-has'), false)
    const failed = noteButton(table({ isAdmin: true, adminNotes: 'failed' }))
    assert.ok(failed && /disabled=""/.test(failed) && /could not be read/.test(failed))
  })

  test('is the FIRST of the row actions, before Edit', () => {
    const markup = table({ isAdmin: true, adminNotes: new Map() })
    assert.ok(markup.indexOf('boe-row-icon--note') > 0)
    assert.ok(markup.indexOf('boe-row-icon--note') < markup.indexOf('boe-row-icon--edit'))
  })

  test('is not drawn for anybody who was not handed the notes (everybody but an admin)', () => {
    const plain = table({ isAdmin: false })
    assert.equal(plain.includes('boe-row-icon--note'), false)
    assert.equal(plain.includes('admin note'), false)
    // Even with notes in hand, no handler means no control.
    assert.equal(table({ isAdmin: true, adminNotes: NOTE, withHandler: false }).includes('boe-row-icon--note'), false)
    // And what a non-admin was never given cannot leak into the markup.
    assert.equal(plain.includes('Called the client'), false)
  })

  test('the row is still the payment button, and the icon is the first button inside its actions cell', () => {
    const markup = table({ isAdmin: true, adminNotes: new Map() })
    assert.match(markup, /aria-label="Open payment P-AA-0089"/)
    assert.match(markup, /boe-row-actions[^>]*>\s*<button[^>]*boe-row-icon--note/)
  })
})

describe('the note popup', () => {
  const dialog = (initial: string) => renderToStaticMarkup(
    <PaymentAdminNoteDialog
      supabase={{} as never}
      payment={{ id: PAYMENT, human_payment_id: 'P-AA-0089', client_name: null, amount: 1338565 }}
      initial={initial}
      onSaved={noop}
      onClose={noop}
    />,
  )

  test('names the payment, says who can see it, and opens with the box ready', () => {
    const markup = dialog('')
    assert.match(markup, /aria-label="Admin note · P-AA-0089"/)
    assert.match(markup, /Not identified/)
    assert.match(markup, /₹13,38,565\.00/)
    assert.ok(markup.includes(ADMIN_NOTE_PRIVACY_LINE))
    assert.match(markup, /<textarea[^>]*aria-label="Admin note"/)
    assert.match(markup, /placeholder="Write a private note…"/)
  })

  test('Save is off until something changes, and the box starts with the note that is there', () => {
    const empty = dialog('')
    assert.match(empty, /<button[^>]*disabled=""[^>]*>Save note<\/button>/)
    const filled = dialog('Waiting for Monday')
    assert.match(filled, /<textarea[^>]*>Waiting for Monday<\/textarea>/)
    assert.match(filled, /<button[^>]*disabled=""[^>]*>Save note<\/button>/)
    assert.match(filled, />Cancel<\/button>/)
  })

  test('a click on the backdrop does not discard typing (the form-modal rule)', () => {
    // Static markup carries no event handlers, so this one is a source pin.
    const source = readFileSync(join(process.cwd(), 'src/components/finance/PaymentAdminNote.tsx'), 'utf8')
    assert.match(source, /<FinanceModal[^>]*closeOnBackdropClick=\{false\}/)
  })
})

describe('the box inside the payment popup', () => {
  const slot = (notes: ReadonlyMap<string, PaymentAdminNote> | 'loading' | 'failed') => renderToStaticMarkup(
    <PaymentAdminNoteSlot supabase={{} as never} paymentId={PAYMENT} notes={notes} onSaved={noop} />,
  )

  test('shows the note box once the notes are read, with the private-note line', () => {
    const markup = slot(NOTE)
    assert.match(markup, /Admin note/)
    assert.ok(markup.includes(ADMIN_NOTE_PRIVACY_LINE))
    assert.match(markup, /<textarea[^>]*>Called the client\.\nMoney comes on Monday\.<\/textarea>/)
  })

  test('shows nothing while reading, and a sentence (never an empty, savable box) when the read failed', () => {
    assert.equal(slot('loading'), '')
    const failed = slot('failed')
    assert.match(failed, /could not be read/)
    assert.equal(failed.includes('<textarea'), false)
  })
})
