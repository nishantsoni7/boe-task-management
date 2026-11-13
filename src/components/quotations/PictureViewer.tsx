'use client'

// The picture pop-up (owner, 13 Nov 2026): click a product's picture to see it large. ← and → go to the previous and next
// product that has a picture (they wrap round), Esc closes. Focus moves into the pop-up and goes back to the picture that
// opened it. Products without a picture are skipped: the caller only passes the ones that have one.

import { useCallback, useEffect, useRef } from 'react'
import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import { sizeWithUnit, type DimensionUnit, type QuoteLine } from '@/lib/quotations/math'
import { Pic } from './Pic'
import s from './quotations.module.css'

export type ViewerItem = { key: string; name: string; detail: string; path: string }

/** The pictures of these products, in the order given (the order they are on the page): the pop-up's ← and → follow it. */
export function viewerItemsOf(lines: readonly QuoteLine[], unit: DimensionUnit): ViewerItem[] {
  return lines.filter(l => !!l.image_path)
    .map(l => ({ key: l.key, name: l.name.trim(), detail: [sizeWithUnit(l.size_text, unit), l.material.trim()].filter(Boolean).join(' · '), path: l.image_path as string }))
}

/** Where a step of -1 or 1 lands among `count` pictures, wrapping round (→ on the last goes to the first). */
export const stepIndex = (index: number, count: number, step: -1 | 1) => (count < 2 ? index : (index + step + count) % count)

export function PictureViewer({ items, index, url, onIndex, onClose }: {
  items: ViewerItem[]; index: number; url: (path: string) => string; onIndex: (i: number) => void; onClose: () => void
}) {
  const boxRef = useRef<HTMLDivElement>(null)
  const i = Math.max(0, Math.min(index, items.length - 1))
  const item = items[i]
  const many = items.length > 1
  const go = useCallback((step: -1 | 1) => onIndex(stepIndex(i, items.length, step)), [i, items.length, onIndex])

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    boxRef.current?.focus()
    return () => { opener?.focus?.() }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return }
      if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); return }
      if (e.key === 'ArrowRight') { e.preventDefault(); go(1); return }
      if (e.key !== 'Tab' || !boxRef.current) return
      // Keep Tab inside the pop-up.
      const stops = [...boxRef.current.querySelectorAll<HTMLElement>('button:not([disabled])')]
      if (!stops.length) return
      const first = stops[0], last = stops[stops.length - 1]
      if (e.shiftKey && (document.activeElement === first || document.activeElement === boxRef.current)) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [go, onClose])

  // The neighbours load while this one is looked at, so the arrows feel instant. Strings, not the url function, so it runs once per picture.
  const before = items[stepIndex(i, items.length, -1)] ? url(items[stepIndex(i, items.length, -1)].path) : ''
  const after = items[stepIndex(i, items.length, 1)] ? url(items[stepIndex(i, items.length, 1)].path) : ''
  useEffect(() => { for (const src of [before, after]) if (src) new Image().src = src }, [before, after])

  if (!item) return null
  return (
    <div className={s.viewerScrim} onClick={onClose}>
      <div ref={boxRef} tabIndex={-1} className={s.viewer} role="dialog" aria-modal="true" aria-label={`Picture of ${item.name || 'the product'}`} onClick={e => e.stopPropagation()}>
        <div className={s.viewerHead}>
          <div style={{ minWidth: 0 }}>
            <div className={s.viewerName}>{item.name || 'Product'}</div>
            {item.detail && <div className={`${s.small} ${s.muted}`}>{item.detail}</div>}
          </div>
          <span className={s.spacer} />
          <span className={s.chip} aria-live="polite">{i + 1} of {items.length} with pictures</span>
          <button type="button" className={s.iconBtn} onClick={onClose} aria-label="Close"><X size={18} aria-hidden /></button>
        </div>
        <div className={s.viewerBody}>
          {many && <button type="button" className={`${s.viewerNav} ${s.viewerPrev}`} onClick={() => go(-1)} aria-label="Previous product"><ChevronLeft size={22} aria-hidden /></button>}
          <Pic className={s.viewerImg} src={url(item.path)} alt={item.name || 'Product picture'} />
          {many && <button type="button" className={`${s.viewerNav} ${s.viewerNext}`} onClick={() => go(1)} aria-label="Next product"><ChevronRight size={22} aria-hidden /></button>}
        </div>
        <div className={s.viewerFoot}>
          {many && <span className={s.viewerKeys}><kbd className={s.kbd}>←</kbd> <kbd className={s.kbd}>→</kbd> previous and next product</span>}
          <span className={s.viewerKeys}><kbd className={s.kbd}>Esc</kbd> close</span>
          <span className={s.spacer} />
          {many && (
            <div className={s.viewerThumbs}>
              {items.map((x, k) => (
                <button key={x.key} type="button" className={s.viewerThumb} aria-current={k === i} aria-label={`Show ${x.name || 'product'}`} onClick={() => onIndex(k)}>
                  <Pic src={url(x.path)} alt="" lazy />
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
