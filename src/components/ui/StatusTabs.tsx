'use client'

import { colors } from '@/lib/tokens'
import type { LucideIcon } from 'lucide-react'

// ── List status navigation ────────────────────────────────────────────────────
// Shared by Payment Requests, Received Payments, and Order Requests, and a port
// of the strip introduced on Confirmed Orders (src/app/orders/all/page.tsx),
// which keeps its own inline copy as the reference implementation. It is
// deliberately *not* styled like the toolbar controls above it: flat background,
// no boxed border, underline indicator. Filters are form controls; this is
// navigation over the data below.
//
// Callers own their statuses — this file has no opinion on what the tabs mean.
// Pass the accent from the page's existing row-badge palette so a status wears
// one colour in the strip, the row, and the modal.

export type TabAccent = {
  color: string        // text + icon + underline
  tint: string         // active tab background
  badge: string        // count badge, inactive
  badgeActive: string  // count badge, active
}

// Builds an accent from the `{ bg, color, border }` shape every consuming page
// already uses for its STATUS_META row badges.
export function accentFromBadge(meta: { bg: string; color: string; border: string }): TabAccent {
  return { color: meta.color, tint: meta.bg, badge: meta.bg, badgeActive: meta.border }
}

// The BOE brand accent, for an "All"/"Total" tab that has no row-badge
// equivalent of its own.
export const BRAND_TAB_ACCENT: TabAccent = {
  color: '#DC1F2E',
  tint: 'rgba(220,31,46,0.055)',
  badge: 'rgba(220,31,46,0.09)',
  badgeActive: 'rgba(220,31,46,0.17)',
}

export type StatusTab<K extends string> = {
  key: K
  label: string
  Icon: LucideIcon
  accent: TabAccent
  /**
   * How many records the tab holds, or NULL when that is not yet known.
   *
   * NULL IS A REAL ANSWER, not a missing one. A tab counted by the database can
   * be in flight, or its count query can fail while the list itself loaded
   * fine — and a confident `0` on a tab that actually holds records is worse
   * than no number at all: it tells somebody the work is done. It renders as a
   * dash, which reads as "not known" rather than as "none".
   *
   * Callers that count in memory pass a number and are unaffected.
   */
  count: number | null
}

export function StatusTabs<K extends string>({
  tabs,
  active,
  onSelect,
  summary,
}: {
  tabs: StatusTab<K>[]
  active: K
  onSelect: (key: K) => void
  /** Small muted result count, right-aligned and outside the scroll area. */
  summary?: string
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'stretch', gap: '12px',
      borderBottom: `1px solid ${colors.border}`, padding: '0 14px 0 6px',
    }}>
      {/* Scrolls as one line on narrow viewports; never wraps or stacks. */}
      <div style={{
        display: 'flex', alignItems: 'stretch', gap: 'clamp(10px, 1.9vw, 24px)',
        flex: 1, minWidth: 0, overflowX: 'auto',
      }}>
        {tabs.map(({ key, label, Icon, accent, count }) => {
          const isActive = active === key
          return (
            <button
              key={key}
              onClick={() => onSelect(key)}
              aria-pressed={isActive}
              style={{
                display: 'flex', alignItems: 'center', gap: '5px',
                padding: '8px 8px 7px', border: 'none',
                background: isActive ? accent.tint : 'transparent',
                borderRadius: '6px 6px 0 0',
                borderBottom: `2px solid ${isActive ? accent.color : 'transparent'}`,
                fontSize: '12px', fontWeight: isActive ? 700 : 500,
                color: isActive ? accent.color : colors.primary,
                cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0,
                transition: 'background 0.12s, color 0.12s',
              }}
            >
              <Icon
                size={14}
                style={{ color: accent.color, opacity: isActive ? 1 : 0.55, flexShrink: 0 }}
                aria-hidden
              />
              {label}
              <span style={{
                minWidth: '18px', padding: '1px 5px', borderRadius: '999px',
                background: isActive ? accent.badgeActive : accent.badge,
                color: accent.color, fontSize: '10px', fontWeight: 700,
                lineHeight: '15px', textAlign: 'center',
              }}>
                {count ?? '—'}
              </span>
            </button>
          )
        })}
      </div>
      {summary && (
        <div style={{
          display: 'flex', alignItems: 'center', flexShrink: 0,
          fontSize: '11px', color: colors.muted, whiteSpace: 'nowrap',
        }}>
          {summary}
        </div>
      )}
    </div>
  )
}
