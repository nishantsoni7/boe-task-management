import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { roundPrice, suggestPrice, type PricePoint } from './suggest'

const NOW = new Date('2026-11-12T06:00:00Z')
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString()
const pt = (k: PricePoint['k'], p: number, d: number): PricePoint => ({ k, p, at: daysAgo(d), q: 10 })

describe('the suggested price', () => {
  test('three close approved PIs: high confidence, newest counts most, rounded to ₹100', () => {
    const s = suggestPrice([pt('order', 56000, 200), pt('order', 58000, 100), pt('order', 60000, 10)], NOW)!
    // (60000×3 + 58000×2 + 56000×1) / 6 = 58,666.7 → 58,700
    assert.deepEqual([s.price, s.low, s.high, s.confidence, s.used], [58700, 56000, 60000, 'high', 3])
    assert.match(s.basis, /3 approved PIs/)
  })

  test('orders far apart are only medium; one order is medium; won quotations add evidence', () => {
    assert.equal(suggestPrice([pt('order', 40000, 30), pt('order', 60000, 20), pt('order', 50000, 10)], NOW)!.confidence, 'medium')
    const one = suggestPrice([pt('order', 50000, 10), pt('won', 56000, 5)], NOW)!
    assert.equal(one.confidence, 'medium')
    assert.equal(one.price, 52000) // (50000×2 + 56000) / 3
    assert.match(one.basis, /1 approved PI and 1 won quotation/)
  })

  test('orders older than 18 months are history: they fall back to plain earlier prices, low confidence', () => {
    const s = suggestPrice([pt('order', 30000, 700), pt('order', 32000, 650)], NOW)!
    assert.deepEqual([s.price, s.confidence], [31000, 'low'])
    assert.match(s.basis, /none recently ordered or won/)
  })

  test('won quotations without orders; open quotes alone are low', () => {
    assert.deepEqual([suggestPrice([pt('won', 9000, 20), pt('won', 9400, 10)], NOW)!.price, suggestPrice([pt('won', 9000, 20), pt('won', 9400, 10)], NOW)!.confidence], [9270, 'medium'])
    assert.equal(suggestPrice([pt('quote', 1234, 5)], NOW)!.confidence, 'low')
    assert.equal(suggestPrice([], NOW), null)
    assert.equal(suggestPrice([pt('lost', 5000, 5)], NOW), null)
  })

  test('lost twice at or below the price lowers the confidence and says why', () => {
    const s = suggestPrice([pt('order', 50000, 30), pt('order', 51000, 20), pt('order', 50500, 10), pt('lost', 48000, 5), pt('lost', 50000, 3)], NOW)!
    assert.equal(s.confidence, 'medium')
    assert.match(s.basis, /lost 2 times at or below/)
  })

  test('rounding reads like a price list', () => {
    assert.deepEqual([roundPrice(9234), roundPrice(58666.7), roundPrice(105049)], [9230, 58700, 105000])
  })
})
