import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  ORDER_DETAILS_FIELDS,
  ORDER_DETAILS_REQUIREMENT_PREFIX,
  SALES_DETAILS_UNAVAILABLE,
  orderDetailsErrors,
  orderDetailsFieldOf,
  orderDetailsForm,
  orderDetailsReview,
  orderDetailsSavePlan,
  orderDetailsSubmissionGaps,
  readSalesDetails,
  withOrderDetailsRequirements,
  type OrderDetailsRow,
} from './salesOrderDetails'
import { PiOrderDetailsSection } from '@/components/orders/PiOrderDetailsSection'
import { PiApproveOrderModal } from '@/components/orders/piReviewModals'
import { buildApprovalSummary } from '@/app/orders/drafts/[submissionId]/piDetailView'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { OrderConfirmationDraft } from './orderConfirmation'

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8').replace(/\r\n/g, '\n')
const PAGE = read('src/app/orders/drafts/[submissionId]/page.tsx')
const MIGRATION = read('supabase/migrations/20270211000000_order_submission_sales_order_details.sql')
const PEOPLE = [{ id: 'u-dhruv', name: 'Dhruv Mehta' }, { id: 'u-asha', name: 'Asha Rao' }]

const COMPLETE: OrderDetailsRow = {
  status: 'draft',
  order_confirmation_date: '2026-09-27', due_date: '2026-11-20',
  fabric_responsibility: 'client',
  middleman_commission: 'no',
  salesperson_id: 'u-dhruv', lead_source: 'website',
  billing_percentage: 65, billing_terms: '50% on dispatch',
}
const READY = { ready: true, missing: [], summary: null } as const

describe('every field says how much it is needed — and nothing optional became required', () => {
  test('the needs are the database’s own gates', () => {
    const need = Object.fromEntries(ORDER_DETAILS_FIELDS.map(f => [f.key, f.need]))
    assert.deepEqual(need, {
      order_confirmation_date: 'submission', due_date: 'submission',
      salesperson_id: 'approval', lead_source: 'approval',
      billing_percentage: 'optional', billing_terms: 'optional',
      fabric_responsibility: 'submission',
      middleman_commission: 'submission', middleman_structure: 'conditional',
    })
  })

  test('a draft missing ONLY optional or approval-time details is ready to submit', () => {
    const row = { ...COMPLETE, salesperson_id: null, lead_source: null, billing_percentage: null, billing_terms: null }
    assert.deepEqual(orderDetailsSubmissionGaps(row), [])
    assert.equal(withOrderDetailsRequirements(READY, row), READY)
  })
})

describe('the readiness checklist points each gap at its field in the section', () => {
  test('missing dates, fabric and middleman answer are each named, keyed to their field', () => {
    const r = withOrderDetailsRequirements(READY, { status: 'draft' })
    assert.equal(r.ready, false)
    assert.deepEqual(r.missing.map(m => [orderDetailsFieldOf(m.key), m.section]), [
      ['order_confirmation_date', 'internal'], ['due_date', 'internal'],
      ['fabric_responsibility', 'internal'], ['middleman_commission', 'internal'],
    ])
    assert.ok(r.summary?.startsWith('Before this PI can be submitted, 4 things are needed'))
  })

  test('the shared fabric requirement is RE-POINTED, never listed twice', () => {
    const shared = { ready: false, missing: [
      { key: 'client_city', label: 'Client city', section: 'client' as const },
      { key: 'fabric_responsibility', label: 'Fabric responsibility', section: 'terms' as const },
    ], summary: 'x' }
    const r = withOrderDetailsRequirements(shared, { ...COMPLETE, fabric_responsibility: null })
    assert.deepEqual(r.missing.map(m => m.key), ['client_city', `${ORDER_DETAILS_REQUIREMENT_PREFIX}fabric_responsibility`])
  })

  test('the date order rule is the RPC’s own', () => {
    const gaps = orderDetailsSubmissionGaps({ ...COMPLETE, due_date: '2026-09-01' })
    assert.deepEqual(gaps.map(g => g.key), ['due_date'])
    assert.match(gaps[0].label, /on or after the confirmation date/)
  })

  test('a "Yes" without its structure asks for the details, not the answer', () => {
    const gaps = orderDetailsSubmissionGaps({ ...COMPLETE, middleman_commission: 'yes' })
    assert.deepEqual(gaps.map(g => g.key), ['middleman_structure'])
  })

  test('past draft or returned, nothing is added', () => {
    assert.equal(withOrderDetailsRequirements(READY, { status: 'submitted' }), READY)
  })

  test('the page feeds the checklist from it, and Add focuses the field in the section', () => {
    assert.ok(PAGE.includes('readiness={actions.canSubmit ? withOrderDetailsRequirements(submissionReadiness, detailsRow) : null}'))
    assert.ok(PAGE.includes("if (section === 'internal') { focusOrderDetails(orderDetailsFieldOf(key) ?? 'middleman_commission'); return }"))
    assert.ok(PAGE.includes("onEdit={() => focusOrderDetails('middleman_commission')}"), 'the commission card opens the same section')
    assert.ok(!PAGE.includes('PiInternalDetailsModal'), 'the separate Internal details dialog is gone')
  })
})

