// ── Product Master navigation ─────────────────────────────────────────────────
// The pure half of "the Product Master category lives in the URL". The sidebar
// sub-navigation, the list page and the edit page all have to agree on three
// things — where a category lives, which category the current URL is showing,
// and where Back goes — so those rules live here rather than being re-derived
// in each of the three components.
//
// There is deliberately no "all products" destination: a Product Master view is
// always one category. The category is navigation state (a sidebar entry), not a
// filter, which is why it survives "Clear filters" and why the list page sends
// the user to the first category when the URL carries none.

/** The one Product Master route. Every category is a query param on it. */
export const PRODUCT_LIST_PATH = '/showroom-admin/products'

export type ProductCategoryCount = { name: string; count: number }

/**
 * Params the list page owns. Anything else in a `from=` value is dropped: that
 * value arrives from a URL, and only these five can be replayed onto the list.
 */
export const PRODUCT_LIST_PARAM_KEYS = ['q', 'category', 'status', 'sort', 'page'] as const

const stripLeadingQuestion = (raw: string | null | undefined) => (raw ?? '').replace(/^\?/, '')

/**
 * Keep only the params the list page understands, in a fixed order. A
 * hand-edited or stale `from=` can therefore never inject a param the list does
 * not own, and two equivalent search strings normalise to one.
 */
export function sanitizeListSearch(raw: string | null | undefined): string {
  const source = new URLSearchParams(stripLeadingQuestion(raw))
  const out = new URLSearchParams()
  for (const key of PRODUCT_LIST_PARAM_KEYS) {
    const value = source.get(key)
    if (value) out.set(key, value)
  }
  return out.toString()
}

/** The list route carrying `search` (already-sanitised or empty). */
export function productListHref(search?: string | null): string {
  const qs = stripLeadingQuestion(search)
  return qs ? `${PRODUCT_LIST_PATH}?${qs}` : PRODUCT_LIST_PATH
}

/**
 * A category's own destination — the list, filtered to it, with every other
 * control back at its default. This is what a sidebar entry points at.
 */
export function productCategoryHref(category: string): string {
  if (!category) return PRODUCT_LIST_PATH
  const params = new URLSearchParams()
  params.set('category', category)
  return `${PRODUCT_LIST_PATH}?${params.toString()}`
}

/** True on the list route itself. */
export function isProductListRoute(pathname: string): boolean {
  return pathname === PRODUCT_LIST_PATH
}

/** True anywhere under Product Master, including a product's edit page. */
export function isProductRoute(pathname: string): boolean {
  return pathname === PRODUCT_LIST_PATH || pathname.startsWith(`${PRODUCT_LIST_PATH}/`)
}

/**
 * Opening a product carries the list's exact search string along in `from=`, so
 * the edit page can rebuild the view the user left even when browser history
 * cannot be used (a reload, a shared link, a direct hit on the edit URL).
 */
export function productEditHref(productCode: string, listSearch?: string | null): string {
  const base = `${PRODUCT_LIST_PATH}/${encodeURIComponent(productCode)}/edit`
  const from = sanitizeListSearch(listSearch)
  return from ? `${base}?from=${encodeURIComponent(from)}` : base
}

/**
 * Which sidebar category the current URL belongs to — read from `category` on
 * the list, and from the `from=` breadcrumb on a product's own page, so the
 * category a product was opened from stays highlighted while it is being
 * edited.
 */
export function activeProductCategory(pathname: string, search?: string | null): string {
  const params = new URLSearchParams(stripLeadingQuestion(search))
  if (isProductListRoute(pathname)) return params.get('category') ?? ''
  if (isProductRoute(pathname)) {
    const from = params.get('from')
    return from ? new URLSearchParams(from).get('category') ?? '' : ''
  }
  return ''
}

// ── Category resolution ───────────────────────────────────────────────────────

/**
 * What the list page should do about the category currently in the URL.
 *
 * `normalize` and `select` both end in a `replace`, and both are idempotent:
 * the value they write is a stored name, which then resolves to `ok`. That is
 * what makes a redirect loop impossible.
 */
export type CategoryResolution =
  /** The URL already names a stored category. */
  | { status: 'ok'; category: string }
  /** A case or whitespace variant of a real category — rewrite to the stored spelling. */
  | { status: 'normalize'; category: string }
  /** Missing, unknown, deleted or deactivated — fall back to the first available. */
  | { status: 'select'; category: string }
  /** There are no categories to choose from; the page shows an empty state. */
  | { status: 'none' }
  /** The category list has not loaded yet — decide nothing, redirect nothing. */
  | { status: 'pending' }

