'use client'

import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, CheckCircle2, FileText, ExternalLink } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { AnnouncementsShell } from '../AnnouncementsShell'
import {
  useMyAnnouncements, useAcknowledgeAnnouncement, signAnnouncementPdf,
} from '@/hooks/queries/useAnnouncements'
import {
  ANNOUNCEMENT_PDF_URL_TTL_SECONDS, announcementErrorMessage, formatAnnouncementDate, formatFileSize,
} from '@/lib/announcements'

type Shown = {
  id: string
  title: string
  summary: string
  body: string
  starts_on: string
  ends_on: string
  attachment_path: string | null
  attachment_name: string | null
  attachment_size: number | null
  read_at: string | null
  /** False for an admin previewing an announcement they are not a recipient of. */
  recipient: boolean
}

export default function AnnouncementDetailPage() {
  const { id } = useParams<{ id: string }>()
  return (
    <AnnouncementsShell title="Announcement">
      {({ userId, isAdmin }) => <AnnouncementDetail id={id} userId={userId} isAdmin={isAdmin} />}
    </AnnouncementsShell>
  )
}

function AnnouncementDetail({ id, userId, isAdmin }: { id: string; userId: string; isAdmin: boolean }) {
  const mine = useMyAnnouncements(userId)
  const own = mine.data?.find(a => a.id === id)

  // An administrator may open any announcement (from Control Center) without
  // being one of its recipients. RLS returns the row to admins only; for
  // anybody else a missing row means "not active for you".
  const preview = useQuery({
    queryKey: ['announcements', 'admin-preview', id],
    enabled: isAdmin && mine.isSuccess && !own,
    queryFn: async () => {
      const { data, error } = await createClient()
        .from('announcements')
        .select('id, title, summary, body, starts_on, ends_on, attachment_path, attachment_name, attachment_size')
        .eq('id', id)
        .maybeSingle()
      if (error) throw error
      return data
    },
  })

  const shown: Shown | null = own
    ? { ...own, recipient: true }
    : preview.data ? { ...preview.data, read_at: null, recipient: false } : null

  const pdf = useQuery({
    queryKey: ['announcements', 'pdf', shown?.attachment_path ?? null],
    enabled: !!shown?.attachment_path,
    queryFn: () => signAnnouncementPdf(shown!.attachment_path!, ANNOUNCEMENT_PDF_URL_TTL_SECONDS),
    // Re-sign before the link expires, so a page left open still opens.
    staleTime: (ANNOUNCEMENT_PDF_URL_TTL_SECONDS - 60) * 1000,
    refetchInterval: (ANNOUNCEMENT_PDF_URL_TTL_SECONDS - 60) * 1000,
  })

  const ack = useAcknowledgeAnnouncement(userId)

  const loading = mine.isPending || (isAdmin && !own && preview.isPending && preview.fetchStatus !== 'idle')
  if (loading) return <p className="boe-announce-muted">Loading…</p>

  if (!shown) {
    return (
      <div className="boe-announce-page">
        <BackLink />
        <p className="boe-announce-empty">
          This announcement is not available. It may have ended, or it was not addressed to you.
        </p>
      </div>
    )
  }

  return (
    <article className="boe-announce-page boe-announce-detail">
      <BackLink />

      <header className="boe-announce-detail-head">
        <h2 className="boe-announce-detail-title">{shown.title}</h2>
        <p className="boe-announce-detail-summary">{shown.summary}</p>
        <p className="boe-announce-card-meta">
          Active {formatAnnouncementDate(shown.starts_on)} – {formatAnnouncementDate(shown.ends_on)}
        </p>
      </header>

      <div className="boe-announce-detail-body">{shown.body}</div>

      {shown.attachment_path && (
        <section className="boe-announce-pdf" aria-label="Attached PDF">
          <div className="boe-announce-pdf-row">
            <FileText size={18} aria-hidden="true" />
            <span className="boe-announce-pdf-name">
              {shown.attachment_name}
              {shown.attachment_size != null && <span className="boe-announce-muted"> · {formatFileSize(shown.attachment_size)}</span>}
            </span>
            {pdf.data ? (
              <a className="boe-announce-btn" href={pdf.data} target="_blank" rel="noopener noreferrer">
                Open PDF <ExternalLink size={14} aria-hidden="true" />
              </a>
            ) : (
              <span className="boe-announce-muted">{pdf.isError ? 'The PDF could not be opened.' : 'Preparing…'}</span>
            )}
          </div>
          {/* Inline preview on wider screens; a phone opens the PDF in its own viewer. */}
          {pdf.data && (
            <iframe className="boe-announce-pdf-frame" src={pdf.data} title={shown.attachment_name ?? 'Announcement PDF'} />
          )}
        </section>
      )}

      <footer className="boe-announce-ack">
        {!shown.recipient ? (
          <p className="boe-announce-muted">Admin preview — you are not one of this announcement&apos;s recipients.</p>
        ) : shown.read_at ? (
          <p className="boe-announce-ack-done">
            <CheckCircle2 size={16} aria-hidden="true" />
            You confirmed you read this on {new Date(shown.read_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })}.
          </p>
        ) : (
          <>
            <button
              type="button"
              className="boe-announce-btn boe-announce-btn-primary"
              disabled={ack.isPending}
              onClick={() => ack.mutate(shown.id)}
            >
              {ack.isPending ? 'Saving…' : 'I have read this'}
            </button>
            {ack.isError && (
              <p className="boe-announce-error" role="alert">{announcementErrorMessage(ack.error)}</p>
            )}
          </>
        )}
      </footer>
    </article>
  )
}

function BackLink() {
  return (
    <Link href="/announcements" className="boe-announce-back">
      <ArrowLeft size={14} aria-hidden="true" /> All announcements
    </Link>
  )
}
