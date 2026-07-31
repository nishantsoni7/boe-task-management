// Asset list search and filtering.
//
// All of it is pure and client-side, deliberately. The inventory is a few
// hundred rows of company hardware, not a dataset — filtering in the browser
// keeps every combination instant, keeps the filters composable without a
// query builder, and means a filter can never disagree with what is on screen.
// If the inventory ever outgrows that, this is the one file to move
// server-side, and its tests are the specification of what to preserve.
//
// The rule that governs everything below: an EMPTY filter matches everything.
// A filter is a narrowing, and a narrowing nobody asked for is a bug — it
// silently hides assets and the reader has no way to tell.

import type { Asset, EmployeeAsset } from './types'
import { warrantyStatus, type WarrantyStatus } from './warranty'
import { findOpenAssignment, describeCustody } from './transfers'

export type AssetFilters = {
  /** Free text, matched across name, code, serial, brand, model, holder. */
  search: string
  category: string
  status: string
  /** A user id, or '' for any. */
  employeeId: string
  department: string
  location: string
  condition: string
  warranty: string
  /** Inclusive `YYYY-MM-DD` bounds on purchase_date. */
  purchasedFrom: string
  purchasedTo: string
}

export const EMPTY_ASSET_FILTERS: AssetFilters = {
  search: '',
  category: '',
  status: '',
  employeeId: '',
  department: '',
  location: '',
  condition: '',
  warranty: '',
  purchasedFrom: '',
  purchasedTo: '',
}

/** Whether anything is actually narrowing the list — drives "Clear filters". */
export function hasActiveFilters(filters: AssetFilters): boolean {
  return (Object.keys(EMPTY_ASSET_FILTERS) as (keyof AssetFilters)[])
    .some(key => filters[key].trim() !== '')
}

/** How many filters are applied, for the "N filters" affordance. */
export function activeFilterCount(filters: AssetFilters): number {
  return (Object.keys(EMPTY_ASSET_FILTERS) as (keyof AssetFilters)[])
    .filter(key => key !== 'search' && filters[key].trim() !== '').length
}

function norm(value: string | null | undefined): string {
  return (value ?? '').toLowerCase().trim()
}

/**
 * Every field one asset is searchable by, as one lower-cased haystack.
 *
 * `holderName` is passed in rather than looked up here so this stays pure and
 * so the searchable holder is exactly the name shown in the table — searching
 * for what you can see is the only behaviour that does not surprise anyone.
 */
export function assetSearchHaystack(asset: Asset, holderName: string | null): string {
  return [
    asset.asset_name,
    asset.asset_code,
    asset.serial_no,
    asset.brand,
    asset.model,
    asset.asset_type,
    asset.location,
    asset.department,
    holderName,
  ]
    .filter((v): v is string => typeof v === 'string' && v.trim() !== '')
    .join(' ')
    .toLowerCase()
}

/**
 * Does this asset match the search text?
 *
 * Every whitespace-separated term must appear somewhere in the haystack, so
 * "dell priya" finds the Dell that Priya holds rather than everything matching
 * either word. Empty search matches everything.
 */
export function matchesSearch(haystack: string, search: string): boolean {
  const terms = search.toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return true
  return terms.every(term => haystack.includes(term))
}

export type AssetRow = {
  asset: Asset
  /** The open custody row, or null when nobody holds it. */
  assignment: EmployeeAsset | null
  /** Resolved custodian id — null for a location-held or unassigned asset. */
  holderId: string | null
  /** What the Current Holder column shows. */
  holderLabel: string
  holderName: string | null
  warranty: WarrantyStatus
}

/**
 * Turn the raw asset + assignment reads into the rows the table renders.
 *
 * Derivation happens ONCE, here, so the table cell, the search haystack and
 * the employee filter all agree about who holds what — three places computing
 * it separately is how "Assigned to nobody" rows appear.
 */
export function buildAssetRows(
  assets: readonly Asset[],
  assignments: readonly EmployeeAsset[],
  employeeName: (id: string) => string | null,
  now: Date | string = new Date(),
): AssetRow[] {
  return assets.map(asset => {
    const assignment = findOpenAssignment(assignments, asset.id)
    const custody = describeCustody(asset, assignment, employeeName)
    return {
      asset,
      assignment,
      holderId: custody.employeeId,
      holderLabel: custody.label,
      holderName: custody.employeeId ? employeeName(custody.employeeId) : custody.location,
      warranty: warrantyStatus(asset.warranty_expiry_date, now),
    }
  })
}

/**
 * Apply every filter. Each clause is independent and additive, so combining
 * filters narrows rather than replacing, and removing one restores exactly
 * what it was hiding.
 */
export function filterAssetRows(rows: readonly AssetRow[], filters: AssetFilters): AssetRow[] {
  const search        = filters.search.trim()
  const category      = filters.category.trim()
  const status        = filters.status.trim()
  const employeeId    = filters.employeeId.trim()
  const department    = norm(filters.department)
  const location      = norm(filters.location)
  const condition     = filters.condition.trim()
  const warranty      = filters.warranty.trim()
  const purchasedFrom = filters.purchasedFrom.trim()
  const purchasedTo   = filters.purchasedTo.trim()

  return rows.filter(row => {
    const a = row.asset

    if (search && !matchesSearch(assetSearchHaystack(a, row.holderName), search)) return false
    if (category && a.asset_type !== category) return false
    if (status && a.status !== status) return false
    if (employeeId && row.holderId !== employeeId) return false

    // Department and location are free text on the asset, so they are matched
    // as a contained substring — "store" finds "Store Room A".
    if (department && !norm(a.department).includes(department)) return false
    if (location && !norm(a.location).includes(location)) return false

    // An asset with no recorded condition is not "good"; it is simply not a
    // match for any specific condition filter.
    if (condition && a.condition !== condition) return false
    if (warranty && row.warranty !== warranty) return false

    // Purchase-date range. An asset with no purchase date recorded cannot be
    // shown to fall inside a date range, so a bounded search excludes it —
    // including it would assert a date nobody wrote down.
    if (purchasedFrom || purchasedTo) {
      const purchased = a.purchase_date
      if (!purchased) return false
      if (purchasedFrom && purchased < purchasedFrom) return false
      if (purchasedTo && purchased > purchasedTo) return false
    }

    return true
  })
}

/**
 * The distinct values actually present in the inventory, for the dropdowns.
 *
 * Built from the data rather than from a fixed list so a department or a
 * location that exists on an asset can always be filtered for, and one that
 * exists nowhere never offers a filter that returns nothing.
 */
export function distinctValues(
  assets: readonly Asset[],
  field: 'asset_type' | 'department' | 'location' | 'condition',
): string[] {
  const seen = new Set<string>()
  for (const a of assets) {
    const v = a[field]
    if (typeof v === 'string' && v.trim() !== '') seen.add(v.trim())
  }
  return Array.from(seen).sort((x, y) => x.localeCompare(y))
}

/** Sort order for the list: most recently updated first. */
export function sortAssetRows(rows: readonly AssetRow[]): AssetRow[] {
  return [...rows].sort((a, b) => {
    if (a.asset.updated_at === b.asset.updated_at) {
      return a.asset.asset_name.localeCompare(b.asset.asset_name)
    }
    return a.asset.updated_at < b.asset.updated_at ? 1 : -1
  })
}