/**
 * Resolve a URL's category against the categories that actually exist.
 *
 * Never invents or renames anything: `normalize` only ever returns a name that
 * is already in `available`, so a differently-cased bookmark lands on the
 * stored category rather than creating a second one. A name that matches
 * nothing is not "fixed" either — the user is moved to a real category instead
 * of being left on a permanently empty list.
 *
 * `ready` is what stops a bookmark being discarded during the window where the
 * category list simply has not arrived yet.
 */
export function resolveCategorySelection(input: {
  requested: string | null | undefined
  available: readonly string[]
  ready: boolean
}): CategoryResolution {
  const { available, ready } = input
  // Compared RAW, not trimmed: `?category=%20Bar%20Chairs%20` is not the stored
  // value, and leaving it in the URL would send the padded string to the API's
  // `eq` filter and match nothing. Padding is a variant to be rewritten, not a
  // spelling to be accepted.
  const requested = input.requested ?? ''

  if (!ready) return { status: 'pending' }
  if (available.length === 0) return { status: 'none' }

  if (requested) {
    if (available.includes(requested)) return { status: 'ok', category: requested }
    const folded = requested.trim().toLowerCase()
    // A stored name is never blank, so whitespace-only input matches nothing.
    const match = folded ? available.find(name => name.trim().toLowerCase() === folded) : undefined
    if (match) return { status: 'normalize', category: match }
  }

  return { status: 'select', category: available[0] }
}

// ── Back from a product ───────────────────────────────────────────────────────

export type ProductBackTarget = { action: 'back' } | { action: 'push'; href: string }

/**
 * Where "Back to products" goes. Always an internal Product Master URL:
 * `from` has been through {@link sanitizeListSearch}, so an external URL, an
 * absolute path or an unknown param cannot survive into it — the worst a
 * hostile `from` can do is be ignored.
 *
 * Order of preference: the list view the product was opened from, then the
 * product's own category (which is where a bookmark or a new tab should land),
 * then the bare list, which itself resolves to a category.
 */
export function productBackHref(input: {
  from: string | null | undefined
  productCategory: string | null | undefined
}): string {
  const search = sanitizeListSearch(input.from)
  if (search) return productListHref(search)

  const category = (input.productCategory ?? '').trim()
  return category ? productCategoryHref(category) : PRODUCT_LIST_PATH
}

/**
 * A one-shot record that the list itself opened this product.
 *
 * Written by the list at the moment it navigates to a product, and consumed by
 * the product page on mount. Deliberately NOT derived from `history.state.idx`:
 * this Next version does not populate `idx` at all, so an index comparison
 * could never authorise anything.
 */
export type ProductReturnMarker = {
  /** The list's search string at the moment it handed off. */
  search: string
}

/**
 * How the visible Back control returns.
 *
 * A plain `history.back()` is wrong here: a product opened from a bookmark, a
 * new tab or a link from elsewhere in BOE has *something* behind it, and going
 * back would leave the module entirely while the button says "Back to
 * products". So history is used only when the list itself performed the
 * navigation — the marker proves it, and its search string must match the
 * breadcrumb this page was opened with, so a stale one cannot stand in.
 *
 * When it holds, `back()` is strictly better than any pushed URL: it restores
 * the page, the filters *and* the scroll offset natively. Otherwise Back is an
 * ordinary internal navigation to {@link productBackHref}, which can never
 * leave Product Master. Browser Back is untouched either way.
 */
export function resolveProductBack(input: {
  marker: ProductReturnMarker | null | undefined
  from: string | null | undefined
  productCategory: string | null | undefined
}): ProductBackTarget {
  const { marker, from, productCategory } = input

  // Both sides must sanitise to the SAME NON-EMPTY search. The non-empty part
  // matters: two unusable values (a hostile `from`, a junk marker) both
  // sanitise to '' and would otherwise compare equal, handing history a
  // destination nobody verified. A real list handoff always carries at least a
  // category, so it never trips this.
  const markerSearch = sanitizeListSearch(marker?.search)
  const openedFromTheList = !!marker && markerSearch !== '' &&
    markerSearch === sanitizeListSearch(from)

  if (openedFromTheList) return { action: 'back' }
  return { action: 'push', href: productBackHref({ from, productCategory }) }
}

/** sessionStorage key holding the {@link ProductReturnMarker}. One per tab. */
export const PRODUCT_RETURN_MARKER_KEY = 'boe:product-master-return'

