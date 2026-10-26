import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { isKeyActivityEvent } from './orderActivityImportance'
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
