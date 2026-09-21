/**
 * WHAT A DRAFT PI MUST SAY BEFORE IT CAN BE FINALIZED.
 *
 * The owner's decision of 2026-09-21, checked end to end across the four layers
 * that implement it: the words (src/lib/orders/piTerms.ts), the readiness list
 * (piReadiness), the generated document (confirmedPdf), and the migration whose
 * columns and gate are the authority (20261225000000).
 *
 * THE MIGRATION IS READ AS TEXT, not applied. These tests run without a
 * database — the SQL assertions inside the migration are what prove it against
 * a real one. What is checked here is the part that can drift silently: that
 * the sentence this module prints and the default that migration writes are the
 * same string, and that the gate names the same seven fields the screen does.
 *
 *   npx tsx --test src/lib/orders/piTerms.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  BOE_STANDARD_COMMERCIAL_TERMS,
  COMMERCIAL_TERMS_MAX_LENGTH,
  FABRIC_RESPONSIBILITY_OPTIONS,
  FABRIC_RESPONSIBILITY_UNANSWERED,
  commercialTermsNote,
  fabricResponsibilityLabel,
  fabricResponsibilityNeedsConfirmation,
  fabricResponsibilityStatement,
  isFabricResponsibility,
  isStandardCommercialTerms,
} from './piTerms'
import { piReadiness, PI_FINALIZATION_REQUIREMENTS } from './piReadiness'
import { buildConfirmedPdfModel } from './confirmedPdf'
import { buildHeaderRows, buildOrderInformationRows } from '@/lib/pi/previewView'
import { buildOverviewMeta } from '@/app/orders/drafts/[submissionId]/piDetailView'
import type { PiHeader } from '@/lib/pi/types'

/** A header with nothing in it: these tests are about LABELS, not values. */
const EMPTY_HEADER: PiHeader = {
  sourceOrderNumber: null, creationDate: null, createdBy: null, boeGst: null,
  contactNumber: null, billToName: null, billToPhone: null, billToGst: null,
  billingAddress: null, shipToName: null, shipToPhone: null, shipToGst: null,
  shippingAddress: null, orderConfirmationDate: null, dispatchCommitment: null,
}
import type { OrderPiRow } from './orderPiHandoff'

const MIGRATION = readFileSync(
  join(process.cwd(), 'supabase', 'migrations',
    '20261225000000_order_submission_pi_header_terms_and_fabric.sql'),
  'utf8')

// ── The three answers ─────────────────────────────────────────────────────────

describe('the fabric question has exactly three answers, and no default', () => {
  test('the three, in the words the owner specified', () => {
    assert.deepEqual(
      FABRIC_RESPONSIBILITY_OPTIONS.map(o => o.value),
      ['not_selected', 'boe', 'client'])
    assert.deepEqual(
      FABRIC_RESPONSIBILITY_OPTIONS.map(o => o.label),
      [
        'Fabric not selected yet',
        'Fabric will be provided by BOE',
        'Fabric will be provided by client',
      ])
  })

  test('the column has no default, so nobody is answered for', () => {
    // THE WHOLE DESIGN IN ONE LINE. A default would have the system take a
    // commercial position on a document a client is sent.
    const column = MIGRATION.slice(
      MIGRATION.indexOf('add column if not exists fabric_responsibility'))
      .slice(0, 200)
    assert.ok(!/default/i.test(column),
      'fabric_responsibility must be added without a DEFAULT')
  })

  test('only those three are a valid stored value', () => {
    for (const option of FABRIC_RESPONSIBILITY_OPTIONS) {
      assert.ok(isFabricResponsibility(option.value))
    }
    for (const nonsense of [null, undefined, '', 'BOE', 'Boe', 'client ', 'maybe', 0]) {
      assert.ok(!isFabricResponsibility(nonsense), JSON.stringify(nonsense))
    }
  })

  test('and the database says the same three', () => {
    assert.ok(MIGRATION.includes(
      "fabric_responsibility in ('not_selected', 'boe', 'client')"))
  })
})

