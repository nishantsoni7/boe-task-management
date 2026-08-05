'use client'

import { useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { AlertTriangle } from 'lucide-react'
import { colors } from '@/lib/tokens'
import { MeetingModal, MeetingModalActions, MeetingModalError } from './MeetingModal'
import { meetingErrorMessage, logMeetingFailure } from '@/lib/meetings/errors'
import { completionWarning, summarizeMeetingForCompletion } from '@/lib/meetings/status'
import type { MeetingOrder, MeetingOrderItem } from '@/lib/meetings/types'

// The compact summary shown when a meeting is completed.
//
// Completion is never blocked. A meeting ends when the meeting ends, and
// refusing to close it until every line is resolved would only teach people to
// mark things resolved. The warning states what carries forward — those items
// stay on the follow-up lists — and then the button says Complete anyway.

export function CompleteMeetingModal({
  supabase, meetingId, orders, items, onClose, onCompleted,
}: {
  supabase: SupabaseClient
  meetingId: string
  orders: MeetingOrder[]
  items: MeetingOrderItem[]
  onClose: () => void
  onCompleted: () => void
}) {
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState<string | null>(null)

  const summary = summarizeMeetingForCompletion(orders, items)
  const warning = completionWarning(summary)

  const complete = async () => {
    if (saving) return
    setSaving(true)
    setError(null)

    const { error: rpcErr } = await supabase.rpc('set_meeting_status', {
      p_meeting_id: meetingId,
      p_status: 'completed',
    })

    if (rpcErr) {
      logMeetingFailure('set-status', rpcErr)
      setError(meetingErrorMessage('set-status', rpcErr))
      setSaving(false)
      return
    }

    setSaving(false)
    onCompleted()
  }

  const rows: { label: string; value: number; emphasis?: boolean }[] = [
    { label: 'Orders reviewed',      value: summary.ordersReviewed },
    { label: 'Product lines',        value: summary.itemsReviewed },
    { label: 'Unresolved issues',    value: summary.unresolvedIssues, emphasis: summary.unresolvedIssues > 0 },
    { label: 'Follow-ups scheduled', value: summary.followUpsScheduled },
    { label: 'Tasks created',        value: summary.tasksCreated },
    { label: 'Items without updates', value: summary.itemsWithoutUpdates, emphasis: summary.itemsWithoutUpdates > 0 },
  ]

  return (
    <MeetingModal
      title="Complete this meeting"
      subtitle="Completed meetings become read-only. They can be reopened for a correction."
      onClose={onClose}
      width={460}
    >
      {error && <MeetingModalError message={error} />}

      <div style={{
        border: `1px solid ${colors.border}`, borderRadius: '10px', overflow: 'hidden',
      }}>
        {rows.map((row, i) => (
          <div
            key={row.label}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '9px 14px', fontSize: '12.5px',
              borderBottom: i === rows.length - 1 ? 'none' : `1px solid ${colors.border}`,
              background: i % 2 === 0 ? 'transparent' : colors.raised,
            }}
          >
            <span style={{ color: colors.secondary }}>{row.label}</span>
            <span style={{
              fontWeight: 700,
              color: row.emphasis ? colors.amber : colors.primary,
              fontVariantNumeric: 'tabular-nums',
            }}>
              {row.value}
            </span>
          </div>
        ))}
      </div>

      {warning && (
        <div style={{
          display: 'flex', gap: '9px', alignItems: 'flex-start',
          padding: '10px 12px', borderRadius: '8px',
          background: colors.amberTint, border: '1px solid rgba(232,160,48,0.28)',
        }}>
          <AlertTriangle size={15} strokeWidth={2} color={colors.amber} style={{ flexShrink: 0, marginTop: '1px' }} />
          <div style={{ fontSize: '12px', color: '#8A5A10', lineHeight: 1.45 }}>{warning}</div>
        </div>
      )}

      <MeetingModalActions
        onClose={onClose}
        onSave={complete}
        saving={saving}
        saveLabel="Complete Meeting"
      />
    </MeetingModal>
  )
}

/** Reopen a completed meeting — the one write permitted against one. */
export function ReopenMeetingModal({
  supabase, meetingId, onClose, onReopened,
}: {
  supabase: SupabaseClient
  meetingId: string
  onClose: () => void
  onReopened: () => void
}) {
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState<string | null>(null)

  const reopen = async () => {
    if (saving) return
    setSaving(true)
    setError(null)

    const { error: rpcErr } = await supabase.rpc('set_meeting_status', {
      p_meeting_id: meetingId,
      p_status: 'in_progress',
    })

    if (rpcErr) {
      logMeetingFailure('set-status', rpcErr)
      setError(meetingErrorMessage('set-status', rpcErr))
      setSaving(false)
      return
    }

    setSaving(false)
    onReopened()
  }

  return (
    <MeetingModal
      title="Reopen this meeting?"
      subtitle="For a correction to what was recorded."
      onClose={onClose}
      width={420}
    >
      {error && <MeetingModalError message={error} />}
      <div style={{ fontSize: '12.5px', color: colors.secondary, lineHeight: 1.5 }}>
        The meeting returns to In Progress and becomes editable again. Everything already recorded
        stays exactly as it is — reopening adds to the record, it never rewrites it, and the
        completion can be re-applied afterwards.
      </div>
      <MeetingModalActions
        onClose={onClose}
        onSave={reopen}
        saving={saving}
        saveLabel="Reopen Meeting"
      />
    </MeetingModal>
  )
}
