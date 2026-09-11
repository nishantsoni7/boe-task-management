'use client'

import { useId } from 'react'
import { colors } from '@/lib/tokens'
import { COMPLETED_PAGE_SIZE, pageSpan, totalPages, type CompletionSummary } from '@/lib/tasks/taskReporting'

// The pieces both Completed pages share: the summary counts, the completion
// date filter and the pager. Presentation only — every number comes from the
// database through the page's hooks.

const SUMMARY_ROWS: { key: keyof CompletionSummary; label: string }[] = [
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'last7',     label: 'Last 7 days' },
  { key: 'last30',    label: 'Last 30 days' },
]

/** `compact` is the mobile strip; otherwise the 220px card for the right column. */
export function CompletionSummaryCard({
  summary, compact = false,
}: {
  summary: CompletionSummary | undefined
  compact?: boolean
}) {
  const shown = (key: keyof CompletionSummary) => (summary ? String(summary[key]) : '—')

  if (compact) {
    return (
      <section aria-label="Completed summary" style={{
        display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px', marginBottom: '10px',
      }}>
        {SUMMARY_ROWS.map(row => (
          <div key={row.key} style={{
            background: colors.raised, border: `1.5px solid ${colors.border}`,
            borderRadius: '8px', padding: '8px 10px',
          }}>
            <div style={{ fontSize: '16px', fontWeight: 700, color: colors.primary, lineHeight: 1.1 }}>
              {shown(row.key)}
            </div>
            <div style={{ fontSize: '10.5px', color: colors.muted, marginTop: '3px', whiteSpace: 'nowrap' }}>
              {row.label}
            </div>
          </div>
        ))}
      </section>
    )
  }

  return (
    <section aria-label="Completed summary" style={{
      width: '220px', flexShrink: 0, boxSizing: 'border-box',
      background: colors.base, border: `1.5px solid ${colors.border}`,
      borderRadius: '10px', padding: '12px 14px',
    }}>
      <div style={{ fontSize: '12px', fontWeight: 600, color: colors.primary, marginBottom: '6px' }}>
        Completed
      </div>
      {SUMMARY_ROWS.map((row, i) => (
        <div key={row.key} style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
          padding: '6px 0', borderTop: i === 0 ? 'none' : `1px solid ${colors.border}`,
        }}>
          <span style={{ fontSize: '11.5px', color: colors.secondary }}>{row.label}</span>
          <span style={{ fontSize: '13px', fontWeight: 700, color: colors.primary, fontVariantNumeric: 'tabular-nums' }}>
            {shown(row.key)}
          </span>
        </div>
      ))}
    </section>
  )
}

/** "Completed on: [date]" with a Clear action. Empty value means any date. */
export function CompletedOnFilter({
  value, onChange,
}: {
  value: string
  onChange: (next: string) => void
}) {
  const inputId = useId()
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
      <label htmlFor={inputId} style={{ fontSize: '11.5px', color: colors.muted, whiteSpace: 'nowrap' }}>
        Completed on:
      </label>
      <input
        id={inputId}
        type="date"
        value={value}
        onChange={e => onChange(e.target.value)}
        style={{
          padding: '3px 8px', background: colors.base, border: `1px solid ${colors.border}`,
          borderRadius: '6px', outline: 'none', fontSize: '11.5px',
          color: value ? colors.primary : colors.muted, cursor: 'pointer',
        }}
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label="Clear completed date"
          style={{
            padding: '3px 8px', background: 'transparent', border: `1px solid ${colors.border}`,
            borderRadius: '6px', fontSize: '11px', color: colors.secondary, cursor: 'pointer',
          }}
        >
          Clear
        </button>
      )}
    </div>
  )
}

/** Previous / Next with position. Renders nothing while everything fits on one page. */
export function CompletedPager({
  page, total, onPage,
}: {
  page: number
  total: number
  onPage: (next: number) => void
}) {
  if (total <= COMPLETED_PAGE_SIZE) return null
  const pages = totalPages(total)
  const { first, last } = pageSpan(page, total)

  const button = (label: string, target: number, disabled: boolean) => (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onPage(target)}
      style={{
        padding: '5px 12px', borderRadius: '6px', fontSize: '12px', fontWeight: 500,
        background: colors.base, border: `1px solid ${colors.border}`,
        color: disabled ? colors.muted : colors.primary,
        cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.55 : 1,
      }}
    >
      {label}
    </button>
  )

  return (
    <nav aria-label="Completed task pages" style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      gap: '8px', flexWrap: 'wrap', marginTop: '12px',
    }}>
      {button('‹ Previous', page - 1, page <= 1)}
      <span style={{ fontSize: '11.5px', color: colors.muted }}>
        {`Page ${page} of ${pages} · ${first}–${last} of ${total}`}
      </span>
      {button('Next ›', page + 1, page >= pages)}
    </nav>
  )
}
