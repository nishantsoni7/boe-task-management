'use client'

import Link from 'next/link'
import { ChevronRight, FileText } from 'lucide-react'
import { AnnouncementsShell } from './AnnouncementsShell'
import { useMyAnnouncements } from '@/hooks/queries/useAnnouncements'
import { formatAnnouncementDate } from '@/lib/announcements'

// Every announcement active for this person, read or not, for its whole window.
// An expired or ended one simply is not returned by my_announcements().
export default function AnnouncementsPage() {
  return (
    <AnnouncementsShell title="Announcements" subtitle="Notices from BOE for you">
      {({ userId, isAdmin }) => <AnnouncementList userId={userId} isAdmin={isAdmin} />}
    </AnnouncementsShell>
  )
}

function AnnouncementList({ userId, isAdmin }: { userId: string; isAdmin: boolean }) {
  const { data = [], isPending, isError } = useMyAnnouncements(userId)

  return (
    <div className="boe-announce-page">
      {isAdmin && (
        <p className="boe-announce-admin-note">
          To publish or end an announcement, go to{' '}
          <Link href="/admin/control-center/announcements">Control Center › Announcements</Link>.
        </p>
      )}
      {isPending ? (
        <p className="boe-announce-muted">Loading…</p>
      ) : isError ? (
        <p className="boe-announce-error">Announcements could not be loaded. Please refresh.</p>
      ) : data.length === 0 ? (
        <p className="boe-announce-empty">There are no active announcements for you.</p>
      ) : (
        <ul className="boe-announce-cards">
          {data.map(a => (
            <li key={a.id}>
              <Link href={`/announcements/${a.id}`} className={`boe-announce-card${a.read_at ? '' : ' unread'}`}>
                <span className="boe-announce-text">
                  <span className="boe-announce-card-meta">
                    {a.read_at ? 'Read' : <strong>New</strong>}
                    {' · '}until {formatAnnouncementDate(a.ends_on)}
                    {a.attachment_path && <><span aria-hidden="true"> · </span><FileText size={12} aria-hidden="true" /> PDF</>}
                  </span>
                  <span className="boe-announce-title">{a.title}</span>
                  <span className="boe-announce-summary">{a.summary}</span>
                </span>
                <ChevronRight size={16} aria-hidden="true" className="boe-announce-chevron" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
