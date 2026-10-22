/**
 * Inventory logic that needs no database: lead-time wording, stock state, filters and totals, the WhatsApp
 * message, the picture sizing, and the error classes. Behaviour of the database functions is proven by
 * supabase/tests/inventory_module_suite.sql.
 *
 * Run: npx tsx --test src/lib/inventory/inventory.test.ts
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { InventoryItem } from './constants'
import { daysBetween, formatPhone, formatPrice, readyShort, readyState, readyText, stockState, thumbPath } from './format'
import { DEFAULT_FILTERS, activeFilterCount, categoriesOf, filterItems, sortItems, totalsOf } from './filters'
import { buildShareMessage, waDigits, waLink } from './whatsapp'
import { fitWithin } from './images'
import { classifyInventoryError } from './errors'

const item = (over: Partial<InventoryItem> = {}): InventoryItem => ({
  id: '1', product_code: 'CH-001', name: 'Teak dining chair', category: 'Chairs', size_text: '45 × 50 × 90 cm', material: 'Teak',
  description: null, price: 4500, retail_price: 5200, condition: 'new', stage: 'ready', expected_ready_on: null,
  qty_total: 10, qty_reserved: 0, qty_sold: 0, qty_available: 10, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z',
  inventory_images: [{ path: 'b', position: 1 }, { path: 'a', position: 0 }], ...over,
})
const TODAY = '2026-10-13'

describe('lead time', () => {
  it('counts whole days between dates', () => {
    assert.equal(daysBetween('2026-10-13', '2026-10-25'), 12)
    assert.equal(daysBetween('2026-10-13', '2026-10-13'), 0)
    assert.equal(daysBetween('2026-10-13', '2026-10-10'), -3)
    assert.equal(daysBetween('2026-12-30', '2027-01-02'), 3) // across a year end
  })
  it('says what a salesperson can tell a customer', () => {
    assert.equal(readyText(item({ stage: 'ready' }), TODAY), 'Ready to ship')
    assert.equal(readyText(item({ stage: 'finishing', expected_ready_on: '2026-10-25' }), TODAY), 'Ready in about 12 days')
    assert.equal(readyText(item({ stage: 'finishing', expected_ready_on: '2026-10-14' }), TODAY), 'Ready by tomorrow')
    assert.equal(readyText(item({ stage: 'finishing', expected_ready_on: '2026-10-13' }), TODAY), 'Ready today')
    assert.equal(readyText(item({ stage: 'raw', expected_ready_on: null }), TODAY), 'Ready date not set yet')
    assert.match(readyText(item({ stage: 'raw', expected_ready_on: '2026-10-10' }), TODAY), /Was due 3 days ago/)
    assert.match(readyText(item({ stage: 'raw', expected_ready_on: '2026-10-12' }), TODAY), /Was due 1 day ago/)
  })
  it('a ready piece is ready whatever its date says', () => {
    assert.deepEqual(readyState(item({ stage: 'ready', expected_ready_on: '2030-01-01' }), TODAY), { kind: 'ready' })
  })
  it('short form for a card', () => {
    assert.equal(readyShort(item({ stage: 'finishing', expected_ready_on: '2026-10-25' }), TODAY), 'Ready in ~12 days')
    assert.equal(readyShort(item({ stage: 'finishing', expected_ready_on: '2026-10-10' }), TODAY), '3 days overdue')
    assert.equal(readyShort(item({ stage: 'ready' }), TODAY), 'Ready now')
  })
})

describe('stock state', () => {
  it('sold out, low and in stock', () => {
    assert.equal(stockState({ qty_available: 0, qty_total: 10 }), 'out')
    assert.equal(stockState({ qty_available: 2, qty_total: 20 }), 'low')
    assert.equal(stockState({ qty_available: 2, qty_total: 4 }), 'in_stock') // half is still free
    assert.equal(stockState({ qty_available: 8, qty_total: 10 }), 'in_stock')
    assert.equal(stockState({ qty_available: 1, qty_total: 1 }), 'in_stock') // a single piece is not "low"
  })
})

describe('pictures', () => {
  it('the thumbnail is the first by position, not by array order', () => {
    assert.equal(thumbPath(item()), 'a')
    assert.equal(thumbPath(item({ inventory_images: [] })), null)
  })
  it('fits within the longest side and never enlarges', () => {
    assert.deepEqual(fitWithin(4000, 3000), { width: 1600, height: 1200 })
    assert.deepEqual(fitWithin(3000, 4000), { width: 1200, height: 1600 })
    assert.deepEqual(fitWithin(800, 600), { width: 800, height: 600 })
    assert.deepEqual(fitWithin(10000, 1), { width: 1600, height: 1 })
  })
})

describe('filters, sort and totals', () => {
  const items = [
    item({ id: 'a', product_code: 'CH-010', name: 'Oak chair', material: 'Oak', stage: 'finishing', condition: 'new', price: 3000, retail_price: 3500, qty_available: 5, updated_at: '2026-10-02T00:00:00Z' }),
    item({ id: 'b', product_code: 'SF-002', name: 'Velvet sofa', category: 'Sofas', material: 'Velvet', stage: 'awaiting_upholstery', condition: 'refurbished', price: 24000, retail_price: 26000, qty_total: 2, qty_sold: 2, qty_available: 0, updated_at: '2026-10-05T00:00:00Z' }),
    item({ id: 'c', product_code: 'TB-001', name: 'Antique table', category: null, stage: 'under_repair', condition: 'antique', price: 9000, retail_price: 10000, qty_total: 1, qty_available: 1, updated_at: '2026-10-03T00:00:00Z' }),
  ]
  it('search matches every word across code, name, material and stage', () => {
    assert.deepEqual(filterItems(items, { ...DEFAULT_FILTERS, q: 'oak chair' }).map(i => i.id), ['a'])
    assert.deepEqual(filterItems(items, { ...DEFAULT_FILTERS, q: 'sf-002' }).map(i => i.id), ['b'])
    assert.deepEqual(filterItems(items, { ...DEFAULT_FILTERS, q: 'upholstery' }).map(i => i.id), ['b'])
    assert.deepEqual(filterItems(items, { ...DEFAULT_FILTERS, q: 'antique' }).map(i => i.id), ['c'])
    assert.deepEqual(filterItems(items, { ...DEFAULT_FILTERS, q: 'oak table' }).map(i => i.id), [])
  })
  it('stage, condition, availability and category narrow the list', () => {
    assert.deepEqual(filterItems(items, { ...DEFAULT_FILTERS, stages: ['under_repair'] }).map(i => i.id), ['c'])
    assert.deepEqual(filterItems(items, { ...DEFAULT_FILTERS, conditions: ['new', 'antique'] }).map(i => i.id), ['a', 'c'])
    assert.deepEqual(filterItems(items, { ...DEFAULT_FILTERS, stock: 'sold_out' }).map(i => i.id), ['b'])
    assert.deepEqual(filterItems(items, { ...DEFAULT_FILTERS, stock: 'available' }).map(i => i.id), ['a', 'c'])
    assert.deepEqual(filterItems(items, { ...DEFAULT_FILTERS, category: 'Sofas' }).map(i => i.id), ['b'])
  })
  it('sorts', () => {
    assert.deepEqual(sortItems(items, 'price_low').map(i => i.id), ['a', 'c', 'b'])
    assert.deepEqual(sortItems(items, 'price_high').map(i => i.id), ['b', 'c', 'a'])
    assert.deepEqual(sortItems(items, 'recent').map(i => i.id), ['b', 'c', 'a'])
    assert.deepEqual(sortItems(items, 'code').map(i => i.id), ['a', 'b', 'c'])
    assert.deepEqual(sortItems(items, 'available').map(i => i.id), ['a', 'c', 'b'])
  })
  it('does not mutate its input', () => {
    const before = items.map(i => i.id).join()
    sortItems(items, 'price_high')
    assert.equal(items.map(i => i.id).join(), before)
  })
  it('totals add up and value is only what is still available', () => {
    const t = totalsOf(items)
    assert.equal(t.products, 3)
    assert.equal(t.units, 13)
    assert.equal(t.available, 6)
    assert.equal(t.sold, 2)
    assert.equal(t.value, 5 * 3500 + 0 + 10000)
  })
  it('categories are distinct and sorted; filter count ignores search and sort', () => {
    assert.deepEqual(categoriesOf(items), ['Chairs', 'Sofas'])
    assert.equal(activeFilterCount({ ...DEFAULT_FILTERS, q: 'x', sort: 'code' }), 0)
    assert.equal(activeFilterCount({ ...DEFAULT_FILTERS, stages: ['raw', 'finishing'], conditions: ['new'], stock: 'available', category: 'Sofas' }), 5)
  })
})

describe('WhatsApp', () => {
  const base = item({ stage: 'finishing', expected_ready_on: '2026-10-25', qty_available: 8, description: 'Walnut finish available.' })
  const msg = buildShareMessage(base, { imageUrls: ['https://x/1.jpg', 'https://x/2.jpg'], includePrice: true, today: TODAY })
  it('carries the facts a buyer asks about, with the pictures last', () => {
    const lines = msg.split('\n')
    assert.equal(lines[0], '*Teak dining chair*')
    for (const want of ['Code: CH-001', 'Size: 45 × 50 × 90 cm', 'Material: Teak', 'Condition: New', 'Status: Ready in about 12 days', 'Price: ₹5,200 each', 'Available: 8', 'Walnut finish available.']) {
      assert.ok(lines.includes(want), `missing ${want}`)
    }
    assert.deepEqual(lines.slice(-3), ['Photos:', 'https://x/1.jpg', 'https://x/2.jpg'])
  })
  it('leaves the price out when asked', () => {
    const m = buildShareMessage(base, { imageUrls: [], includePrice: false, today: TODAY })
    assert.ok(!m.includes('Price') && !m.includes('₹'))
    assert.ok(!m.includes('Photo'))
  })
  it('says sold out instead of a count of zero', () => {
    assert.match(buildShareMessage(item({ qty_available: 0 }), { imageUrls: [], includePrice: true }), /Currently sold out/)
  })
  it('a single piece is not "each"', () => {
    assert.match(buildShareMessage(item({ qty_total: 1, qty_available: 1 }), { imageUrls: [], includePrice: true }), /Price: ₹5,200$/m)
  })
  it('wa.me links: digits only, text encoded', () => {
    assert.equal(waDigits('98765 43210'), '919876543210')
    assert.equal(waDigits('+91 98765 43210'), '919876543210')
    assert.equal(waDigits('09876543210'), '919876543210')
    assert.equal(waDigits('+44 7911 123456'), '447911123456')
    assert.equal(waDigits('12345'), null)
    assert.equal(waDigits(''), null)
    assert.equal(waLink('Hi there\nA&B', '98765 43210'), 'https://wa.me/919876543210?text=Hi%20there%0AA%26B')
    assert.equal(waLink('x', null), 'https://wa.me/?text=x')
  })
})

describe('price', () => {
  it('keeps two digits for paise and none for whole rupees', () => {
    assert.equal(formatPrice(4500), '₹4,500')
    assert.equal(formatPrice(18750.5), '₹18,750.50')
    assert.equal(formatPrice(1234567), '₹12,34,567')
    assert.equal(formatPrice(0.05), '₹0.05')
  })
})

describe('phone display', () => {
  it('groups an Indian number and leaves others alone', () => {
    assert.equal(formatPhone('+919876543210'), '+91 98765 43210')
    assert.equal(formatPhone('+447911123456'), '+447911123456')
    assert.equal(formatPhone(null), '')
  })
})

describe('error classes', () => {
  it('turns the database sentence into a person-readable one', () => {
    assert.deepEqual(classifyInventoryError({ message: 'INVENTORY_INSUFFICIENT: Only 4 available right now' }), { kind: 'insufficient', message: 'Only 4 available right now' })
    assert.equal(classifyInventoryError({ message: 'INVENTORY_DUPLICATE_CODE: CH-001 is already used by another product' }).kind, 'duplicate_code')
    assert.equal(classifyInventoryError({ message: 'x', code: '42501' }).kind, 'forbidden')
    assert.equal(classifyInventoryError({ message: 'Failed to fetch' }).kind, 'uncertain')
    assert.equal(classifyInventoryError({ message: 'JWT expired' }).kind, 'auth')
    assert.equal(classifyInventoryError({ message: 'boom' }).kind, 'unknown')
    assert.equal(classifyInventoryError(null).kind, 'unknown')
  })
})
