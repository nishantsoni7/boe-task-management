/**
 * Previous/Next control — what it offers at each position in a run.
 *
 * The rules that must hold on screen, not just in `resolveProductNeighbors`:
 *   * both codes are shown, so the user knows where a step goes before taking it,
 *   * a boundary offers no control at all rather than a dead one, and
 *   * a product with nowhere to step renders nothing.
 *
 * Hook-free, so it can be called as a plain function and its buttons invoked.
 *
 * Run:
 *   npx tsx --test src/app/showroom-admin/products/ProductStepper.test.tsx
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { ProductStepper } from './ProductStepper'
import type { ProductNeighbors } from '@/lib/showroom/productNav'

const neighbors = (o: Partial<ProductNeighbors> = {}): ProductNeighbors => ({
  previous: 'BOE-SR-001',
  next:     'BOE-SR-003',
  position: 2,
  total:    4,
  ...o,
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function elements(node: ReactNode): ReactElement<any>[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!isValidElement(node)) return []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const el = node as ReactElement<any>
  if (typeof el.type === 'function') {
    return [el, ...elements((el.type as (props: unknown) => ReactNode)(el.props))]
  }
  return [el, ...elements(el.props?.children)]
}

/** Step buttons keyed by their accessible name. */
const buttons = (node: ReactNode) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out: Record<string, ReactElement<any>> = {}
  for (const el of elements(node)) {
    if (el.type !== 'button') continue
    const label = el.props['aria-label']
    if (label) out[label] = el
  }
  return out
}

const render = (n: ProductNeighbors, onNavigate: (code: string) => void = () => {}) =>
  ProductStepper({ neighbors: n, onNavigate })

describe('a product in the middle of a run', () => {
  test('both codes are shown, not just arrows', () => {
    const markup = renderToStaticMarkup(render(neighbors()))
    assert.match(markup, /BOE-SR-001/)
    assert.match(markup, /BOE-SR-003/)
  })

  test('each control opens its own product', () => {
    const opened: string[] = []
    const found = buttons(render(neighbors(), code => opened.push(code)))
    found['Previous product: BOE-SR-001'].props.onClick()
    found['Next product: BOE-SR-003'].props.onClick()
    assert.deepEqual(opened, ['BOE-SR-001', 'BOE-SR-003'])
  })

  test('the position in the run is shown', () => {
    assert.match(renderToStaticMarkup(render(neighbors())), /2 of 4/)
  })
})

describe('the boundaries offer no invalid action', () => {
  test('the first product has no Previous control at all', () => {
    const first = neighbors({ previous: null, position: 1 })
    const found = buttons(render(first))
    assert.equal(Object.keys(found).length, 1)
    assert.ok(found['Next product: BOE-SR-003'])
    // Not merely disabled — absent.
    assert.doesNotMatch(renderToStaticMarkup(render(first)), /Previous product/)
  })

  test('the last product has no Next control at all', () => {
    const last = neighbors({ next: null, position: 4 })
    const found = buttons(render(last))
    assert.equal(Object.keys(found).length, 1)
    assert.ok(found['Previous product: BOE-SR-001'])
    assert.doesNotMatch(renderToStaticMarkup(render(last)), /Next product/)
  })

  test('no control can be clicked into a null destination', () => {
    for (const n of [
      neighbors({ previous: null, position: 1 }),
      neighbors({ next: null, position: 4 }),
    ]) {
      const opened: string[] = []
      for (const button of Object.values(buttons(render(n, c => opened.push(c))))) {
        button.props.onClick()
      }
      assert.ok(opened.every(code => typeof code === 'string' && code.length > 0))
    }
  })
})

describe('nothing to step through', () => {
  test('a product alone in its run renders nothing rather than an empty frame', () => {
    assert.equal(render({ previous: null, next: null, position: 1, total: 1 }), null)
  })

  test('a product outside its run renders nothing', () => {
    // The truncated-run case — no guess is offered.
    assert.equal(render({ previous: null, next: null, position: null, total: 0 }), null)
  })
})
