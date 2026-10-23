'use client'

import { colors } from '@/lib/tokens'
import { LIST_PAGE_SIZE, listPageCount, listPageSpan, needsPager, pageSlots } from '@/lib/listPaging'

type Props = {
  /** 1-based current page. */
  page: number
  /** Exact total rows behind the list, or null while it is not known yet. */
  total: number | null
  onPage: (next: number) => void
  pageSize?: number
  /** Called when a button is hovered or focused, so that page can be read early. */
  onIntent?: (page: number) => void
  /** Names the list for screen readers: "Samples pages". */
  label: string
  /** The next page is loading while the old one stays visible. */
  busy?: boolean
}

/**
 * The page strip under a long list: Previous, numbered pages with gaps, Next,
 * and "31–60 of 212".
 *
 * RENDERS NOTHING UNLESS THE LIST DOES NOT FIT ON ONE PAGE. A list of 30 rows or
 * fewer looks exactly as it did before paging existed.
 */
export function Pagination({ page, total, onPage, pageSize = LIST_PAGE_SIZE, onIntent, label, busy = false }: Props) {
  if (!needsPager(total, pageSize) || total === null) return null
  const pages = listPageCount(total, pageSize)
  const { first, last } = listPageSpan(page, total, pageSize)

  const button = (content: string, target: number, opts: { disabled?: boolean; current?: boolean; aria?: string }) => (
    <button
      key={`${content}-${target}`}
      type="button"
      disabled={opts.disabled}
      aria-label={opts.aria}
      aria-current={opts.current ? 'page' : undefined}
      onClick={() => onPage(target)}
      onMouseEnter={() => onIntent?.(target)}
      onFocus={() => onIntent?.(target)}
      style={{
        minWidth: '30px', padding: '5px 10px', borderRadius: '6px',
        fontSize: '12px', fontWeight: opts.current ? 700 : 500,
        background: opts.current ? colors.primary : colors.base,
        border: `1px solid ${opts.current ? colors.primary : colors.border}`,
        color: opts.current ? '#fff' : opts.disabled ? colors.muted : colors.primary,
        cursor: opts.disabled ? 'default' : 'pointer',
        opacity: opts.disabled ? 0.55 : 1,
      }}
    >
      {content}
    </button>
  )

  return (
    <nav
      aria-label={label}
      aria-busy={busy}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: '10px', flexWrap: 'wrap', marginTop: '14px',
        opacity: busy ? 0.7 : 1, transition: 'opacity 0.12s',
      }}
    >
      <span style={{ fontSize: '12px', color: colors.muted }}>{`${first}–${last} of ${total}`}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexWrap: 'wrap' }}>
        {button('‹', page - 1, { disabled: page <= 1, aria: 'Previous page' })}
        {pageSlots(page, pages).map((slot, i) =>
          slot === 'gap'
            ? <span key={`gap-${i}`} aria-hidden="true" style={{ padding: '0 4px', color: colors.muted, fontSize: '12px' }}>…</span>
            : button(String(slot), slot, { current: slot === page, aria: `Page ${slot}` }),
        )}
        {button('›', page + 1, { disabled: page >= pages, aria: 'Next page' })}
      </div>
    </nav>
  )
}
