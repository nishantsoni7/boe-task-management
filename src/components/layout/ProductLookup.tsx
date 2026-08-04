'use client'

import { useEffect, useRef, useState } from 'react'
import { Search, X } from 'lucide-react'
import { useShowroomProductLookup } from '@/hooks/queries/useShowroomProductLookup'
import {
  LOOKUP_DEBOUNCE_MS,
  lookupResultHref,
  normalizeLookupQuery,
  resolveLookupKey,
  shouldRunLookup,
  type ProductLookupResult,
} from '@/lib/showroom/productLookup'

// Find a product without knowing its category.
//
// This is what the removed "All Products" tab was actually used for: someone
// reads a code off a QR label and wants that product. It is a jump-to control,
// not a catalogue view — no status filter, no sort, no paging, no totals, and
// it never changes what the list beside it is showing.
//
// Dismissal: click-away closes it. That is allowed here and not a breach of the
// BOE Form Modal Dismissal Rule, which governs FORM modals holding typed work
// (src/lib/ui/modalDismissal.ts explicitly exempts read-only pop-ups). Nothing
// is lost by closing a search result list.
//
// The results list is a separate hook-free component so its markup can be
// asserted without a network or a DOM.

export type ProductLookupProps = {
  /** Navigate to a product. The layout supplies this so the drawer closes too. */
  onOpenProduct: (href: string) => void
  /** False while the viewer may not manage products — the box does not fetch. */
  enabled: boolean
}

