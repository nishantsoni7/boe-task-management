'use client'

// CROP BY DRAWING A BOX (owner, 18 Nov 2026: "The crop functionality is not user friendly. It should be directly based on
// selection from mouse and then crop as in Photoshop"). Drag on the picture to draw the area to keep; drag inside it to
// move it; drag a corner to resize it. Mouse, pen and touch alike (pointer events). The picture is shown already turned,
// so the box is drawn on what will be kept. Used by Improve picture → Crop & rotate and by the scan review's Crop.

import { useEffect, useRef, useState } from 'react'

/** The area kept, as fractions (0 to 1) of the turned picture. */
export type Box = { x: number; y: number; w: number; h: number }
export const WHOLE: Box = { x: 0, y: 0, w: 1, h: 1 }
const MIN = 0.03

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** A box with its corners kept inside the picture and never smaller than MIN on a side. */
export function fitBox(b: Box): Box {
  const w = clamp(b.w, MIN, 1), h = clamp(b.h, MIN, 1)
  return { x: clamp(b.x, 0, 1 - w), y: clamp(b.y, 0, 1 - h), w, h }
}

/** The box between two points (in fractions), whichever way it was dragged. */
export function boxBetween(a: { x: number; y: number }, b: { x: number; y: number }): Box {
  return fitBox({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) })
}

/** The picture turned `turns` quarter-turns clockwise, then cut to `box`, as it will be saved. */
export function renderCrop(img: HTMLImageElement, turns: number, box: Box): HTMLCanvasElement {
  const side = turns % 2 === 1
  const W = side ? img.naturalHeight : img.naturalWidth, H = side ? img.naturalWidth : img.naturalHeight
  const turned = document.createElement('canvas')
  turned.width = W; turned.height = H
  const t = turned.getContext('2d')!
  t.translate(W / 2, H / 2); t.rotate((turns * Math.PI) / 2)
  t.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2)
  const b = fitBox(box)
  const out = document.createElement('canvas')
  out.width = Math.max(1, Math.round(b.w * W)); out.height = Math.max(1, Math.round(b.h * H))
  out.getContext('2d')!.drawImage(turned, b.x * W, b.y * H, b.w * W, b.h * H, 0, 0, out.width, out.height)
  return out
}

type Drag = { kind: 'new' | 'move' | 'nw' | 'ne' | 'sw' | 'se'; from: { x: number; y: number }; start: Box }

