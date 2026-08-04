'use client'

import { Package, ChevronRight } from 'lucide-react'
import type { ProductCategoryCount } from '@/lib/showroom/productNav'

// Product Master's sidebar sub-navigation: the parent entry with the catalog
// total, and one child per stored category with its own count. This replaces
// the category tab strip that used to sit above the product table, so the list
// page gets that row of vertical space back.
//
// Category names are whatever `showroom_categories` stores — the component
// never maps, re-cases or re-labels them, so a click always filters on a value
// the products table actually holds.
//
// Deliberately hook-free: the layout owns routing, expansion and count loading,
// which keeps every rendering rule here testable by calling the function.

export type ProductMasterNavProps = {
  /** Stored categories with their counts, in the order they should appear. */
  categories: ProductCategoryCount[]
  /** Catalog total shown beside the parent entry. */
  totalCount: number
  /** Stored name of the category the current route is showing, or '' for none. */
  activeCategory: string
  /** Whether the current route lives anywhere under Product Master. */
  active: boolean
  expanded: boolean
  onParentClick: () => void
  onSelectCategory: (category: string) => void
}

export function ProductMasterNav({
  categories, totalCount, activeCategory, active, expanded,
  onParentClick, onSelectCategory,
}: ProductMasterNavProps) {
  return (
    <>
      <button
        className={`boe-nav-item${active ? ' active' : ''}`}
        onClick={onParentClick}
        aria-expanded={expanded}
        aria-current={active && !activeCategory ? 'page' : undefined}
        // Both counts are active-only, matching what Product Master lists by
        // default. Saying so once on the parent is enough — repeating "active"
        // on five children would be noise.
        title={`${totalCount} active products`}
        // Tighter gap than the default nav item: the row carries an icon, a
        // label, a two-part badge and a chevron, and at the 272px mobile drawer
        // width the default 9px gap is what tips the label onto a second line.
        style={{ fontWeight: active ? 600 : 400, marginBottom: '2px', gap: '7px' }}
      >
        <span style={{ color: active ? '#DC1F2E' : '#A0A9BE', display: 'flex', alignItems: 'center' }}>
          <Package size={15} strokeWidth={1.8} />
        </span>
        <span style={{ whiteSpace: 'nowrap' }}>Product Master</span>
        <CountBadge value={totalCount} suffix="active" style={{ marginLeft: 'auto' }} />
        <ChevronRight
          size={12}
          strokeWidth={2}
          aria-hidden="true"
          style={{
            opacity: 0.4, flexShrink: 0,
            transform: expanded ? 'rotate(90deg)' : 'none',
            transition: 'transform 0.15s',
          }}
        />
      </button>

      {expanded && categories.length > 0 && (
        <div style={{
          marginLeft: '18px', marginBottom: '4px', paddingLeft: '10px',
          borderLeft: '1px solid rgba(0,0,0,0.08)',
        }}>
          {categories.map(category => {
            const selected = category.name === activeCategory
            return (
              <button
                key={category.name}
                className={`boe-nav-item${selected ? ' active' : ''}`}
                onClick={() => onSelectCategory(category.name)}
                aria-current={selected ? 'page' : undefined}
                style={{
                  fontSize: '12.5px',
                  fontWeight: selected ? 600 : 400,
                  color: selected ? '#111318' : '#707A92',
                  padding: '5px 8px',
                  marginBottom: '1px',
                }}
              >
                <span style={{ flex: 1, minWidth: 0 }}>{category.name}</span>
                {/* Always rendered, including at zero — an empty category is a
                    fact worth showing, not an entry to hide. */}
                <CountBadge value={category.count} />
              </button>
            )
          })}
        </div>
      )}
    </>
  )
}

function CountBadge({
  value, suffix, style,
}: { value: number; suffix?: string; style?: React.CSSProperties }) {
  return (
    <span style={{
      fontSize: '10px', fontWeight: 600, color: '#8C94A6',
      fontFamily: "'DM Mono', monospace",
      background: 'rgba(0,0,0,0.07)', borderRadius: '999px',
      padding: '1px 6px', lineHeight: '15px',
      minWidth: '17px', textAlign: 'center', flexShrink: 0,
      whiteSpace: 'nowrap',
      ...style,
    }}>
      {value}
      {suffix && (
        <span style={{ fontSize: '9px', fontWeight: 500, opacity: 0.75, marginLeft: '2px' }}>{suffix}</span>
      )}
    </span>
  )
}
