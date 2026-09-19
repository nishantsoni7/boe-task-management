/**
 * Back to where you came from — the validated `returnTo` an Order or PI record
 * uses to send its reader back to the exact list view they left.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { RETURN_TO_PARAM, returnLabelFor, returnPathFrom, withReturnTo } from './recordReturn'
import { mergeSearchParams } from './urlMirror'

const ORDER = '/orders/4f1c2d3e-5a6b-4c7d-8e9f-0a1b2c3d4e5f'

describe('withReturnTo', () => {
  test('carries an in-app list view, filters and all', () => {
    const href = withReturnTo(ORDER, '/orders/all?status=running&q=hotel')
    const params = new URLSearchParams(href.split('?')[1])
    assert.equal(href.split('?')[0], ORDER)
    assert.equal(params.get(RETURN_TO_PARAM), '/orders/all?status=running&q=hotel')
    assert.equal(returnPathFrom(params), '/orders/all?status=running&q=hotel', 'and reads back intact')
  })

  test('keeps a query the href already had', () => {
    const href = withReturnTo('/finance/received?payment=abc', '/finance/received?status=zero')
    const params = new URLSearchParams(href.split('?')[1])
    assert.equal(params.get('payment'), 'abc')
    assert.equal(params.get(RETURN_TO_PARAM), '/finance/received?status=zero')
  })

  test('REFUSES anything that could leave the app — the record falls back to its own list', () => {
    for (const unsafe of [
      'https://evil.example/orders', '//evil.example', '/\\evil.example', 'javascript:alert(1)',
      'orders/all', '', null, undefined, '/orders/all\nx',
    ]) {
      assert.equal(withReturnTo(ORDER, unsafe as string), ORDER, String(unsafe))
    }
  })

  test('a hand-edited returnTo is validated again when it is read', () => {
    assert.equal(returnPathFrom(`?${RETURN_TO_PARAM}=${encodeURIComponent('https://evil.example')}`), null)
    assert.equal(returnPathFrom(`?${RETURN_TO_PARAM}=${encodeURIComponent('//evil.example')}`), null)
    assert.equal(returnPathFrom(''), null)
  })
})

describe('the Back control names where it goes', () => {
  test('each list by its sidebar name', () => {
    assert.equal(returnLabelFor('/orders/all?status=running'), 'Back to Confirmed Orders')
    assert.equal(returnLabelFor('/orders/drafts'), 'Back to PI Drafts')
    assert.equal(returnLabelFor('/orders'), 'Back to Orders')
    assert.equal(returnLabelFor('/finance'), 'Back to Payment Requests')
    assert.equal(returnLabelFor('/finance/received?status=zero&page=2'), 'Back to Confirmed Payments')
    assert.equal(returnLabelFor('/orders/notifications'), 'Back to Notifications')
  })

  test('a record by its kind, and anything else plainly', () => {
    assert.equal(returnLabelFor('/orders/drafts/abc'), 'Back to PI Draft')
    assert.equal(returnLabelFor(ORDER), 'Back to Order')
    assert.equal(returnLabelFor('/tasks/my'), 'Back')
  })
})

describe('mergeSearchParams (the URL mirror)', () => {
  test('sets and removes only the named keys, and keeps every other one', () => {
    const next = mergeSearchParams('payment=abc&view=all&q=old', { q: 'new', page: '2', view: null })
    const params = new URLSearchParams(next)
    assert.equal(params.get('payment'), 'abc', 'a deep link is left alone')
    assert.equal(params.get('q'), 'new')
    assert.equal(params.get('page'), '2')
    assert.equal(params.has('view'), false, 'null removes')
  })

  test('an empty value removes its key, so a default filter keeps the address clean', () => {
    assert.equal(mergeSearchParams('q=x', { q: '' }), '')
    assert.equal(mergeSearchParams('?q=x&tab=all', { q: null }), 'tab=all')
  })

  test('no change is no change — the mirror cannot loop', () => {
    assert.equal(mergeSearchParams('q=a&page=2', { q: 'a', page: '2' }), 'q=a&page=2')
  })
})