// ── Case C, D and E: what the generated PI states ─────────────────────────────

describe('the generated PI states who provides the fabric, in words', () => {
  test('BOE supplies it', () => {
    assert.equal(fabricResponsibilityStatement('boe'), 'Fabric will be provided by BOE.')
  })

  test('the client supplies it', () => {
    assert.equal(fabricResponsibilityStatement('client'), 'Fabric will be provided by client.')
  })

  test('nobody has decided yet, said as a status', () => {
    assert.equal(fabricResponsibilityStatement('not_selected'), 'Fabric not selected yet.')
  })

  test('the three statements cannot be mistaken for one another', () => {
    const said = FABRIC_RESPONSIBILITY_OPTIONS.map(o => o.statement)
    assert.equal(new Set(said).size, 3)
    // "Not selected" must not read as either party providing it.
    const pending = fabricResponsibilityStatement('not_selected')!
    assert.ok(!/provided by/i.test(pending),
      'the pending status must not read as a commitment by either party')
  })

  test('a client-supplied PI never presents BOE as sourcing the fabric', () => {
    const statement = fabricResponsibilityStatement('client')!
    assert.ok(/client/i.test(statement))
    assert.ok(!/\bBOE\b/.test(statement),
      'BOE must not appear in the sentence that says the client provides it')
  })

  test('AN UNANSWERED PI BORROWS NOBODY’S SENTENCE', () => {
    // The distinction the whole feature turns on: null is "nobody has been
    // asked", which is not the deliberate answer "not selected yet". Printing
    // the latter for the former would put a decision on a document that nobody
    // took.
    assert.equal(fabricResponsibilityStatement(null), null)
    assert.equal(fabricResponsibilityStatement(undefined), null)
    assert.equal(fabricResponsibilityLabel(null), null)
    // On screen it reads as its own thing, and only on screen.
    assert.notEqual(FABRIC_RESPONSIBILITY_UNANSWERED, 'Fabric not selected yet')
  })
})

// ── Changing the answer keeps the figures ─────────────────────────────────────

describe('changing the fabric answer never removes a figure', () => {
  test('moving to client-supplied with a charge on the PI asks first', () => {
    assert.ok(fabricResponsibilityNeedsConfirmation({ next: 'client', fabricCost: 40000 }))
  })

  test('and does not ask when there is no charge to contradict', () => {
    for (const cost of [null, 0]) {
      assert.ok(!fabricResponsibilityNeedsConfirmation({ next: 'client', fabricCost: cost }))
    }
  })

  test('the other two answers never ask', () => {
    for (const next of ['boe', 'not_selected', null]) {
      assert.ok(!fabricResponsibilityNeedsConfirmation({ next, fabricCost: 40000 }), String(next))
    }
  })

  test('THE WRITE PATH CANNOT TOUCH A FABRIC FIGURE AT ALL', () => {
    // The strongest form of "does not delete without confirmation": the RPC
    // that owns the answer has no fabric-cost column on the left of any
    // assignment, so there is nothing to confirm about. The migration asserts
    // this against the live function body too; this catches it in review.
    const editor = MIGRATION.slice(
      MIGRATION.indexOf('create or replace function public.update_order_submission_pi_terms'),
      MIGRATION.indexOf('comment on function public.update_order_submission_pi_terms'))
    for (const column of ['fabric_cost', 'fabric_cost_meaning', 'fabric_cost_text']) {
      assert.ok(!new RegExp(`\\b${column}\\s*=`).test(editor),
        `the PI terms editor must not assign ${column}`)
    }
  })

  test('and neither can the seed that prefills from the workbook', () => {
    const seed = MIGRATION.slice(
      MIGRATION.indexOf('create or replace function public.seed_order_submission_pi_terms'),
      MIGRATION.indexOf('comment on function public.seed_order_submission_pi_terms'))
    for (const column of ['fabric_cost', 'fabric_cost_meaning', 'fabric_cost_text']) {
      assert.ok(!new RegExp(`\\b${column}\\s*=`).test(seed),
        `the seed must not assign ${column}`)
    }
  })
})