describe('saving reuses the existing doors, and only the ones whose values changed', () => {
  test('nothing changed, nothing is written', () => {
    assert.deepEqual(orderDetailsSavePlan(COMPLETE, orderDetailsForm(COMPLETE)), [])
  })

  test('each group goes to the RPC that already owns it, internal details last', () => {
    const blank: OrderDetailsRow = { status: 'draft' }
    const form = { ...orderDetailsForm(blank),
      order_confirmation_date: '2026-09-27', due_date: '2026-11-20', middleman_commission: 'no' as const,
      salesperson_id: 'u-dhruv', lead_source: 'website', billing_percentage: '65', billing_terms: 'Net 30',
      fabric_responsibility: 'boe' }
    const plan = orderDetailsSavePlan(blank, form)
    assert.deepEqual(plan.map(s => s.rpc), [
      'set_order_submission_sales_details', 'update_order_submission_pi_terms',
      'update_order_submission_schedule_terms', 'set_order_submission_billing_percentage',
      'save_order_submission_internal_details',
    ])
    assert.deepEqual(plan[0].args, { p_salesperson_id: 'u-dhruv', p_lead_source: 'website' })
    assert.deepEqual(plan[1].args, { p_fields: { fabric_responsibility: 'boe' }, p_reason: null })
    assert.deepEqual(plan[2].args, { p_fields: { billing_terms: 'Net 30' }, p_reason: null })
    assert.deepEqual(plan[3].args, { p_percentage: 65, p_reason: null })
    assert.equal(plan[3].versioned, false, 'the billing RPC takes no version; the section re-reads it')
    assert.equal((plan[4].args as { p_confirm: boolean }).p_confirm, false, 'a draft save never confirms')
  })

  test('a blank billing percentage clears the declaration rather than inventing one', () => {
    const plan = orderDetailsSavePlan(COMPLETE, { ...orderDetailsForm(COMPLETE), billing_percentage: '' })
    assert.deepEqual(plan.map(s => [s.rpc, s.args.p_percentage]), [['set_order_submission_billing_percentage', null]])
  })

  test('an incomplete draft still saves; only an impossible value stops it', () => {
    assert.deepEqual(orderDetailsErrors(orderDetailsForm({ status: 'draft' }), null), {})
    const bad = orderDetailsErrors({ ...orderDetailsForm(COMPLETE), billing_percentage: '20', due_date: '2026-01-01' }, null)
    assert.ok(bad.billing_percentage && bad.due_date)
  })

  // Found in the 2026-09-27 walkthrough: the Submit dialog seeded its terms from
  // the payment summary read at page open and wrote them back on submit, so
  // billing terms saved in the section afterwards were blanked.
  test('Submit opens on the RECORD’s terms, so it never blanks what the section saved', () => {
    assert.ok(PAGE.includes("paymentTerms: submission.payment_terms ?? payments?.payment_terms ?? '',"))
    assert.ok(PAGE.includes("billingTerms: submission.billing_terms ?? payments?.billing_terms ?? '',"))
  })

  test('the section runs the plan with the row version each RPC hands back', () => {
    const section = read('src/components/orders/PiOrderDetailsSection.tsx')
    assert.ok(section.includes('if (step.versioned) args.p_expected_version = version'))
    assert.ok(section.includes(".select('row_version')"), 'and re-reads it after the one RPC that returns none')
    assert.ok(section.includes('Saved already:'), 'a part-way failure says what was saved')
  })
})

