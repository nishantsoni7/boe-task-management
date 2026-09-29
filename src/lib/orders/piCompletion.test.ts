/**
 * COMPLETE PI DETAILS — WHAT BLOCKS, WHAT WAITS, WHAT IS OPTIONAL.
 *
 * The classification below is not new. Each test names the database gate the
 * claim rests on and reads that migration, so a change to a gate fails here
 * instead of leaving the checklist telling somebody the wrong thing.
 *
 * Run:
 *   npx tsx --test src/lib/orders/piCompletion.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  COMPLETION_NEED_LABEL,
  PROCEED_WITHOUT_QUESTION,
  SUBMIT_FINAL_WARNING,
  buildCompletionFacts,
  buildPiCompletion,
  joinItemNames,
  stageAfter,
  submitStages,
} from './piCompletion'
import { piReadiness } from './piReadiness'
import { withOrderDetailsRequirements, type OrderDetailsRow } from './salesOrderDetails'
import { formatIsoDay } from './piInternalDetails'

const migration = (name: string) =>
  readFileSync(join(process.cwd(), 'supabase/migrations', name), 'utf8').replace(/\r\n/g, '\n')

/** A PI with everything the database asks for, nothing optional, and no salesperson chosen yet. */
const COMPLETE_ROW = {
  client_name: 'Kalyan Interiors', source_workbook_path: 'pi/kalyan.xlsx', parse_blocking_issues: [],
  creation_date: '2026-09-20', source_created_by: 'Dhruv', contact_number: '9999999999',
  client_city: 'Jaipur', fabric_responsibility: 'boe', commercial_terms_note: 'Standard terms',
}
const COMPLETE_DETAILS: OrderDetailsRow = {
  status: 'draft', middleman_commission: 'no',
  order_confirmation_date: '2026-09-20', due_date: '2026-11-20',
  fabric_responsibility: 'boe', salesperson_id: null, lead_source: null, billing_percentage: null, billing_terms: null,
}
const LINES = [{ item_sequence: 1, product_name: 'Sofa', hasRepresentativeImage: true }]

const completion = (over: {
  row?: { [K in keyof typeof COMPLETE_ROW]?: (typeof COMPLETE_ROW)[K] | null }
  details?: Partial<OrderDetailsRow>
  supportingMissing?: ('design_files' | 'client_po')[]
  highlight?: { available: boolean; remark: string | null }
  salesDetailsAvailable?: boolean
} = {}) => {
  const details = { ...COMPLETE_DETAILS, ...over.details }
  return buildPiCompletion({
    readiness: withOrderDetailsRequirements(piReadiness('submission', { ...COMPLETE_ROW, ...over.row } as Parameters<typeof piReadiness>[1], LINES), details),
    details,
    salesDetailsAvailable: over.salesDetailsAvailable ?? true,
    supportingMissing: over.supportingMissing ?? [],
    highlight: over.highlight ?? { available: true, remark: 'Rush' },
  })
}