// ── Case F: the commercial terms ──────────────────────────────────────────────

describe('the commercial terms note', () => {
  test('is the standard BOE sentence', () => {
    assert.equal(
      BOE_STANDARD_COMMERCIAL_TERMS,
      'Given prices are ex-factory. Fabric, packaging and GST, if not quoted, will be extra as applicable.')
  })

  test('and the column default is the SAME string, character for character', () => {
    // The one duplication this feature has: the default is what puts the
    // sentence on a new draft, and the constant is what the screen offers to
    // restore. A drift between them would show up on a document.
    assert.ok(MIGRATION.includes(`default '${BOE_STANDARD_COMMERCIAL_TERMS}'`),
      'the migration default and BOE_STANDARD_COMMERCIAL_TERMS must be identical')
  })

  test('a blank note is null, never an empty sentence', () => {
    for (const blank of [null, undefined, '', '   ', '\n']) {
      assert.equal(commercialTermsNote(blank), null, JSON.stringify(blank))
    }
  })

  test('an edited note survives verbatim, including its line breaks', () => {
    const edited = 'Prices include fabric and packing.\nTransport is billed at actual.'
    assert.equal(commercialTermsNote(edited), edited)
    assert.ok(!isStandardCommercialTerms(edited))
  })

  test('THE PARSE NEVER REINSTATES THE STANDARD WORDING OVER AN EDIT', () => {
    // The rule that makes "do not silently overwrite edited terms" true across
    // a re-upload, a regeneration and a PI change: the seed writes the terms
    // ONLY while they are still untouched — null, or still exactly standard.
    const seed = MIGRATION.slice(
      MIGRATION.indexOf('create or replace function public.seed_order_submission_pi_terms'),
      MIGRATION.indexOf('comment on function public.seed_order_submission_pi_terms'))
    assert.ok(seed.includes('commercial_terms_note is null or btrim(commercial_terms_note) = c_standard'),
      'the seed must leave an edited note alone')
    assert.ok(seed.includes('fabric_responsibility is null'),
      'and must leave an answered fabric question alone')

    // And replace_order_submission_parse, which DOES replace everything else on
    // every upload, is not re-emitted here and must not learn to write these.
    assert.ok(!MIGRATION.includes('create or replace function public.replace_order_submission_parse'),
      'the parse writer is not touched by this migration')
  })

  test('a note longer than the field allows is refused, not truncated', () => {
    assert.equal(COMMERCIAL_TERMS_MAX_LENGTH, 2000)
    assert.ok(MIGRATION.includes('ORDER_SUBMISSION_FIELD_TOO_LONG'))
  })
})

// ── Cases A, B and G: what blocks finalization ────────────────────────────────

/** A PI with everything a finalized one must say. */
const complete = () => ({
  client_name: 'Kalyan Interiors',
  source_workbook_path: 'submissions/abc/original/pi.xlsx',
  parse_blocking_issues: [],
  creation_date: '2026-09-20',
  source_created_by: 'R. Sharma',
  contact_number: '+91 98200 11223',
  client_city: 'Bengaluru',
  fabric_responsibility: 'boe',
  commercial_terms_note: BOE_STANDARD_COMMERCIAL_TERMS,
})

const items = () => [{ item_sequence: 1, product_name: 'Chair', hasRepresentativeImage: true }]

const missingKeys = (over: Record<string, unknown>) =>
  piReadiness('submission', { ...complete(), ...over }, items()).missing.map(m => m.key)

