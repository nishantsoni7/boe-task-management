'use client'

import Link from 'next/link'
import { Megaphone, ChevronRight } from 'lucide-react'
import { bannerContent, type MyAnnouncement } from '@/lib/announcements'

// THE MODULES-PAGE BANNER. One compact block, never a stack of pop-ups:
//
//   one unread     the whole banner is the link — its title and summary, so
//                  the reader knows what it concerns before opening it
//   several        a count, then one short row per announcement (up to three)
//                  and "View all" for the rest
//   none unread    nothing at all — the banner is gone for good once each has
//                  been acknowledged, on every device, because the read state
//                  is a database row and not a browser flag
//
// Presentational only: the caller passes the list from useMyAnnouncements().
export function AnnouncementBanner({ announcements }: { announcements: MyAnnouncement[] }) {
  const { unread, shown, more } = bannerContent(announcements)
  if (unread.length === 0) return null

  if (unread.length === 1) {
    const a = unread[0]
    return (
      <Link
        href={`/announcements/${a.id}`}
        className="boe-announce-banner boe-announce-banner-single"
        aria-label={`New announcement: ${a.title}. Open to read.`}
      >
        <span className="boe-announce-icon" aria-hidden="true"><Megaphone size={18} strokeWidth={1.9} /></span>
        <span className="boe-announce-text">
          <span className="boe-announce-eyebrow">New announcement</span>
          <span className="boe-announce-title">{a.title}</span>
          <span className="boe-announce-summary">{a.summary}</span>
        </span>
        <span className="boe-announce-cta">
          Read <ChevronRight size={15} strokeWidth={2} aria-hidden="true" />
        </span>
      </Link>
    )
  }

  return (
    <section className="boe-announce-banner" aria-label={`${unread.length} new announcements`}>
      <div className="boe-announce-head">
        <span className="boe-announce-icon" aria-hidden="true"><Megaphone size={18} strokeWidth={1.9} /></span>
        <span className="boe-announce-eyebrow boe-announce-count">{unread.length} new announcements</span>
        <Link href="/announcements" className="boe-announce-viewall">View all</Link>
      </div>
      <ul className="boe-announce-list">
        {shown.map(a => (
          <li key={a.id}>
            <Link href={`/announcements/${a.id}`} className="boe-announce-row">
              <span className="boe-announce-text">
                <span className="boe-announce-title">{a.title}</span>
                <span className="boe-announce-summary">{a.summary}</span>
              </span>
              <ChevronRight size={15} strokeWidth={2} aria-hidden="true" className="boe-announce-chevron" />
            </Link>
          </li>
        ))}
      </ul>
      {more > 0 && (
        <Link href="/announcements" className="boe-announce-more">+{more} more</Link>
      )}
    </section>
  )
}
