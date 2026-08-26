'use client'

import { colors } from '@/lib/tokens'

// The compact, layout-stable stand-in for the notification list while the first
// page is still in flight.
//
// It exists because the alternatives are both wrong. A full-screen
// <LoadingScreen /> unmounts the module shell, so the sidebar stops responding
// and leaving the page has to wait for a request that is only needed to STAY on
// it. Rendering the list area empty shows "No notifications yet" — a factual
// claim about the user's inbox, made before anything has been read.
//
// So: same card, same row height, same left rail, no content. The list that
// arrives replaces it without the page moving.
export function NotificationListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div
      className="boe-card"
      style={{ overflow: 'hidden', padding: 0, maxWidth: '900px' }}
      // Announced rather than silent: a screen reader is told the list is
      // loading instead of being handed an empty region.
      role="status"
      aria-busy="true"
      aria-label="Loading notifications"
    >
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          style={{
            display: 'flex', alignItems: 'center',
            borderLeft: '3px solid transparent',
            borderBottom: i < rows - 1 ? `1px solid ${colors.border}` : 'none',
            // Matches the real row's 13px vertical padding + three text lines.
            padding: '13px 16px 13px 0',
            gap: '10px',
          }}
        >
          <div style={{ width: '40px', display: 'flex', justifyContent: 'center', flexShrink: 0 }}>
            <Block w="16px" h="16px" radius="4px" />
          </div>
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <Block w="34%" h="11px" />
            <Block w="62%" h="10px" />
            <Block w="22%" h="9px" />
          </div>
          <div style={{ width: '148px', display: 'flex', justifyContent: 'flex-end', gap: '6px', flexShrink: 0 }}>
            <Block w="82px" h="24px" radius="6px" />
            <Block w="28px" h="28px" radius="6px" />
          </div>
        </div>
      ))}
    </div>
  )
}

// A plain tinted rectangle. No shimmer animation on purpose: the point of this
// change is that the delay got shorter, not that it got prettier, and a moving
// placeholder is the standard way of making a wait look like progress.
function Block({ w, h, radius = '4px' }: { w: string; h: string; radius?: string }) {
  return (
    <span
      aria-hidden="true"
      style={{
        display: 'block', width: w, height: h,
        borderRadius: radius,
        background: 'rgba(0,0,0,0.06)',
      }}
    />
  )
}