describe('what is required for submission — each one a gate the database already holds', () => {
  const finalizable = migration('20261225000000_order_submission_pi_header_terms_and_fabric.sql')
  const internalGate = migration('20270123000000_order_submission_internal_details_required_on_submit.sql')

  test('the finalization gate names the seven fields the checklist calls required', () => {
    assert.ok(finalizable.includes("'fabric_responsibility'"), 'fabric responsibility is in the database gate (its own test is below)')
    for (const [field, label] of [
      ['creation_date', 'Date of creation'], ['source_created_by', 'Salesperson named in PI workbook'],
      ['contact_number', 'Salesperson contact number'], ['client_name', 'Client name'],
      ['client_city', 'Client city'],
      ['commercial_terms_note', 'Commercial terms'],
    ] as const) {
      assert.ok(finalizable.includes(`'${field}'`), `${field} is in the database's gate`)
      const blanked = completion({ row: { [field]: null } })
      assert.ok(blanked.requiredMissing.some(item => item.label === label && item.need === 'submission'),
        `${label} blocks submission`)
      assert.equal(blanked.readyToSubmit, false)
    }
  })

  test('the two order dates and the middleman answer are required too (20270123000000)', () => {
    assert.ok(internalGate.includes('order_submission_internal_details_problem'), 'the submission trigger asks the internal-details rule')
    const rule = migration('20270122000000_order_submission_internal_details.sql')
    assert.ok(/order_confirmation_date/.test(rule) && /middleman_commission/.test(rule) && /internal_details_confirmed_at/.test(rule))
    const none = completion({ details: { order_confirmation_date: null, due_date: null, middleman_commission: null } })
    const keys = none.requiredMissing.map(i => i.key)
    assert.ok(keys.includes('order_details:order_confirmation_date'))
    assert.ok(keys.includes('order_details:due_date'))
    assert.ok(keys.includes('order_details:middleman_commission'))
  })

  test('a middleman "Yes" without who and how much is still missing, and points at the same field once', () => {
    const yes = completion({ details: { middleman_commission: 'yes' } })
    const structure = yes.requiredMissing.filter(i => i.field === 'middleman_structure')
    assert.equal(structure.length, 1)
    assert.equal(yes.requiredMissing.filter(i => i.field === 'middleman_commission').length, 0, 'the question is answered; only the structure is open')
  })

  test('a dispatch date before the confirmation date is refused, and is named', () => {
    const early = completion({ details: { order_confirmation_date: '2026-10-01', due_date: '2026-09-01' } })
    assert.ok(early.requiredMissing.some(i => i.field === 'due_date' && /on or after the confirmation date/.test(i.label)))
  })

  test('the workbook and the product lines block too — and only a corrected workbook fixes the first', () => {
    const noWorkbook = buildPiCompletion({
      readiness: withOrderDetailsRequirements(piReadiness('submission', { ...COMPLETE_ROW, source_workbook_path: null }, LINES), COMPLETE_DETAILS),
      details: COMPLETE_DETAILS, salesDetailsAvailable: true, supportingMissing: [], highlight: { available: true, remark: 'x' },
    })
    const item = noWorkbook.requiredMissing.find(i => i.key === 'source_workbook')
    assert.ok(item?.needsReimport)
    const noLines = buildPiCompletion({
      readiness: withOrderDetailsRequirements(piReadiness('submission', COMPLETE_ROW, []), COMPLETE_DETAILS),
      details: COMPLETE_DETAILS, salesDetailsAvailable: true, supportingMissing: [], highlight: { available: true, remark: 'x' },
    })
    assert.ok(noLines.requiredMissing.some(i => i.key === 'products' && i.where === 'products'))
  })

  test('an unanswered fabric question blocks; "not decided yet" is an answer and does not', () => {
    assert.ok(completion({ row: { fabric_responsibility: null }, details: { fabric_responsibility: null } })
      .requiredMissing.some(i => i.field === 'fabric_responsibility'))
    assert.equal(completion({ row: { fabric_responsibility: 'not_selected' }, details: { fabric_responsibility: 'not_selected' } }).readyToSubmit, true)
  })

  test('a PI with all of it is ready, whatever is optional or later', () => {
    const done = completion({ supportingMissing: ['design_files', 'client_po'], highlight: { available: true, remark: null } })
    assert.equal(done.readyToSubmit, true)
    assert.deepEqual(done.requiredMissing, [])
  })
})

describe('what is required only LATER — never a submission blocker', () => {
  const approval = migration('20261201000000_order_submission_confirmation_required_fields.sql')

  test('the salesperson and lead source are needed to create the Order (approve_order_submission), not to submit', () => {
    assert.ok(approval.includes('ORDER_CONFIRMATION_SALESPERSON_REQUIRED') && approval.includes('ORDER_CONFIRMATION_LEAD_SOURCE_REQUIRED'))
    const c = completion()
    assert.deepEqual(c.laterMissing.map(i => i.key), ['salesperson_id', 'lead_source'])
    assert.ok(c.laterMissing.every(i => i.need === 'later'))
    assert.equal(c.readyToSubmit, true, 'so they do not hold the Submit control')
    assert.ok(!c.requiredMissing.some(i => i.field === 'salesperson_id' || i.field === 'lead_source'))
  })

  test('once chosen they leave the list', () => {
    const c = completion({ details: { salesperson_id: 'u-1', lead_source: 'website' } })
    assert.deepEqual(c.laterMissing, [])
  })

  test('before the database has the two columns they cannot be asked for', () => {
    assert.deepEqual(completion({ salesDetailsAvailable: false }).laterMissing, [])
  })

  test('they are listed in the "proceed without these?" step, in their own group, apart from the optional ones', () => {
    const c = completion()
    assert.ok(!c.optionalMissing.some(i => i.key === 'salesperson_id' || i.key === 'lead_source'), 'not mislabelled Optional')
    assert.deepEqual(c.laterMissing.map(i => i.label), ['BOE salesperson assigned to Order', 'Lead source'])
    assert.equal(submitStages({ optionalCount: c.optionalMissing.length + c.laterMissing.length, meetsStandard: true })[0], 'optional')
  })

  test('with only later items empty the step still appears', () => {
    const c = completion({
      details: { billing_percentage: 65, billing_terms: 'x', payment_terms: 'y' },
      highlight: { available: true, remark: 'x' },
    })
    assert.deepEqual(c.optionalMissing, [])
    assert.equal(c.laterMissing.length, 2)
    assert.equal(submitStages({ optionalCount: c.optionalMissing.length + c.laterMissing.length, meetsStandard: true })[0], 'optional')
  })
})