describe('the section states what Sales has provided', () => {
  const render = (row: OrderDetailsRow, canEdit = true) => renderToStaticMarkup(
    <PiOrderDetailsSection supabase={{} as SupabaseClient} submissionId="s1" row={row} rowVersion={3}
      canEdit={canEdit} salesDetailsAvailable people={PEOPLE} grandTotal={1137756} fabricCost={0}
      focus={null} onSaved={() => {}} />)

  test('one labelled, internal section, every field with how much it is needed', () => {
    const html = render(COMPLETE)
    assert.match(html, /aria-label="Internal order details"/)
    assert.match(html, />Internal</)
    for (const label of ['Date of Order Confirmation', 'Dispatch Date Finalized', 'Salesperson', 'Lead source',
      'Billing percentage', 'Billing terms', 'Fabric responsibility', 'Middleman commission']) {
      assert.ok(html.includes(label), label)
    }
    assert.ok(html.includes('Dhruv Mehta') && html.includes('Website') && html.includes('65%') && html.includes('Fabric will be provided by client'))
    for (const need of ['submission', 'approval', 'optional']) assert.match(html, new RegExp(`data-need="${need}"`))
    assert.match(html, />\s*Edit details</)
  })

  test('a blank draft says what is missing, and offers Complete details to its editor only', () => {
    const html = render({ status: 'draft' })
    assert.match(html, />Not added yet</)
    assert.match(html, />Not given</, 'optional blanks are quiet')
    assert.match(html, /Complete details/)
    assert.doesNotMatch(render({ status: 'draft' }, false), /<button/)
  })

  test('a salesperson id nobody in the list has is never shown as a blank or a guess', () => {
    const review = orderDetailsReview({ ...COMPLETE, salesperson_id: 'u-gone' }, PEOPLE)
    assert.equal(review.find(r => r.key === 'salesperson_id')?.value, 'Saved (not in the list)')
  })

  test('the two new columns are read on their own, and a failure is "not available"', () => {
    assert.deepEqual(readSalesDetails(null), SALES_DETAILS_UNAVAILABLE)
    assert.deepEqual(readSalesDetails({ salesperson_id: 'u-dhruv', lead_source: '' }), { available: true, salesperson_id: 'u-dhruv', lead_source: null })
  })
})

