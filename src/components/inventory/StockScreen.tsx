'use client'

import { useCallback, useMemo, useState } from 'react'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { PackageOpen, Plus, Search, SlidersHorizontal, X } from 'lucide-react'
import { InventoryLayout } from '@/components/layout/InventoryLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { useInventory } from '@/hooks/useInventory'
import { fetchItems, itemsKey } from '@/lib/inventory/api'
import { CONDITIONS, STAGES, type Condition, type Stage } from '@/lib/inventory/constants'
import {
  DEFAULT_FILTERS, SORTS, activeFilterCount, categoriesOf, filterItems, sortItems, totalsOf,
  type ItemFilters, type SortKey, type StockFilter,
} from '@/lib/inventory/filters'
import { errorMessage } from '@/lib/inventory/errors'
import { imageUrl } from '@/lib/inventory/images'
import { ProductCard, ProductCardSkeleton } from './ProductCard'
import { Notice, Sheet } from './parts'
import s from './inventory.module.css'

export default function StockScreen() {
  const { supabase, profile, loading, signOut, access, pending } = useInventory()
  const [f, setF] = useState<ItemFilters>(DEFAULT_FILTERS)
  const [filtersOpen, setFiltersOpen] = useState(false)

  const itemsQ = useQuery({ queryKey: itemsKey, queryFn: () => fetchItems(supabase), enabled: !loading, staleTime: 30_000 })
  const items = useMemo(() => itemsQ.data ?? [], [itemsQ.data])
  const toUrl = useCallback((p: string) => imageUrl(supabase, p), [supabase])

  const visible = useMemo(() => sortItems(filterItems(items, f), f.sort), [items, f])
  const totals = useMemo(() => totalsOf(items), [items])
  const categories = useMemo(() => categoriesOf(items), [items])
  const stageCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const i of filterItems(items, { ...f, stages: [] })) m.set(i.stage, (m.get(i.stage) ?? 0) + 1)
    return m
  }, [items, f])
  const extra = activeFilterCount({ ...f, stages: [] })

  if (loading) return <LoadingScreen />
  const set = (patch: Partial<ItemFilters>) => setF(prev => ({ ...prev, ...patch }))
  const anyFilter = !!f.q || f.stages.length > 0 || extra > 0
  const reset = () => setF({ ...DEFAULT_FILTERS, sort: f.sort })
  const stageOn = (v: Stage) => f.stages.length === 1 && f.stages[0] === v

  return (
    <InventoryLayout
      profile={profile} access={access} pending={pending} onSignOut={signOut}
      title="Stock" subtitle={itemsQ.isSuccess ? `${totals.products} product${totals.products === 1 ? '' : 's'}` : undefined}
      showAddBar={access.create}
      actions={access.create ? <Link href="/inventory/new" className={`${s.btn} ${s.btnPrimary} ${s.btnSm} ${s.hideOnPhone}`}><Plus size={16} /> Add Product</Link> : undefined}
    >
      <div className={s.wrap}>
        <div className={s.stats}>
          <div className={s.stat}><span className={s.statLabel}>Available units</span><span className={s.statValue}>{totals.available}</span><span className={s.statNote}>of {totals.units} stocked</span></div>
          <div className={`${s.stat}${pending > 0 && access.approve ? ` ${s.statWarn}` : ''}`}>
            <span className={s.statLabel}>{access.approve ? 'Waiting for you' : 'My open requests'}</span>
            <span className={s.statValue}>{pending}</span>
            <span className={s.statNote}>{totals.reserved} unit{totals.reserved === 1 ? '' : 's'} reserved</span>
          </div>
          <div className={s.stat}><span className={s.statLabel}>Sold</span><span className={s.statValue}>{totals.sold}</span><span className={s.statNote}>confirmed units</span></div>
          <div className={s.stat}><span className={s.statLabel}>Products</span><span className={s.statValue}>{totals.products}</span><span className={s.statNote}>{items.filter(i => i.qty_available <= 0).length} sold out</span></div>
        </div>

        <div className={s.toolbar}>
          <div className={s.searchRow}>
            <div className={s.search}>
              <Search size={18} className={s.searchIcon} aria-hidden="true" />
              <input
                className={s.searchInput} type="search" inputMode="search" enterKeyHint="search" autoComplete="off"
                placeholder="Search products" aria-label="Search products"
                value={f.q} onChange={e => set({ q: e.target.value })}
              />
              {f.q && <button type="button" className={s.searchClear} onClick={() => set({ q: '' })} aria-label="Clear search"><X size={18} /></button>}
            </div>
            <button type="button" className={`${s.btn} ${s.filterBtn}`} onClick={() => setFiltersOpen(true)} aria-label="Filters and sorting">
              <SlidersHorizontal size={18} /><span>Filters</span>
              {extra > 0 && <span className={s.filterCount}>{extra}</span>}
            </button>
          </div>
          <div className={s.chipRow} role="group" aria-label="Filter by stage">
            <button type="button" className={`${s.chip}${f.stages.length === 0 ? ` ${s.chipOn}` : ''}`} aria-pressed={f.stages.length === 0} onClick={() => set({ stages: [] })}>
              All <span className={s.chipCount}>{[...stageCounts.values()].reduce((a, b) => a + b, 0)}</span>
            </button>
            {STAGES.slice().reverse().map(st => (
              <button key={st.value} type="button" className={`${s.chip}${stageOn(st.value) ? ` ${s.chipOn}` : ''}`} aria-pressed={stageOn(st.value)} onClick={() => set({ stages: stageOn(st.value) ? [] : [st.value] })}>
                {st.label} <span className={s.chipCount}>{stageCounts.get(st.value) ?? 0}</span>
              </button>
            ))}
          </div>
        </div>

        {itemsQ.isError && <Notice kind="err">{errorMessage(itemsQ.error)} <button type="button" className={s.linkBtn} onClick={() => itemsQ.refetch()}>Try again</button></Notice>}

        {itemsQ.isSuccess && anyFilter && (
          <div className={s.resultLine}>
            <span>{visible.length} of {items.length} shown</span>
            <button type="button" className={s.linkBtn} onClick={reset}>Clear filters</button>
          </div>
        )}

        {itemsQ.isLoading ? (
          <div className={s.grid} aria-busy="true" aria-label="Loading products">{Array.from({ length: 8 }, (_, i) => <ProductCardSkeleton key={i} />)}</div>
        ) : itemsQ.isSuccess && items.length === 0 ? (
          <div className={s.empty}>
            <div className={s.emptyIcon}><PackageOpen size={28} /></div>
            <div className={s.emptyTitle}>No products yet</div>
            <div className={s.emptyText}>{access.create ? 'Add the first piece of furniture with its photos, size and price. Your sales team will see it straight away.' : 'Products appear here as soon as the manager adds them.'}</div>
            {access.create && <Link href="/inventory/new" className={`${s.btn} ${s.btnPrimary}`}><Plus size={18} /> Add the first product</Link>}
          </div>
        ) : itemsQ.isSuccess && visible.length === 0 ? (
          <div className={s.empty}>
            <div className={s.emptyIcon}><Search size={26} /></div>
            <div className={s.emptyTitle}>Nothing matches</div>
            <div className={s.emptyText}>Try a different word, or clear the filters to see all {items.length} products.</div>
            <button type="button" className={`${s.btn} ${s.btnDark}`} onClick={reset}>Clear filters</button>
          </div>
        ) : (
          <div className={s.grid}>{visible.map((i, n) => <ProductCard key={i.id} item={i} toUrl={toUrl} priority={n < 4} />)}</div>
        )}
      </div>

      {filtersOpen && (
        <Sheet
          title="Filters" onClose={() => setFiltersOpen(false)}
          footer={<>
            <button type="button" className={s.btn} onClick={() => setF({ ...DEFAULT_FILTERS, stages: f.stages, q: f.q })}>Reset</button>
            <button type="button" className={`${s.btn} ${s.btnPrimary}`} onClick={() => setFiltersOpen(false)}>Show {visible.length} product{visible.length === 1 ? '' : 's'}</button>
          </>}
        >
          <div className={s.field}>
            <span className={s.label}>Availability</span>
            <div className={s.seg} role="group" aria-label="Availability">
              {([['all', 'All'], ['available', 'In stock'], ['sold_out', 'Sold out']] as [StockFilter, string][]).map(([v, l]) => (
                <button key={v} type="button" className={`${s.segBtn}${f.stock === v ? ` ${s.segOn}` : ''}`} aria-pressed={f.stock === v} onClick={() => set({ stock: v })}>{l}</button>
              ))}
            </div>
          </div>
          <div className={s.field}>
            <span className={s.label}>Condition</span>
            <div className={s.chipRow} style={{ flexWrap: 'wrap', overflow: 'visible' }} role="group" aria-label="Condition">
              {CONDITIONS.map(c => {
                const on = f.conditions.includes(c.value as Condition)
                return (
                  <button key={c.value} type="button" className={`${s.chip}${on ? ` ${s.chipOn}` : ''}`} aria-pressed={on}
                    onClick={() => set({ conditions: on ? f.conditions.filter(x => x !== c.value) : [...f.conditions, c.value as Condition] })}>{c.label}</button>
                )
              })}
            </div>
          </div>
          {categories.length > 0 && (
            <div className={s.field}>
              <label className={s.label} htmlFor="inv-cat">Category</label>
              <select id="inv-cat" className={s.select} value={f.category} onChange={e => set({ category: e.target.value })}>
                <option value="">All categories</option>
                {categories.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
          )}
          <div className={s.field}>
            <label className={s.label} htmlFor="inv-sort">Sort by</label>
            <select id="inv-sort" className={s.select} value={f.sort} onChange={e => set({ sort: e.target.value as SortKey })}>
              {SORTS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
        </Sheet>
      )}
    </InventoryLayout>
  )
}