/** Parse a stored marker, tolerating anything at all in storage. */
export function parseReturnMarker(raw: string | null | undefined): ProductReturnMarker | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return null
    const { search } = parsed as { search?: unknown }
    if (typeof search !== 'string') return null
    return { search }
  } catch {
    return null
  }
}

// ── Previous / next product ───────────────────────────────────────────────────

/**
 * Params that identify a *sequence* of products — the list view the user is
 * stepping through.
 *
 * Deliberately {@link PRODUCT_LIST_PARAM_KEYS} minus `page`: paging is a window
 * onto one ordering, not a different ordering, so the product after the last row
 * of page 1 is the first row of page 2. Dropping `page` is also what lets every
 * product in a category share one cached sequence instead of one per page.
 */
export const PRODUCT_SEQUENCE_PARAM_KEYS = ['q', 'category', 'status', 'sort'] as const

/**
 * The sequence context for a product being edited, as a search string.
 *
 * Prefers the list state the product was opened from (`from=`), so Previous/Next
 * walk the same filtered, sorted run of products the user was browsing. A
 * product reached without that breadcrumb — a bookmark, a new tab, the sidebar
 * lookup — falls back to its own category at Product Master's defaults, which is
 * the ordering the list would show if that category were opened fresh.
 *
 * Returns '' when neither is available. There is no all-products sequence for
 * the same reason there is no all-products list: a category is always required.
 */
export function productSequenceSearch(input: {
  from: string | null | undefined
  productCategory: string | null | undefined
}): string {
  const source = new URLSearchParams(sanitizeListSearch(input.from))
  const out = new URLSearchParams()
  for (const key of PRODUCT_SEQUENCE_PARAM_KEYS) {
    const value = source.get(key)
    if (value) out.set(key, value)
  }

  if (!out.get('category')) {
    const fallback = (input.productCategory ?? '').trim()
    if (!fallback) return ''
    // Only the category carries over. A `q=` or `sort=` from some other view
    // would describe a run this product was never part of.
    return new URLSearchParams({ category: fallback }).toString()
  }

  return out.toString()
}

export type ProductNeighbors = {
  /** Code of the product before this one, or null at the start of the run. */
  previous: string | null
  /** Code of the product after this one, or null at the end of the run. */
  next: string | null
  /** 1-based position in the run; null when this product is not in it. */
  position: number | null
  /** How many products the run holds. */
  total: number
}

const NO_NEIGHBORS: ProductNeighbors = { previous: null, next: null, position: null, total: 0 }

// Codes are stored upper-cased (every write path calls .toUpperCase()), but a
// URL can be typed or shared in any case and `productCode` is read from the URL
// verbatim. Folding both sides is what stops `/boe-sr-002/edit` from looking
// like a product that is not in its own sequence.
const foldCode = (code: string) => code.trim().toUpperCase()

/**
 * Where Previous and Next point, given the ordered run of product codes.
 *
 * `codes` arrives already in the list's own order — same filters, same sort,
 * same `product_code` tiebreaker — so this only has to locate the current
 * product in it. The two boundaries fall out of that: the first product has no
 * Previous, the last has no Next, and a lone product has neither.
 *
 * A code that is not in the run yields no neighbours rather than a guess. That
 * covers the honest cases (the run was truncated at the server's cap, the
 * product was renamed or filtered out under the user) where any answer other
 * than "none" would send the user somewhere they never asked to go.
 */
export function resolveProductNeighbors(
  codes: readonly string[],
  currentCode: string,
): ProductNeighbors {
  const target = foldCode(currentCode ?? '')
  if (!target || codes.length === 0) return NO_NEIGHBORS

  const index = codes.findIndex(code => foldCode(code) === target)
  if (index === -1) return NO_NEIGHBORS

  return {
    previous: index > 0 ? codes[index - 1] : null,
    next:     index < codes.length - 1 ? codes[index + 1] : null,
    position: index + 1,
    total:    codes.length,
  }
}

// ── Parent nav entry ──────────────────────────────────────────────────────────

export type ParentClickResult = { action: 'toggle' } | { action: 'navigate'; href: string }

/**
 * What clicking "Product Master" itself does. Inside the module it is a
 * disclosure control — collapsing the list must not throw away the category the
 * user is looking at. From outside it is a normal nav entry, and lands on the
 * first category, because there is no all-products screen to land on.
 */
export function resolveParentClick(input: {
  onProductRoute: boolean
  firstCategory: string | null | undefined
}): ParentClickResult {
  if (input.onProductRoute) return { action: 'toggle' }
  return {
    action: 'navigate',
    href: input.firstCategory ? productCategoryHref(input.firstCategory) : PRODUCT_LIST_PATH,
  }
}
