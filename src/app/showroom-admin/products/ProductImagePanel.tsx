'use client'

import { useState } from 'react'
import { Package } from 'lucide-react'
import { colors } from '@/lib/tokens'

// The product's own image, shown beside the edit form so the person changing a
// price or a spec can see what they are editing. Reads the same `images` array
// the form edits, so pasting a URL into the Product images field updates the
// preview immediately — this panel manages nothing of its own and adds no
// upload path.
//
// Hook-free apart from the selection the caller owns, so its rendering rules
// (which image is large, when thumbnails appear, what an imageless product
// shows) are testable by calling the function.

export type ProductImagePanelProps = {
  /** Raw form values — blanks and whitespace are filtered here, not by callers. */
  images: (string | null | undefined)[]
  /** Index into the *cleaned* list. Out-of-range falls back to the first image. */
  selectedIndex: number
  onSelect: (index: number) => void
  /** Alt text — the product name, or the code before a name is typed. */
  alt: string
}

/** Usable image URLs, in order, with blanks and duplicates removed. */
export function usableImages(images: (string | null | undefined)[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of images ?? []) {
    const url = (raw ?? '').trim()
    if (!url || seen.has(url)) continue
    seen.add(url)
    out.push(url)
  }
  return out
}

export function ProductImagePanel({ images, selectedIndex, onSelect, alt }: ProductImagePanelProps) {
  // A URL that 404s or is half-typed shows the empty state rather than a broken
  // image icon — same treatment the list thumbnails give it.
  const [broken, setBroken] = useState<string[]>([])

  const urls = usableImages(images)
  // A removed or not-yet-typed image must never leave the panel blank.
  const index = selectedIndex >= 0 && selectedIndex < urls.length ? selectedIndex : 0
  const candidate = urls[index]
  const primary = candidate && !broken.includes(candidate) ? candidate : undefined

  return (
    <div style={{
      background: colors.base,
      border: `1.5px solid ${colors.border}`,
      borderRadius: '16px',
      padding: '16px',
      display: 'flex', flexDirection: 'column', gap: '12px',
    }}>
      <p className="section-label" style={{ margin: 0 }}>Product image</p>

      <div style={{
        // A square frame with the image contained inside it: the panel keeps a
        // predictable height while every product — tall chair or wide bench —
        // is shown whole rather than cropped to fit.
        aspectRatio: '1 / 1',
        width: '100%',
        borderRadius: '12px',
        background: colors.raised,
        border: `1px solid ${colors.border}`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        overflow: 'hidden',
      }}>
        {primary ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={primary}
            alt={alt}
            decoding="async"
            onError={() => setBroken(list => list.includes(primary) ? list : [...list, primary])}
            style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', display: 'block' }}
          />
        ) : (
          <div style={{ textAlign: 'center', padding: '20px' }}>
            <Package size={30} color={colors.muted} strokeWidth={1.4} />
            <p style={{ color: colors.muted, fontSize: '13px', marginTop: '10px' }}>No image yet</p>
            <p style={{ color: colors.tertiary, fontSize: '12px', marginTop: '4px', lineHeight: 1.5 }}>
              Add an image URL under <strong>Product images</strong> and it will appear here.
            </p>
          </div>
        )}
      </div>

      {urls.length > 1 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
          {urls.map((url, i) => {
            const selected = i === index
            return (
              <button
                key={url}
                type="button"
                onClick={() => onSelect(i)}
                aria-label={`Show image ${i + 1}`}
                aria-pressed={selected}
                style={{
                  width: 52, height: 52, flexShrink: 0, padding: 0,
                  borderRadius: '8px', overflow: 'hidden',
                  background: colors.raised,
                  border: `1.5px solid ${selected ? '#1A2035' : colors.border}`,
                  cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={url}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', display: 'block' }}
                />
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
