// What the Factory Status cell draws (owner, 2026-11-03): the status, then how much has left.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { FactoryCell } from './FactoryCell'
import { factoryView } from '@/lib/orders/orderListValue'

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
const draw = (status: string, alignment: string | null, progress?: { ordered: number; dispatched: number; lastDispatchedOn: string | null }) =>
  renderToStaticMarkup(<FactoryCell view={factoryView({ status, production_alignment: alignment }, progress)} />)

describe('the Factory Status cell', () => {
  test('Aligned is a dot and a word; Not Aligned and On hold are amber pills; Ready for dispatch is a green pill', () => {
    assert.ok(draw('running', 'aligned').includes('orders-status-ok'))
    assert.equal(draw('running', 'aligned').includes('fin-pill'), false)
    assert.ok(draw('running', 'not_aligned').includes('fin-pill--zero'))
    assert.ok(draw('on_hold', 'aligned').includes('fin-pill--zero'))
    assert.ok(draw('ready_for_dispatch', 'aligned').includes('fin-pill--full'))
    assert.equal(text(draw('ready_for_dispatch', 'aligned')), 'Ready for dispatch')
  })

  test('Dispatched is a grey dot and a quiet word', () => {
    const html = draw('dispatched', 'aligned')
    assert.ok(html.includes('orders-status-done'))
    assert.equal(html.includes('fin-pill'), false)
  })

  test('part dispatched is a plain line under the status, never a second pill', () => {
    const html = draw('running', 'aligned', { ordered: 74, dispatched: 22, lastDispatchedOn: '2026-10-28' })
    assert.equal(text(html), 'Aligned Part dispatched · 22 of 74 pcs')
    assert.ok(html.includes('class="orders-dispatch"'))
    assert.equal(html.includes('fin-pill'), false)
    assert.equal(html.includes('orders-dispatch--done'), false)
  })

  test('a Dispatched Order\'s line is the quiet one', () => {
    const html = draw('dispatched', 'aligned', { ordered: 74, dispatched: 74, lastDispatchedOn: '2026-10-28' })
    assert.equal(text(html), 'Dispatched 74 pcs · last 28 Oct')
    assert.ok(html.includes('orders-dispatch--done'))
  })

  test('nothing sent: just the status', () => {
    assert.equal(text(draw('running', 'not_aligned')), 'Not Aligned')
    assert.equal(draw('running', 'not_aligned').includes('orders-dispatch'), false)
  })
})