describe('a PI cannot be finalized until it says all seven things', () => {
  test('the seven, in the order the form shows them', () => {
    assert.deepEqual(
      PI_FINALIZATION_REQUIREMENTS.map(r => r.key),
      [
        'creation_date', 'source_created_by', 'contact_number',
        'client_name', 'client_city', 'fabric_responsibility', 'commercial_terms_note',
      ])
  })

  test('and the database gate names the same seven', () => {
    const gate = MIGRATION.slice(
      MIGRATION.indexOf('create or replace function public.assert_order_submission_finalizable'),
      MIGRATION.indexOf('comment on function public.assert_order_submission_finalizable'))
    for (const requirement of PI_FINALIZATION_REQUIREMENTS) {
      assert.ok(gate.includes(requirement.key),
        `the gate must check ${requirement.key}`)
    }
  })

  test('Case A — a complete PI is ready', () => {
    const readiness = piReadiness('submission', complete(), items())
    assert.equal(readiness.ready, true)
    assert.equal(readiness.summary, null)
  })

  test('Case G — a missing client name or city blocks, and says which', () => {
    assert.deepEqual(missingKeys({ client_name: null }), ['client_name'])
    assert.deepEqual(missingKeys({ client_city: null }), ['client_city'])
    assert.deepEqual(missingKeys({ client_city: '   ' }), ['client_city'],
      'whitespace is not a city')
  })

  test('Case B — a PI with only a name and a city asks for the rest, by name', () => {
    const keys = missingKeys({
      creation_date: null,
      source_created_by: null,
      contact_number: null,
      fabric_responsibility: null,
      commercial_terms_note: null,
    })
    assert.deepEqual(keys,
      ['creation_date', 'source_created_by', 'contact_number',
       'fabric_responsibility', 'commercial_terms_note'])
  })

  test('Case B — and the optional details are never asked for', () => {
    // The client's own phone, both GST numbers, both addresses and the ship-to
    // party are legitimately absent. A screen that nagged about them would
    // teach people to ignore it.
    const readiness = piReadiness('submission', complete(), items())
    assert.equal(readiness.ready, true,
      'nothing optional may block a complete PI')
  })

  test('an unanswered fabric question blocks; all three answers clear it', () => {
    assert.deepEqual(missingKeys({ fabric_responsibility: null }), ['fabric_responsibility'])
    for (const option of FABRIC_RESPONSIBILITY_OPTIONS) {
      assert.deepEqual(missingKeys({ fabric_responsibility: option.value }), [],
        `${option.value} is a deliberate answer and must not block`)
    }
  })

  test('the payment surface is not made to answer questions it never read', () => {
    // A caller that passes fewer columns reports fewer requirements: an ABSENT
    // property is silence, not a gap. Otherwise the payment card would invent
    // requirements out of columns it never selected.
    const readiness = piReadiness('payment', {
      client_name: 'Kalyan Interiors',
      source_workbook_path: null,
    })
    assert.equal(readiness.ready, true)
  })

  test('every message names its own field', () => {
    for (const requirement of PI_FINALIZATION_REQUIREMENTS) {
      assert.ok(requirement.label.length > 0)
      assert.ok(['client', 'terms'].includes(requirement.section),
        `${requirement.key} must open an editor that can actually supply it`)
    }
  })
})

// ── The generated document carries both ───────────────────────────────────────

const PI_ROW = (over: Partial<OrderPiRow> = {}): OrderPiRow => ({
  id: 'sub-1',
  client_name: 'Kalyan Interiors',
  client_city: 'Bengaluru',
  bill_to_name: 'Kalyan Interiors',
  ship_to_name: null,
  creation_date: '2026-09-20',
  source_created_by: 'R. Sharma',
  contact_number: '+91 98200 11223',
  bill_to_phone: null,
  ship_to_phone: null,
  billing_address: '12 Residency Road',
  shipping_address: null,
  bill_to_gst: null,
  ship_to_gst: null,
  order_confirmation_date: '2026-07-01',
  dispatch_commitment: null,
  due_date: '2026-08-15',
  gross_product_amount: 100000,
  discount_amount: 0,
  subtotal_after_discount: 100000,
  fabric_cost: 40000,
  fabric_cost_meaning: 'numeric',
  fabric_cost_text: null,
  packing_cost: null,
  packing_cost_meaning: 'numeric',
  packing_cost_text: null,
  transportation_amount: null,
  transportation_text: null,
  total_before_gst: 140000,
  gst_amount: 25200,
  grand_total: 165200,
  commercial_terms_note: BOE_STANDARD_COMMERCIAL_TERMS,
  fabric_responsibility: 'boe',
  billing_percentage: null,
  source_workbook_name: null,
  source_workbook_path: null,
  ...over,
} as OrderPiRow)

