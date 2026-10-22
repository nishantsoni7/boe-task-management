import { conditionLabel, stageLabel, type Condition, type InventoryItem, type Stage } from './constants'

export type StockFilter = 'all' | 'available' | 'sold_out'
export type SortKey = 'recent' | 'price_low' | 'price_high' | 'available' | 'code'

export type ItemFilters = {
  q: string
  stages: Stage[]
  conditions: Condition[]
  stock: StockFilter
  category: string
  sort: SortKey
}

export const DEFAULT_FILTERS: ItemFilters = { q: '', stages: [], conditions: [], stock: 'all', category: '', sort: 'recent' }

export const SORTS: { value: SortKey; label: string }[] = [
  { value: 'recent', label: 'Recently updated' },
  { value: 'price_low', label: 'Retail price: low to high' },
  { value: 'price_high', label: 'Retail price: high to low' },
  { value: 'available', label: 'Most available' },
  { value: 'code', label: 'Product code' },
]

/** Everything a person might type: code, name, category, material, size, notes, and the stage/condition names. */
function haystack(i: InventoryItem): string {
  return [i.product_code, i.name, i.category, i.material, i.size_text, i.description, stageLabel(i.stage), conditionLabel(i.condition)]
    .filter(Boolean).join(' ').toLowerCase()
}

export function filterItems(items: InventoryItem[], f: ItemFilters): InventoryItem[] {
  const words = f.q.toLowerCase().split(/\s+/).filter(Boolean)
  return items.filter(i => {
    if (f.stages.length && !f.stages.includes(i.stage)) return false
    if (f.conditions.length && !f.conditions.includes(i.condition)) return false
    if (f.stock === 'available' && i.qty_available <= 0) return false
    if (f.stock === 'sold_out' && i.qty_available > 0) return false
    if (f.category && (i.category ?? '') !== f.category) return false
    if (words.length) {
      const h = haystack(i)
      if (!words.every(w => h.includes(w))) return false
    }
    return true
  })
}

export function sortItems(items: InventoryItem[], key: SortKey): InventoryItem[] {
  const out = [...items]
  switch (key) {
    case 'price_low': return out.sort((a, b) => a.retail_price - b.retail_price || a.product_code.localeCompare(b.product_code))
    case 'price_high': return out.sort((a, b) => b.retail_price - a.retail_price || a.product_code.localeCompare(b.product_code))
    case 'available': return out.sort((a, b) => b.qty_available - a.qty_available || a.product_code.localeCompare(b.product_code))
    case 'code': return out.sort((a, b) => a.product_code.localeCompare(b.product_code, undefined, { numeric: true }))
    default: return out.sort((a, b) => b.updated_at.localeCompare(a.updated_at))
  }
}

export const categoriesOf = (items: InventoryItem[]): string[] =>
  [...new Set(items.map(i => i.category).filter((c): c is string => !!c))].sort((a, b) => a.localeCompare(b))

export const activeFilterCount = (f: ItemFilters): number =>
  f.stages.length + f.conditions.length + (f.stock !== 'all' ? 1 : 0) + (f.category ? 1 : 0)

export type Totals = { products: number; units: number; available: number; sold: number; reserved: number; value: number }

/** The stats strip. `value` is the retail price of what is still available. */
export function totalsOf(items: InventoryItem[]): Totals {
  return items.reduce<Totals>((t, i) => ({
    products: t.products + 1,
    units: t.units + i.qty_total,
    available: t.available + i.qty_available,
    sold: t.sold + i.qty_sold,
    reserved: t.reserved + i.qty_reserved,
    value: t.value + i.qty_available * Number(i.retail_price),
  }), { products: 0, units: 0, available: 0, sold: 0, reserved: 0, value: 0 })
}
