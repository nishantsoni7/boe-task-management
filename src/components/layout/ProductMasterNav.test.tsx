/**
 * Product Master sidebar sub-navigation — rendering contract.
 *
 * What the sidebar is allowed to put in front of a user: the parent entry with
 * the catalog total, one child per stored category with its own count, an
 * active-state that follows the route, and — the point of the whole change —
 * no "All Products" entry anywhere.
 *
 * The component is hook-free on purpose, so each control can be found in the
 * element tree and invoked to check it is wired to the handler it claims.
 *
 * Run:
 *   npx tsx --test src/components/layout/ProductMasterNav.test.tsx
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ProductMasterNav, type ProductMasterNavProps } from './ProductMasterNav'
import type { ProductCategoryCount } from '@/lib/showroom/productNav'

// The five categories `showroom_categories` stores, with real counts.
const CATEGORIES: ProductCategoryCount[] = [
  { name: 'Bar Chairs',    count: 26 },
  { name: 'Dummy',         count: 16 },
  { name: 'Lounge Chairs', count: 10 },
  { name: 'Metal Chairs',  count: 73 },
  { name: 'Wooden Chairs', count: 74 },
]
const TOTAL = 199

const props = (overrides: Partial<ProductMasterNavProps> = {}): ProductMasterNavProps => ({
  categories: CATEGORIES,
  totalCount: TOTAL,
  activeCategory: '',
  active: false,
  expanded: true,
  onParentClick: () => {},
  onSelectCategory: () => {},
  ...overrides,
})

const html = (overrides?: Partial<ProductMasterNavProps>) =>
  renderToStaticMarkup(<ProductMasterNav {...props(overrides)} />)

/** Text a person actually reads — markup stripped, attributes gone with it. */
const visibleText = (markup: string) =>
  markup.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()

/** Every element in a rendered tree, so buttons can be inspected and invoked. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function elements(node: ReactNode): ReactElement<any>[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!isValidElement(node)) return []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const el = node as ReactElement<any>
  return [el, ...elements(el.props?.children)]
}

/** The rendered tree as elements — the component is a plain function call. */
const tree = (overrides?: Partial<ProductMasterNavProps>) =>
  elements(ProductMasterNav(props(overrides)))

const buttons = (overrides?: Partial<ProductMasterNavProps>) =>
  tree(overrides).filter(el => el.type === 'button')

/** The category entries only — the parent is always the first button. */
const categoryButtons = (overrides?: Partial<ProductMasterNavProps>) =>
  buttons(overrides).slice(1)

describe('no all-products entry', () => {
  test('"All Products" is not rendered, expanded or collapsed', () => {
    assert.doesNotMatch(html({ expanded: true }),  /All Products/i)
    assert.doesNotMatch(html({ expanded: false }), /All Products/i)
  })

  test('no substitute entry appears alongside the stored categories', () => {
    const labels = buttons()
      .map(el => visibleText(renderToStaticMarkup(el)))
    // One parent + exactly the five stored categories, nothing else.
    assert.equal(labels.length, CATEGORIES.length + 1)
    for (const forbidden of [/All Products/i, /^All\b/i, /Everything/i, /Show all/i]) {
      assert.equal(labels.some(l => forbidden.test(l)), false, `unexpected entry matching ${forbidden}`)
    }
  })
})

describe('counts', () => {
  test('the parent shows the catalog total', () => {
    assert.match(visibleText(html()), new RegExp(`Product Master\\s+${TOTAL}`))
  })

  test('the parent says the total is active-only, so the number is not ambiguous', () => {
    // The Categories page counts inactive products too; without this the two
    // screens look like they disagree.
    assert.match(visibleText(html()), new RegExp(`${TOTAL}\\s+active`))
    assert.match(buttons()[0].props.title, /^199 active products$/)
  })

  test('the children stay plain numbers — "active" is said once, not six times', () => {
    for (const el of categoryButtons()) {
      assert.doesNotMatch(visibleText(renderToStaticMarkup(el)), /active/i)
    }
  })

  test('every stored category renders with its own count', () => {
    const text = visibleText(html())
    for (const category of CATEGORIES) {
      assert.match(text, new RegExp(`${category.name}\\s+${category.count}`), category.name)
    }
  })

  test('a zero count is shown, not hidden', () => {
    const text = visibleText(html({ categories: [{ name: 'Dummy', count: 0 }], totalCount: 0 }))
    assert.match(text, /Dummy\s+0/)
  })

  test('every requested category label is present', () => {
    const text = visibleText(html())
    for (const name of ['Bar Chairs', 'Dummy', 'Lounge Chairs', 'Metal Chairs', 'Wooden Chairs']) {
      assert.match(text, new RegExp(name))
    }
  })
})

