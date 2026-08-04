/**
 * Product lookup results — rendering contract.
 *
 * What a result row must carry: the code, the name AND the category. The
 * category is not decoration — two products can share a name, and it is the
 * only thing that tells the user which one they are about to open.
 *
 * ProductLookupResults is hook-free so it can be called as a plain function;
 * the container that owns the input, the debounce and the query is not
 * exercised here (that is what the pure rules in productLookup.test.ts cover).
 *
 * Run:
 *   npx tsx --test src/components/layout/ProductLookup.test.tsx
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ProductLookupResults, type ProductLookupResultsProps } from './ProductLookup'
import type { ProductLookupResult } from '@/lib/showroom/productLookup'

const visibleText = (html: string) =>
  html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function elements(node: ReactNode): ReactElement<any>[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!isValidElement(node)) return []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const el = node as ReactElement<any>
  return [el, ...elements(el.props?.children)]
}

const RESULTS: ProductLookupResult[] = [
  { id: '1', product_code: 'BOE-1042', name: 'Oak Bench',  category: 'Benches' },
  { id: '2', product_code: 'BOE-2200', name: 'Oak Bench',  category: 'Dining Tables' },
  { id: '3', product_code: 'BOE-3100', name: 'Teak Stool', category: null },
]

const props = (over: Partial<ProductLookupResultsProps> = {}): ProductLookupResultsProps => ({
  results: RESULTS, loading: false, failed: false, highlight: -1,
  onPick: () => {}, onHighlight: () => {}, ...over,
})

const render = (over: Partial<ProductLookupResultsProps> = {}) =>
  renderToStaticMarkup(<ProductLookupResults {...props(over)} />)

describe('lookup results', () => {
  test('every row shows code, name and category', () => {
    const text = visibleText(render())
    for (const fragment of ['BOE-1042', 'Oak Bench', 'Benches', 'BOE-2200', 'Dining Tables']) {
      assert.match(text, new RegExp(fragment.replace('-', '\\-')), fragment)
    }
  })

  test('duplicate names stay tellable apart by code and category', () => {
    // Both rows are "Oak Bench"; the code and category are what distinguish them.
    const html = render({ results: RESULTS.slice(0, 2) })
    const text = visibleText(html)
    assert.equal((text.match(/Oak Bench/g) ?? []).length, 2)
    assert.match(text, /BOE-1042/)
    assert.match(text, /BOE-2200/)
    assert.match(text, /Benches/)
    assert.match(text, /Dining Tables/)
  })

  test('a product with no category still says something', () => {
    assert.match(visibleText(render()), /Uncategorised/)
  })

  test('no pricing or private product data is rendered', () => {
    // The API returns four fields; this asserts the row cannot start showing
    // anything else without the test noticing.
    const html = render()
    for (const banned of ['mrp', '₹', 'cost', 'price', 'notes', 'is_active', 'created_at']) {
      assert.ok(!html.toLowerCase().includes(banned.toLowerCase()), banned)
    }
  })

  test('the list is a listbox of options, so a screen reader can walk it', () => {
    const html = render()
    assert.match(html, /role="listbox"/)
    assert.equal((html.match(/role="option"/g) ?? []).length, 3)
    assert.match(html, /aria-label="Product search results"/)
  })

  test('the highlighted row is the selected option, and only it', () => {
    const html = render({ highlight: 1 })
    assert.equal((html.match(/aria-selected="true"/g) ?? []).length, 1)
  })

  test('nothing found says so rather than rendering an empty box', () => {
    const html = render({ results: [] })
    assert.match(visibleText(html), /No matching product/)
    assert.ok(!html.includes('role="option"'))
  })

  test('a failed search is reported, not silently empty', () => {
    assert.match(visibleText(render({ results: [], failed: true })), /Couldn.t search products/)
  })

  test('the first load says it is searching', () => {
    assert.match(visibleText(render({ results: [], loading: true })), /Searching/)
  })

  test('results already on screen are kept while the next term loads', () => {
    // Re-querying must not blank the list under the user's cursor.
    assert.match(visibleText(render({ loading: true })), /BOE-1042/)
  })

  test('clicking a row hands back that exact result', () => {
    const picked: string[] = []
    const el = ProductLookupResults(props({ onPick: r => picked.push(r.product_code) }))
    const buttons = elements(el).filter(e => e.type === 'button')
    assert.equal(buttons.length, 3)
    buttons[1].props.onClick()
    assert.deepEqual(picked, ['BOE-2200'])
  })

  test('hovering a row moves the highlight to it', () => {
    const moved: number[] = []
    const el = ProductLookupResults(props({ onHighlight: i => moved.push(i) }))
    const buttons = elements(el).filter(e => e.type === 'button')
    buttons[2].props.onMouseEnter()
    assert.deepEqual(moved, [2])
  })
})
