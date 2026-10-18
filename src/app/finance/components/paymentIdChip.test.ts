import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

test('every payment table prints the Payment ID through the copyable chip', () => {
  for (const file of [
    'src/app/finance/paymentRequestsTable.tsx',
    'src/app/finance/received/receivedPaymentsTable.tsx',
    'src/app/finance/received/receivedPaymentsLists.tsx',
  ]) {
    assert.ok(read(file).includes('<PaymentIdChip>{r.human_payment_id}</PaymentIdChip>'), file)
  }
})

test('the copy button does not open the row it sits in', () => {
  const chip = read('src/app/finance/components/PaymentIdChip.tsx')
  assert.ok(chip.includes('e.stopPropagation()'))
  assert.ok(chip.includes('aria-label'))
})

test('the search box has one focus ring, on the box, not a second one on the input', () => {
  const css = read('src/app/globals.css')
  assert.ok(css.includes('.boe-list-search:focus-within'))
  assert.ok(/\.boe-list-search input:focus-visible \{ outline: none !important;/.test(css))
})

test('Payment Requests uses the shared list search, not an inline copy', () => {
  const page = read('src/app/finance/page.tsx')
  assert.ok(page.includes('className="boe-list-search"'))
  assert.ok(page.includes('Payment ID, client or order'))
})