const pdfModel = (over: Partial<OrderPiRow> = {}) => buildConfirmedPdfModel({
  orderNumber: 'BOE/0001',
  submission: PI_ROW(over),
  items: [],
})

describe('the confirmed document carries the answer and the terms', () => {
  test('Case D — BOE supplies the fabric, and the cost line still works', () => {
    const model = pdfModel({ fabric_responsibility: 'boe' })
    assert.equal(model.fabricResponsibility, 'Fabric will be provided by BOE.')
    const fabric = model.commercial.find(r => r.key === 'fabric')
    assert.ok(fabric, 'the fabric cost row is still built')
    assert.ok(!fabric.missing, 'and still carries its figure')
  })

  test('Case C — the client supplies it, and BOE is not named as sourcing it', () => {
    const model = pdfModel({ fabric_responsibility: 'client' })
    assert.equal(model.fabricResponsibility, 'Fabric will be provided by client.')
    assert.ok(!/\bBOE\b/.test(model.fabricResponsibility!))
    // AND THE FIGURE IS UNTOUCHED. Nothing in the document path clears it.
    const fabric = model.commercial.find(r => r.key === 'fabric')
    assert.ok(fabric && !fabric.missing,
      'the fabric figure the workbook stated survives the choice')
  })

  test('Case E — not selected yet is stated as the status it is', () => {
    const model = pdfModel({ fabric_responsibility: 'not_selected' })
    assert.equal(model.fabricResponsibility, 'Fabric not selected yet.')
    assert.ok(!/provided by/i.test(model.fabricResponsibility!))
  })

  test('Case F — edited wording reaches the document, unchanged', () => {
    const edited = 'Prices include fabric and packing. Transport at actual.'
    const model = pdfModel({ commercial_terms_note: edited })
    assert.equal(model.commercialTerms, edited)
  })

  test('the standard wording is printed too, not silently assumed', () => {
    assert.equal(pdfModel().commercialTerms, BOE_STANDARD_COMMERCIAL_TERMS)
  })

  test('the billing block states the city', () => {
    const city = pdfModel().billTo.find(f => f.label === 'City')
    assert.ok(city)
    assert.equal(city.value, 'Bengaluru')
  })

  test('an unanswered PI produces no sentence, even here', () => {
    // A confirmed Order cannot be in this state — submission refuses one — but
    // the model must not invent a sentence if it somehow is.
    assert.equal(pdfModel({ fabric_responsibility: null }).fabricResponsibility, null)
  })
})

// ── A re-upload, simulated against the seed's own rule ───────────────────────

/**
 * THE SEED'S RULE, EXECUTED RATHER THAN READ.
 *
 * piFinalizationGate.test.ts asserts the SQL says "fill a hole, never overwrite
 * an answer". This models the same rule in TypeScript and runs a re-upload
 * through it, because what matters to a person is the OUTCOME — I chose the
 * fabric and typed my terms, I re-uploaded a corrected workbook, and my answers
 * are still there — and an assertion about SQL text does not demonstrate that.
 *
 * The model is kept honest by deriving its two conditions from the migration
 * itself, so a change to the rule that this file did not follow fails here.
 */
const SEED_SQL = readFileSync(
  join(process.cwd(), 'supabase', 'migrations',
    '20261225000000_order_submission_pi_header_terms_and_fabric.sql'), 'utf8')
  .replace(/\r\n/g, '\n')

type Row = {
  fabric_responsibility: string | null
  commercial_terms_note: string | null
  client_city: string | null
}

