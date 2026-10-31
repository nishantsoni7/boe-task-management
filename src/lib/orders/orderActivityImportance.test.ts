import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { isKeyActivityEvent, isMainActivityEvent } from './orderActivityImportance'
import { describeMiddlemanParts } from './piInternalDetails'
import { orderInternalDetailRows } from './orderInternalDetailsView'

describe('which activity events are key events', () => {
  test('milestones on the Order trail are key; bookkeeping is not', () => {
    for (const eventType of ['created', 'status_changed', 'order_amended', 'pi_revision_approved', 'payment_verified', 'production_alignment_changed']) {
      assert.equal(isKeyActivityEvent({ source: 'order', label: 'x', eventType }), true, eventType)
    }
    for (const eventType of ['note_added', 'payment_linked', 'factory_focus_selected']) {
      assert.equal(isKeyActivityEvent({ source: 'order', label: 'x', eventType }), false, eventType)
    }
  })

  test('the source PI trail is read by its wording', () => {
    assert.equal(isKeyActivityEvent({ source: 'pi', label: 'PI approved' }), true)
    assert.equal(isKeyActivityEvent({ source: 'pi', label: 'Revised PI uploaded' }), true)
    assert.equal(isKeyActivityEvent({ source: 'pi', label: 'Sent to operations for review' }), true)
    assert.equal(isKeyActivityEvent({ source: 'pi', label: 'Order product codes assigned' }), false)
    assert.equal(isKeyActivityEvent({ source: 'pi', label: 'Note added' }), false)
  })
})

describe('the middleman answer split for the Order page', () => {
  test('a commission and a name, each on its own', () => {
    assert.deepEqual(describeMiddlemanParts({
      middleman_commission: 'yes', middleman_recipient: 'Ramesh', middleman_commission_basis: 'amount',
      middleman_commission_amount: '50000', commission_restricted: false,
    }), { commission: '₹50,000.00', name: 'Ramesh' })
    assert.deepEqual(describeMiddlemanParts({
      middleman_commission: 'yes', middleman_recipient: 'Asha', middleman_commission_basis: 'percent',
      middleman_commission_percent: '2.5', middleman_commission_percent_of: 'grand_total', commission_restricted: false,
    }).name, 'Asha')
  })

  // Order 542's own figures: agreed as ₹1,66,400 on a Total before GST of ₹13,50,590.
  const figures = { gross_product_amount: '1366400', subtotal_after_discount: '1266400', total_before_gst: '1350590', grand_total: '1593696.20' }
  const agreedAmount = {
    middleman_commission: 'yes', middleman_recipient: 'Mr.Ashwin', middleman_commission_basis: 'amount',
    middleman_commission_amount: '166400', commission_restricted: false,
  }
  const agreedPercent = (of: string) => ({
    middleman_commission: 'yes', middleman_recipient: 'Asha', middleman_commission_basis: 'percent',
    middleman_commission_percent: '2.5', middleman_commission_percent_of: of, commission_restricted: false,
  })

  test('an agreed amount also reads as a share of Total before GST, the figure the page itself shows', () => {
    assert.deepEqual(describeMiddlemanParts({ ...agreedAmount, ...figures }),
      { commission: '₹1,66,400.00 · 12.32% of Total before GST', name: 'Mr.Ashwin' })
  })

  test('an agreed percentage also reads in rupees of the figure it was agreed on, each base its own', () => {
    assert.equal(describeMiddlemanParts({ ...agreedPercent('total_before_gst'), ...figures }).commission, '₹33,764.75 · 2.5% of Total before GST')
    assert.equal(describeMiddlemanParts({ ...agreedPercent('grand_total'), ...figures }).commission, '₹39,842.41 · 2.5% of Grand total (incl. GST)')
    assert.equal(describeMiddlemanParts({ ...agreedPercent('subtotal_after_discount'), ...figures }).commission, '₹31,660.00 · 2.5% of Subtotal (after the deduction)')
    assert.equal(describeMiddlemanParts({ ...agreedPercent('gross_product_amount'), ...figures }).commission, '₹34,160.00 · 2.5% of Gross product amount')
  })

  test('with no figure to work from, only what was agreed is shown: never a guessed share', () => {
    assert.equal(describeMiddlemanParts(agreedAmount).commission, '₹1,66,400.00')
    assert.equal(describeMiddlemanParts({ ...agreedAmount, total_before_gst: null }).commission, '₹1,66,400.00')
    assert.equal(describeMiddlemanParts({ ...agreedAmount, total_before_gst: '0' }).commission, '₹1,66,400.00')
    assert.equal(describeMiddlemanParts({ ...agreedAmount, total_before_gst: '' }).commission, '₹1,66,400.00')
    assert.equal(describeMiddlemanParts(agreedPercent('grand_total')).commission, '2.5% of Grand total (incl. GST)')
    assert.equal(describeMiddlemanParts({ ...agreedPercent('nonsense'), ...figures }).commission, '2.5% of an unnamed figure')
  })

  test('a reader who may not see the commission gets no share of it either', () => {
    assert.deepEqual(describeMiddlemanParts({ ...agreedAmount, ...figures, commission_restricted: true }), { commission: 'Restricted', name: 'Restricted' })
  })

  test('no middleman says No and Not applicable; an unanswered one says so; a restricted reader never sees a value or a false No', () => {
    assert.deepEqual(describeMiddlemanParts({ middleman_commission: 'no', commission_restricted: false }), { commission: 'No', name: 'Not applicable' })
    assert.deepEqual(describeMiddlemanParts({ commission_restricted: false }), { commission: 'Not answered', name: 'Not answered' })
    assert.deepEqual(describeMiddlemanParts({ middleman_commission: 'no', commission_restricted: true }), { commission: 'Restricted', name: 'Restricted' })
  })

  test('the Order page rows are fabric, bill / cash, middleman commission, middleman name — terms only when stated', () => {
    const rows = orderInternalDetailRows({ fabric_responsibility: 'client', billing_percentage: '70', middleman_commission: 'no', commission_restricted: false })
    assert.deepEqual(rows.map(r => r.key), ['fabric_responsibility', 'billing_percentage', 'middleman_commission', 'middleman_name'])
    assert.equal(rows[1].value, 'Bill 70% · Cash 30%')
    const withTerms = orderInternalDetailRows({ billing_terms: 'On dispatch', payment_terms: '50% advance', commission_restricted: false })
    assert.deepEqual(withTerms.slice(4).map(r => r.key), ['billing_terms', 'payment_terms'])
  })
})

