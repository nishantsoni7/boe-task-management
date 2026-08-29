/**
 * The framing constants, and the one rule about them: pixels are decided here,
 * never by the caller.
 *
 * Run:
 *   npx tsx --test src/lib/imageEditor/studioMaster.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  MASTER_WIDTH, MASTER_HEIGHT, PRODUCT_HEIGHT_SHARE, PRODUCT_HEIGHT_MIN,
  PRODUCT_HEIGHT_MAX, SIDE_MARGIN_SHARE, ABOVE_SHARE_OF_LEFTOVER,
} from './studioMaster'

describe('the master', () => {
  test('it is 1440 x 1440', () => {
    assert.equal(MASTER_WIDTH, 1440)
    assert.equal(MASTER_HEIGHT, 1440)
  })

  test('the approved targets fall out of the shares exactly', () => {
    assert.equal(Math.round(MASTER_HEIGHT * PRODUCT_HEIGHT_SHARE), 763)
    assert.equal(Math.round(MASTER_WIDTH * (1 - 2 * SIDE_MARGIN_SHARE)), 1267)
    assert.equal(Math.round(MASTER_WIDTH / 2), 720)
  })

  test('53% is the target and 52-55% is the band it is judged against', () => {
    assert.equal(PRODUCT_HEIGHT_SHARE, 0.53)
    assert.equal(PRODUCT_HEIGHT_MIN, 0.52)
    assert.equal(PRODUCT_HEIGHT_MAX, 0.55)
    assert.ok(PRODUCT_HEIGHT_SHARE > PRODUCT_HEIGHT_MIN && PRODUCT_HEIGHT_SHARE < PRODUCT_HEIGHT_MAX)
  })

  test('the leftover splits 60:40 above and below', () => {
    assert.equal(ABOVE_SHARE_OF_LEFTOVER, 0.6)
    const leftover = MASTER_HEIGHT - Math.round(MASTER_HEIGHT * PRODUCT_HEIGHT_SHARE)
    assert.equal(Math.round(leftover * ABOVE_SHARE_OF_LEFTOVER), 406)
    assert.equal(leftover - Math.round(leftover * ABOVE_SHARE_OF_LEFTOVER), 271)
  })

  test('the shares account for the whole canvas', () => {
    const above = (1 - PRODUCT_HEIGHT_SHARE) * ABOVE_SHARE_OF_LEFTOVER
    const below = (1 - PRODUCT_HEIGHT_SHARE) * (1 - ABOVE_SHARE_OF_LEFTOVER)
    assert.ok(Math.abs(PRODUCT_HEIGHT_SHARE + above + below - 1) < 1e-9)
  })
})