/** What seed_order_submission_pi_terms does, in the same three cases. */
function seed(row: Row, fromWorkbook: Partial<Row>): Row {
  const standard = (v: string | null) => v === null || v.trim() === BOE_STANDARD_COMMERCIAL_TERMS
  return {
    // Only while nobody has answered.
    fabric_responsibility: fromWorkbook.fabric_responsibility != null && row.fabric_responsibility === null
      ? fromWorkbook.fabric_responsibility
      : row.fabric_responsibility,
    // Only while the terms are still untouched: null, or still exactly standard.
    commercial_terms_note: fromWorkbook.commercial_terms_note != null && standard(row.commercial_terms_note)
      ? fromWorkbook.commercial_terms_note
      : row.commercial_terms_note,
    // Only into an empty field.
    client_city: fromWorkbook.client_city != null && row.client_city === null
      ? fromWorkbook.client_city
      : row.client_city,
  }
}

describe('re-uploading a workbook never undoes a person', () => {
  test('the model matches the rule the migration actually applies', () => {
    // If the SQL rule changes, this model is wrong and these outcomes prove
    // nothing. So the three conditions are read back out of the migration.
    assert.ok(SEED_SQL.includes('v_fabric is not null and fabric_responsibility is null'))
    assert.ok(SEED_SQL.includes(
      'commercial_terms_note is null or btrim(commercial_terms_note) = c_standard'))
    assert.ok(SEED_SQL.includes('v_city is not null and client_city is null'))
  })

  test('A MANUAL FABRIC CHOICE SURVIVES A RE-UPLOAD', () => {
    // Somebody settled the fabric on a call and chose it on the draft. The
    // workbook they then re-upload still says something else. The person wins.
    const before: Row = { fabric_responsibility: 'client', commercial_terms_note: null, client_city: null }
    const after = seed(before, { fabric_responsibility: 'boe' })
    assert.equal(after.fabric_responsibility, 'client')
  })

  test('and so does a deliberate "not selected yet"', () => {
    const before: Row = { fabric_responsibility: 'not_selected', commercial_terms_note: null, client_city: null }
    assert.equal(seed(before, { fabric_responsibility: 'boe' }).fabric_responsibility, 'not_selected')
  })

  test('but an UNANSWERED PI takes the workbook\u2019s answer', () => {
    const before: Row = { fabric_responsibility: null, commercial_terms_note: null, client_city: null }
    assert.equal(seed(before, { fabric_responsibility: 'boe' }).fabric_responsibility, 'boe')
  })

  test('EDITED COMMERCIAL TERMS SURVIVE A RE-UPLOAD', () => {
    const negotiated = 'Prices include fabric and packing. Transport at actual.'
    const before: Row = { fabric_responsibility: 'boe', commercial_terms_note: negotiated, client_city: 'Jodhpur' }
    const after = seed(before, {
      commercial_terms_note: BOE_STANDARD_COMMERCIAL_TERMS,
      client_city: 'Mumbai',
    })
    assert.equal(after.commercial_terms_note, negotiated,
      'the negotiated wording is not replaced by the standard one')
    assert.equal(after.client_city, 'Jodhpur', 'and the corrected city stands')
  })

  test('terms still at the standard wording DO take the workbook\u2019s', () => {
    // Untouched is untouched, whether that is NULL or the default the column
    // put there. Only an EDIT is protected.
    const fromSheet = 'Given prices are ex-factory. Fabric extra.'
    for (const untouched of [null, BOE_STANDARD_COMMERCIAL_TERMS]) {
      const before: Row = { fabric_responsibility: null, commercial_terms_note: untouched, client_city: null }
      assert.equal(seed(before, { commercial_terms_note: fromSheet }).commercial_terms_note, fromSheet,
        JSON.stringify(untouched))
    }
  })

  test('a workbook that says nothing changes nothing', () => {
    const before: Row = { fabric_responsibility: 'client', commercial_terms_note: 'mine', client_city: 'Jodhpur' }
    assert.deepEqual(seed(before, {}), before)
  })
})

// ── Historical records ────────────────────────────────────────────────────────

