'use client'

import { useState } from 'react'
import { Package, Pencil, QrCode, Trash2 } from 'lucide-react'
import type { ShowroomProduct } from '@/lib/types'
import { colors, font } from '@/lib/tokens'
import { thumbSource } from '@/lib/imageHosts'

// The Product Master results table, lifted out of the page so its rendering
// contract — every row still offering Print QR, Edit, Delete and the status
// toggle — can be asserted directly. Every component here is a plain function
// of its props; the page owns the data and the handlers.

// ── Product table ─────────────────────────────────────────────────────────────

export function ProductTable({
  products, fetching, togglingId, onEdit, onToggle, onPrintQr, onDelete,
}: {
  products: ShowroomProduct[]
  fetching: boolean
  togglingId: string | null
  onEdit: (code: string) => void
  onToggle: (p: ShowroomProduct) => void
  onPrintQr: (p: ShowroomProduct) => void
  onDelete: (p: ShowroomProduct) => void
}) {
  if (products.length === 0) return null

  return (
    <div>
      {/* The previous rows stay on screen while the next page loads — dimmed and
          inert rather than replaced by a skeleton, so the table never blanks. */}
      <div style={{
        background: colors.base,
        border: `1.5px solid ${colors.border}`,
        borderRadius: '10px',
        overflow: 'hidden',
        opacity: fetching ? 0.55 : 1,
        pointerEvents: fetching ? 'none' : undefined,
        transition: 'opacity 120ms ease',
      }}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${colors.border}` }}>
                {['Image', 'Product Code', 'Product Name', 'Category', 'MRP', 'Status', 'Actions'].map(h => (
                  <th key={h} style={{
                    padding: '8px 16px', textAlign: h === 'MRP' ? 'right' : 'left',
                    fontSize: '10px', fontWeight: 600, color: colors.muted,
                    textTransform: 'uppercase', letterSpacing: '0.05em',
                    whiteSpace: 'nowrap',
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {products.map(product => (
                <ProductRow
                  key={product.id}
                  product={product}
                  toggling={togglingId === product.id}
                  onEdit={() => onEdit(product.product_code)}
                  onToggle={() => onToggle(product)}
                  onPrintQr={() => onPrintQr(product)}
                  onDelete={() => onDelete(product)}
                />
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

/** CSS size of a list thumbnail. Mirrored into the img's width/height. */
const THUMB_BOX = 56

// Thumbnail with a safe fallback: hides the broken-image icon and shows a
// neutral placeholder box if the URL is missing or fails to load.
//
// The box is 56px, so the bytes should be too. `thumbSource` routes an
// allowlisted host through Next's optimizer at 64/128px and quality 35 — a
// couple of kilobytes instead of whatever the original weighs — and hands back
// any other URL untouched, so an unconfigured host renders exactly as it did
// before rather than breaking.
export function ProductThumb({ src, alt }: { src: string | null; alt: string }) {
  // Two retreats, in order: optimized → original → placeholder.
  //
  // The middle step is the one that matters. Optimizing means Next fetches the
  // image server-side, which nothing did before — so a host the browser can
  // reach but the server cannot would turn every working thumbnail into a
  // placeholder. Falling back to the origin URL first makes that failure cost
  // the saving instead of the image.
  const [failed, setFailed] = useState<{ optimized: boolean; original: boolean }>(
    { optimized: false, original: false },
  )
  // A row component is reused as pages change, so the retreat state has to be
  // tied to the URL it was recorded for.
  const [seenSrc, setSeenSrc] = useState(src)
  if (seenSrc !== src) {
    setSeenSrc(src)
    setFailed({ optimized: false, original: false })
  }

  const source = thumbSource(src)
  const useOptimized = !!source?.optimized && !failed.optimized
  const showImage = !!source && !failed.original

  return (
    <div style={{
      width: THUMB_BOX, height: THUMB_BOX, borderRadius: '8px', flexShrink: 0,
      background: colors.raised,
      border: `1px solid ${colors.border}`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      overflow: 'hidden',
    }}>
      {showImage ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          // `key` forces a real reload when the retreat changes the URL —
          // without it React patches src in place and the browser may not
          // re-request after an error.
          key={useOptimized ? 'optimized' : 'original'}
          src={useOptimized ? source.src : source.original}
          srcSet={useOptimized ? source.srcSet : undefined}
          alt={alt}
          // Intrinsic size stated up front so the row reserves its space before
          // any byte of the image arrives.
          width={THUMB_BOX}
          height={THUMB_BOX}
          loading="lazy"
          decoding="async"
          onError={() => setFailed(prev => useOptimized
            // The optimizer could not produce it — try the origin directly,
            // which is exactly what this row did before optimization existed.
            ? { ...prev, optimized: true }
            // The origin itself is unreachable or not an image: a genuinely
            // broken URL, so show the neutral placeholder rather than a
            // broken-image icon.
            : { ...prev, original: true })}
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        />
      ) : (
        <Package size={20} color={colors.muted} strokeWidth={1.5} />
      )}
    </div>
  )
}

export function ProductRow({
  product, toggling, onEdit, onToggle, onPrintQr, onDelete,
}: {
  product: ShowroomProduct
  toggling: boolean
  onEdit: () => void
  onToggle: () => void
  onPrintQr: () => void
  onDelete: () => void
}) {
  return (
    <tr style={{
      borderBottom: `1px solid ${colors.border}`,
      opacity: product.is_active ? 1 : 0.6,
    }}>
      {/* Image */}
      <td style={{ padding: '10px 16px', verticalAlign: 'middle' }}>
        <ProductThumb src={product.images?.[0] ?? product.image_url ?? null} alt={product.name} />
      </td>

      {/* Product Code */}
      <td style={{ padding: '10px 16px', verticalAlign: 'middle', whiteSpace: 'nowrap' }}>
        <span style={{
          fontSize: '12px', fontWeight: 600,
          color: '#1A2035',
          background: 'rgba(26,32,53,0.06)',
          borderRadius: '5px', padding: '4px 9px',
          whiteSpace: 'nowrap',
        }}>
          {product.product_code}
        </span>
      </td>

      {/* Product Name */}
      <td style={{ padding: '10px 16px', verticalAlign: 'middle', minWidth: '160px' }}>
        <span style={{ fontSize: '13.5px', fontWeight: 600, color: colors.primary }}>
          {product.name}
        </span>
      </td>

      {/* Category */}
      <td style={{ padding: '10px 16px', verticalAlign: 'middle', whiteSpace: 'nowrap' }}>
        <span style={{ fontSize: '12px', color: colors.tertiary }}>
          {product.category}
        </span>
      </td>

      {/* MRP */}
      <td style={{ padding: '10px 16px', verticalAlign: 'middle', textAlign: 'right', whiteSpace: 'nowrap' }}>
        <span style={{ fontSize: '13.5px', fontWeight: 600, color: colors.primary, fontFamily: font.body }}>
          ₹{Number(product.mrp).toLocaleString('en-IN')}
        </span>
      </td>

      {/* Status */}
      <td style={{ padding: '10px 16px', verticalAlign: 'middle', whiteSpace: 'nowrap' }}>
        <button
          onClick={onToggle}
          disabled={toggling}
          style={{
            fontSize: '11px', fontWeight: 600,
            color: product.is_active ? '#166534' : colors.muted,
            background: product.is_active ? '#F0FDF4' : colors.float,
            border: `1px solid ${product.is_active ? '#BBF7D0' : colors.border}`,
            borderRadius: '999px',
            padding: '4px 12px',
            cursor: toggling ? 'default' : 'pointer',
            opacity: toggling ? 0.6 : 1,
            whiteSpace: 'nowrap',
          }}
        >
          {toggling ? '…' : product.is_active ? 'Active' : 'Inactive'}
        </button>
      </td>

      {/* Actions */}
      <td style={{ padding: '10px 16px', verticalAlign: 'middle' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <IconButton onClick={onPrintQr} title="Print QR label" variant="neutral">
            <QrCode size={14} strokeWidth={1.8} />
          </IconButton>
          <IconButton onClick={onEdit} title="Edit product" variant="neutral">
            <Pencil size={14} strokeWidth={1.8} />
          </IconButton>
          <IconButton onClick={onDelete} title="Delete product" variant="red">
            <Trash2 size={14} strokeWidth={1.8} />
          </IconButton>
        </div>
      </td>
    </tr>
  )
}

export function IconButton({
  onClick, title, variant, children,
}: {
  onClick: () => void
  title: string
  variant: 'neutral' | 'red'
  children: React.ReactNode
}) {
  const palette = variant === 'red'
    ? { color: colors.red, background: colors.redTint, border: 'rgba(217,79,79,0.2)' }
    : { color: colors.secondary, background: colors.float, border: colors.border }

  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: 28, height: 28, flexShrink: 0,
        color: palette.color,
        background: palette.background,
        border: `1px solid ${palette.border}`,
        borderRadius: '6px',
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  )
}
