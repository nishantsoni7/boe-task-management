import { Download } from 'lucide-react'
import { PI_FORMAT_ACTION, PI_FORMAT_FILENAME } from '@/lib/orders/piFormat'

// THE PI FORMAT DOWNLOAD — ONE ACTION, TWO PLACES.
//
// Orders' left navigation and the PI Drafts heading both render this, so they cannot drift:
// the same route (/api/orders/pi-format), the same saved name, the same label and title. Nothing
// here builds, copies or edits the workbook; the route serves the approved bytes and applies the
// Orders module-entry rule (src/lib/orders/piFormat.ts). A plain anchor, so the download is an
// ordinary navigation carrying the session cookie and works the same on a phone; it is a real
// link, so it is reachable and activated with the keyboard.

export function PiFormatButton() {
  return (
    <a
      className="boe-btn boe-btn-ghost"
      href={PI_FORMAT_ACTION.href}
      download={PI_FORMAT_FILENAME}
      title={PI_FORMAT_ACTION.title}
    >
      <Download size={13} strokeWidth={2.2} aria-hidden="true" />
      {PI_FORMAT_ACTION.label}
    </a>
  )
}

/** The left-navigation entry. Never "active": it is a file, not a page. */
export function PiFormatNavLink({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <a
      className="boe-nav-item"
      href={PI_FORMAT_ACTION.href}
      download={PI_FORMAT_FILENAME}
      title={PI_FORMAT_ACTION.title}
      onClick={onNavigate}
      style={{ fontWeight: 400, marginBottom: '2px', textDecoration: 'none' }}
    >
      <span aria-hidden="true" style={{ color: '#A0A9BE', display: 'flex', alignItems: 'center' }}>
        <Download size={15} strokeWidth={1.8} />
      </span>
      {PI_FORMAT_ACTION.label}
    </a>
  )
}