describe('a PI finalized before this feature is not rewritten', () => {
  test('its three new columns are NULL, and NULL prints nothing', () => {
    // No backfill, so an approved PI from months ago still says nothing about
    // fabric, terms or city — which is true of it. The document model must
    // therefore print nothing rather than invent a standard.
    const historical = pdfModel({
      fabric_responsibility: null,
      commercial_terms_note: null,
      client_city: null,
    })
    assert.equal(historical.fabricResponsibility, null)
    assert.equal(historical.commercialTerms, null)
    assert.ok(!historical.billTo.some(f => f.label === 'City'))
  })

  test('so regenerating its documents changes nothing a client would see', () => {
    // Every field the old model carried is still there and still says the same
    // thing; the three new ones contribute no line at all.
    const historical = pdfModel({
      fabric_responsibility: null, commercial_terms_note: null, client_city: null,
    })
    assert.equal(historical.clientName, 'Kalyan Interiors')
    assert.ok(historical.commercial.length > 0, 'the figures are unchanged')
    const labels = historical.billTo.map(f => f.label)
    assert.deepEqual(labels, ['Name', 'Address'], 'the billing block is what it was')
  })
})

// ── One word for one person ───────────────────────────────────────────────────

describe('every surface calls the salesperson the salesperson', () => {
  /**
   * order_submissions.source_created_by is the SALESPERSON — the person
   * responsible for the order. Three surfaces render it, and for a while they
   * disagreed: the PI detail strip said "Salesperson", the Upload PI preview
   * and the Drafts list said "Created by". On the Drafts list that sat directly
   * above "Uploaded by", so two different people read as two versions of one
   * idea.
   *
   * THE VALUES ARE ASSERTED, NOT THE MARKUP. Each builder is called and its
   * labels are read, so a screen that renders the builder cannot drift from it.
   */
  test('the Upload PI preview', () => {
    const rows = buildOrderInformationRows({
      header: EMPTY_HEADER,
      grossProductAmount: 1000,
      upload: { by: 'Priya Rao', at: '01 Aug 2026' },
    })
    const salesperson = rows.find(r => r.key === 'salesperson')
    assert.ok(salesperson, 'the Upload PI preview must name the salesperson')
    assert.equal(salesperson.label, 'Salesperson')
    assert.ok(!rows.some(r => r.label === 'Created by'),
      'and must not also call somebody "Created by"')
  })

  test('the shared header builder, which the PDF and the PI detail page read', () => {
    const rows = buildHeaderRows(EMPTY_HEADER)
    const author = rows.find(r => r.key === 'createdBy')
    assert.ok(author)
    assert.equal(author.label, 'Salesperson')
    assert.ok(!rows.some(r => r.label === 'Created by'))
  })

  test('the PI detail strip, unchanged', () => {
    const meta = buildOverviewMeta({
      salesperson: 'Dhruv', salespersonPhone: '+91 83023 68420',
      submitterName: 'Priya Rao', createdOn: '01 Aug 2026',
    })
    assert.equal(meta[0].label, 'Salesperson')
  })

  test('and the generated PDF', () => {
    const meta = Object.fromEntries(pdfModel().meta.map(f => [f.label, f.value]))
    assert.equal(meta['Salesperson'], 'R. Sharma')
    assert.equal(meta['PI created by'], undefined)
  })

  test('"Uploaded by" and "PI submitted by" stay their own thing', () => {
    // The point is not to remove a word; it is that two DIFFERENT people are
    // named differently. Whoever uploaded or submitted a PI is not necessarily
    // the salesperson on it.
    const rows = buildOrderInformationRows({
      header: EMPTY_HEADER,
      grossProductAmount: 1000,
      upload: { by: 'Priya Rao', at: '01 Aug 2026' },
    })
    assert.ok(rows.some(r => r.label === 'Uploaded by'))
    const meta = buildOverviewMeta({
      salesperson: 'Dhruv', submitterName: 'Priya Rao', createdOn: '01 Aug 2026',
    })
    assert.ok(meta.some(m => m.label === 'PI submitted by'))
  })
})