describe('which events the Activity section shows (owner, 2026-10-27)', () => {
  const order = (eventType: string) => isMainActivityEvent({ source: 'order', label: 'x', eventType })
  const pi = (label: string) => isMainActivityEvent({ source: 'pi', label })

  test('decisions and changes on the Order are main', () => {
    for (const t of ['created', 'order_created_from_pi_submission', 'status_changed', 'order_amended', 'order_client_details_amended',
      'pi_revision_proposed', 'pi_revision_approved', 'pi_revision_rejected', 'production_alignment_changed', 'payment_verified',
      'payment_rejected', 'order_advance_hold_opened', 'operations_handoff_accepted', 'operations_handoff_clarification_needed',
      'operations_handoff_acceptance_withdrawn', 'operations_handoff_realigned', 'document_submission_operations_accepted',
      'document_submission_rejected', 'order_approval_recorded']) {
      assert.equal(order(t), true, t)
    }
  })

  test('bookkeeping on the Order is minor, however it is worded', () => {
    for (const t of ['note_added', 'payment_linked', 'payment_unlinked', 'operations_handoff_recorded', 'operations_reviewer_assigned',
      'operations_reviewer_unassigned', 'factory_focus_selected', 'factory_focus_removed', 'document_generation_started',
      'document_generation_ready', 'document_uploaded']) {
      assert.equal(order(t), false, t)
    }
  })

  test('the source PI trail: approvals, rejections, updates and amendments are main; numbering and moves are minor', () => {
    for (const l of ['PI approved', 'Revised PI uploaded'.replace('uploaded', 'approved'), 'Revised PI rejected', 'Rejected', 'Changes requested',
      'PI replaced', 'Payment verified by Finance', 'Payment rejected by Finance', 'Client details updated', 'Schedule and terms amended by admin',
      'Product details updated', 'Correction requested', 'Correction refused', 'Confirmed Order created', 'Advance exception approved']) {
      assert.equal(pi(l), true, l)
    }
    for (const l of ['Draft created', 'Submitted for approval', 'Order number reserved', 'Order number assigned', 'Revised PI carries the Order number',
      'Payments moved onto the Order', 'Payment attached', 'Order product codes assigned']) {
      assert.equal(pi(l), false, l)
    }
  })
})
