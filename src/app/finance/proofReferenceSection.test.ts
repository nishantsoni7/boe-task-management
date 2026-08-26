/**
 * ONE SECTION FOR PROOF, REFERENCE AND NOTES.
 *
 * The three entry forms each asked the same three things under two or three
 * separate headings — "Payment Proof / Reference" for the attachment and the
 * reference, and a "Notes" / "Sales Note" / "Remark" block of its own below it.
 * They are three parts of one question, and splitting them left a form with a
 * heading for every field.
 *
 * THE DATABASE COLUMNS STAY SEPARATE. proof_note is the reference, sales_note is
 * the note to Finance, and the attachment is a row in payment_proof_attachments.
 * They mean different things and are stored, queried and displayed as different
 * things. This is a GROUPING, not a merge — and that is what these assertions
 * pin: one heading, three fields, three columns.
 *
 * Run:
 *   npx tsx --test src/app/finance/proofReferenceSection.test.ts
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROOF_REFERENCE_TITLE } from './components/ProofReferenceSection'

const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8')

const REQUEST_PAGE  = 'src/app/finance/page.tsx'
const RECORD_FORM   = 'src/app/finance/received/RecordSplitPaymentModal.tsx'
const RECEIVED_VIEW = 'src/app/finance/received/ReceivedPaymentsView.tsx'
const SECTION       = 'src/app/finance/components/ProofReferenceSection.tsx'

/** The New Payment modal, sliced out of a three-thousand-line page. */
function requestModal(): string {
  const src = read(REQUEST_PAGE)
  const from = src.indexOf('function NewPaymentConfirmationModal(')
  const to   = src.indexOf('function EditPaymentModal(')
  assert.ok(from > -1 && to > from, 'the Payment Request modal could not be located')
  return src.slice(from, to)
}

/** The correction form, out of the same page. */
function editModal(): string {
  const src = read(REQUEST_PAGE)
  const from = src.indexOf('function EditPaymentModal(')
  const to   = src.indexOf('function FigureBand(')
  assert.ok(from > -1 && to > from, 'the Edit Payment Request modal could not be located')
  return src.slice(from, to)
}

describe('the section itself', () => {
  test('it is named once, and that is the name the product uses', () => {
    assert.equal(PROOF_REFERENCE_TITLE, 'Payment Proof / Reference')
  })

  test('it owns the heading and the frame, so the fields inside carry neither', () => {
    const src = read(SECTION)
    assert.ok(src.includes('{PROOF_REFERENCE_TITLE}'), 'the section prints the shared title')
    assert.ok(src.includes('aria-labelledby={headingId}'),
      'the heading must actually label the section for a screen reader')
    // No nested card: ProofReferenceField draws a label and its control, and no
    // border of its own.
    const field = src.slice(src.indexOf('export function ProofReferenceField('),
                            src.indexOf('export function ProofReferenceSection('))
    assert.equal(/border:/.test(field), false,
      'a field inside the section must not draw a frame — three controls would read as three panels')
  })
})

describe('all three entry forms group the same three things', () => {
  const forms: [string, () => string][] = [
    ['Send Payment Request', requestModal],
    ['Edit Payment Request', editModal],
    ['Record Payment',       () => read(RECORD_FORM)],
  ]

  for (const [name, source] of forms) {
    test(`${name} draws exactly one Payment Proof / Reference section`, () => {
      const src = source()
      assert.equal((src.match(/<ProofReferenceSection>/g) ?? []).length, 1,
        `${name} must have one such section, not zero and not two`)
    })

    test(`${name} has no separate Notes heading left behind`, () => {
      const src = source()
      // The old headings, each of which was a section of its own.
      for (const heading of [
        'Field label="Notes (optional)"',
        'Field label="Sales Note (optional)"',
        'Field label="Remark"',
        'Field label="Payment Proof / Reference Note"',
      ]) {
        assert.equal(src.includes(heading), false,
          `${name} must not keep the standalone "${heading}" block`)
      }
    })

    test(`${name} still sends the reference and the note as SEPARATE values`, () => {
      const src = source()
      // The grouping is visual. Two columns, two payload keys, two meanings.
      const referenceKey = /p_proof_note|p_reference/.test(src)
      const noteKey      = /p_sales_note|p_remarks/.test(src)
      assert.ok(referenceKey, `${name} must still send the reference`)
      assert.ok(noteKey, `${name} must still send the note, as its own field`)
    })
  }

  test('every form offers the proof upload inside that section', () => {
    for (const [name, source] of forms.filter(([n]) => n !== 'Edit Payment Request')) {
      const src = source()
      const from = src.indexOf('<ProofReferenceSection>')
      const to   = src.indexOf('</ProofReferenceSection>')
      assert.ok(from > -1 && to > from, `${name}: the section could not be located`)
      assert.ok(src.slice(from, to).includes('fileInputRef'),
        `${name} must offer the attachment inside the grouped section`)
    }
    // The correction form has never attached a proof — the attachment is written
    // once, with the payment, and correcting a request does not re-upload it.
    // payment_proof_attachments rows key on the payment id, which an edit never
    // changes, so an edited request keeps exactly the proof it had.
    assert.equal(editModal().includes('fileInputRef'), false)
  })
})

describe('the detail views group them the same way', () => {
  test('both detail surfaces put proof, reference and notes under one heading', () => {
    for (const file of [REQUEST_PAGE, RECEIVED_VIEW]) {
      const src = read(file)
      assert.ok(src.includes('<SectionHeader>Payment Proof / Reference</SectionHeader>'),
        `${file} must group the three under the product's own heading`)
      assert.equal(src.includes('<SectionHeader>Notes</SectionHeader>'), false,
        `${file} must not keep a standalone Notes section`)
      assert.equal(src.includes('<SectionHeader>Supporting information</SectionHeader>'), false,
        `${file} must use the product's heading, not a second name for it`)
    }
  })

  test('and every existing value still has somewhere to be displayed', () => {
    for (const file of [REQUEST_PAGE, RECEIVED_VIEW]) {
      const src = read(file)
      assert.ok(src.includes('r.proof_note'), `${file} must still print the stored reference`)
      assert.ok(src.includes('r.sales_note'), `${file} must still print the stored note`)
      assert.ok(src.includes('<PaymentProofView'), `${file} must still offer the stored proof`)
    }
  })
})
