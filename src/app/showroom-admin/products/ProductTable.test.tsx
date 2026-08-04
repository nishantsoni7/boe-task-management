/**
 * Product Master results table — rendering contract.
 *
 * Removing the category tab strip must not have cost the list anything: every
 * row still offers Print QR, Edit, Delete and the status toggle, each wired to
 * the handler the page passes, and a product with no image still renders a row.
 *
 * The components are hook-free apart from the thumbnail's own error state, so
 * each control can be found in the element tree and invoked.
 *
 * Run:
 *   npx tsx --test src/app/showroom-admin/products/ProductTable.test.tsx
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ProductTable, ProductRow } from './ProductTable'
import type { ShowroomProduct } from '@/lib/types'

const product = (overrides: Partial<ShowroomProduct> = {}): ShowroomProduct => ({
  id: 'p1',
  product_code: 'BOE-DC-101',
  name: 'Dining Chair',
  category: 'Wooden Chairs',
  description: null,
  specifications: null,
  image_url: null,
  images: ['https://cdn.test/chair.jpg'],
  dimensions: null,
  mrp: 12500,
  is_active: true,
  created_at: '2026-01-01T00:00:00Z',
  ...overrides,
})

/**
 * Every element in a rendered tree. Presentational children (ProductRow,
 * IconButton) are plain functions, so they are called to reach the real
 * <button> inside; anything needing React internals throws and stays a leaf.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function elements(node: ReactNode): ReactElement<any>[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!isValidElement(node)) return []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const el = node as ReactElement<any>
  if (typeof el.type === 'function') {
    // A component holding state (the thumbnail) throws an invalid-hook-call and
    // logs it on the way out. That is the expected "stop here" signal, not a
    // failure, so its warning is kept out of the test output.
    const warn = console.error
    console.error = () => {}
    try {
      return [el, ...elements((el.type as (props: unknown) => ReactNode)(el.props))]
    } catch {
      return [el]
    } finally {
      console.error = warn
    }
  }
  return [el, ...elements(el.props?.children)]
}

const spies = () => {
  const calls: string[] = []
  return {
    calls,
    handlers: {
      onEdit:    (code: string) => calls.push(`edit:${code}`),
      onToggle:  (p: ShowroomProduct) => calls.push(`toggle:${p.product_code}`),
      onPrintQr: (p: ShowroomProduct) => calls.push(`qr:${p.product_code}`),
      onDelete:  (p: ShowroomProduct) => calls.push(`delete:${p.product_code}`),
    },
  }
}

const table = (products: ShowroomProduct[], handlers: ReturnType<typeof spies>['handlers']) =>
  ProductTable({ products, fetching: false, togglingId: null, ...handlers })

/** One row, called as a plain function, with its handlers bound as the table binds them. */
const row = (p: ShowroomProduct, handlers: ReturnType<typeof spies>['handlers'], toggling = false) =>
  ProductRow({
    product: p,
    toggling,
    onEdit:    () => handlers.onEdit(p.product_code),
    onToggle:  () => handlers.onToggle(p),
    onPrintQr: () => handlers.onPrintQr(p),
    onDelete:  () => handlers.onDelete(p),
  })

/** Buttons carrying a title/aria-label, keyed by that label. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const controls = (node: ReactNode): Record<string, ReactElement<any>> => {
  const out: Record<string, ReactElement<unknown>> = {}
  for (const el of elements(node)) {
    if (el.type !== 'button') continue
    const label = el.props.title ?? el.props['aria-label']
    if (label) out[label] = el
  }
  return out
}

describe('every row keeps the actions it had', () => {
  test('Print QR, Edit and Delete are all present', () => {
    const found = controls(row(product(), spies().handlers))
    assert.ok(found['Print QR label'], 'Print QR label control missing')
    assert.ok(found['Edit product'],   'Edit product control missing')
    assert.ok(found['Delete product'], 'Delete product control missing')
  })

  test('each control calls its own handler for its own product', () => {
    const s = spies()
    const found = controls(row(product(), s.handlers))
    found['Print QR label'].props.onClick()
    found['Edit product'].props.onClick()
    found['Delete product'].props.onClick()
    assert.deepEqual(s.calls, ['qr:BOE-DC-101', 'edit:BOE-DC-101', 'delete:BOE-DC-101'])
  })

  test('the status pill still toggles active/inactive', () => {
    const s = spies()
    const toggle = elements(row(product(), s.handlers))
      .find(el => el.type === 'button' && el.props.children === 'Active')
    assert.ok(toggle, 'status toggle missing')
    toggle.props.onClick()
    assert.deepEqual(s.calls, ['toggle:BOE-DC-101'])
  })

  test('an inactive product shows the opposite label', () => {
    const markup = renderToStaticMarkup(table([product({ is_active: false })], spies().handlers))
    assert.match(markup, />Inactive</)
  })

  test('a row mid-toggle disables the pill instead of double-firing', () => {
    const toggle = elements(row(product(), spies().handlers, true))
      .find(el => el.type === 'button' && el.props.disabled === true)
    assert.ok(toggle, 'the status pill should be disabled while toggling')
  })

  test('the table renders one row per product, each with its own actions', () => {
    const markup = renderToStaticMarkup(table([
      product(),
      product({ id: 'p2', product_code: 'BOE-BC-207', name: 'Bar Chair', category: 'Bar Chairs' }),
    ], spies().handlers))
    assert.match(markup, /BOE-DC-101/)
    assert.match(markup, /BOE-BC-207/)
    assert.equal([...markup.matchAll(/aria-label="Edit product"/g)].length, 2)
    assert.equal([...markup.matchAll(/aria-label="Delete product"/g)].length, 2)
    assert.equal([...markup.matchAll(/aria-label="Print QR label"/g)].length, 2)
  })
})

describe('row content', () => {
  test('code, name, category and MRP are all shown', () => {
    const markup = renderToStaticMarkup(table([product()], spies().handlers))
    assert.match(markup, /BOE-DC-101/)
    assert.match(markup, /Dining Chair/)
    assert.match(markup, /Wooden Chairs/)
    assert.match(markup, /12,500/)
  })

  test('a product with no image still renders its row', () => {
    const imageless = product({ images: [], image_url: null })
    const markup = renderToStaticMarkup(table([imageless], spies().handlers))
    assert.match(markup, /BOE-DC-101/)
    assert.doesNotMatch(markup, /<img/)
  })

  test('the legacy single image_url is used when images[] is empty', () => {
    const legacy = product({ images: [], image_url: 'https://cdn.test/legacy.jpg' })
    assert.match(
      renderToStaticMarkup(table([legacy], spies().handlers)),
      /src="https:\/\/cdn\.test\/legacy\.jpg"/,
    )
  })

  test('an empty result set renders nothing rather than an empty shell', () => {
    assert.equal(table([], spies().handlers), null)
  })
})
