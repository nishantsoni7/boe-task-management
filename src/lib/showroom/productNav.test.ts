/**
 * Product Master navigation — routing and back-navigation rules.
 *
 * These are the rules the sidebar, the list page and a product's edit page all
 * depend on and none of them can show on its own:
 *   * a category is a query param on one route, never a route of its own,
 *   * the value in the URL is the stored category name, verbatim,
 *   * opening a product carries the list's exact state along, and only the five
 *     params the list owns survive the round trip,
 *   * Back prefers real history and falls back to the *category* it came from,
 *     never to a generic products page, and
 *   * there is no all-products destination anywhere in here.
 *
 * Run:
 *   npx tsx --test src/lib/showroom/productNav.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  PRODUCT_LIST_PATH,
  activeProductCategory,
  isProductListRoute,
  isProductRoute,
  parseReturnMarker,
  productBackHref,
  productCategoryHref,
  productEditHref,
  productListHref,
  productSequenceSearch,
  resolveCategorySelection,
  resolveParentClick,
  resolveProductBack,
  resolveProductNeighbors,
  sanitizeListSearch,
} from './productNav'

// The five categories `showroom_categories` actually stores.
const STORED = ['Bar Chairs', 'Dummy', 'Lounge Chairs', 'Metal Chairs', 'Wooden Chairs']

describe('category destinations', () => {
  test('a category is a query param on the single list route', () => {
    assert.equal(productCategoryHref('Bar Chairs'), '/showroom-admin/products?category=Bar+Chairs')
  })

  test('every stored category round-trips through its own href unchanged', () => {
    for (const name of STORED) {
      const href = productCategoryHref(name)
      const [pathname, search] = href.split('?')
      assert.equal(pathname, PRODUCT_LIST_PATH, `${name} must not get its own route`)
      assert.equal(activeProductCategory(pathname, search), name)
    }
  })

  test('a name with a comma or an ampersand survives encoding', () => {
    const href = productCategoryHref('Chairs & Stools, Outdoor')
    const search = href.split('?')[1]
    assert.equal(activeProductCategory(PRODUCT_LIST_PATH, search), 'Chairs & Stools, Outdoor')
  })

  test('no category means the bare list route — there is no all-products param', () => {
    assert.equal(productCategoryHref(''), PRODUCT_LIST_PATH)
    assert.equal(productListHref(''), PRODUCT_LIST_PATH)
    assert.equal(productListHref(null), PRODUCT_LIST_PATH)
  })

  test('a leading ? in a search string is not doubled', () => {
    assert.equal(productListHref('?category=Dummy'), '/showroom-admin/products?category=Dummy')
  })
})

describe('route matching', () => {
  test('the list route is a product route; the edit page is too', () => {
    assert.equal(isProductListRoute(PRODUCT_LIST_PATH), true)
    assert.equal(isProductRoute(PRODUCT_LIST_PATH), true)
    assert.equal(isProductRoute('/showroom-admin/products/BOE-DC-101/edit'), true)
    assert.equal(isProductRoute('/showroom-admin/products/new'), true)
  })

  test('the edit page is not the list route', () => {
    assert.equal(isProductListRoute('/showroom-admin/products/BOE-DC-101/edit'), false)
  })

  test('a sibling module page is neither', () => {
    assert.equal(isProductRoute('/showroom-admin/categories'), false)
    assert.equal(isProductRoute('/showroom-admin'), false)
    // Not a prefix match on the raw string.
    assert.equal(isProductRoute('/showroom-admin/products-archive'), false)
  })
})

describe('active category follows the current route', () => {
  test('on the list it is the category param', () => {
    assert.equal(activeProductCategory(PRODUCT_LIST_PATH, 'category=Metal+Chairs&page=3'), 'Metal Chairs')
  })

  test('on the list with no category, nothing is highlighted', () => {
    assert.equal(activeProductCategory(PRODUCT_LIST_PATH, ''), '')
    assert.equal(activeProductCategory(PRODUCT_LIST_PATH, 'q=oak'), '')
  })

  test('on a product page it comes from the breadcrumb it was opened with', () => {
    const href = productEditHref('BOE-DC-101', 'category=Lounge Chairs&page=2')
    const [pathname, search] = href.split('?')
    assert.equal(activeProductCategory(pathname, search), 'Lounge Chairs')
  })

  test('a product opened without a breadcrumb highlights nothing', () => {
    assert.equal(activeProductCategory('/showroom-admin/products/BOE-DC-101/edit', ''), '')
  })

  test('an unrelated route highlights nothing', () => {
    assert.equal(activeProductCategory('/showroom-admin/categories', 'category=Dummy'), '')
  })
})

describe('opening a product preserves the list state', () => {
  test('search, category, status, sort and page all ride along', () => {
    const listSearch = 'q=oak&category=Wooden Chairs&status=all&sort=mrp_desc&page=4'
    const href = productEditHref('BOE-DC-101', listSearch)
    const from = new URLSearchParams(href.split('?')[1]).get('from')
    const restored = new URLSearchParams(from ?? '')

    assert.equal(restored.get('q'), 'oak')
    assert.equal(restored.get('category'), 'Wooden Chairs')
    assert.equal(restored.get('status'), 'all')
    assert.equal(restored.get('sort'), 'mrp_desc')
    assert.equal(restored.get('page'), '4')
  })

  test('a product code with a slash or a space is encoded into the path', () => {
    assert.equal(
      productEditHref('BOE DC/101', ''),
      '/showroom-admin/products/BOE%20DC%2F101/edit',
    )
  })

  test('a clean list produces a clean edit URL', () => {
    assert.equal(productEditHref('BOE-DC-101', ''), '/showroom-admin/products/BOE-DC-101/edit')
  })

  test('params the list does not own are dropped', () => {
    assert.equal(sanitizeListSearch('category=Dummy&redirect=https://evil.test&meta=0'), 'category=Dummy')
  })

  test('an empty or malformed breadcrumb sanitises to nothing', () => {
    assert.equal(sanitizeListSearch(null), '')
    assert.equal(sanitizeListSearch('%%%'), '')
    assert.equal(sanitizeListSearch('category='), '')
  })
})

describe('where Back to products lands', () => {
  test('the list view the product was opened from', () => {
    assert.equal(
      productBackHref({ from: 'q=teak&category=Metal Chairs&sort=name_asc&page=3', productCategory: 'Metal Chairs' }),
      '/showroom-admin/products?q=teak&category=Metal+Chairs&sort=name_asc&page=3',
    )
  })

  test("without a breadcrumb, the product's own category — the new-tab and bookmark case", () => {
    assert.equal(
      productBackHref({ from: null, productCategory: 'Lounge Chairs' }),
      '/showroom-admin/products?category=Lounge+Chairs',
    )
  })

  test('with neither, the bare list, which itself resolves to a category', () => {
    assert.equal(productBackHref({ from: '', productCategory: '' }), PRODUCT_LIST_PATH)
    assert.equal(productBackHref({ from: null, productCategory: null }), PRODUCT_LIST_PATH)
  })

  test('an external URL in `from` cannot escape the module', () => {
    for (const hostile of [
      'https://evil.test/steal',
      '//evil.test',
      'http://localhost:3000/admin',
      '/etc/passwd',
      'javascript:alert(1)',
    ]) {
      const href = productBackHref({ from: hostile, productCategory: 'Dummy' })
      assert.equal(href, '/showroom-admin/products?category=Dummy', hostile)
    }
  })

  test('an arbitrary internal path in `from` is ignored, not followed', () => {
    const href = productBackHref({ from: 'redirect=/admin/control-center', productCategory: 'Dummy' })
    assert.equal(href, '/showroom-admin/products?category=Dummy')
  })

  test('a hostile value smuggled through a known param stays a query value', () => {
    // `q` is a search term. Whatever it holds, it is encoded into the query
    // string of the products path — it can never become the path itself.
    const href = productBackHref({ from: 'q=https://evil.test', productCategory: 'Dummy' })
    assert.ok(href.startsWith('/showroom-admin/products?'))
    assert.equal(new URL(href, 'https://boe.test').pathname, PRODUCT_LIST_PATH)
  })

  test('a malformed breadcrumb degrades to the category rather than throwing', () => {
    assert.doesNotThrow(() => productBackHref({ from: '%%%&&&==', productCategory: 'Dummy' }))
    assert.equal(
      productBackHref({ from: '%%%&&&==', productCategory: 'Dummy' }),
      '/showroom-admin/products?category=Dummy',
    )
  })
})

describe('back uses history only when the list itself opened the product', () => {
  // Note: this Next version does not populate `history.state.idx`, so nothing
  // here may depend on a history index. The marker the list writes is the only
  // evidence that the previous entry is that list.
  const from = 'q=teak&category=Metal Chairs'

  test('opened from the list: the entry behind this one IS that list', () => {
    assert.deepEqual(
      resolveProductBack({ marker: { search: from }, from, productCategory: 'Metal Chairs' }),
      { action: 'back' },
    )
  })

  test('a differently-ordered but equivalent breadcrumb still matches', () => {
    assert.deepEqual(
      resolveProductBack({
        marker: { search: 'category=Metal Chairs&q=teak' },
        from,
        productCategory: 'Metal Chairs',
      }),
      { action: 'back' },
    )
  })

  test('opened in a new tab: no marker, so navigate to the category', () => {
    assert.deepEqual(
      resolveProductBack({ marker: null, from: null, productCategory: 'Dummy' }),
      { action: 'push', href: '/showroom-admin/products?category=Dummy' },
    )
  })

  test('opened from a bookmark carrying a breadcrumb: rebuild it, do not guess at history', () => {
    assert.deepEqual(
      resolveProductBack({ marker: undefined, from, productCategory: 'Metal Chairs' }),
      { action: 'push', href: '/showroom-admin/products?q=teak&category=Metal+Chairs' },
    )
  })

  test('history points outside Product Master: never leave the module', () => {
    // The user came from /modules, so there IS an entry behind — but the list
    // did not open this page. A button reading "Back to products" must not land
    // on /modules.
    assert.deepEqual(
      resolveProductBack({ marker: null, from: null, productCategory: 'Bar Chairs' }),
      { action: 'push', href: '/showroom-admin/products?category=Bar+Chairs' },
    )
  })

  test('a marker for a different list view does not authorise history', () => {
    assert.deepEqual(
      resolveProductBack({ marker: { search: 'category=Bar Chairs' }, from, productCategory: 'Metal Chairs' }),
      { action: 'push', href: '/showroom-admin/products?q=teak&category=Metal+Chairs' },
    )
  })

  test('a marker cannot rescue a product opened without a breadcrumb', () => {
    assert.deepEqual(
      resolveProductBack({ marker: { search: 'category=Metal Chairs' }, from: null, productCategory: 'Metal Chairs' }),
      { action: 'push', href: '/showroom-admin/products?category=Metal+Chairs' },
    )
  })

  test('a hostile breadcrumb is not made to match by a hostile marker', () => {
    // Both sanitise to '', which would compare equal — but then there is no list
    // view to go back to, so history must not be used.
    const target = resolveProductBack({
      marker: { search: 'https://evil.test' },
      from: 'https://evil.test',
      productCategory: 'Dummy',
    })
    assert.deepEqual(target, { action: 'push', href: '/showroom-admin/products?category=Dummy' })
  })

  test('every non-history outcome is an internal Product Master destination', () => {
    const cases = [
      { marker: null, from: 'https://evil.test', productCategory: 'Dummy' },
      { marker: null, from: '//evil.test',       productCategory: null },
      { marker: null, from: null,                productCategory: null },
      { marker: { search: 'q=x' }, from: 'q=y',  productCategory: 'Dummy' },
    ]
    for (const input of cases) {
      const target = resolveProductBack(input)
      assert.equal(target.action, 'push')
      if (target.action === 'push') {
        assert.ok(target.href.startsWith(PRODUCT_LIST_PATH), target.href)
        assert.equal(new URL(target.href, 'https://boe.test').pathname, PRODUCT_LIST_PATH)
      }
    }
  })
})

describe('the stored return marker', () => {
  test('a well-formed marker round-trips', () => {
    assert.deepEqual(parseReturnMarker(JSON.stringify({ search: 'category=Dummy' })), {
      search: 'category=Dummy',
    })
  })

  test('anything unusable reads as no marker rather than throwing', () => {
    for (const raw of [
      null, undefined, '', 'not json', '[]', '{}', '3',
      JSON.stringify({ search: 3 }),
      JSON.stringify({ search: null }),
      JSON.stringify({ idx: 3 }),
    ]) {
      assert.equal(parseReturnMarker(raw), null, String(raw))
    }
  })

  test('a marker with an empty search is still valid — that is the clean list URL', () => {
    assert.deepEqual(parseReturnMarker(JSON.stringify({ search: '' })), { search: '' })
  })
})

describe('resolving the category in the URL', () => {
  const resolve = (requested: string | null, available = STORED, ready = true) =>
    resolveCategorySelection({ requested, available, ready })

  test('a stored category is used as-is', () => {
    assert.deepEqual(resolve('Metal Chairs'), { status: 'ok', category: 'Metal Chairs' })
  })

  test('no category selects the first available one', () => {
    assert.deepEqual(resolve(''),   { status: 'select', category: 'Bar Chairs' })
    assert.deepEqual(resolve(null), { status: 'select', category: 'Bar Chairs' })
  })

  test('an unknown category selects a valid one instead of stranding the user', () => {
    assert.deepEqual(resolve('Zebra Chairs'), { status: 'select', category: 'Bar Chairs' })
  })

  test('a category deleted or deactivated since the URL was bookmarked', () => {
    // "Dummy" is gone from `available`; the bookmark must still land somewhere real.
    const remaining = STORED.filter(n => n !== 'Dummy')
    assert.deepEqual(resolve('Dummy', remaining), { status: 'select', category: 'Bar Chairs' })
  })

  test('a differently-cased URL maps onto the stored spelling, it does not create one', () => {
    for (const variant of ['bar chairs', 'BAR CHAIRS', 'Bar chairs', '  Bar Chairs  ']) {
      const result = resolve(variant)
      assert.equal(result.status, 'normalize', variant)
      // The stored value, byte for byte — never the variant.
      assert.equal('category' in result ? result.category : '', 'Bar Chairs')
      assert.ok(STORED.includes('category' in result ? result.category : ''))
    }
  })

  test('normalising never invents a name outside the stored set', () => {
    for (const requested of ['bar chairs', 'Zebra', '', 'DUMMY']) {
      const result = resolve(requested)
      if ('category' in result) assert.ok(STORED.includes(result.category), requested)
    }
  })

  test('a malformed encoded value is treated as unknown, not as a crash', () => {
    for (const junk of ['%E0%A4%A', '%%%', ' ', '<script>', '../../etc']) {
      assert.doesNotThrow(() => resolve(junk), junk)
      assert.deepEqual(resolve(junk), { status: 'select', category: 'Bar Chairs' })
    }
  })

  test('nothing is decided until the category list has actually loaded', () => {
    // The window where counts are still in flight: a good bookmark must survive it.
    assert.deepEqual(resolve('Metal Chairs', STORED, false), { status: 'pending' })
    assert.deepEqual(resolve('', [], false),                 { status: 'pending' })
    assert.deepEqual(resolve('Zebra', [], false),            { status: 'pending' })
  })

  test('a loaded but empty category list is an empty state, not a redirect', () => {
    assert.deepEqual(resolve('Metal Chairs', []), { status: 'none' })
    assert.deepEqual(resolve('', []),             { status: 'none' })
  })

  test('resolution is idempotent — what it writes resolves to ok, so no loop', () => {
    for (const requested of ['', 'Zebra', 'bar chairs', '%%%']) {
      const first = resolve(requested)
      assert.notEqual(first.status, 'ok')
      assert.ok('category' in first)
      const second = resolve('category' in first ? first.category : '')
      assert.equal(second.status, 'ok', `${requested} did not settle`)
    }
  })
})

describe('the sequence a product is stepped through', () => {
  test('the list view it was opened from — search, status and sort all kept', () => {
    const search = productSequenceSearch({
      from: 'q=oak&category=Wooden Chairs&status=all&sort=mrp_desc&page=4',
      productCategory: 'Wooden Chairs',
    })
    const params = new URLSearchParams(search)
    assert.equal(params.get('q'), 'oak')
    assert.equal(params.get('category'), 'Wooden Chairs')
    assert.equal(params.get('status'), 'all')
    assert.equal(params.get('sort'), 'mrp_desc')
  })

  test('page is dropped — the run spans the whole view, not one page of it', () => {
    // This is what lets Next step from the last row of page 1 to the first row
    // of page 2, and what lets every product in a category share one cached run.
    const search = productSequenceSearch({
      from: 'category=Bar Chairs&page=7',
      productCategory: 'Bar Chairs',
    })
    assert.equal(new URLSearchParams(search).get('page'), null)
    assert.equal(
      search,
      productSequenceSearch({ from: 'category=Bar Chairs&page=2', productCategory: 'Bar Chairs' }),
      'two pages of one view must produce the same run',
    )
  })

  test("without a breadcrumb it falls back to the product's own category at defaults", () => {
    assert.equal(
      productSequenceSearch({ from: null, productCategory: 'Lounge Chairs' }),
      'category=Lounge+Chairs',
    )
  })

  test('the fallback carries the category alone — no stale search or sort', () => {
    // `from` has no category, so it describes some other view; replaying its `q`
    // against this product's category would describe a run it was never in.
    assert.equal(
      productSequenceSearch({ from: 'q=teak&sort=mrp_desc', productCategory: 'Dummy' }),
      'category=Dummy',
    )
  })

  test('with no category at all there is no run — never the whole catalogue', () => {
    assert.equal(productSequenceSearch({ from: null, productCategory: null }), '')
    assert.equal(productSequenceSearch({ from: '', productCategory: '  ' }), '')
    assert.equal(productSequenceSearch({ from: 'q=oak', productCategory: '' }), '')
  })

  test('a hostile breadcrumb cannot inject a param into the run', () => {
    const search = productSequenceSearch({
      from: 'category=Dummy&redirect=https://evil.test&meta=0&limit=99999',
      productCategory: 'Dummy',
    })
    assert.equal(search, 'category=Dummy')
  })
})

describe('previous and next product', () => {
  // One category as Product Master orders it by default (code ascending).
  const RUN = ['BOE-SR-001', 'BOE-SR-002', 'BOE-SR-003', 'BOE-SR-004']

  test('a product in the middle has both neighbours', () => {
    assert.deepEqual(resolveProductNeighbors(RUN, 'BOE-SR-002'), {
      previous: 'BOE-SR-001',
      next:     'BOE-SR-003',
      position: 2,
      total:    4,
    })
  })

  test('the first product has no previous', () => {
    const n = resolveProductNeighbors(RUN, 'BOE-SR-001')
    assert.equal(n.previous, null)
    assert.equal(n.next, 'BOE-SR-002')
    assert.equal(n.position, 1)
  })

  test('the last product has no next', () => {
    const n = resolveProductNeighbors(RUN, 'BOE-SR-004')
    assert.equal(n.previous, 'BOE-SR-003')
    assert.equal(n.next, null)
    assert.equal(n.position, 4)
  })

  test('a lone product in its category has neither', () => {
    assert.deepEqual(resolveProductNeighbors(['BOE-SR-001'], 'BOE-SR-001'), {
      previous: null, next: null, position: 1, total: 1,
    })
  })

  test('stepping forward then back returns to where it started', () => {
    // FLOW 1: open 002, Next to 003, Previous is 002 again.
    const forward = resolveProductNeighbors(RUN, 'BOE-SR-002').next
    assert.equal(forward, 'BOE-SR-003')
    assert.equal(resolveProductNeighbors(RUN, forward!).previous, 'BOE-SR-002')
  })

  test('walking Next from the first product visits every product exactly once', () => {
    // FLOW 2: several steps without returning to the list.
    const visited: string[] = []
    let code: string | null = RUN[0]
    while (code) {
      visited.push(code)
      code = resolveProductNeighbors(RUN, code).next
      assert.ok(visited.length <= RUN.length, 'walk did not terminate')
    }
    assert.deepEqual(visited, RUN)
  })

  test('the run order is followed verbatim, not re-sorted', () => {
    // A `sort=mrp_desc` run arrives in price order, and Next must honour that
    // rather than fall back to code order.
    const byPrice = ['BOE-SR-004', 'BOE-SR-001', 'BOE-SR-003', 'BOE-SR-002']
    assert.equal(resolveProductNeighbors(byPrice, 'BOE-SR-001').next, 'BOE-SR-003')
    assert.equal(resolveProductNeighbors(byPrice, 'BOE-SR-001').previous, 'BOE-SR-004')
  })

  test('the same run and product always give the same answer', () => {
    const first = resolveProductNeighbors(RUN, 'BOE-SR-003')
    for (let i = 0; i < 3; i++) {
      assert.deepEqual(resolveProductNeighbors(RUN, 'BOE-SR-003'), first)
    }
  })

  test('a URL in the wrong case still finds its place in the run', () => {
    // Codes are stored upper-cased but `product_code` is read from the URL as
    // typed, so a shared lower-case link must not look like a missing product.
    const n = resolveProductNeighbors(RUN, 'boe-sr-002')
    assert.equal(n.previous, 'BOE-SR-001')
    assert.equal(n.next, 'BOE-SR-003')
  })

  test('surrounding whitespace does not hide a product from its own run', () => {
    assert.equal(resolveProductNeighbors(RUN, ' BOE-SR-002 ').next, 'BOE-SR-003')
  })

  test('a product outside the run gets no neighbours rather than a guess', () => {
    // The truncated-run case, and the filtered-out case: any answer other than
    // "none" would step the user somewhere they never browsed.
    assert.deepEqual(resolveProductNeighbors(RUN, 'BOE-XX-999'), {
      previous: null, next: null, position: null, total: 0,
    })
  })

  test('an empty or unloaded run offers nothing', () => {
    assert.deepEqual(resolveProductNeighbors([], 'BOE-SR-001'), {
      previous: null, next: null, position: null, total: 0,
    })
  })

  test('a blank product code is not matched against a blank entry', () => {
    assert.equal(resolveProductNeighbors(RUN, '').position, null)
    assert.equal(resolveProductNeighbors(['', 'BOE-SR-001'], '').position, null)
  })

  test('every neighbour returned is a real member of the run', () => {
    for (const code of RUN) {
      const { previous, next } = resolveProductNeighbors(RUN, code)
      if (previous) assert.ok(RUN.includes(previous), previous)
      if (next)     assert.ok(RUN.includes(next), next)
    }
  })
})

describe('the Product Master parent entry', () => {
  test('inside the module it toggles, so the selected category is kept', () => {
    assert.deepEqual(
      resolveParentClick({ onProductRoute: true, firstCategory: 'Bar Chairs' }),
      { action: 'toggle' },
    )
  })

  test('from outside it opens the first category — never an all-products screen', () => {
    assert.deepEqual(
      resolveParentClick({ onProductRoute: false, firstCategory: 'Bar Chairs' }),
      { action: 'navigate', href: '/showroom-admin/products?category=Bar+Chairs' },
    )
  })

  test('with no categories loaded yet it still reaches the module', () => {
    assert.deepEqual(
      resolveParentClick({ onProductRoute: false, firstCategory: null }),
      { action: 'navigate', href: PRODUCT_LIST_PATH },
    )
  })
})
