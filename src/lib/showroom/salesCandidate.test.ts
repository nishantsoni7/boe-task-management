/**
 * The Sales Candidate shown on internal showroom screens.
 *
 * The defect this locks down: the inquiry detail card showed Customer, Mobile
 * and Created but never said WHOSE inquiry it was, even though the page had
 * already resolved the name into state and used it in the WhatsApp message.
 *
 * Run:
 *   npx tsx --test src/lib/showroom/salesCandidate.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { SALES_CANDIDATE_LABEL, salesCandidateLabel } from './salesCandidate'
import { SALESPERSON_LABEL } from './quotationImages'

describe('salesCandidateLabel', () => {
  test('an assigned salesperson is shown by name', () => {
    assert.equal(salesCandidateLabel('Ashok Choudhary'), 'Ashok Choudhary')
  })

  test('an unresolved owner reads "Not assigned" — the row is never hidden', () => {
    assert.equal(salesCandidateLabel(null), 'Not assigned')
    assert.equal(salesCandidateLabel(undefined), 'Not assigned')
    assert.equal(salesCandidateLabel(''), 'Not assigned')
    assert.equal(salesCandidateLabel('   '), 'Not assigned')
  })

  test('the PDF path’s em dash is treated as absent, not printed as a name', () => {
    // The quotation route falls back to '—' when the users lookup returns
    // nothing; that value must never surface as somebody's name.
    assert.equal(salesCandidateLabel('—'), 'Not assigned')
    assert.equal(salesCandidateLabel('-'), 'Not assigned')
  })

  test('a padded name is trimmed, not rejected', () => {
    assert.equal(salesCandidateLabel('  Prerna  '), 'Prerna')
  })
})

describe('terminology', () => {
  test('internal screens say Sales Candidate', () => {
    assert.equal(SALES_CANDIDATE_LABEL, 'Sales Candidate')
  })

  test('the customer-facing quotation keeps saying Sales Consultant', () => {
    // Deliberately different wording for a deliberately different audience.
    // Unifying them would rename a field on a document customers keep.
    assert.equal(SALESPERSON_LABEL, 'Sales Consultant')
    assert.notEqual(SALES_CANDIDATE_LABEL, SALESPERSON_LABEL)
  })
})
