import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
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
