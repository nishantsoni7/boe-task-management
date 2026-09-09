/**
 * Inquiry stage presentation.
 *
 * The defect this locks down: an inquiry a customer submitted minutes ago —
 * `status: 'new'`, `quotation_status: 'draft'` — was labelled "Draft" in the
 * admin list, which reads as "a quotation has been started". Nobody had touched
 * it. The two status columns have to be read together to say anything true.
 *
 * No new database status is introduced by any of this; it is presentation over
 * the two columns that already exist.
 *
 * Run:
 *   npx tsx --test src/lib/showroom/inquiryStage.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  STAGE_ORDER,
  WORKFLOW_STEPS,
  inquiryStage,
  stageLabel,
  stagePresentation,
  workflowStepForPath,
} from './inquiryStage'

describe('inquiryStage', () => {
  test('a freshly submitted inquiry is Selecting Products, not Draft', () => {
    assert.equal(inquiryStage({ status: 'new', quotation_status: 'draft' }), 'selecting')
    assert.equal(stagePresentation({ status: 'new', quotation_status: 'draft' }).label, 'Selecting Products')
  })

  test('an inquiry being worked on is a quotation draft', () => {
    assert.equal(inquiryStage({ status: 'in_discussion', quotation_status: 'draft' }), 'quotation_draft')
  })

  test('an empty inquiry is never a draft quotation whatever the status column says', () => {
    assert.equal(inquiryStage({ status: 'in_discussion', quotation_status: 'draft', itemCount: 0 }), 'selecting')
  })

  test('either column reaching sent is enough to read as sent', () => {
    assert.equal(inquiryStage({ status: 'quotation_sent', quotation_status: 'draft' }), 'quotation_sent')
    assert.equal(inquiryStage({ status: 'in_discussion',  quotation_status: 'sent'  }), 'quotation_sent')
  })

  test('an outcome is terminal and is never overwritten by a later PDF', () => {
    // The route refuses to move quotation_status off anything but 'draft' for
    // exactly this reason; the display must agree with it.
    assert.equal(inquiryStage({ status: 'quotation_sent', quotation_status: 'converted' }), 'converted')
    assert.equal(inquiryStage({ status: 'quotation_sent', quotation_status: 'lost' }),      'lost')
    assert.equal(inquiryStage({ status: 'new',            quotation_status: 'converted' }), 'converted')
  })

  test('a null quotation_status is treated as a draft, as the list already did', () => {
    assert.equal(inquiryStage({ status: 'new', quotation_status: null }), 'selecting')
  })

  test('a closed inquiry never reads as still being worked on', () => {
    // `closed` is settable — /api/showroom/inquiry/[id] lists it in
    // VALID_STATUSES — and an earlier version of this function ignored the
    // column, labelling a deliberately closed inquiry "Selecting Products".
    assert.equal(inquiryStage({ status: 'closed', quotation_status: 'draft' }), 'closed')
    assert.equal(inquiryStage({ status: 'closed', quotation_status: null }),    'closed')
    assert.equal(inquiryStage({ status: 'closed', quotation_status: 'sent' }),  'closed')
    assert.equal(inquiryStage({ status: 'closed', quotation_status: 'draft', itemCount: 3 }), 'closed')
    assert.equal(stageLabel('closed'), 'Closed')
  })

  test('an outcome still outranks merely being closed', () => {
    // Closed says that it ended; converted and lost say how. Prefer the how.
    assert.equal(inquiryStage({ status: 'closed', quotation_status: 'converted' }), 'converted')
    assert.equal(inquiryStage({ status: 'closed', quotation_status: 'lost' }),      'lost')
  })

  test('no combination of the two real columns produces a misleading label', () => {
    // Exhaustive over the actual enums. The rules asserted here are the ones a
    // salesperson would call a lie if they were broken.
    const statuses = ['new', 'in_discussion', 'quotation_sent', 'closed'] as const
    const qStatuses = ['draft', 'sent', 'converted', 'lost', null] as const
    for (const status of statuses) {
      for (const quotation_status of qStatuses) {
        for (const itemCount of [0, 3]) {
          const stage = inquiryStage({ status, quotation_status, itemCount })

          // Never claim an outcome the quotation column does not record.
          if (stage === 'converted') assert.equal(quotation_status, 'converted')
          if (stage === 'lost')      assert.equal(quotation_status, 'lost')

          // Never claim a quotation was sent when neither column says so.
          if (stage === 'quotation_sent') {
            assert.ok(quotation_status === 'sent' || status === 'quotation_sent')
          }

          // Never show a closed inquiry as open work.
          if (status === 'closed' && quotation_status !== 'converted' && quotation_status !== 'lost') {
            assert.equal(stage, 'closed')
          }

          // Never call an empty inquiry a draft quotation.
          if (itemCount === 0) assert.notEqual(stage, 'quotation_draft')
        }
      }
    }
  })

  test('every stage has a label, and only open stages tell you what to do next', () => {
    for (const stage of STAGE_ORDER) assert.ok(stageLabel(stage).length > 0)
    assert.equal(stagePresentation({ status: 'new', quotation_status: 'draft' }).hint !== null, true)
    assert.equal(stagePresentation({ status: 'new', quotation_status: 'converted' }).hint, null)
    assert.equal(stagePresentation({ status: 'new', quotation_status: 'lost' }).hint, null)
  })

  test('the stage order runs from open to ended', () => {
    assert.deepEqual(STAGE_ORDER,
      ['selecting', 'quotation_draft', 'quotation_sent', 'converted', 'lost', 'closed'])
  })
})

describe('workflowStepForPath', () => {
  test('each customer-facing route maps to the step the person is on', () => {
    assert.equal(workflowStepForPath('/showroom/join'),                'Customer')
    assert.equal(workflowStepForPath('/showroom/scan'),                'Products')
    assert.equal(workflowStepForPath('/showroom/product/BOE-SR-003'),  'Products')
    assert.equal(workflowStepForPath('/showroom/project-list'),        'Quotation')
  })

  test('a trailing slash is the same route', () => {
    assert.equal(workflowStepForPath('/showroom/project-list/'), 'Quotation')
  })

  test('pages outside the flow show no indicator', () => {
    assert.equal(workflowStepForPath('/showroom/done'), null)
    assert.equal(workflowStepForPath('/showroom/share/abc'), null)
    assert.equal(workflowStepForPath('/showroom-admin'), null)
    assert.equal(workflowStepForPath(null), null)
  })

  test('the flow is three steps', () => {
    assert.deepEqual([...WORKFLOW_STEPS], ['Customer', 'Products', 'Quotation'])
  })
})