describe('approval reviews what Sales provided instead of asking again', () => {
  const render = (provided: Parameters<typeof PiApproveOrderModal>[0]['provided'], confirmation: OrderConfirmationDraft = {
    salesperson: 'u-dhruv', confirmDate: '2026-09-27', dueDate: '2026-11-20', leadSource: 'website',
  }) => renderToStaticMarkup(
    <PiApproveOrderModal client="Rivoli" mode="approve_and_create"
      rows={buildApprovalSummary({ client: 'Rivoli', productValue: '₹9,64,200', advanceConfirmed: '₹0' })}
      saving={false} failure={null} onCancel={() => {}} onConfirm={() => {}}
      salespeople={PEOPLE} confirmation={confirmation} onConfirmationChange={() => {}} confirmationField={null}
      provided={provided}
      detailsReview={orderDetailsReview(COMPLETE, PEOPLE).filter(r => ['billing_percentage', 'billing_terms', 'fabric_responsibility', 'middleman_commission'].includes(r.key))}
    />)

  test('the persisted salesperson, dates and lead source are review values, with a Change control — no selector', () => {
    const html = render({ salesperson: { id: 'u-dhruv', name: 'Dhruv Mehta' }, leadSource: 'website', confirmDate: '2026-09-27', dueDate: '2026-11-20' })
    for (const field of ['salesperson', 'confirm_date', 'due_date', 'lead_source']) assert.match(html, new RegExp(`data-review="${field}"`))
    assert.ok(html.includes('Dhruv Mehta') && html.includes('27 Sep 2026') && html.includes('20 Nov 2026') && html.includes('Website'))
    assert.doesNotMatch(html, /<select/, 'nothing to pick')
    assert.doesNotMatch(html, /type="date"/, 'nothing to type')
    assert.equal((html.match(/>Change</g) ?? []).length, 4, 'management keeps the authority to change each one')
  })

  test('billing, fabric and commission are reviewed, never re-entered', () => {
    const html = render({ salesperson: { id: 'u-dhruv', name: 'Dhruv Mehta' }, leadSource: 'website', confirmDate: '2026-09-27', dueDate: '2026-11-20' })
    const review = html.slice(html.indexOf('data-testid="pi-approve-details-review"'))
    for (const text of ['Billing percentage', '65%', 'Billing terms', '50% on dispatch', 'Fabric will be provided by client', 'Middleman commission', 'No']) {
      assert.ok(review.includes(text), text)
    }
  })

  test('A LEGACY PI with no saved salesperson keeps the selector, says so, and picks nobody', () => {
    const html = render({ salesperson: null, leadSource: null, confirmDate: '2026-09-27', dueDate: '2026-11-20' },
      { salesperson: null, confirmDate: '2026-09-27', dueDate: '2026-11-20', leadSource: null })
    assert.match(html, /Select a salesperson…/)
    assert.match(html, /This PI has no saved salesperson\. Choose one; nobody is picked for you\./)
    assert.match(html, /<option value="" selected="">Select a salesperson…/)
    assert.match(html, /Select a lead source…/)
    assert.match(html, /data-review="confirm_date"/, 'the dates Sales gave are still review values')
  })

  test('the page prefills from the PI, never from the approver', () => {
    assert.ok(PAGE.includes('salesperson: salesDetails.salesperson_id ?? resolveSavedSalesperson({'))
    assert.ok(PAGE.includes('leadSource: salesDetails.lead_source ?? prev.leadSource,'))
    assert.ok(!/salesperson:\s*viewerId/.test(PAGE) && !/salesperson:\s*profile/.test(PAGE))
  })

  test('approve_order_submission is not changed: it still requires all four', () => {
    assert.ok(!/approve_order_submission/.test(MIGRATION.replace(/--.*$/gm, '')), 'the migration does not touch the approval RPC')
  })
})

describe('the migration', () => {
  test('two nullable columns, a known-values check, and one owner-or-admin writer', () => {
    assert.match(MIGRATION, /add column if not exists salesperson_id uuid references public\.users\(id\) on delete set null/)
    assert.match(MIGRATION, /add column if not exists lead_source {4}text;/)
    assert.match(MIGRATION, /lead_source in \('reference', 'repeat_customer', 'whatsapp', 'instagram', 'website'\)/)
    assert.match(MIGRATION, /security definer\s+set search_path = public, pg_temp/)
    assert.match(MIGRATION, /if not public\.can_edit_order_submission\(p_submission_id\) then/)
    assert.match(MIGRATION, /v_sub\.row_version is distinct from p_expected_version/)
    assert.match(MIGRATION, /revoke all {4}on function public\.set_order_submission_sales_details\(uuid, uuid, text, integer\) from public, anon;/)
    assert.ok(!/create policy|alter policy|drop policy/i.test(MIGRATION))
    assert.ok(!/order_submission_activity_action_check/.test(MIGRATION), 'the existing action is reused')
  })

  test('neither column reaches a client document', () => {
    for (const doc of ['src/lib/orders/confirmedPdf.ts', 'src/lib/orders/confirmedWorkbook.ts', 'src/lib/pi/previewView.ts']) {
      const src = read(doc)
      assert.ok(!src.includes('salesperson_id') && !src.includes('lead_source'), doc)
    }
  })
})
