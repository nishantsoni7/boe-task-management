'use client'

import { Search, X, SlidersHorizontal } from 'lucide-react'
import { colors, font } from '@/lib/tokens'

export const PRODUCTS_PER_PAGE = 15

export const SORT_OPTIONS = [
  { value: 'code_asc',  label: 'Product code A–Z' },
  { value: 'code_desc', label: 'Product code Z–A' },
  { value: 'name_asc',  label: 'Name A–Z' },
  { value: 'name_desc', label: 'Name Z–A' },
  { value: 'mrp_asc',   label: 'MRP low to high' },
  { value: 'mrp_desc',  label: 'MRP high to low' },
  { value: 'newest',    label: 'Newest added' },
  { value: 'oldest',    label: 'Oldest added' },
] as const

export const STATUS_OPTIONS = [
  { value: 'all',      label: 'All status' },
  { value: 'active',   label: 'Active' },
  { value: 'inactive', label: 'Inactive' },
] as const

export type SortValue   = (typeof SORT_OPTIONS)[number]['value']
export type StatusValue = (typeof STATUS_OPTIONS)[number]['value']
export type CategoryCount = { name: string; count: number }

const controlStyle: React.CSSProperties = {
  height: '36px',
  fontSize: '13px',
  color: colors.primary,
  background: colors.base,
  border: `1.5px solid ${colors.borderSoft}`,
  borderRadius: '7px',
  padding: '0 10px',
  outline: 'none',
  boxSizing: 'border-box',
  fontFamily: font.body,
  cursor: 'pointer',
}

// ── Category chips ────────────────────────────────────────────────────────────
// Chips (not a dropdown) because the catalog runs a handful of admin-managed
// categories; they stay one tap away and wrap instead of overflowing.

export function CategoryChips({
  categories, selected, allCount, disabled, onSelect,
}: {
  categories: CategoryCount[]
  selected: string
  allCount: number
  disabled: boolean
  onSelect: (category: string) => void
}) {
  const chips = [{ name: '', label: 'All Products', count: allCount },
    ...categories.map(c => ({ name: c.name, label: c.name, count: c.count }))]

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '12px' }}>
      {chips.map(chip => {
        const active = chip.name === selected
        return (
          <button
            key={chip.name || '__all__'}
            onClick={() => onSelect(chip.name)}
            disabled={disabled}
            aria-pressed={active}
            style={{
              display: 'flex', alignItems: 'center', gap: '7px',
              fontSize: '12.5px', fontWeight: active ? 600 : 500,
              color: active ? '#fff' : colors.secondary,
              background: active ? '#1A2035' : colors.base,
              border: `1.5px solid ${active ? '#1A2035' : colors.border}`,
              borderRadius: '999px',
              padding: '7px 13px',
              cursor: disabled ? 'default' : 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            {chip.label}
            <span style={{
              fontSize: '11px', fontWeight: 600,
              fontFamily: font.mono,
              color: active ? 'rgba(255,255,255,0.75)' : colors.muted,
            }}>
              {chip.count}
            </span>
          </button>
        )
      })}
    </div>
  )
}

// ── Search + status + sort ────────────────────────────────────────────────────

