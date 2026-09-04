/**
 * Payroll Issues — a dedicated primary destination scoped to one payroll
 * period at a time, reusing the existing period-scoped ObjectionQueue rather
 * than a second implementation.
 *
 * Run:
 *   npx tsx --test src/app/payroll/issues/payrollIssuesPage.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const page = read('src/app/payroll/issues/page.tsx')

describe('Payroll Issues reuses the existing period-scoped queue', () => {
  test('imports and renders the real ObjectionQueue, not a second table', () => {
    assert.match(page, /import \{ ObjectionQueue \} from '@\/components\/objections\/ObjectionQueue'/)
    assert.match(page, /<ObjectionQueue/)
  })

  test('scoped by year/month — the same relationship the route resolves through payroll_result → payroll_period', () => {
    assert.match(page, /subject="payroll"/)
    assert.match(page, /period=\{\{ year: shown\.year, month: shown\.month \}\}/)
  })

  test('the empty state matches the established wording', () => {
    assert.match(page, /No payroll issues were reported for this period\./)
  })

  test('never infers a period from calendar time or from subject text', () => {
    assert.equal(/new Date\(\)\.getMonth|subject_snapshot/.test(page), false)
  })
})

describe('the shown month is decided by View, not by the two selectors live', () => {
  test('a separate `shown` state, only updated on the View click', () => {
    assert.match(page, /const \[shown, setShown\]/)
    assert.match(page, /onClick=\{\(\) => setShown\(\{ year, month \}\)\}/)
  })
})
