/**
 * MATCHING A REVISED WORKBOOK'S LINES (20270104000000) — the admin's step.
 *
 * Run:
 *   npx tsx --test src/components/orders/piLineReview.render.test.tsx
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { PI_LINE_REVIEW_NEW, PI_LINE_REVIEW_TITLE, PiLineReview, lineReviewFrom, type PiLineReviewData } from './PiLineReview'

const review: PiLineReviewData = {
  lines: [{ id: 'n1', seq: null, name: 'Table, oak', qty: 2, why: 'no item number' }],
  candidates: [
    { id: 'o1', seq: 'B001', name: 'Armchair', code: 'BE001' },
    { id: 'o3', seq: 'B003', name: 'Table', code: 'BE003' },
  ],
}

describe('the approve response that asks for matching', () => {
  test('is recognised only for its own refusal', () => {
    assert.deepEqual(lineReviewFrom({ error: 'ORDER_PI_REVISION_LINES_NEED_REVIEW', review }), review)
    assert.equal(lineReviewFrom({ error: 'ORDER_PI_REVISION_STALE', review }), null)
    assert.equal(lineReviewFrom({ error: 'ORDER_PI_REVISION_LINES_NEED_REVIEW', review: { lines: 'x' } }), null)
  })
})

describe('the matching step', () => {
  const html = renderToStaticMarkup(
    <PiLineReview versionNumber={3} review={review} busy={false} onConfirm={() => {}} onCancel={() => {}} />,
  )
  test('names each unmatched line and why', () => {
    assert.ok(html.includes(PI_LINE_REVIEW_TITLE))
    assert.ok(html.includes('Table, oak') && html.includes('no item number'))
  })
  test('offers every product in force, by code, and "new product"', () => {
    assert.ok(html.includes('Continues BE001 · B001 · Armchair'))
    assert.ok(html.includes('Continues BE003 · B003 · Table'))
    assert.ok(html.includes(PI_LINE_REVIEW_NEW))
  })
  test('cannot be confirmed until every line is matched', () => {
    assert.match(html, /<button[^>]*disabled=""[^>]*>Approve with this matching<\/button>/)
  })
})
