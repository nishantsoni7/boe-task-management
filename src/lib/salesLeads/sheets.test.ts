/**
 * Sales: reading the two old Google Sheets. Every name and number here is made up: the real sheets stay out of the repository.
 *
 * Run:
 *   npm run test:file -- src/lib/salesLeads/sheets.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { dayOf, firstDates, looseDate, readLeadsMaster, readWebsiteLeads, sheetSource, workbookKind } from './sheets'

const MASTER_HEAD = ['Date', 'Month', 'Lead Source', 'Customer Name', 'Email', 'Contact', 'Location', 'Requirement', 'Assigned to']

describe('which sheet it is', () => {
  test('Leads Master has year tabs; Website Leads has all_leads', () => {
    assert.equal(workbookKind(['2026', 'Export 2026', 'Variables']), 'leads_master')
    assert.equal(workbookKind(['all_leads', 'Sales Manage', 'Till 2025']), 'website')
    assert.equal(workbookKind(['Sheet1']), null)
  })
})

describe('dates', () => {
  test('a day that does not exist in the month becomes its last day', () => {
    assert.equal(dayOf(2025, 2, 31), '2025-02-28')
    assert.equal(dayOf(2026, 11, 0), '2026-11-01')
    assert.equal(dayOf(2026, 13, 1), null)
  })
  test('a date cell is read as the day in India; written dates are read too', () => {
    assert.equal(looseDate(new Date('2025-02-12T18:30:00Z')), '2025-02-13')
    assert.equal(looseDate('Fri Mar 10 2023 00:00:00 GMT+0530'), '2023-03-10')
    assert.equal(looseDate('10/03/2023'), '2023-03-10')
    assert.equal(looseDate('date'), null)
  })
  test('the sources the sheets use', () => {
    assert.equal(sheetSource('facebook Promo'), 'facebook_promo')
    assert.equal(sheetSource('Google  Ads'), 'google_ads')
    assert.equal(sheetSource('Repeat'), 'repeat_customer')
    assert.equal(sheetSource('BNI'), 'bni')
    assert.equal(sheetSource('Something new'), 'others')
  })
})

describe('Leads Master', () => {
  const plan = readLeadsMaster({
    '2025': [MASTER_HEAD, [14, 'Mar', 'Whatsapp', 'Hotel One', 'ONE@Hotel.test', '98765 43210', 'Goa', 'Chairs', 'Ashok'],
      ['', 'Apr', 'Website', '', 'not an email', '98765 43211', '', '', 'Monika'], ['', '', '', '', '', '', '', '', '']],
    'Export 2026': [['Month', 'Lead Source', 'Customer Name', 'Email', 'Contact', 'Location', 'Requirement', 'Assinged to'],
      ['Feb', 'Website', 'Cafe Abroad', '', '+971 50 123 4567', 'Dubai', 'Tables', 'Mohit']],
    Retailers: [['Date.', 'Month', 'Lead Source', 'Customer Name', 'Contact', 'Location', 'Requirement'], [3, 'Aug', 'Instagram', '', '91234 56789', '', 'Showroom']],
    Architects: [['Sr. No.', 'Name', 'Location', 'Contact', 'Assigned to'], [1, 'Arch', 'Pune', '99999 00000', 'Saksham']],
  })
  test('each lead tab is read with its year; Architects is left out', () => {
    assert.deepEqual(plan.rows.map(r => r.received_on), ['2025-03-14', '2025-04-01', '2026-02-01', '2026-08-03'])
    assert.equal(plan.tabs.find(t => t.tab === 'Architects')?.note, 'not leads')
  })
  test('who it was given to, and a missing day, are said in its history', () => {
    assert.equal(plan.rows[0].detail, 'Leads Master 2025, given to Ashok')
    assert.equal(plan.rows[1].detail, 'Leads Master 2025, given to Monika, day not recorded')
    assert.equal(plan.estimated, 2)
  })
  test('numbers in one format, a bad email dropped, retailers said so', () => {
    assert.equal(plan.rows[0].phone, '+919876543210')
    assert.equal(plan.rows[0].email, 'one@hotel.test')
    assert.equal(plan.rows[1].email, null)
    assert.equal(plan.rows[2].phone, '+971501234567')
    assert.equal(plan.rows[3].requirement, 'Retailer: Showroom')
  })
})

describe('Website Leads', () => {
  const head = ['', 'form-type', 'your-name', 'your-email', 'your-tel', 'your-location', 'your-textarea', '']
  const known = new Map([['+919000000002', '2025-05-10'], ['+919000000005', '2025-06-01']])
  const plan = readWebsiteLeads({
    all_leads: [head,
      ['', '', 'First', 'a@a.test', '9000000001', 'Pune', 'Need chairs', 'Mohit'],
      ['', 'Google Ads', 'Second', 'b@b.test', '9000000002', '', 'Tables', 'Ashok'],
      ['', '', 'Third', '', '9000000003', '', '', 'Ashok'],
      ['', '', 'Vendor', '', '9000000004', '', 'We make foam', 'Supplier'],
      ['', '', 'Fifth', '', '9000000005', '', '', 'Prerna'],
    ],
  }, known)
  test('suppliers and staff are not leads', () => {
    assert.deepEqual(plan.rows.map(r => r.name), ['First', 'Second', 'Third', 'Fifth'])
  })
  test('an undated row takes the date of the nearest dated row before it, or after it at the top', () => {
    assert.deepEqual(plan.rows.map(r => r.received_on), ['2025-05-10', '2025-05-10', '2025-05-10', '2025-06-01'])
    assert.equal(plan.rows[0].detail, 'Website form (all_leads), given to Mohit, date estimated')
    assert.equal(plan.rows[1].detail, 'Website form (all_leads), given to Ashok')
    assert.equal(plan.estimated, 2)
  })
  test('Google Ads comes from the form type; the message is the requirement', () => {
    assert.deepEqual(plan.rows.map(r => r.source), ['website', 'google_ads', 'website', 'website'])
    assert.equal(plan.rows[0].requirement, 'Need chairs')
  })
  test('Leads Master dates each number by its first appearance', () => {
    const m = firstDates([
      { phone: '+91a', received_on: '2025-03-01', source: 'website', name: null, email: null, location: null, requirement: null, detail: '' },
      { phone: '+91a', received_on: '2024-06-01', source: 'website', name: null, email: null, location: null, requirement: null, detail: '' },
    ])
    assert.equal(m.get('+91a'), '2024-06-01')
  })
})
