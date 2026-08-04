// ── Product Master empty states ───────────────────────────────────────────────
// Which "nothing here" message the list shows, as a rule rather than a ternary
// buried in the page.
//
// The distinction matters because Product Master is always one category: an
// empty result is usually a brand-new category, not a search that missed. The
// old copy said "No products match your filters" in both cases, which told a
// user who had set no filters to go and change them.

export type ProductListEmptyState = {
  message: string
  hint: string
}

/**
 * The empty state for a category that returned no rows.
 *
 * Sort is deliberately NOT an input. Re-ordering rows cannot remove any, so a
 * non-default sort must never turn "this category is empty" into "your filters
 * are too narrow" — only the controls that actually exclude rows count.
 */
export function productListEmptyState(input: {
  /** A search term is in effect. */
  hasSearch: boolean
  /** The status control is on something other than the default (Active). */
  statusFiltered: boolean
}): ProductListEmptyState {
  if (input.hasSearch || input.statusFiltered) {
    return {
      message: 'No products match your filters',
      hint: 'Try a different search term or status.',
    }
  }

  // Nothing was narrowed, so the category itself is empty. The next step is to
  // add a product, and Add Product is already on screen above this message.
  return {
    message: 'No products in this category yet',
    hint: 'Add the first product to start building this category.',
  }
}
