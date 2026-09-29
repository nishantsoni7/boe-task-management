import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { PiDiscountWordingNotice } from './PiInternalDetails'

describe('the middleman commission is asked, and shown, once', () => {
  const page = () => readFileSync(join(process.cwd(), 'src/app/orders/drafts/[submissionId]/page.tsx'), 'utf8')

  test('the PI summary no longer repeats it: no summary component, no Enter and confirm, no second warning', () => {
    assert.doesNotMatch(page(), /PiInternalDetailsCard|PiCommissionSummary/)
    const src = readFileSync(join(process.cwd(), 'src/components/orders/PiInternalDetails.tsx'), 'utf8')
    assert.doesNotMatch(src, /Enter and confirm|Needed before review|PiCommissionSummary/)
    assert.ok(page().includes('dateNotes={workbookDateNotes(submission)}'))
  })

  test('Internal order details is the one place: the question, and its follow-up, in one choice group', () => {
    const form = readFileSync(join(process.cwd(), 'src/components/orders/PiOrderDetailsSection.tsx'), 'utf8')
    assert.equal((form.match(/name="od-middleman"/g) ?? []).length, 1)
    // Asked with the other answers Submit needs, its follow-up directly beneath it.
    const required = form.slice(form.indexOf('<FormGroup title={REQUIRED_TITLE}>'), form.lastIndexOf('<FormGroup title={LATER_TITLE}>'))
    assert.ok(required.includes('name="od-middleman"') && required.includes('pi-form-followup'))
  })
})

describe('PiDiscountWordingNotice', () => {
  test('renders nothing when there is nothing to check', () => {
    assert.equal(renderToStaticMarkup(<PiDiscountWordingNotice notice={null} />), '')
  })

  test('the PI page offers no Design Fee choice — a non-zero deduction is always Discount on the client PI', () => {
    const page = readFileSync(join(process.cwd(), 'src/app/orders/drafts/[submissionId]/page.tsx'), 'utf8')
    assert.doesNotMatch(page, /design_fee|DeductionLabelControl|set_order_submission_deduction_label/)
  })
})