export function ProductToolbar({
  searchInput, status, sort, filtersActive, disabled,
  onSearchChange, onStatusChange, onSortChange, onClear,
}: {
  searchInput: string
  status: StatusValue
  sort: SortValue
  filtersActive: boolean
  disabled: boolean
  onSearchChange: (value: string) => void
  onStatusChange: (value: StatusValue) => void
  onSortChange: (value: SortValue) => void
  onClear: () => void
}) {
  return (
    <div style={{
      display: 'flex', flexWrap: 'wrap', gap: '8px',
      alignItems: 'center', marginBottom: '16px',
    }}>
      {/* Search */}
      <div style={{ position: 'relative', flex: '1 1 240px', minWidth: 0 }}>
        <Search
          size={14}
          strokeWidth={2}
          color={colors.muted}
          style={{ position: 'absolute', left: '11px', top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }}
        />
        <input
          value={searchInput}
          onChange={e => onSearchChange(e.target.value)}
          placeholder="Search products..."
          aria-label="Search products"
          style={{
            ...controlStyle,
            cursor: 'text',
            width: '100%',
            padding: searchInput ? '0 32px 0 32px' : '0 11px 0 32px',
          }}
        />
        {searchInput && (
          <button
            onClick={() => onSearchChange('')}
            title="Clear search"
            aria-label="Clear search"
            style={{
              position: 'absolute', right: '8px', top: '50%', transform: 'translateY(-50%)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 20, height: 20,
              color: colors.muted, background: 'transparent',
              border: 'none', borderRadius: '4px', cursor: 'pointer', padding: 0,
            }}
          >
            <X size={13} strokeWidth={2} />
          </button>
        )}
      </div>

      <select
        value={status}
        onChange={e => onStatusChange(e.target.value as StatusValue)}
        disabled={disabled}
        aria-label="Filter by status"
        style={{ ...controlStyle, flex: '0 0 auto' }}
      >
        {STATUS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>

      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flex: '0 0 auto' }}>
        <SlidersHorizontal size={13} strokeWidth={1.8} color={colors.muted} />
        <select
          value={sort}
          onChange={e => onSortChange(e.target.value as SortValue)}
          disabled={disabled}
          aria-label="Sort products"
          style={controlStyle}
        >
          {SORT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>

      {filtersActive && (
        <button
          onClick={onClear}
          style={{
            ...controlStyle,
            display: 'flex', alignItems: 'center', gap: '5px',
            fontSize: '12.5px', fontWeight: 500,
            color: colors.secondary,
            background: colors.float,
            border: `1.5px solid ${colors.border}`,
            flex: '0 0 auto',
          }}
        >
          <X size={13} strokeWidth={2} />
          Clear filters
        </button>
      )}
    </div>
  )
}

// ── Pagination ────────────────────────────────────────────────────────────────

// Condense long page runs to "1 … 4 5 6 … 20" so the control never grows past a
// single row.
export function pageWindow(current: number, last: number): (number | 'gap')[] {
  if (last <= 7) return Array.from({ length: last }, (_, i) => i + 1)

  const out: (number | 'gap')[] = [1]
  const start = Math.max(2, current - 1)
  const end   = Math.min(last - 1, current + 1)

  if (start > 2) out.push('gap')
  for (let i = start; i <= end; i++) out.push(i)
  if (end < last - 1) out.push('gap')
  out.push(last)

  return out
}

function pageBtnStyle(state: 'active' | 'idle' | 'disabled'): React.CSSProperties {
  return {
    minWidth: 32, height: 32,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: '12.5px',
    fontWeight: state === 'active' ? 600 : 500,
    fontFamily: font.body,
    color: state === 'active' ? '#fff' : state === 'disabled' ? colors.muted : colors.secondary,
    background: state === 'active' ? '#1A2035' : colors.base,
    border: `1.5px solid ${state === 'active' ? '#1A2035' : colors.border}`,
    borderRadius: '7px',
    padding: '0 9px',
    cursor: state === 'disabled' ? 'not-allowed' : 'pointer',
    opacity: state === 'disabled' ? 0.55 : 1,
  }
}

export function ProductPagination({
  page, lastPage, busy, onPageChange,
}: {
  page: number
  lastPage: number
  busy: boolean
  onPageChange: (page: number) => void
}) {
  if (lastPage <= 1) return null

  const atStart = page <= 1
  const atEnd   = page >= lastPage

  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      flexWrap: 'wrap', gap: '6px', marginTop: '14px',
    }}>
      <button
        onClick={() => onPageChange(page - 1)}
        disabled={atStart || busy}
        style={pageBtnStyle(atStart || busy ? 'disabled' : 'idle')}
      >
        Previous
      </button>

      {pageWindow(page, lastPage).map((entry, i) =>
        entry === 'gap' ? (
          <span key={`gap-${i}`} style={{ color: colors.muted, fontSize: '12.5px', padding: '0 2px' }}>…</span>
        ) : (
          <button
            key={entry}
            onClick={() => onPageChange(entry)}
            disabled={busy}
            aria-current={entry === page ? 'page' : undefined}
            style={pageBtnStyle(entry === page ? 'active' : busy ? 'disabled' : 'idle')}
          >
            {entry}
          </button>
        ),
      )}

      <button
        onClick={() => onPageChange(page + 1)}
        disabled={atEnd || busy}
        style={pageBtnStyle(atEnd || busy ? 'disabled' : 'idle')}
      >
        Next
      </button>
    </div>
  )
}