export function CropBox({ img, turns, box, onBox, disabled }: {
  img: HTMLImageElement; turns: number; box: Box; onBox: (b: Box) => void; disabled?: boolean
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  const whole = box.w >= 0.999 && box.h >= 0.999

  // The whole picture, turned, as the backdrop the box is drawn on.
  useEffect(() => {
    const c = canvasRef.current
    if (!c) return
    const side = turns % 2 === 1
    c.width = side ? img.naturalHeight : img.naturalWidth
    c.height = side ? img.naturalWidth : img.naturalHeight
    const g = c.getContext('2d')
    if (!g) return
    g.save(); g.translate(c.width / 2, c.height / 2); g.rotate((turns * Math.PI) / 2)
    g.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2); g.restore()
  }, [img, turns])

  // The point under the pointer as fractions of the picture area (the element marked data-crop-area).
  const at = (area: Element, e: React.PointerEvent) => {
    const r = area.getBoundingClientRect()
    return { x: clamp((e.clientX - r.left) / r.width, 0, 1), y: clamp((e.clientY - r.top) / r.height, 0, 1) }
  }
  // One handler for the area, the box and the four corners: what is dragged is the element's data-kind.
  const begin = (e: React.PointerEvent<HTMLElement>) => {
    if (disabled) return
    let kind = (e.currentTarget.dataset.kind ?? 'new') as Drag['kind']
    // While the box is still the whole picture it covers everything, so a drag on it draws a new box (found live, 18 Nov 2026).
    if (kind === 'move' && whole) kind = 'new'
    const area = e.currentTarget.closest('[data-crop-area]')
    if (!area) return
    e.preventDefault(); e.stopPropagation()
    ;(area as HTMLElement).setPointerCapture?.(e.pointerId)
    setDrag({ kind, from: at(area, e), start: box })
  }
  const move = (e: React.PointerEvent<HTMLElement>) => {
    if (!drag) return
    const p = at(e.currentTarget, e), d = { x: p.x - drag.from.x, y: p.y - drag.from.y }, s = drag.start
    if (drag.kind === 'new') onBox(boxBetween(drag.from, p))
    else if (drag.kind === 'move') onBox(fitBox({ ...s, x: s.x + d.x, y: s.y + d.y }))
    else {
      const left = drag.kind === 'nw' || drag.kind === 'sw', top = drag.kind === 'nw' || drag.kind === 'ne'
      const fixed = { x: left ? s.x + s.w : s.x, y: top ? s.y + s.h : s.y }
      onBox(boxBetween(fixed, p))
    }
  }
  const end = (e: React.PointerEvent<HTMLElement>) => { if (drag) { e.currentTarget.releasePointerCapture?.(e.pointerId); setDrag(null) } }

  const pct = (v: number) => `${v * 100}%`
  const handle = (kind: 'nw' | 'ne' | 'sw' | 'se', x: number, y: number) => (
    <span key={kind} data-handle={kind} data-kind={kind} onPointerDown={begin} aria-hidden
      style={{ position: 'absolute', left: pct(x), top: pct(y), width: 14, height: 14, margin: '-7px 0 0 -7px', background: '#fff',
        border: '2px solid var(--boe-accent, #b5532c)', borderRadius: 3, cursor: kind === 'nw' || kind === 'se' ? 'nwse-resize' : 'nesw-resize', touchAction: 'none' }} />
  )
  const shade: React.CSSProperties = { position: 'absolute', background: 'rgba(0,0,0,0.45)', pointerEvents: 'none' }

  return (
    <div style={{ display: 'grid', gap: 6, justifyItems: 'center' }}>
      <div data-crop-area data-kind="new" onPointerDown={begin} onPointerMove={move} onPointerUp={end} onPointerCancel={end}
        style={{ position: 'relative', display: 'inline-block', maxWidth: '100%', lineHeight: 0, cursor: disabled ? 'default' : 'crosshair', touchAction: 'none', userSelect: 'none' }}
        aria-label="Drag on the picture to choose the area to keep">
        <canvas ref={canvasRef} style={{ maxWidth: '100%', maxHeight: 340, display: 'block', borderRadius: 6 }} />
        {/* Outside the box, darkened: above, below, left, right. */}
        <span style={{ ...shade, left: 0, top: 0, width: '100%', height: pct(box.y) }} />
        <span style={{ ...shade, left: 0, top: pct(box.y + box.h), width: '100%', bottom: 0 }} />
        <span style={{ ...shade, left: 0, top: pct(box.y), width: pct(box.x), height: pct(box.h) }} />
        <span style={{ ...shade, left: pct(box.x + box.w), top: pct(box.y), right: 0, height: pct(box.h) }} />
        <span data-crop-box data-kind="move" onPointerDown={begin}
          style={{ position: 'absolute', left: pct(box.x), top: pct(box.y), width: pct(box.w), height: pct(box.h),
            outline: '2px solid #fff', boxShadow: '0 0 0 1px rgba(0,0,0,0.5)', cursor: disabled ? 'default' : whole ? 'crosshair' : 'move', touchAction: 'none' }} />
        {!disabled && [handle('nw', box.x, box.y), handle('ne', box.x + box.w, box.y), handle('sw', box.x, box.y + box.h), handle('se', box.x + box.w, box.y + box.h)]}
      </div>
      <span style={{ fontSize: 12, color: 'var(--boe-muted, #6b6b6b)' }}>
        Drag on the picture to choose what to keep. Drag inside the box to move it, or a corner to resize it.
      </span>
    </div>
  )
}
