// Operations flags PI lines (20270616000000): the review window, the flag under a product row, the
// reviewer's button, the per-line answer boxes, and where the Order page wires them.
//
// Run with (a path with [id] is a glob on Windows):
//   npm run test:file -- "src/app/orders/**/orderLineReview.render.test.tsx"

import '@/lib/testing/cssModuleStub'
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { LineFlagBand, OrderLineReviewModal } from './OrderLineReview'
import { OperationsReviewActions } from './OrderStatusWorkspace'
import { RespondToOperationsModal } from './OrderRevisionModals'
import { readLineFlags, type LineMark } from '@/lib/orders/lineFlags'
import type { OperationsHandoffView } from '@/lib/orders/operationsHandoff'

const page = readFileSync(join(__dirname, 'page.tsx'), 'utf8').replace(/\r/g, '')
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
const noop = () => {}

const lines = [
  { itemId: 'i-1', code: '700-BE0001', name: 'Lounge Sofa', detail: '12 × ₹18,500' },
  { itemId: 'i-2', code: '700-BE0002', name: 'Dining Chair', detail: '8 × ₹4,500 · Acacia wood' },
]
const chair: LineMark = { kind: 'cannot_make', reasons: ['price_low'], note: 'Made in-house.', price: '7000' }

const modal = (initial?: Map<string, LineMark>) => renderToStaticMarkup(createElement(OrderLineReviewModal, {
  orderNumber: '0700', versionLabel: 'PI V1', lines, initial, saving: false, failure: null,
  onClose: noop, onAccept: noop, onOtherReason: noop, onConfirm: noop,
}))

const flag = (over: Record<string, unknown> = {}) => readLineFlags([{
  item_id: 'i-2', line_code: '700-BE0002', line_title: 'Dining Chair', kind: 'cannot_make', reasons: ['price_low', 'quantity_low'],
  note: 'No outside vendor will make 8 pieces.', suggested_price: 7000, flagged_at: '2026-11-12T04:11:00Z',
  by_name: 'Operations Reviewer', handoff_id: 'h-1', version_number: 1, handoff_status: 'clarification_needed', ...over,
}])[0]

describe('the review window', () => {
  test('lists every line with OK / Comment / Cannot make, all OK to start, and offers the ordinary acceptance', () => {
    const html = modal()
    const t = text(html)
    assert.match(t, /Review PI V1 lines/)
    assert.match(t, /700-BE0001/)
    assert.match(t, /700-BE0002/)
    assert.equal((html.match(/aria-pressed="true"/g) ?? []).length, 2, 'each line starts OK')
    assert.match(t, /Accept for production/)
    assert.match(t, /Cannot accept this PI for another reason/)
    assert.equal(/Note for Sales/.test(t), false, 'no note box while every line is OK')
  })

  test('a saved Cannot make reopens with its reasons, note and price, and the button sends it back to Sales', () => {
    const html = modal(new Map([['i-2', chair]]))
    const t = text(html)
    assert.match(t, /Note for Sales/)
    assert.match(html, /Made in-house\./)
    assert.match(html, /value="7000"/)
    assert.match(t, /Price should be/)
    assert.match(t, /Send back to Sales/)
    assert.match(t, /stays not aligned until Sales answers/)
    assert.match(t, /1 cannot be made/)
  })
})

describe('the flag under a product row', () => {
  test('says what Operations said: status, reasons, note, who, and the price', () => {
    const t = text(renderToStaticMarkup(createElement(LineFlagBand, { flag: flag() })))
    for (const s of ['Cannot make as quoted', 'Price too low', 'Quantity too low', 'No outside vendor will make 8 pieces.',
      'Operations · Operations Reviewer · PI V1', 'price should be ₹7,000 per piece']) {
      assert.ok(t.includes(s), s)
    }
  })

  test('a Cannot make Operations later accepted reads as settled', () => {
    assert.match(text(renderToStaticMarkup(createElement(LineFlagBand, { flag: flag({ handoff_status: 'accepted' }) }))),
      /Flagged, then accepted by Operations/)
  })
})

describe("the reviewer's button", () => {
  const view = { kind: 'recorded', status: 'awaiting', actions: { accept: true, cannotAccept: true, withdraw: false } } as unknown as OperationsHandoffView
  test('reads Flag lines… when the line review is available, and Cannot accept when it is not', () => {
    const withLines = text(renderToStaticMarkup(createElement(OperationsReviewActions, { view, busy: false, onAccept: noop, onCannotAccept: noop, onFlagLines: noop })))
    assert.match(withLines, /Flag lines…/)
    assert.equal(/Cannot accept/.test(withLines), false)
    const without = text(renderToStaticMarkup(createElement(OperationsReviewActions, { view, busy: false, onAccept: noop, onCannotAccept: noop })))
    assert.match(without, /Cannot accept/)
  })
})

describe('the answer to Operations', () => {
  test('one box per flagged line, labelled with its code and what was flagged', () => {
    const t = text(renderToStaticMarkup(createElement(RespondToOperationsModal, {
      orderNumber: '0700', versionLabel: 'PI V1', objection: '1 line cannot be made as quoted…', saving: false, failure: null,
      onClose: noop, onConfirm: noop,
      lines: [{ key: 'i-2', label: '700-BE0002 Dining Chair', flagged: 'Cannot make as quoted: Price too low. Made in-house.' }],
    })))
    assert.match(t, /700-BE0002 Dining Chair/)
    assert.match(t, /Cannot make as quoted: Price too low/)
    assert.match(t, /Anything else for Operations/)
  })

  test('without flagged lines it is the window it was', () => {
    const t = text(renderToStaticMarkup(createElement(RespondToOperationsModal, {
      orderNumber: '0700', versionLabel: 'PI V1', objection: 'Client wanted a visit', saving: false, failure: null, onClose: noop, onConfirm: noop,
    })))
    assert.match(t, /Operations said: “Client wanted a visit”/)
    assert.equal(/Anything else for Operations/.test(t), false)
  })
})

describe('the Order page', () => {
  test('reads the flags with its own hook (no new read on the startup path) and writes through flag_order_lines', () => {
    assert.match(page, /useOrderLineFlags\(order\?\.id \?\? null,/)
    assert.match(page, /supabase\.rpc\('flag_order_lines', \{ p_handoff_id: live\.id, p_lines: lines \}\)/)
  })

  test('offers the line review only when this database has it and the PI has lines', () => {
    assert.match(page, /onFlagLines=\{lineFlagsRead\?\.available && piProducts\.length > 0/)
  })

  test('draws the flags on the product rows and gives the answer window one box per flagged line', () => {
    assert.match(page, /lineFlags=\{new Map\(\(lineFlagsRead\?\.flags \?\? \[\]\)/)
    assert.match(page, /<RespondToOperationsModal[\s\S]*?lines=\{\(lineFlagsRead\?\.flags/)
  })
})
