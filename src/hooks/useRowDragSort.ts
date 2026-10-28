'use client'

import { useCallback, useEffect, useRef } from 'react'
import { flushSync } from 'react-dom'
import { dragTargetIndex } from '@/lib/tasks/taskOrder'

// Pointer-driven drag-to-reorder for a list of rows, with no library.
//
// WHY NOT NATIVE HTML5 DRAG. It gives no live feedback (rows do not make room),
// the browser's auto-scroll near an edge is slow and inconsistent, and a long
// list could not be dragged from the bottom to the top in one move.
//
// COST. Nothing runs until a grip is pressed: no listeners on the rows, no
// measuring at load. While dragging, rows are moved with `transform` straight on
// the DOM - React state is not touched per pointer move - and the order is
// committed once, on release.

const EDGE = 90          // px from the scroll area's edge where auto-scroll starts
const MAX_SPEED = 22     // px per frame at the very edge
const START_DISTANCE = 4 // px of movement before a press becomes a drag
const GAP = 6            // the list's row gap (matches #my-tasks-list)

function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let p = el?.parentElement; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY
    if ((o === 'auto' || o === 'scroll') && p.scrollHeight > p.clientHeight) return p
  }
  return null
}

export function useRowDragSort(opts: {
  /** Row ids in on-screen order. Read only when a drag starts. */
  getIds: () => string[]
  /** Group of a row (Important / pinned / rest); a row only moves inside its group. */
  groupOf: (id: string) => number | undefined
  /** Called once on release with the dragged id and the id whose slot it takes. */
  onMove: (fromId: string, toId: string) => void
}) {
  const rows = useRef(new Map<string, HTMLElement>())
  const optsRef = useRef(opts)
  useEffect(() => { optsRef.current = opts })

  const rowRef = useCallback((id: string) => (el: HTMLElement | null) => {
    if (el) rows.current.set(id, el)
    else rows.current.delete(id)
  }, [])

  const begin = useCallback((id: string, e: React.PointerEvent) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return
    e.stopPropagation()
    const grip = e.currentTarget as HTMLElement
    const startY = e.clientY
    let lastY = startY
    let active = false
    let raf = 0
    let ids: string[] = []
    let els: HTMLElement[] = []
    let mids: number[] = []
    let from = 0
    let lo = 0
    let hi = 0
    let height = 0
    let target = 0
    let scroller: HTMLElement | null = null
    let startScroll = 0
    const scrollTop = () => (scroller ? scroller.scrollTop : window.scrollY)

    try { grip.setPointerCapture(e.pointerId) } catch { /* pointer already gone */ }

    const paint = () => {
      const dy = (lastY - startY) + (scrollTop() - startScroll)
      const dragged = els[from]
      // keep the lifted row inside its own group
      const minDy = els[lo].offsetTop - dragged.offsetTop
      const last = els[hi]
      const maxDy = (last.offsetTop + last.offsetHeight) - (dragged.offsetTop + dragged.offsetHeight)
      const clamped = Math.max(minDy, Math.min(maxDy, dy))
      dragged.style.transform = `translateY(${clamped}px) scale(1.01)`
      target = dragTargetIndex(mids, from, lo, hi, mids[from] + clamped)
      for (let i = lo; i <= hi; i++) {
        if (i === from) continue
        let shift = 0
        if (target > from && i > from && i <= target) shift = -(height + GAP)
        if (target < from && i < from && i >= target) shift = height + GAP
        els[i].style.transform = shift ? `translateY(${shift}px)` : ''
      }
    }

    const tick = () => {
      if (!active) return
      const rect = scroller ? scroller.getBoundingClientRect() : { top: 0, bottom: window.innerHeight }
      let v = 0
      if (lastY < rect.top + EDGE) v = -MAX_SPEED * Math.min(1, (rect.top + EDGE - lastY) / EDGE)
      else if (lastY > rect.bottom - EDGE) v = MAX_SPEED * Math.min(1, (lastY - (rect.bottom - EDGE)) / EDGE)
      if (v) {
        if (scroller) scroller.scrollTop += v
        else window.scrollBy(0, v)
      }
      paint()
      raf = requestAnimationFrame(tick)
    }

    const start = () => {
      ids = optsRef.current.getIds()
      els = ids.map(i => rows.current.get(i)).filter((x): x is HTMLElement => !!x)
      if (els.length !== ids.length) return false
      from = ids.indexOf(id)
      if (from < 0) return false
      const g = optsRef.current.groupOf(id)
      lo = from
      hi = from
      while (lo > 0 && optsRef.current.groupOf(ids[lo - 1]) === g) lo--
      while (hi < ids.length - 1 && optsRef.current.groupOf(ids[hi + 1]) === g) hi++
      mids = els.map(el => el.offsetTop + el.offsetHeight / 2)
      height = els[from].offsetHeight
      target = from
      scroller = scrollParent(els[from])
      startScroll = scrollTop()
      document.body.style.userSelect = 'none'
      saved = els.map(el => ({
        transition: el.style.transition, boxShadow: el.style.boxShadow, cursor: el.style.cursor,
      }))
      for (let i = lo; i <= hi; i++) {
        els[i].style.transition = i === from ? 'box-shadow 0.12s' : 'transform 0.16s ease'
        els[i].style.willChange = 'transform'
      }
      const d = els[from]
      d.style.zIndex = '5'
      d.style.boxShadow = '0 8px 24px rgba(0,0,0,0.18)'
      d.style.cursor = 'grabbing'
      return true
    }

    // What React had put on the rows before the drag touched them.
    let saved: { transition: string; boxShadow: string; cursor: string }[] = []

    const clear = () => {
      els.forEach((el, i) => {
        el.style.transition = 'none'
        el.style.transform = ''
        el.style.willChange = ''
        el.style.zIndex = ''
        el.style.boxShadow = saved[i].boxShadow
        el.style.cursor = saved[i].cursor
      })
    }

    const end = (commit: boolean) => {
      grip.removeEventListener('pointermove', move)
      grip.removeEventListener('pointerup', up)
      grip.removeEventListener('pointercancel', cancel)
      window.removeEventListener('keydown', key)
      cancelAnimationFrame(raf)
      document.body.style.userSelect = ''
      if (!active) return
      active = false
      // Commit and clear in one synchronous step so the row never flashes back
      // to its old slot between the new order rendering and the transforms going.
      if (commit && target !== from) flushSync(() => optsRef.current.onMove(id, ids[target]))
      clear()
      // The transitions were suppressed for the swap; release them next frame.
      requestAnimationFrame(() => els.forEach((el, i) => { el.style.transition = saved[i].transition }))
    }

    const move = (ev: PointerEvent) => {
      lastY = ev.clientY
      if (!active) {
        if (Math.abs(lastY - startY) < START_DISTANCE) return
        if (!start()) { end(false); return }
        active = true
        raf = requestAnimationFrame(tick)
      }
      ev.preventDefault()
    }
    const up = () => end(true)
    const cancel = () => end(false)
    const key = (ev: KeyboardEvent) => { if (ev.key === 'Escape') end(false) }

    grip.addEventListener('pointermove', move)
    grip.addEventListener('pointerup', up)
    grip.addEventListener('pointercancel', cancel)
    window.addEventListener('keydown', key)
  }, [])

  return { rowRef, begin }
}
