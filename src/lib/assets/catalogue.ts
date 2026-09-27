// Assets & Access — the asset CATALOGUE: categories and the products within
// them (20270131000000).
//
// Three words, three things, and the screens must never blur them:
//
//   Category  a grouping such as "Laptop / Desktop". Stored on each asset as
//             assets.asset_type, which is the category's immutable KEY.
//   Product   a reusable type or model within a category, such as one laptop
//             model. Optional on an asset (assets.product_id). A product has
//             no holder, no status and no code — it is never an item.
//   Asset     an individual item BOE owns, with its own code, which may be
//             assigned to a person.
//
// Renaming a category or product changes its `name` only; every asset keeps
// the same key / id and simply reads the new name. That is why every label on
// every screen is resolved through this file rather than from the stored key.
//
// Pure, apart from loadAssetCatalogue at the bottom — tested without React or
// a database in catalogue.test.ts.

import type { SupabaseClient } from '@supabase/supabase-js'
import { humanizeToken } from './types'

export type AssetCategory = {
  /** Immutable. The value assets.asset_type stores. */
  key: string
  name: string
  is_active: boolean
  created_at: string
  created_by: string | null
  updated_at: string
  updated_by: string | null
}

export type AssetProduct = {
  id: string
  category_key: string
  name: string
  is_active: boolean
  created_at: string
  created_by: string | null
  updated_at: string
  updated_by: string | null
}

export type AssetCatalogue = {
  categories: AssetCategory[]
  products: AssetProduct[]
}

export const EMPTY_ASSET_CATALOGUE: AssetCatalogue = { categories: [], products: [] }

export const CATEGORY_COLUMNS = 'key, name, is_active, created_at, created_by, updated_at, updated_by'
export const PRODUCT_COLUMNS  = 'id, category_key, name, is_active, created_at, created_by, updated_at, updated_by'

/** The database's limits (asset_categories / asset_products CHECKs). */
export const CATEGORY_NAME_MAX = 60
export const PRODUCT_NAME_MAX  = 80

/**
 * Trimmed, with runs of whitespace collapsed — exactly what
 * asset_catalogue_normalise_name() stores, so the inline duplicate hint and
 * the server's refusal can never disagree.
 */
export function normaliseCatalogueName(name: string | null | undefined): string {
  return (name ?? '').trim().replace(/\s+/g, ' ')
}

function sameName(a: string, b: string): boolean {
  return normaliseCatalogueName(a).toLowerCase() === normaliseCatalogueName(b).toLowerCase()
}

/**
 * The category that already uses this name, if any — active OR inactive, the
 * same scope as the database's unique index. `exceptKey` is the category being
 * renamed, which may of course keep its own name.
 */
export function findDuplicateCategory(
  categories: readonly AssetCategory[],
  name: string,
  exceptKey?: string | null,
): AssetCategory | null {
  if (!normaliseCatalogueName(name)) return null
  return categories.find(c => c.key !== exceptKey && sameName(c.name, name)) ?? null
}

/** Same, scoped to ONE category: products are unique within their category. */
export function findDuplicateProduct(
  products: readonly AssetProduct[],
  categoryKey: string,
  name: string,
  exceptId?: string | null,
): AssetProduct | null {
  if (!normaliseCatalogueName(name)) return null
  return products.find(p =>
    p.category_key === categoryKey && p.id !== exceptId && sameName(p.name, name),
  ) ?? null
}

/**
 * The sentence shown under a name field, or null when the name is fine.
 * Mirrors the RPCs' refusals so the reader sees the problem while typing
 * rather than after pressing Save.
 */
export function categoryNameProblem(
  categories: readonly AssetCategory[],
  name: string,
  exceptKey?: string | null,
): string | null {
  const clean = normaliseCatalogueName(name)
  if (!clean) return 'Enter a category name.'
  if (clean.length > CATEGORY_NAME_MAX) return `Keep the category name to ${CATEGORY_NAME_MAX} characters or fewer.`
  const dup = findDuplicateCategory(categories, clean, exceptKey)
  if (!dup) return null
  return dup.is_active
    ? `A category named "${dup.name}" already exists.`
    : `An inactive category named "${dup.name}" already exists. Reactivate it instead.`
}

export function productNameProblem(
  catalogue: AssetCatalogue,
  categoryKey: string,
  name: string,
  exceptId?: string | null,
): string | null {
  const clean = normaliseCatalogueName(name)
  if (!clean) return 'Enter a product name.'
  if (clean.length > PRODUCT_NAME_MAX) return `Keep the product name to ${PRODUCT_NAME_MAX} characters or fewer.`
  const dup = findDuplicateProduct(catalogue.products, categoryKey, clean, exceptId)
  if (!dup) return null
  const category = categoryLabel(catalogue, categoryKey)
  return dup.is_active
    ? `"${category}" already has a product named "${dup.name}".`
    : `"${category}" has an inactive product named "${dup.name}". Reactivate it instead.`
}

// ─── Labels ──────────────────────────────────────────────────────────────────

/**
 * The name to show for a stored category key. Falls back to the humanised key
 * so a screen that renders before the catalogue has loaded still says
 * something readable, never a blank.
 */
export function categoryLabel(catalogue: AssetCatalogue, key: string | null | undefined): string {
  if (!key) return '—'
  return catalogue.categories.find(c => c.key === key)?.name ?? humanizeToken(key)
}

/** The product's name, or null when the asset names none. */
export function productLabel(catalogue: AssetCatalogue, id: string | null | undefined): string | null {
  if (!id) return null
  return catalogue.products.find(p => p.id === id)?.name ?? null
}

