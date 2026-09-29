'use client'

import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import {
  applyAmountMask,
  readAmountsHidden,
  writeAmountsHidden,
  type MaskMemory,
  type MaskableNode,
} from '@/lib/orders/amountMask'

export const HIDE_AMOUNTS_LABEL = 'Hide amounts'
export const SHOW_AMOUNTS_LABEL = 'Show amounts'
export const AMOUNTS_HIDDEN_NOTICE = 'Amounts are hidden on this page.'

const sessionStore = (): Storage | null => {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage
  } catch {
    return null
  }
}

/**
 * The hide-amounts preference for this browser session.
 *
 * Read once when the page mounts (the page itself is only drawn after its record
 * has loaded, so the first paint of any figure already knows the answer) and
 * written on every change.
 */
export function useAmountsHidden(): [boolean, (hidden: boolean) => void] {
  const [hidden, setHidden] = useState(() => readAmountsHidden(sessionStore()))
  const set = useCallback((next: boolean) => {
    writeAmountsHidden(sessionStore(), next)
    setHidden(next)
  }, [])
  return [hidden, set]
}

/**
 * The header control. A real toggle button: `aria-pressed` carries the state and
 * the visible label says what pressing it will do.
 */
export function AmountsToggle({ hidden, onChange }: { hidden: boolean; onChange: (hidden: boolean) => void }) {
  const Icon = hidden ? Eye : EyeOff
  return (
    <>
      <button
        type="button"
        className="boe-btn boe-btn-ghost pi-amounts-toggle"
        aria-pressed={hidden}
        onClick={() => onChange(!hidden)}
        title={hidden ? 'Amounts are hidden. Show them again.' : 'Hide every amount on this page, for sharing your screen.'}
      >
        <Icon size={13} strokeWidth={2.2} aria-hidden="true" />
        <span className="pi-amounts-toggle-label">{hidden ? SHOW_AMOUNTS_LABEL : HIDE_AMOUNTS_LABEL}</span>
      </button>
      {/* Said aloud when the state changes, for somebody who cannot see the figures go. */}
      <span role="status" aria-live="polite" style={{
        position: 'absolute', width: 1, height: 1, margin: -1, padding: 0, overflow: 'hidden',
        clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0,
      }}>
        {hidden ? AMOUNTS_HIDDEN_NOTICE : ''}
      </span>
    </>
  )
}

/**
 * Masks every rupee figure inside it while `hidden` is true, and restores them
 * when it is not. See amountMask.ts for why this works on the rendered text.
 *
 * A MutationObserver re-applies the mask to anything React draws afterwards — a
 * dialog opening, a refresh landing — in the same microtask checkpoint as the
 * DOM change, so a figure is never painted unmasked. Our own writes re-trigger
 * the observer once; the second pass finds nothing to change and stops.
 */
export function AmountMaskRegion({ hidden, children }: { hidden: boolean; children: React.ReactNode }) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const memory = useRef<MaskMemory>(new WeakMap())

  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    const run = () => applyAmountMask(root as unknown as MaskableNode, hidden, memory.current)
    run()
    if (!hidden) return
    let scheduled = false
    const observer = new MutationObserver(() => {
      if (scheduled) return
      scheduled = true
      queueMicrotask(() => { scheduled = false; run() })
    })
    observer.observe(root, {
      subtree: true, childList: true, characterData: true,
      attributes: true, attributeFilter: ['aria-label', 'title', 'alt'],
    })
    return () => observer.disconnect()
  }, [hidden])

  return (
    // display: contents keeps the region out of the layout: the page's own
    // stack and grid see their children exactly as before.
    <div ref={rootRef} data-amounts-hidden={hidden ? 'true' : 'false'} style={{ display: 'contents' }}>
      {children}
    </div>
  )
}