export function ProductLookup({ onOpenProduct, enabled }: ProductLookupProps) {
  const [query, setQuery]         = useState('')
  const [term, setTerm]           = useState('')
  const [open, setOpen]           = useState(false)
  const [highlight, setHighlight] = useState(-1)

  const boxRef   = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Debounce typing into the fetched term. Only the non-blank case waits:
  // clearing the box drops the term immediately, at the event that cleared it,
  // so no effect ever writes state synchronously.
  useEffect(() => {
    const next = normalizeLookupQuery(query)
    if (!next || next === term) return
    const timer = setTimeout(() => setTerm(next), LOOKUP_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [query, term])

  const { results, loading, failed } = useShowroomProductLookup(term, enabled && open)

  // A new set of matches invalidates the old highlight — otherwise Enter could
  // open row 3 of a list the user is no longer looking at. Adjusted during
  // render rather than in an effect, so the stale highlight is never painted.
  const [prevResults, setPrevResults] = useState(results)
  if (results !== prevResults) {
    setPrevResults(results)
    setHighlight(-1)
  }

  // Click-away. Pointerdown rather than click so it beats a result's own click
  // only when the pointer went down outside the box.
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [open])

  const openResult = (result: ProductLookupResult) => {
    setOpen(false)
    setQuery('')
    setTerm('')
    onOpenProduct(lookupResultHref(result.product_code))
  }

  const resultsOpen = open && shouldRunLookup(term) && results.length > 0

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const action = resolveLookupKey({
      key: e.key,
      resultsOpen,
      count: results.length,
      highlight,
      hasQuery: query.length > 0,
    })
    if (!action) return
    e.preventDefault()

    if (action.action === 'move')  setHighlight(action.index)
    if (action.action === 'close') setOpen(false)
    if (action.action === 'clear') { setQuery(''); setTerm('') }
    if (action.action === 'open') {
      const picked = results[action.index]
      if (picked) openResult(picked)
    }
  }

  const showPanel = open && shouldRunLookup(term)

  return (
    <div ref={boxRef} style={{ position: 'relative', padding: '0 4px 8px' }}>
      <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
        <Search
          size={13}
          strokeWidth={2}
          aria-hidden="true"
          style={{ position: 'absolute', left: 9, color: '#A0A9BE', pointerEvents: 'none' }}
        />
        <input
          ref={inputRef}
          type="search"
          value={query}
          onChange={e => {
            const value = e.target.value
            setQuery(value)
            setOpen(true)
            // Backspacing to empty drops the results at once — there is nothing
            // left to debounce, and a stale list under an empty box reads as a
            // result for the term the user just deleted.
            if (!normalizeLookupQuery(value)) setTerm('')
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder="Find a product…"
          aria-label="Find a product by code or name"
          aria-expanded={resultsOpen}
          aria-controls="boe-product-lookup-results"
          role="combobox"
          aria-autocomplete="list"
          style={{
            width: '100%',
            // Comfortably tappable in the mobile drawer, matching .boe-nav-item.
            minHeight: 36,
            padding: '7px 26px 7px 27px',
            fontSize: '12.5px',
            color: '#111318',
            background: 'rgba(0,0,0,0.035)',
            border: '1px solid rgba(0,0,0,0.08)',
            borderRadius: '8px',
            outline: 'none',
            // The browser's own search reset would sit on top of the ✕ below.
            WebkitAppearance: 'none',
            appearance: 'none',
          }}
        />
        {query && (
          <button
            type="button"
            onClick={() => { setQuery(''); setTerm(''); inputRef.current?.focus() }}
            aria-label="Clear product search"
            title="Clear product search"
            style={{
              position: 'absolute', right: 6,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 18, height: 18, padding: 0,
              color: '#8C94A6', background: 'transparent',
              border: 'none', borderRadius: '4px', cursor: 'pointer',
            }}
          >
            <X size={12} strokeWidth={2.2} />
          </button>
        )}
      </div>

      {showPanel && (
        <ProductLookupResults
          results={results}
          loading={loading}
          failed={failed}
          highlight={highlight}
          onPick={openResult}
          onHighlight={setHighlight}
        />
      )}
    </div>
  )
}

// ── Results ───────────────────────────────────────────────────────────────────

export type ProductLookupResultsProps = {
  results: ProductLookupResult[]
  loading: boolean
  failed: boolean
  highlight: number
  onPick: (result: ProductLookupResult) => void
  onHighlight: (index: number) => void
}

/**
 * The matches, or why there are none.
 *
 * Every row shows the code, the name AND the category. All three are required,
 * not decorative: two products can share a name, and the category is what tells
 * the user which of them they are about to open — as well as where they will
 * land when they get there.
 */
export function ProductLookupResults({
  results, loading, failed, highlight, onPick, onHighlight,
}: ProductLookupResultsProps) {
  const shell: React.CSSProperties = {
    position: 'absolute', left: 4, right: 4, top: '100%', zIndex: 120,
    marginTop: 4, padding: '4px',
    background: '#FFFFFF',
    border: '1px solid rgba(0,0,0,0.10)',
    borderRadius: '10px',
    boxShadow: '0 6px 20px rgba(0,0,0,0.13), 0 1px 4px rgba(0,0,0,0.06)',
    maxHeight: 300, overflowY: 'auto',
  }

  const note = (text: string) => (
    <div style={{ ...shell, padding: '10px 12px', fontSize: '12px', color: '#707A92' }}>{text}</div>
  )

  if (failed)              return note('Couldn’t search products. Try again.')
  if (loading && !results.length) return note('Searching…')
  if (!results.length)     return note('No matching product')

  return (
    <ul
      id="boe-product-lookup-results"
      role="listbox"
      aria-label="Product search results"
      style={{ ...shell, listStyle: 'none', margin: 0 }}
    >
      {results.map((result, i) => {
        const active = i === highlight
        return (
          <li key={result.id} role="none">
            <button
              type="button"
              role="option"
              aria-selected={active}
              onClick={() => onPick(result)}
              onMouseEnter={() => onHighlight(i)}
              style={{
                display: 'block', width: '100%', textAlign: 'left',
                padding: '7px 9px', border: 'none', borderRadius: '7px',
                background: active ? 'rgba(0,0,0,0.055)' : 'transparent',
                cursor: 'pointer',
              }}
            >
              <span style={{
                display: 'flex', alignItems: 'center', gap: 7,
                fontSize: '11px', fontWeight: 600, color: '#1A2035',
                fontFamily: "'DM Mono', monospace",
              }}>
                {result.product_code}
              </span>
              <span style={{
                display: 'block', fontSize: '12.5px', color: '#111318',
                marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                {result.name}
              </span>
              {/* Always rendered: it disambiguates two products with one name,
                  and names the category the click is about to navigate into. */}
              <span style={{ display: 'block', fontSize: '11px', color: '#8C94A6', marginTop: 1 }}>
                {result.category || 'Uncategorised'}
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}
