/**
 * Sales: what the Website Leads sheet script may send to /api/sales/capture/website. Made-up data only.
 *
 * Run:
 *   npm run test:file -- src/lib/salesLeads/capture.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { captureRows, MAX_ROWS } from './capture'

test('a body without rows is refused, and so is one with too many', () => {
  assert.deepEqual(captureRows(null), { error: 'Send { rows: [...] }.' })
  assert.deepEqual(captureRows({ rows: 'x' }), { error: 'Send { rows: [...] }.' })
  assert.match((captureRows({ rows: Array.from({ length: MAX_ROWS + 1 }, () => ({ phone: '9' })) }) as { error: string }).error, /up to 100/)
})

test('rows without a number are dropped; fields are trimmed and cut to what the database takes', () => {
  const r = captureRows({ rows: [
    { key: 'k1', phone: ' 98765 43210 ', name: '  Asha  ', message: 'x'.repeat(5000), email: 'a@b.test', location: '', form_type: 'Google Ads' },
    { phone: '' }, 'junk', { phone: 9876543211 },
  ] })
  assert.ok('rows' in r)
  if (!('rows' in r)) return
  assert.equal(r.rows.length, 2)
  assert.deepEqual({ ...r.rows[0], message: r.rows[0].message?.length }, {
    key: 'k1', phone: '98765 43210', name: 'Asha', message: 4000, email: 'a@b.test', location: null, form_type: 'Google Ads',
  })
  assert.equal(r.rows[1].phone, '9876543211')
})