describe('what is optional, and still empty', () => {
  test('billing percentage, billing terms, payment terms, Client PO, Design Files and the order highlight — by name', () => {
    const c = completion({ supportingMissing: ['design_files', 'client_po'], highlight: { available: true, remark: null } })
    assert.deepEqual(c.optionalMissing.map(i => i.label),
      ['Billing percentage', 'Billing terms', 'Payment terms', 'Design Files', 'Client PO', 'Order highlight'])
    assert.ok(c.optionalMissing.every(i => i.need === 'optional'))
    assert.equal(c.readyToSubmit, true, 'optional items never block')
  })

  test('filled ones drop out', () => {
    const c = completion({
      details: { billing_percentage: 65, billing_terms: '50% on dispatch', payment_terms: '30% advance' },
      supportingMissing: ['client_po'], highlight: { available: true, remark: 'Rush order' },
    })
    assert.deepEqual(c.optionalMissing.map(i => i.label), ['Client PO'])
  })

  test('a billing percentage outside the stored range is not a declared one', () => {
    assert.ok(completion({ details: { billing_percentage: 3 } }).optionalMissing.some(i => i.key === 'billing_percentage'))
  })

  test('a highlight that could not be read is not reported as empty', () => {
    assert.ok(!completion({ highlight: { available: false, remark: null } }).optionalMissing.some(i => i.key === 'order_highlight'))
  })

  test('the names read as a sentence', () => {
    assert.equal(joinItemNames([{ label: 'Client PO' }]), 'Client PO')
    assert.equal(joinItemNames([{ label: 'Billing terms' }, { label: 'Client PO' }]), 'Billing terms and Client PO')
    assert.equal(joinItemNames([{ label: 'A' }, { label: 'B' }, { label: 'C' }]), 'A, B and C')
  })
})

describe('the three labels the area shows', () => {
  test('are the ones the owner specified', () => {
    assert.deepEqual(COMPLETION_NEED_LABEL, {
      submission: 'Required for submission',
      later: 'Required later to create the Order',
      optional: 'Optional',
    })
  })
})

describe('the Submit sequence: optional → advance → final', () => {
  test('nothing optional missing and the requirement met: the final confirmation only', () => {
    assert.deepEqual(submitStages({ optionalCount: 0, meetsStandard: true }), ['final'])
  })

  test('optional items missing: the question comes first', () => {
    assert.deepEqual(submitStages({ optionalCount: 2, meetsStandard: true }), ['optional', 'final'])
  })

  test('below the requirement: the existing exception step, THEN the final confirmation', () => {
    assert.deepEqual(submitStages({ optionalCount: 0, meetsStandard: false }), ['advance', 'final'])
    assert.deepEqual(submitStages({ optionalCount: 3, meetsStandard: false }), ['optional', 'advance', 'final'])
  })

  test('a position that could not be read fails closed into the advance step', () => {
    assert.deepEqual(submitStages({ optionalCount: 0, meetsStandard: null }), ['advance', 'final'])
  })

  test('the final confirmation is never skipped', () => {
    for (const optionalCount of [0, 1, 5]) for (const meetsStandard of [true, false, null]) {
      const stages = submitStages({ optionalCount, meetsStandard })
      assert.equal(stages[stages.length - 1], 'final')
    }
  })

  test('Continue moves one step; a step that stopped applying is stepped over', () => {
    assert.equal(stageAfter(['optional', 'advance', 'final'], 'optional'), 'advance')
    assert.equal(stageAfter(['optional', 'advance', 'final'], 'advance'), 'final')
    assert.equal(stageAfter(['optional', 'final'], 'optional'), 'final', 'the requirement was met meanwhile')
    assert.equal(stageAfter(['final'], 'advance'), 'final')
    assert.equal(stageAfter(['final'], 'final'), 'final')
  })

  test('the words are the owner\'s', () => {
    assert.equal(PROCEED_WITHOUT_QUESTION, 'Would you like to proceed without these details?')
    assert.equal(SUBMIT_FINAL_WARNING,
      'After submission, you cannot edit this PI while it is with management. You can request a change from management.')
  })
})

describe('the client and PI-terms read-out', () => {
  const facts = buildCompletionFacts({
    client_name: 'Kalyan Interiors', client_city: '  ', contact_number: '9999999999',
    creation_date: '2026-09-20', source_created_by: 'Dhruv', commercial_terms_note: null,
  }, formatIsoDay)

  test('required ones are labelled, optional ones are labelled, blanks are null', () => {
    const by = Object.fromEntries(facts.map(f => [f.key, f]))
    assert.equal(by.client_name.need, 'submission')
    assert.equal(by.client_city.value, null, 'whitespace is not a city')
    assert.equal(by.creation_date.value, '20 Sep 2026')
    assert.equal(by.commercial_terms_note.value, null)
    for (const key of ['bill_to_phone', 'billing_address', 'shipping_address']) assert.equal(by[key].need, 'optional')
  })

  test('the required labels are the readiness list\'s own, so the two never disagree', () => {
    const ready = piReadiness('submission', { ...COMPLETE_ROW, client_city: null, commercial_terms_note: null }, LINES)
    const names = new Set(facts.map(f => f.label))
    for (const gap of ready.missing) assert.ok(names.has(gap.label), `${gap.label} is a row in the area`)
  })
})
