import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  formatOrderOperationalNumber,
  formatBoeItemCode,
  formatOrderProductCode,
  orderProductCodesByItemId,
} from './orderProductCodes'

describe('formatOrderOperationalNumber', () => {
  test('strips the leading zeros the stored number carries', () => {
    assert.equal(formatOrderOperationalNumber('0524'), '524')
    assert.equal(formatOrderOperationalNumber('0001'), '1')
    assert.equal(formatOrderOperationalNumber('0017'), '17')
  })

  test('a number with no leading zero is unchanged', () => {
    assert.equal(formatOrderOperationalNumber('9999'), '9999')
  })

  test('null and undefined are null, not a throw', () => {
    assert.equal(formatOrderOperationalNumber(null), null)
    assert.equal(formatOrderOperationalNumber(undefined), null)
  })

  test('a value with no non-zero digit reads as null, not empty string', () => {
    // Never actually reachable — orders_display_number_four_digit forbids
    // '0000' — but the function stays total rather than returning ''.
    assert.equal(formatOrderOperationalNumber('0000'), null)
  })
})

describe('formatBoeItemCode', () => {
  test('three digits, BE-prefixed', () => {
    assert.equal(formatBoeItemCode(1), 'BE001')
    assert.equal(formatBoeItemCode(23), 'BE023')
    assert.equal(formatBoeItemCode(456), 'BE456')
  })
})

describe('formatOrderProductCode', () => {
  test('the exact example from the business decision', () => {
    assert.equal(formatOrderProductCode('0524', 1), '524-BE001')
    assert.equal(formatOrderProductCode('0524', 2), '524-BE002')
  })

  test('never the padded form', () => {
    assert.notEqual(formatOrderProductCode('0524', 1), '0524-BE001')
  })

  test('null when there is no display number to build from', () => {
    assert.equal(formatOrderProductCode(null, 1), null)
  })
})

describe('orderProductCodesByItemId', () => {
  test('keys the composed code by the item id, in any order', () => {
    const map = orderProductCodesByItemId('0524', [
      { submission_item_id: 'item-2', boe_sequence: 2, source_product_code: 'B002', source_item_sequence: 'B002' },
      { submission_item_id: 'item-1', boe_sequence: 1, source_product_code: 'B001', source_item_sequence: 'B001' },
    ])
    assert.equal(map.get('item-1'), '524-BE001')
    assert.equal(map.get('item-2'), '524-BE002')
    assert.equal(map.size, 2)
  })

  test('an orphaned code (its item row is gone) is not a current item and is absent', () => {
    const map = orderProductCodesByItemId('0524', [
      { submission_item_id: null, boe_sequence: 2, source_product_code: 'B002', source_item_sequence: 'B002' },
      { submission_item_id: 'item-3', boe_sequence: 3, source_product_code: 'B003', source_item_sequence: 'B003' },
    ])
    assert.equal(map.has('item-3'), true)
    assert.equal(map.size, 1)
  })
})

// 2026-09-27: every Orders SCREEN shows the stored four-digit number (0526);
// product codes keep the operational form (526-BE001). The list and the Order
// header used to print '526' while the PI Draft and the dialogs said '0526'.
describe('Orders screens show 0526; product codes keep 526-BE001', () => {
  const read = (f: string) => readFileSync(f, 'utf8')
  test('the Confirmed Orders list and the Order header print display_number as stored', () => {
    const list = read('src/app/orders/all/page.tsx')
    const detail = read('src/app/orders/[id]/page.tsx')
    assert.equal(/formatOrderOperationalNumber/.test(list), false, 'the list does not strip the zero')
    assert.equal(/formatOrderOperationalNumber/.test(detail), false, 'the Order page does not strip the zero')
    assert.ok(list.includes('const number = o.display_number'))
    assert.ok(list.includes('{o.display_number}'))
    assert.ok(detail.includes('const shownOrderNumber = order.display_number'))
    assert.ok(detail.includes('Order {shownOrderNumber}</h1>'))
  })
  test('the Order documents export and Order notifications say 0526 too', () => {
    const docs = read('src/app/api/orders/[id]/documents/route.ts')
    const notify = read('src/app/api/orders/[id]/notify/route.ts')
    assert.ok(docs.includes("const orderNumber = String(order.display_number ?? '').trim()"))
    assert.ok(notify.includes('const orderNumber = order.display_number'))
    assert.equal(/formatOrderOperationalNumber/.test(docs + notify), false)
    // Issued exports are never rewritten: each generation writes new keys.
    assert.ok(docs.includes('upsert: false'))
  })
  test('the PI version PDF is left as it was: it re-renders on every open, so a change would alter PDFs already issued', () => {
    assert.ok(read('src/app/api/orders/[id]/pi-versions/[versionId]/pdf/route.ts').includes('formatOrderOperationalNumber(displayNumber)'))
  })
  test('product codes are unchanged', () => {
    assert.equal(formatOrderOperationalNumber('0526'), '526')
  })
})
