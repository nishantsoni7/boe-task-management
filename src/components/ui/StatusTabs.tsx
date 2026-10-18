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

// A count chip sits on the accent's own pale fill; whatever accent a page passes in, its number must be
// readable. Darken the foreground toward charcoal until it clears 4.5:1 (pale fills are blended over white).
function channels(css: string): [number, number, number, number] | null {
  const hex = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(css.trim())
  if (hex) {
    const n = parseInt(hex[1], 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, hex[2] ? parseInt(hex[2], 16) / 255 : 1]
  }
  const rgba = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(css.trim())
  return rgba ? [Number(rgba[1]), Number(rgba[2]), Number(rgba[3]), rgba[4] === undefined ? 1 : Number(rgba[4])] : null
}
function luminance([r, g, b]: [number, number, number]): number {
  const f = (v: number) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4) }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}
export function legibleOn(fg: string, fill: string): string {
  const f = channels(fg)
  const b = channels(fill)
  if (!f || !b) return fg
  const bg: [number, number, number] = [0, 1, 2].map((i) => Math.round(b[i] * b[3] + 255 * (1 - b[3]))) as [number, number, number]
  const ink = [48, 53, 54]
  for (let t = 0; t <= 1.0001; t += 0.1) {
    const c = [0, 1, 2].map((i) => Math.round(f[i] * (1 - t) + ink[i] * t)) as [number, number, number]
    const l1 = luminance(c), l2 = luminance(bg)
    if ((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05) >= 5.2) return t === 0 ? fg : `rgb(${c[0]}, ${c[1]}, ${c[2]})`
  }
  return fg
}

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
  color: '#B9472E',
  tint: 'rgba(185,71,46,0.055)',
  badge: 'rgba(185,71,46,0.09)',
  badgeActive: 'rgba(185,71,46,0.17)',
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

/**
 * How tall a tab is, and it is a per-caller choice rather than a global one.
 *
 * `compact` (the default) is the strip Payment Requests, Received Payments and
 * Order Requests have always had — those are desk tools, and changing their
 * density is not this module's business.
 *
 * `touch` raises every tab to a 44px target for a screen whose PRIMARY audience
 * is a thumb. Review Workflow is used mainly from a phone, where its tab strip
 * is the whole navigation: at 35px it was under the comfortable minimum the
 * module holds every one of its own controls to. Adding a prop was the smallest
 * change that fixes it without moving Finance and Orders — the default is
 * byte-identical to what they render today.
 */
export type StatusTabSize = 'compact' | 'touch' | 'roomy'

export function StatusTabs<K extends string>({
  tabs,
  active,
  onSelect,
  summary,
  size = 'compact',
}: {
  tabs: StatusTab<K>[]
  active: K
  onSelect: (key: K) => void
  /** Small muted result count, right-aligned and outside the scroll area. */
  summary?: string
  size?: StatusTabSize
}) {
  const touch = size === 'touch'
  // `roomy` is Finance's own: the same strip with more air (a 44px bar and 13px
  // labels) so it matches the Confirmed Payments tab bar. `compact` and `touch`
  // render exactly as before.
  const roomy = size === 'roomy'
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
                // The touch size raises the HIT AREA and leaves the type alone:
                // a taller tab is easier to press, a bigger one is just louder.
                minHeight: touch || roomy ? '44px' : undefined,
                padding: touch ? '10px 11px 9px' : roomy ? '11px 12px 10px' : '8px 8px 7px', border: 'none',
                background: isActive ? accent.tint : 'transparent',
                borderRadius: '6px 6px 0 0',
                borderBottom: `2px solid ${isActive ? accent.color : 'transparent'}`,
                fontSize: roomy ? '13px' : '12px', fontWeight: isActive ? 700 : 500,
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
                color: legibleOn(accent.color, isActive ? accent.badgeActive : accent.badge), fontSize: '12px', fontWeight: 700,
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
          fontSize: '12px', color: colors.muted, whiteSpace: 'nowrap',
        }}>
          {summary}
        </div>
      )}
    </div>
  )
}
