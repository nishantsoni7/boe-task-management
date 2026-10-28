'use client'

import { useSyncExternalStore } from 'react'
import { Pin, PinOff } from 'lucide-react'

// The hover rail's one preference: keep the full menu open (pinned) or let it
// rest as an icon rail. Stored per browser, in localStorage, because it is a
// display convenience, not an account setting — the same person on a phone or a
// second computer chooses again. The CSS that reads it lives in globals.css
// under "HOVER RAIL SIDEBAR"; a shell opts in with `boe-app-shell boe-rail`
// and adds `boe-rail-pinned` while this says pinned.

const KEY = 'boe.sidebar.pinned'
const EVENT = 'boe-sidebar-pin-change'

function read(): boolean {
  try {
    return window.localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

function subscribe(onChange: () => void) {
  window.addEventListener('storage', onChange)
  window.addEventListener(EVENT, onChange)
  return () => {
    window.removeEventListener('storage', onChange)
    window.removeEventListener(EVENT, onChange)
  }
}

/** [pinned, toggle]. The server render and the first client render are unpinned. */
export function useSidebarPinned(): [boolean, () => void] {
  const pinned = useSyncExternalStore(subscribe, read, () => false)
  const toggle = () => {
    try {
      window.localStorage.setItem(KEY, read() ? '0' : '1')
    } catch {
      // Storage blocked (private window): the rail simply stays unpinned.
    }
    window.dispatchEvent(new Event(EVENT))
  }
  return [pinned, toggle]
}

/** Shell class for a module that uses the rail. */
export function railShellClass(pinned: boolean) {
  return `boe-app-shell boe-rail${pinned ? ' boe-rail-pinned' : ''}`
}

/** Pin / unpin row for the sidebar foot. Hidden by CSS wherever there is no rail. */
export function SidebarPinButton({ pinned, onToggle }: { pinned: boolean; onToggle: () => void }) {
  const label = pinned ? 'Unpin menu' : 'Pin menu open'
  return (
    <button
      type="button"
      className="boe-nav-item boe-nav-item--quiet boe-rail-pin"
      onClick={onToggle}
      aria-pressed={pinned}
      title={label}
      style={{ marginBottom: '2px' }}
    >
      <span aria-hidden="true" style={{ color: '#686D6C', display: 'flex', alignItems: 'center' }}>
        {pinned ? <PinOff size={14} strokeWidth={1.8} /> : <Pin size={14} strokeWidth={1.8} />}
      </span>
      <span className="boe-rail-label">{label}</span>
    </button>
  )
}
