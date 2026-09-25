'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { FileText, Plus } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { useAdminMembers } from '@/hooks/queries/useControlCenterData'
import { MeetingModal, MeetingModalActions, MeetingModalError } from '@/components/meetings/MeetingModal'
import { Toast, useToast } from '@/components/ui/toast'
import { AnnouncementForm } from './AnnouncementForm'
import {
  announcementErrorMessage, announcementStatus, formatAnnouncementDate, indiaDate,
  type AdminAnnouncement, type AnnouncementStatus,
} from '@/lib/announcements'

// Control Center › Announcements. Small on purpose: a list, New, Edit and End.
// The Control Center layout admits admins only (UI half); every write is an
// admin-checked RPC and every read here is admin-scoped by RLS.

const ADMIN_KEY = ['announcements', 'admin'] as const

const STATUS_LABEL: Record<AnnouncementStatus, string> = {
  active: 'Active', scheduled: 'Scheduled', expired: 'Expired', ended: 'Ended early',
}

export default function ControlCenterAnnouncementsPage() {
  const qc = useQueryClient()
  const { toast, show, dismiss } = useToast()
  const [tab, setTab] = useState<'current' | 'past'>('current')
  const [editing, setEditing] = useState<AdminAnnouncement | 'new' | null>(null)
  const [ending, setEnding] = useState<AdminAnnouncement | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)

  const list = useQuery<AdminAnnouncement[]>({
    queryKey: ADMIN_KEY,
    queryFn: async () => {
      const { data, error } = await createClient()
        .from('announcements')
        .select('id, title, summary, body, starts_on, ends_on, attachment_path, attachment_name, attachment_size, ended_at, created_at, announcement_recipients(user_id), announcement_reads(user_id, read_at)')
        .order('created_at', { ascending: false })
      if (error) throw error
      return (data ?? []) as AdminAnnouncement[]
    },
  })

  const membersQuery = useAdminMembers()
  const members = useMemo(() => (membersQuery.data ?? [])
    .filter(m => !m.is_deleted && m.is_active)
    .map(m => ({ id: m.id, full_name: m.full_name, email: m.email, team: m.team }))
    .sort((a, b) => (a.full_name ?? '').localeCompare(b.full_name ?? '')), [membersQuery.data])
  const nameOf = useMemo(() => {
    const byId = new Map((membersQuery.data ?? []).map(m => [m.id, m.full_name ?? m.email ?? 'Unknown']))
    return (id: string) => byId.get(id) ?? 'Former employee'
  }, [membersQuery.data])

  const today = indiaDate()
  const rows = (list.data ?? []).filter(a => {
    const s = announcementStatus(a, today)
    return tab === 'current' ? s === 'active' || s === 'scheduled' : s === 'expired' || s === 'ended'
  })

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ADMIN_KEY })
    // The admin may be a recipient too; their own banner follows.
    void qc.invalidateQueries({ queryKey: ['announcements', 'mine'] })
  }

  return (
    <div className="boe-announce-admin">
      <div className="boe-announce-admin-bar">
        <div className="boe-announce-tabs" role="tablist" aria-label="Announcements">
          <button role="tab" aria-selected={tab === 'current'} className={tab === 'current' ? 'on' : ''} onClick={() => setTab('current')}>
            Active &amp; scheduled
          </button>
          <button role="tab" aria-selected={tab === 'past'} className={tab === 'past' ? 'on' : ''} onClick={() => setTab('past')}>
            Expired &amp; ended
          </button>
        </div>
        <button type="button" className="boe-btn boe-btn-primary" onClick={() => setEditing('new')}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 14px', fontSize: 13 }}>
          <Plus size={15} aria-hidden="true" /> New announcement
        </button>
      </div>

      {list.isPending ? (
        <p className="boe-announce-muted">Loading…</p>
      ) : list.isError ? (
        <p className="boe-announce-error">Announcements could not be loaded. {announcementErrorMessage(list.error, '')}</p>
      ) : rows.length === 0 ? (
        <p className="boe-announce-empty">
          {tab === 'current' ? 'No active or scheduled announcements.' : 'No expired or ended announcements.'}
        </p>
      ) : (
        <ul className="boe-announce-admin-list">
          {rows.map(a => {
            const status = announcementStatus(a, today)
            const readIds = new Set(a.announcement_reads.map(r => r.user_id))
            const recipients = a.announcement_recipients.map(r => r.user_id)
            const readCount = recipients.filter(id => readIds.has(id)).length
            const open = expanded === a.id
            return (
              <li key={a.id} className="boe-announce-admin-row">
                <div className="boe-announce-admin-main">
                  <div className="boe-announce-card-meta">
                    <span className={`boe-announce-status s-${status}`}>{STATUS_LABEL[status]}</span>
                    {formatAnnouncementDate(a.starts_on)} – {formatAnnouncementDate(a.ends_on)}
                    {a.attachment_path && <> · <FileText size={12} aria-hidden="true" /> PDF</>}
                  </div>
                  <div className="boe-announce-title">{a.title}</div>
                  <div className="boe-announce-summary">{a.summary}</div>
                  <button type="button" className="boe-announce-linkbtn" aria-expanded={open}
                    onClick={() => setExpanded(open ? null : a.id)}>
                    {readCount} of {recipients.length} read
                  </button>
                  {open && (
                    <ul className="boe-announce-readers">
                      {recipients
                        .map(id => ({ id, name: nameOf(id), read: readIds.has(id) }))
                        .sort((x, y) => Number(x.read) - Number(y.read) || x.name.localeCompare(y.name))
                        .map(r => (
                          <li key={r.id}>
                            <span>{r.name}</span>
                            <span className={r.read ? 'read' : 'unread'}>{r.read ? 'Read' : 'Not yet'}</span>
                          </li>
                        ))}
                    </ul>
                  )}
                </div>
                <div className="boe-announce-admin-actions">
                  <Link href={`/announcements/${a.id}`} className="boe-btn boe-btn-ghost">View</Link>
                  {status !== 'ended' && (
                    <button type="button" className="boe-btn boe-btn-ghost" onClick={() => setEditing(a)}>Edit</button>
                  )}
                  {(status === 'active' || status === 'scheduled') && (
                    <button type="button" className="boe-btn boe-btn-danger" onClick={() => setEnding(a)}>End now</button>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {editing && (
        <AnnouncementForm
          existing={editing === 'new' ? null : editing}
          members={members}
          onClose={() => setEditing(null)}
          onSaved={msg => { setEditing(null); refresh(); show(msg) }}
        />
      )}

      {ending && (
        <EndAnnouncementDialog
          announcement={ending}
          onClose={() => setEnding(null)}
          onEnded={() => { setEnding(null); refresh(); show('Announcement ended. Employees no longer see it.') }}
        />
      )}

      <Toast toast={toast} onDismiss={dismiss} />
    </div>
  )
}

function EndAnnouncementDialog({ announcement, onClose, onEnded }: {
  announcement: AdminAnnouncement
  onClose: () => void
  onEnded: () => void
}) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const end = async () => {
    setSaving(true)
    setError(null)
    const { error: e } = await createClient().rpc('end_announcement', { p_id: announcement.id })
    if (e) { setError(announcementErrorMessage(e)); setSaving(false); return }
    onEnded()
  }
  return (
    <MeetingModal title="End this announcement now?" subtitle={announcement.title} onClose={onClose} width={440}>
      <p style={{ margin: 0, fontSize: 13, color: '#4A5261' }}>
        It disappears at once from every recipient&apos;s Modules page and Announcements list. This cannot be undone.
      </p>
      {error && <MeetingModalError message={error} />}
      <MeetingModalActions onClose={onClose} onSave={end} saving={saving} saveLabel="End announcement" destructive />
    </MeetingModal>
  )
}
