'use client'

import { colors } from '@/lib/tokens'
import { MeetingModal } from './MeetingModal'
import {
  ACTIVITY_EVENT_LABEL, ACTIVITY_EVENT_TONE, sortActivity, wasReopened,
} from '@/lib/meetings/activity'
import { formatMeetingTimestamp, type MeetingActivityEntry } from '@/lib/meetings/types'

// The meeting's own lifecycle trail — created, started, completed, reopened.
//
// Lifecycle events ONLY. SKU discussion updates live in MeetingHistoryModal and
// the two are never merged: one is "how did this meeting run", the other is
// "what did we say about this product". Mixing them would bury a single
// completion under forty SKU updates.
//
// Read-only by construction, not by convention: meeting_activity_log has no
// INSERT, UPDATE or DELETE policy for anyone, and no client role holds the
// underlying grants either. There is no edit control here because there is
// nothing an edit control could do.

const TONE_COLOR: Record<'neutral' | 'blue' | 'green' | 'amber', string> = {
  neutral: colors.muted,
  blue:    colors.blue,
  green:   '#2E8A58',
  amber:   colors.amber,
}

export function MeetingActivityModal({
  entries, onClose,
}: {
  entries: MeetingActivityEntry[]
  onClose: () => void
}) {
  // Oldest first: a lifecycle trail is a narrative and reads forwards.
  const ordered = sortActivity(entries)
  const reopened = wasReopened(entries)

  return (
    <MeetingModal
      title="Meeting Activity"
      subtitle="When this review was run, and by whom."
      onClose={onClose}
      width={480}
    >
      {reopened && (
        <div style={{
          padding: '9px 12px', borderRadius: '8px',
          background: colors.amberTint, border: '1px solid rgba(232,160,48,0.28)',
          fontSize: '12px', color: '#8A5A10', lineHeight: 1.45,
        }}>
          This meeting was reopened after being completed. Every completion is kept below —
          reopening adds to this record, it never replaces it.
        </div>
      )}

      {ordered.length === 0 ? (
        <div style={{ padding: '24px 0', textAlign: 'center', fontSize: '12.5px', color: colors.muted }}>
          No lifecycle events recorded yet.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {ordered.map((entry, index) => {
            const tone = TONE_COLOR[ACTIVITY_EVENT_TONE[entry.event_type]]
            const isLast = index === ordered.length - 1
            return (
              <div key={entry.id} style={{ display: 'flex', gap: '10px' }}>
                {/* Timeline rail — dot per event, connector between them. */}
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0 }}>
                  <span style={{
                    width: 9, height: 9, borderRadius: '50%',
                    background: tone, marginTop: '5px', flexShrink: 0,
                  }} />
                  {!isLast && (
                    <span style={{ width: 1, flex: 1, background: colors.border, marginTop: '3px' }} />
                  )}
                </div>

                <div style={{ paddingBottom: isLast ? 0 : '14px', minWidth: 0 }}>
                  <div style={{ fontSize: '12.5px', fontWeight: 700, color: colors.primary }}>
                    {ACTIVITY_EVENT_LABEL[entry.event_type]}
                  </div>
                  <div style={{ fontSize: '11.5px', color: colors.secondary, marginTop: '1px' }}>
                    {entry.actor_name?.trim() || 'Unknown'}
                  </div>
                  <div style={{ fontSize: '11px', color: colors.muted, marginTop: '1px' }}>
                    {formatMeetingTimestamp(entry.created_at)}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <div style={{ fontSize: '11px', color: colors.muted, borderTop: `1px solid ${colors.border}`, paddingTop: '10px' }}>
        Product and SKU updates are recorded separately — open the history on any product row.
      </div>
    </MeetingModal>
  )
}
