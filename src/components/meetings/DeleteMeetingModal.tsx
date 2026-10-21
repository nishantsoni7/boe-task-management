'use client'

import { useEffect, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { AlertTriangle } from 'lucide-react'
import { colors } from '@/lib/tokens'
import { MeetingModal, MeetingModalActions, MeetingModalError } from './MeetingModal'

// Administrator-only permanent deletion. Shown from the meeting page and from
// the desktop list row. The server (admin_delete_meeting) is the authority;
// this dialog only makes the act deliberate: it says what will go, what stays,
// and wants the word DELETE typed.

const CONFIRM_WORD = 'DELETE'

type Counts = { orders: number; updates: number; evidence: number; attendees: number; issues: number }

const COUNT_LABELS: { key: keyof Counts; label: string }[] = [
  { key: 'orders',    label: 'Orders under review' },
  { key: 'updates',   label: 'Recorded updates' },
  { key: 'evidence',  label: 'Evidence photos' },
  { key: 'issues',    label: 'Discussion issues on the agenda' },
  { key: 'attendees', label: 'Attendees' },
]

export function DeleteMeetingModal({
  supabase, meeting, onClose, onDeleted,
}: {
  supabase: SupabaseClient
  meeting: { id: string; title: string }
  onClose: () => void
  onDeleted: (filesFailed: number) => void
}) {
  const [counts, setCounts] = useState<Counts | null>(null)
  const [typed, setTyped]   = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState<string | null>(null)

  useEffect(() => {
    let active = true
    const count = async (table: string) => {
      const { count: n } = await supabase
        .from(table)
        .select('meeting_id', { count: 'exact', head: true })
        .eq('meeting_id', meeting.id)
      return n ?? 0
    }
    Promise.all([
      count('meeting_orders'),
      count('meeting_update_history'),
      count('meeting_order_evidence'),
      count('meeting_discussion_appearances'),
      count('meeting_attendees'),
    ]).then(([orders, updates, evidence, issues, attendees]) => {
      if (active) setCounts({ orders, updates, evidence, issues, attendees })
    }).catch(() => { if (active) setCounts(null) })
    return () => { active = false }
  }, [supabase, meeting.id])

  const remove = async () => {
    if (saving || typed.trim() !== CONFIRM_WORD) return
    setSaving(true)
    setError(null)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch('/api/meetings/delete', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify({ meeting_id: meeting.id }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(json.error ?? 'The meeting could not be deleted. Please try again.')
        setSaving(false)
        return
      }
      onDeleted(Number(json.filesFailed ?? 0))
    } catch {
      setError('Could not reach the server. Check your connection and try again.')
      setSaving(false)
    }
  }

  return (
    <MeetingModal
      title="Delete this meeting"
      subtitle={meeting.title}
      onClose={onClose}
      width={460}
    >
      {error && <MeetingModalError message={error} />}

      <div style={{
        display: 'flex', gap: '9px', alignItems: 'flex-start',
        padding: '10px 12px', borderRadius: '8px',
        background: 'rgba(180,35,50,0.07)', border: '1px solid rgba(180,35,50,0.28)',
      }}>
        <AlertTriangle size={15} strokeWidth={2} color="#B42332" style={{ flexShrink: 0, marginTop: '1px' }} />
        <div style={{ fontSize: '12px', color: '#8E1B28', lineHeight: 1.45 }}>
          This permanently deletes the meeting and everything recorded in it. It cannot be undone.
          Tasks created from this meeting are kept, and so are long-running discussion issues
          (an issue that only lived here returns to the Meeting Inbox).
        </div>
      </div>

      <div style={{ border: `1px solid ${colors.border}`, borderRadius: '8px', overflow: 'hidden' }}>
        {COUNT_LABELS.map((row, i) => (
          <div
            key={row.key}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '9px 14px', fontSize: '12.5px',
              borderBottom: i === COUNT_LABELS.length - 1 ? 'none' : `1px solid ${colors.border}`,
              background: i % 2 === 0 ? 'transparent' : colors.raised,
            }}
          >
            <span style={{ color: colors.secondary }}>{row.label}</span>
            <span style={{ fontWeight: 700, color: colors.primary, fontVariantNumeric: 'tabular-nums' }}>
              {counts ? counts[row.key] : '…'}
            </span>
          </div>
        ))}
      </div>

      <label style={{ display: 'block', fontSize: '12px', color: colors.secondary }}>
        Type <strong>{CONFIRM_WORD}</strong> to confirm
        <input
          value={typed}
          onChange={e => setTyped(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          style={{ marginTop: '6px', width: '100%' }}
        />
      </label>

      <MeetingModalActions
        onClose={onClose}
        onSave={remove}
        saving={saving}
        saveLabel="Delete Meeting"
        disabled={typed.trim() !== CONFIRM_WORD}
        destructive
      />
    </MeetingModal>
  )
}
