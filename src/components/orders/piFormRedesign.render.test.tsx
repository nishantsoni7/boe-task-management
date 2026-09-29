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
import { ChoiceGroup, Choice, FormField, RequiredLegend, describedBy } from './PiFormParts'
import type { SupportingState } from './PiSupportingDocuments'
import { orderDetailsForm, orderDetailsSavePlan, orderDetailsSubmissionGaps } from '@/lib/orders/salesOrderDetails'

const read = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n')
const supabase = {} as SupabaseClient
const state = { previous: [], keep: new Set(), staged: [], stagedReadable: true, staging: false, missing: [], stage: async () => null, unstage: async () => null } as unknown as SupportingState

const supporting = (over: Partial<Parameters<typeof PiSupportingDetails>[0]> = {}) => renderToStaticMarkup(
  <PiSupportingDetails
    supabase={supabase} submissionId="s1" row={{ status: 'draft', billing_percentage: 65 }} rowVersion={3}
    canEditBilling canEditFiles canEditHighlight locked={false} supporting={state} submittedAt={null}
    grandTotal={1000} focus={null} onSaved={() => {}} onHighlightRead={() => {}} {...over} />,
)

describe('Supporting details', () => {
  test('one card: Client PO and Design Files in two columns, then billing percentage — all optional, no star', () => {
    const html = supporting()
    assert.match(html, /aria-label="Supporting details"/)
    assert.equal((html.match(/class="pi-attach"/g) ?? []).length, 2)
    assert.ok(html.indexOf('Client PO') < html.indexOf('Design Files'))
    assert.ok(html.includes('Billing percentage') && html.includes('value="65"'))
    assert.ok(html.includes('How much of the order should be billed'))
    assert.ok(!html.includes('pi-form-req'), 'nothing here is needed to submit')
  })

  test('an empty billing percentage stays optional: blank is a valid value, nothing is asked for', () => {
    const html = supporting({ row: { status: 'draft' } })
    assert.ok(html.includes('Optional') && html.includes('placeholder="e.g. 65"'))
    assert.ok(/<button[^>]*disabled=""[^>]*>Save percentage/.test(html), 'nothing to save until it changes')
    assert.deepEqual(orderDetailsSubmissionGaps({ status: 'draft' }).filter(g => g.key === ('billing_percentage' as never)), [])
  })

  test('locked: the same section read-only — no Add, no Save, no input', () => {
    const html = supporting({ locked: true, canEditBilling: false, canEditFiles: false, canEditHighlight: false })
    assert.ok(html.includes('Billing percentage') && html.includes('65%'))
    assert.ok(!html.includes('Save percentage') && !html.includes('type="file"') && !html.includes('<input'))
  })

  test('billing is saved by its own RPC, and only when it changed', () => {
    const row = { status: 'draft', billing_percentage: 65, billing_terms: 'kept as stored' }
    assert.deepEqual(orderDetailsSavePlan(row, orderDetailsForm(row)), [])
    const plan = orderDetailsSavePlan(row, { ...orderDetailsForm(row), billing_percentage: '70' })
    assert.deepEqual(plan.map(s => s.rpc), ['set_order_submission_billing_percentage'])
  })
})

describe('Internal order details form', () => {
  const src = read('src/components/orders/PiOrderDetailsSection.tsx')

  test('grouped: dates, assignment, production, commission, payment — each under its own heading', () => {
    for (const title of ['Order dates', 'Order assignment', 'Production details', 'Commission', 'Payment']) {
      assert.ok(src.includes(`title="${title}"`), title)
    }
  })

  test('required is a programmatic state, not a native one that would block a draft save', () => {
    assert.ok(src.includes('noValidate'))
    assert.equal((src.match(/\brequired\b(?!To)/g) ?? []).filter(Boolean).length > 0, true)
    assert.ok(!/<input[^>]*\srequired[\s>]/.test(src), 'no native required attribute')
    assert.ok(src.includes('aria-required="true"'))
  })

  test('stars only where Submit needs it: dates, fabric, commission — not salesperson or lead source', () => {
    const salesperson = src.slice(src.indexOf('id={orderDetailsInputId(\'salesperson_id\')} label='), src.indexOf('<select id={orderDetailsInputId(\'salesperson_id\')}'))
    assert.ok(!salesperson.includes('required'))
    const lead = src.slice(src.indexOf('id={orderDetailsInputId(\'lead_source\')} label='), src.indexOf('<select id={orderDetailsInputId(\'lead_source\')}'))
    assert.ok(!lead.includes('required'))
    assert.ok(src.includes('Needed when the Order is created, not to submit this PI.'))
  })

  test('no billing terms field, no per-field pill', () => {
    assert.ok(!src.includes('billing_terms') && !src.includes('NeedChip') && !src.includes('Needed to submit'))
  })

  test('nothing is preselected, and the commission follow-up lives in the same group', () => {
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

  test('two columns collapse to one at the phone breakpoint, which is declared last', () => {
    const at = css.lastIndexOf('@media (max-width: 560px) {\n  .pi-form-card')
    assert.ok(at > css.indexOf('.pi-form-grid {'))
    assert.match(css.slice(at), /\.pi-form-grid,\s*\.pi-attach-grid,\s*\.pi-form-facts \{\s*grid-template-columns: minmax\(0, 1fr\)/)
    assert.match(css, /\.pi-form-input:focus-visible/)
  })
})