describe('selecting a category', () => {
  test('clicking a child reports the stored name verbatim', () => {
    const seen: string[] = []
    const child = categoryButtons({ onSelectCategory: name => seen.push(name) })
      .find(el => visibleText(renderToStaticMarkup(el)).startsWith('Lounge Chairs'))
    assert.ok(child, 'Lounge Chairs entry should render')
    child.props.onClick()
    // Not "lounge-chairs", not "Lounge Chair" — the value the products table holds.
    assert.deepEqual(seen, ['Lounge Chairs'])
  })

  test('clicking the parent goes to the parent handler, not to a category', () => {
    const seen: string[] = []
    let parentClicks = 0
    const parent = buttons({
      onParentClick: () => { parentClicks++ },
      onSelectCategory: name => seen.push(name),
    })[0]
    parent.props.onClick()
    assert.equal(parentClicks, 1)
    assert.deepEqual(seen, [])
  })
})

describe('active state follows the route', () => {
  test('the category matching the route is marked current', () => {
    const current = buttons({ active: true, activeCategory: 'Metal Chairs' })
      .filter(el => el.props['aria-current'] === 'page')
    assert.equal(current.length, 1)
    assert.match(visibleText(renderToStaticMarkup(current[0])), /^Metal Chairs/)
    assert.match(current[0].props.className, /\bactive\b/)
  })

  test('the other categories are not marked current', () => {
    const others = categoryButtons({ active: true, activeCategory: 'Metal Chairs' })
      .filter(el => el.props['aria-current'] !== 'page')
    assert.equal(others.length, CATEGORIES.length - 1)
    for (const el of others) assert.doesNotMatch(el.props.className ?? '', /\bactive\b/)
  })

  test('the parent stays highlighted while a category is selected', () => {
    // The module entry and the category inside it are both "where you are" —
    // collapsing the submenu must not make the sidebar look unvisited.
    const parent = buttons({ active: true, activeCategory: 'Metal Chairs' })[0]
    assert.match(parent.props.className, /\bactive\b/)
    // …but only the category is the current *page*.
    assert.equal(parent.props['aria-current'], undefined)
  })

  test('changing the route moves the highlight', () => {
    const activeLabel = (category: string) => {
      const el = buttons({ active: true, activeCategory: category })
        .find(b => b.props['aria-current'] === 'page')
      return el ? visibleText(renderToStaticMarkup(el)) : null
    }
    assert.match(activeLabel('Bar Chairs') ?? '', /^Bar Chairs/)
    assert.match(activeLabel('Wooden Chairs') ?? '', /^Wooden Chairs/)
  })

  test('on the module route with no category, the parent itself is current', () => {
    const parent = buttons({ active: true, activeCategory: '' })[0]
    assert.equal(parent.props['aria-current'], 'page')
  })

  test('outside the module nothing is current', () => {
    assert.equal(buttons({ active: false }).some(el => el.props['aria-current'] === 'page'), false)
  })
})

describe('expansion', () => {
  test('collapsed hides the categories but keeps the parent reachable', () => {
    const text = visibleText(html({ expanded: false }))
    assert.match(text, /Product Master/)
    assert.doesNotMatch(text, /Bar Chairs/)
  })

  test('the parent reports its expanded state to assistive tech', () => {
    assert.equal(buttons({ expanded: true })[0].props['aria-expanded'], true)
    assert.equal(buttons({ expanded: false })[0].props['aria-expanded'], false)
  })

  test('an empty category list renders the parent without an empty submenu box', () => {
    const markup = html({ categories: [], totalCount: 0 })
    assert.match(visibleText(markup), /Product Master/)
    assert.equal(buttons({ categories: [], totalCount: 0 }).length, 1)
  })
})
