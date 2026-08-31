'use client'

import { Monitor, Key } from 'lucide-react'
import { colors } from '@/lib/tokens'
import { ASSETS_AREA_LABEL, type AssetsArea } from '@/lib/assets/viewRouting'

// The module's top-level switch: Assets ⇄ Access Records, with that area's one
// primary action on the right.
//
// WHY THIS EXISTS. Assets & Access is two subjects in one module, and the
// sidebar presented five sibling entries with no statement of which subject the
// reader was in. The switch makes the subject the first thing on the page; the
// sidebar keeps doing what it is good at, which is the detail inside an area.
//
// THE ACTIVE AREA IS OBVIOUS BY THREE SIGNALS AT ONCE — filled BOE-red pill,
// white text, and aria-current. One signal is a preference; three is a control
// that still reads on a dim phone screen, and one of them is readable by a
// screen reader.
//
// Pill tabs rather than an underline strip, matching the asset detail page's
// own tab row (src/app/assets-access/[id]/page.tsx) so the module looks like
// one module. The pattern is deliberately NOT StatusTabs: that component is a
// status filter over one list and requires a count per tab, and "how many
// Assets" is not a number this switch has or should invent.
//
// MOBILE. Two tabs and one button, so there is nothing to scroll and nothing
// to collapse. Below 768px the action moves to its own full-width row under the
// tabs instead of wrapping beside them — a right-aligned button that wraps onto
// a second line ends up floating with no visible relationship to anything.

export type AssetsAreaTabsProps = {
  active: AssetsArea
  onSelect: (area: AssetsArea) => void
  /** The area's primary action, rendered on the right. Omitted when the reader holds none. */
  action?: React.ReactNode
  isMobile?: boolean
}

const AREA_ICON: Record<AssetsArea, React.ReactNode> = {
  'assets':         <Monitor size={14} strokeWidth={1.9} aria-hidden />,
  'access-records': <Key     size={14} strokeWidth={1.9} aria-hidden />,
}

const AREAS: AssetsArea[] = ['assets', 'access-records']

const BOE_RED = '#DC1F2E'

export function AssetsAreaTabs({ active, onSelect, action, isMobile }: AssetsAreaTabsProps) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: isMobile ? 'column' : 'row',
        alignItems: isMobile ? 'stretch' : 'center',
        justifyContent: 'space-between',
        gap: isMobile ? '10px' : '14px',
        marginBottom: '16px',
        paddingBottom: '12px',
        borderBottom: `1px solid ${colors.border}`,
      }}
    >
      <div
        role="tablist"
        aria-label="Assets and Access areas"
        style={{ display: 'flex', gap: '8px', minWidth: 0 }}
      >
        {AREAS.map(area => {
          const isActive = area === active
          return (
            <button
              key={area}
              role="tab"
              aria-selected={isActive}
              aria-current={isActive ? 'page' : undefined}
              onClick={() => onSelect(area)}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: '7px',
                // Equal width on mobile so the two read as one control rather
                // than as a label beside a button.
                flex: isMobile ? '1 1 0' : '0 0 auto',
                justifyContent: 'center',
                padding: isMobile ? '9px 12px' : '8px 18px',
                borderRadius: '22px',
                fontSize: '13px', fontWeight: isActive ? 700 : 600,
                border: `1.5px solid ${isActive ? BOE_RED : colors.border}`,
                background: isActive ? BOE_RED : colors.base,
                color: isActive ? '#fff' : colors.secondary,
                cursor: 'pointer', whiteSpace: 'nowrap',
              }}
            >
              <span style={{ display: 'flex', opacity: isActive ? 1 : 0.65 }}>{AREA_ICON[area]}</span>
              {ASSETS_AREA_LABEL[area]}
            </button>
          )
        })}
      </div>

      {action && (
        <div style={{
          display: 'flex', justifyContent: isMobile ? 'stretch' : 'flex-end',
          flexShrink: 0,
        }}>
          {action}
        </div>
      )}
    </div>
  )
}