const byName = <T extends { name: string }>(a: T, b: T) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })

/** Every category, alphabetically. "Other" reads last, where people look for it. */
export function sortCategories(categories: readonly AssetCategory[]): AssetCategory[] {
  return [...categories].sort((a, b) => {
    if (a.key === 'other' && b.key !== 'other') return 1
    if (b.key === 'other' && a.key !== 'other') return -1
    return byName(a, b)
  })
}

export function productsInCategory(
  products: readonly AssetProduct[],
  categoryKey: string,
  opts: { includeInactive?: boolean } = {},
): AssetProduct[] {
  return products
    .filter(p => p.category_key === categoryKey && (opts.includeInactive || p.is_active))
    .sort(byName)
}

// ─── What a form may offer ───────────────────────────────────────────────────

export type CatalogueOption = { value: string; label: string; inactive: boolean }

/**
 * The categories a create or edit form offers: every ACTIVE category, plus the
 * asset's CURRENT one when it has since been retired — labelled as such, so an
 * edit of some other field never silently re-categorises the asset. The
 * database accepts exactly this: it refuses a NEW inactive choice and leaves
 * an unchanged one alone.
 */
export function categoryOptions(
  categories: readonly AssetCategory[],
  currentKey?: string | null,
): CatalogueOption[] {
  const options = sortCategories(categories.filter(c => c.is_active))
    .map(c => ({ value: c.key, label: c.name, inactive: false }))
  if (currentKey && !options.some(o => o.value === currentKey)) {
    const current = categories.find(c => c.key === currentKey)
    options.unshift({
      value: currentKey,
      label: `${current?.name ?? humanizeToken(currentKey)} (inactive)`,
      inactive: true,
    })
  }
  return options
}

/** Same rule for products, within the chosen category. */
export function productOptions(
  products: readonly AssetProduct[],
  categoryKey: string,
  currentId?: string | null,
): CatalogueOption[] {
  const options = productsInCategory(products, categoryKey)
    .map(p => ({ value: p.id, label: p.name, inactive: false }))
  if (currentId && !options.some(o => o.value === currentId)) {
    const current = products.find(p => p.id === currentId)
    // A product from ANOTHER category is not offered: the asset's category
    // changed, and the database clears or refuses the stale pairing.
    if (current && current.category_key === categoryKey) {
      options.unshift({ value: current.id, label: `${current.name} (inactive)`, inactive: true })
    }
  }
  return options
}

/**
 * The product to keep when the category changes in a form: the same product if
 * it belongs to the new category, otherwise none. Never a product from a
 * category the asset is leaving.
 */
export function productAfterCategoryChange(
  products: readonly AssetProduct[],
  productId: string,
  nextCategoryKey: string,
): string {
  if (!productId) return ''
  const product = products.find(p => p.id === productId)
  return product && product.category_key === nextCategoryKey ? productId : ''
}

// ─── What a picker may show ──────────────────────────────────────────────────

export type CataloguePickerState = 'loading' | 'error' | 'empty' | 'ready'

/**
 * Whether a form may offer the category picker yet.
 *
 * An empty option list means three different things, and a form must never
 * let one pass for another: still loading, the read FAILED, or the catalogue
 * genuinely has no active category. Only 'ready' lets the reader choose and
 * save. The store sets `loaded` only on a successful read, so a failed first
 * read is 'error' — never 'empty'.
 */
export function cataloguePickerState(
  store: { loaded: boolean; error: string | null; loading?: boolean },
  catalogue: AssetCatalogue,
): CataloguePickerState {
  if (!store.loaded) return store.error && !store.loading ? 'error' : 'loading'
  return catalogue.categories.some(c => c.is_active) ? 'ready' : 'empty'
}

// ─── Usage (asset_catalogue_usage) ───────────────────────────────────────────

export type CatalogueUsageRow = {
  category_key: string
  product_id: string | null
  status: string
  asset_count: number | string
}

export type CatalogueUsage = {
  byCategory: Record<string, number>
  byProduct: Record<string, number>
}

/** Fold the RPC's count rows into "used by N assets" per entry. */
export function summariseCatalogueUsage(rows: readonly CatalogueUsageRow[]): CatalogueUsage {
  const byCategory: Record<string, number> = {}
  const byProduct: Record<string, number> = {}
  for (const r of rows) {
    const n = Number(r.asset_count) || 0
    byCategory[r.category_key] = (byCategory[r.category_key] ?? 0) + n
    if (r.product_id) byProduct[r.product_id] = (byProduct[r.product_id] ?? 0) + n
  }
  return { byCategory, byProduct }
}

// ─── Loading ─────────────────────────────────────────────────────────────────

/**
 * Both tables in one round trip. Readable by everyone in the module (RLS), so
 * My Assets can name a category the same way the inventory does.
 */
export async function loadAssetCatalogue(
  supabase: SupabaseClient,
): Promise<{ catalogue: AssetCatalogue; error: string | null }> {
  const [{ data: cats, error: cErr }, { data: prods, error: pErr }] = await Promise.all([
    supabase.from('asset_categories').select(CATEGORY_COLUMNS),
    supabase.from('asset_products').select(PRODUCT_COLUMNS),
  ])
  const error = cErr?.message ?? pErr?.message ?? null
  return {
    catalogue: {
      categories: (cats ?? []) as AssetCategory[],
      products: (prods ?? []) as AssetProduct[],
    },
    error,
  }
}
