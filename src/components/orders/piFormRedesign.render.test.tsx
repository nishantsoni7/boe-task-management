/**
 * THE TWO PI DRAFT FORMS, REDESIGNED: Supporting details above Internal order
 * details, a red star for what Submit for approval needs (once explained), a
 * label above every control, and no Billing terms field.
 *
 * Run:
 *   npx tsx --test src/components/orders/piFormRedesign.render.test.tsx
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { PiSupportingDetails } from './PiSupportingDetails'
import { PiOrderDetailsSection } from './PiOrderDetailsSection'
import { ChoiceGroup, Choice, FormField, RequiredLegend, describedBy } from './PiFormParts'
import type { SupportingState } from './PiSupportingDocuments'
import { orderDetailsForm, orderDetailsSavePlan, orderDetailsSubmissionGaps } from '@/lib/orders/salesOrderDetails'

const read = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n')
const supabase = {} as SupabaseClient
const state = { previous: [], keep: new Set(), staged: [], stagedReadable: true, staging: false, missing: [], stage: async () => null, unstage: async () => null } as unknown as SupportingState

const supporting = (over: Partial<Parameters<typeof PiSupportingDetails>[0]> = {}) => renderToStaticMarkup(
  <PiSupportingDetails
    supabase={supabase} submissionId="s1" rowVersion={3}
    canEditFiles canEditHighlight locked={false} supporting={state} submittedAt={null}
    onSaved={() => {}} onHighlightRead={() => {}} {...over} />,
)

describe('Supporting details', () => {
  test('one row of three areas — Order highlight, Client PO, Design files — all optional, no star, no billing', () => {
    const html = supporting()
    assert.match(html, /aria-label="Supporting details"/)
    assert.equal((html.match(/class="pi-support-col"/g) ?? []).length, 2, 'Client PO and Design files; the highlight is the third area')
    assert.ok(html.includes('pi-support-highlight'))
    assert.ok(html.indexOf('Client PO') < html.indexOf('Design Files'))
    assert.ok(!html.includes('Billing percentage') && !html.includes('Save percentage'), 'billing lives in Internal order details')
    assert.ok(!html.includes('Optional'), 'no "Optional" explanation')
    assert.ok(!html.includes('pi-form-req'), 'nothing here is needed to submit')
  })

  test('the 40 / 30 / 30 split is declared on the row, and stacks when the section is narrow', () => {
    const css = read('src/app/globals.css')
    assert.match(css, /\.pi-support-row \{[^}]*grid-template-columns: minmax\(0, 4fr\) minmax\(0, 3fr\) minmax\(0, 3fr\);/)
    assert.match(css, /@container \(max-width: 720px\) \{\s*\.pi-support-row \{ grid-template-columns: minmax\(0, 1fr\)/)
  })

  test('locked: the same areas read-only — no Add, no Save, no input', () => {
    const html = supporting({ locked: true, canEditFiles: false, canEditHighlight: false })
    assert.ok(html.includes('Client PO') && html.includes('Design Files'))
    assert.ok(!html.includes('type="file"') && !html.includes('<input') && !html.includes('<textarea'))
  })

  test('billing is saved by its own RPC, and only when it changed', () => {
    const row = { status: 'draft', billing_percentage: 65, billing_terms: 'kept as stored' }
    assert.deepEqual(orderDetailsSavePlan(row, orderDetailsForm(row)), [])
    const plan = orderDetailsSavePlan(row, { ...orderDetailsForm(row), billing_percentage: '70' })
    assert.deepEqual(plan.map(s => s.rpc), ['set_order_submission_billing_percentage'])
    assert.deepEqual(orderDetailsSubmissionGaps({ status: 'draft' }).filter(g => g.key === ('billing_percentage' as never)), [])
  })
})

describe('Internal order details', () => {
  const src = read('src/components/orders/PiOrderDetailsSection.tsx')
  const details = (over: Partial<Parameters<typeof PiOrderDetailsSection>[0]> = {}) => renderToStaticMarkup(
    <PiOrderDetailsSection
      supabase={supabase} submissionId="s1" row={{ status: 'draft', billing_percentage: 65, order_confirmation_date: '2026-09-20', due_date: '2026-09-30' }}
      rowVersion={3} canEdit salesDetailsAvailable people={[{ id: 'p1', name: 'Dhruv' }]} grandTotal={1000} fabricCost={null}
      focus={null} onSaved={() => {}} billingValue="₹650" {...over} />,
  )

  test('read view: four columns over two rows, in the agreed order', () => {
    const html = details()
    const labels = [...html.matchAll(/<dt>(?:<label[^>]*>)?([^<]+)/g)].map(m => m[1])
    assert.deepEqual(labels, [
      'Confirmation date', 'Dispatch date', 'Fabric responsibility', 'Assigned salesperson',
      'Middleman commission', 'Billing percentage', 'Payment terms', 'Lead source',
    ])
    assert.match(read('src/app/globals.css'), /\.pi-od-grid \{[^}]*grid-template-columns: repeat\(4, minmax\(0, 1fr\)\);/)
  })

  test('billing percentage: one inline control, its value and its billed amount, here and nowhere else on the page', () => {
    const html = details()
    assert.ok(html.includes('value="65"') && html.includes('Save percentage') && html.includes('Billing value ₹650'))
    assert.equal((html.match(/Billing percentage/g) ?? []).length, 1)
    const readOnly = details({ canEdit: false, locked: true })
    assert.ok(readOnly.includes('65%') && !readOnly.includes('Save percentage') && !readOnly.includes('<input'))
    const blank = details({ row: { status: 'draft' }, billingValue: null })
    assert.ok(blank.includes('placeholder="e.g. 65"') && /<button[^>]*disabled=""[^>]*>Save percentage/.test(blank), 'blank is valid; nothing to save until it changes')
    assert.ok(details({ canEdit: false, row: { status: 'draft' } }).includes('Not declared'))
    const page = read('src/app/orders/drafts/[submissionId]/page.tsx')
    const sections = read('src/app/orders/drafts/[submissionId]/piDetailSections.tsx')
    assert.ok(!/BILLING_LABEL|billing=\{/.test(sections.slice(sections.indexOf('export function PiCommercialCard'), sections.indexOf('// ── 2a.'))), 'not in the commercial summary')
    assert.ok(!page.includes('<PiCommercialCard figures={summaryFigures} billing'))
  })

  test('a missing required value is said in words and marked, never blank; a valid "No commission" is not missing', () => {
    const html = details()
    assert.ok(/<dd data-empty="true" data-required="true">Not added yet<\/dd>/.test(html), 'the unanswered commission')
    const answered = details({ row: { status: 'draft', middleman_commission: 'no', fabric_responsibility: 'client' } as never })
    assert.ok(!/Middleman commission<span[^>]*>\*<\/span><\/dt><dd data-empty="true"/.test(answered))
  })

  test('no category headings, no explanatory paragraphs, no legend', () => {
    const html = details().replace(/ title="[^"]*"/g, '')  // the star's tooltip is not a heading
    for (const gone of ['Required to submit', 'Needed when the Order is created', 'Optional', 'For BOE only']) assert.ok(!html.includes(gone), gone)
    assert.ok(!src.includes('RequiredLegend') && !src.includes('FormGroup'))
  })

  test('required is a programmatic state, not a native one that would block a draft save', () => {
    assert.ok(src.includes('noValidate'))
    assert.ok(!/<input[^>]*\srequired[\s>]/.test(src), 'no native required attribute')
    assert.ok(src.includes('aria-required="true"'))
  })

  test('the form puts the same eight fields in the same order, four to a row', () => {
    const order = ['order_confirmation_date', 'due_date', 'fabric_responsibility', 'salesperson_id', 'middleman_commission', 'billing_percentage', 'payment_terms', 'lead_source']
    const form = src.slice(src.indexOf('<form'))
    const at = [
      form.indexOf("'order_confirmation_date', 'due_date'"), form.indexOf('od-fabric-group'), form.indexOf("orderDetailsInputId('salesperson_id')"),
      form.indexOf('od-middleman-group'), form.indexOf('id={BILLING_ID}'), form.indexOf("orderDetailsInputId('payment_terms')"), form.indexOf("orderDetailsInputId('lead_source')"),
    ]
    assert.ok(at.every((n, i) => n > 0 && (i === 0 || n > at[i - 1])), `${order.join(' > ')}: ${at.join(',')}`)
    assert.equal(form.split('span={3}').length - 1 >= 7, true)
  })

  test('stars only where Submit needs it: dates, fabric, commission — not salesperson or lead source', () => {
    const salesperson = src.slice(src.indexOf('id={orderDetailsInputId(\'salesperson_id\')} label='), src.indexOf('<select id={orderDetailsInputId(\'salesperson_id\')}'))
    assert.ok(!salesperson.includes('required'))
    const lead = src.slice(src.indexOf('id={orderDetailsInputId(\'lead_source\')} label='), src.indexOf('<select id={orderDetailsInputId(\'lead_source\')}'))
    assert.ok(!lead.includes('required'))
  })

  test('no billing terms field, no per-field pill', () => {
    assert.ok(!src.includes('billing_terms') && !src.includes('NeedChip') && !src.includes('Needed to submit'))
  })

  test('nothing is preselected, and the commission follow-up comes right after its row', () => {
    assert.ok(src.includes('checked={form.fabric_responsibility === option.value}'))
    assert.ok(src.includes('checked={form.middleman_commission === answer}'))
    assert.ok(src.indexOf('name="od-middleman"') < src.indexOf('pi-form-followup'))
  })
})

describe('form parts', () => {
  test('the legend explains the star once, in the words the brief gave', () => {
    const html = renderToStaticMarkup(<RequiredLegend />)
    assert.ok(html.includes('Required to submit for approval') && html.includes('aria-hidden="true">*'))
  })

  test('a field has a label above it, a hidden star, and help/error wired with aria-describedby', () => {
    const html = renderToStaticMarkup(
      <FormField id="x" label="Date" required help="Help" error="Bad"><input id="x" aria-describedby={describedBy('x', true, true)} /></FormField>)
    assert.ok(html.indexOf('<label') < html.indexOf('<input'))
    assert.ok(html.includes('id="x-help"') && html.includes('id="x-error"') && html.includes('role="alert"'))
    assert.equal(describedBy('x', false, false), undefined)
  })

  test('a choice group is a fieldset radiogroup with a legend; nothing checked by default', () => {
    const html = renderToStaticMarkup(
      <ChoiceGroup legend="Fabric" required describedById="g"><Choice name="n" label="A" checked={false} onChange={() => {}} /></ChoiceGroup>)
    assert.ok(html.includes('<fieldset') && html.includes('role="radiogroup"') && html.includes('aria-required="true"') && html.includes('<legend'))
    assert.ok(!html.includes('checked=""'))
  })
})

describe('the page and the stylesheet', () => {
  const page = read('src/app/orders/drafts/[submissionId]/page.tsx')
  const css = read('src/app/globals.css')

  test('Supporting details come before Internal order details, in both arrangements', () => {
    assert.ok(page.indexOf('{supportingDetails}') < page.indexOf('<PiOrderDetailsSection'))
    assert.equal((page.match(/\{supportingDetails\}/g) ?? []).length, 2)
  })

  test('the payment status opens open and nothing persists it closed', () => {
    const card = read('src/app/orders/drafts/[submissionId]/piDetailSections.tsx')
    assert.ok(card.includes('useState(true)'))
    const cardBody = card.slice(card.indexOf('export function PiPaymentStatusCard('), card.indexOf('type PiPaymentStatusCardProps'))
    assert.ok(!/localStorage|sessionStorage|useEffect/.test(cardBody))
  })

  test('the grid answers to the card, not the screen: narrower at 720px, one column at 420px, declared after the spans', () => {
    const block = css.slice(css.indexOf('.pi-form-card {'), css.indexOf('.pi-detail-highlight--bare {'))
    assert.match(block, /\.pi-form-card \{\s*container-type: inline-size;/)
    assert.ok(!/\.pi-form-card > \* \{\s*max-width: 920px;/.test(css), 'no 920px cap narrowing the page')
    assert.match(block, /grid-template-columns: repeat\(12, minmax\(0, 1fr\)\)/)
    const narrow = block.indexOf('@container (max-width: 720px)')
    const phone = block.indexOf('@container (max-width: 420px)')
    assert.ok(block.indexOf('.pi-form-grid > .pi-span-3 {') < narrow && narrow < phone)
    assert.match(block.slice(phone), /\.pi-span-6,\s*\.pi-form-grid > \.pi-span-7 \{ grid-column: span 12; \}/)
    assert.match(css, /\.pi-form-input:focus-visible/)
  })
})
