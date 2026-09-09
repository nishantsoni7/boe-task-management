'use client'

import { useState } from 'react'
import { Package } from 'lucide-react'
import { colors } from '@/lib/tokens'

// ── One product photo, on any showroom surface ────────────────────────────────
//
// The customer-facing screens each grew their own version of this box and each
// got it slightly differently: the shared list had no image at all, the cart
// thumbnail cropped with `object-fit: cover`, and none of them handled a URL
// that 404s — a dead link showed the browser's broken-image glyph inside an
// otherwise finished card.
//
// Two rules matter enough to be in one place:
//
//  1. CONTAIN, NEVER COVER. `cover` crops to fill, which on furniture cuts the
//     legs off a chair and the ends off a bench — the exact parts a customer is
//     looking at. Contain shows the whole piece and lets the frame letterbox.
//     The frame reserves its own space, so nothing shifts as images arrive.
//
//  2. A DEAD URL FALLS BACK, IT DOES NOT BREAK. These are pasted URLs on a
//     WordPress site, not uploads this system controls, so one of them being
//     gone is ordinary. It shows the same quiet placeholder as a product with
//     no image on file rather than a broken-image icon.

export type ProductThumbProps = {
  src: string | null | undefined
  /** Product name, or the code when there is no name yet. */
  alt: string
  /** Frame edge in px. The box is always square. */
  size?: number | string
  radius?: number
  /** Larger frames get a label under the icon; a 52px cart thumb does not. */
  showLabel?: boolean
}

export function ProductThumb({
  src, alt, size = 56, radius = 8, showLabel = false,
}: ProductThumbProps) {
  const [failed, setFailed] = useState(false)
  const url = (src ?? '').trim()
  const usable = url !== '' && !failed

  return (
    <div style={{
      width: size, height: typeof size === 'number' ? size : undefined,
      aspectRatio: typeof size === 'number' ? undefined : '1 / 1',
      flexShrink: 0,
      borderRadius: `${radius}px`,
      background: colors.raised,
      border: `1px solid ${colors.border}`,
      overflow: 'hidden',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      {usable ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={url}
          alt={alt}
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
          style={{
            maxWidth: '100%', maxHeight: '100%',
            objectFit: 'contain', display: 'block',
          }}
        />
      ) : (
        <div style={{ textAlign: 'center', padding: '6px', lineHeight: 1.3 }}>
          <Package size={showLabel ? 26 : 18} color={colors.muted} strokeWidth={1.3} />
          {showLabel && (
            <div style={{ fontSize: '10px', color: colors.muted, marginTop: '5px' }}>
              No image
            </div>
          )}
        </div>
      )}
    </div>
  )
}
