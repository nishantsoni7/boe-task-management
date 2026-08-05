'use client'

import { colors } from '@/lib/tokens'
import { MeetingModal } from './MeetingModal'
import { HISTORY_ENTRY_LABEL, historyChangeLines, hasUpdateText } from '@/lib/meetings/history'
import { formatMeetingTimestamp, type MeetingHistoryEntry } from '@/lib/meetings/types'

// The full trail for one SKU line, or one order.
//
// Read-only, by construction and not by convention: there is no edit control
// here because there is no UPDATE or DELETE policy on meeting_update_history for
// anyone, including an admin. Nothing on this screen could save a change if it
// tried.
//
// A pop-up rather than a page: the reader is mid-review and wants the previous
// three entries, not a navigation. It reuses the module's one modal shell, so
// Escape and ✕ close it and the backdrop does nothing — the BOE rule would
// permit click-away here (there is no unsaved input), but one dismissal
// behaviour across the module is worth more than the exemption.

export function MeetingHistoryModal({
  title, subtitle, entries, onClose,
}: {
  title: string
  subtitle?: string
  entries: MeetingHistoryEntry[]
  onClose: () => void
}) {
  return (
    <MeetingModal title={title} subtitle={subtitle} onClose={onClose} width={560}>
      <div style={{
        fontSize: '11px', color: colors.muted,
        display: 'flex', alignItems: 'center', gap: '6px',
      }}>
        <span>{entries.length} {entries.length === 1 ? 'entry' : 'entries'}</span>
        <span>·</span>
        <span>Newest first. Past entries can never be edited or removed.</span>
      </div>

      {entries.length === 0 ? (
        <div style={{ padding: '28px 0', textAlign: 'center', fontSize: '12.5px', color: colors.muted }}>
          Nothing recorded yet.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {entries.map((entry, index) => (
            <HistoryRow key={entry.id} entry={entry} isLast={index === entries.length - 1} />
          ))}
        </div>
      )}
    </MeetingModal>
  )
}

function HistoryRow({ entry, isLast }: { entry: MeetingHistoryEntry; isLast: boolean }) {
  const changes = historyChangeLines(entry)

  return (
    <div style={{
      paddingBottom: '12px', marginBottom: isLast ? 0 : '12px',
      borderBottom: isLast ? 'none' : `1px solid ${colors.border}`,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' }}>
        <div style={{ fontSize: '12px', fontWeight: 700, color: colors.primary }}>
          {HISTORY_ENTRY_LABEL[entry.entry_type]}
          {entry.sku && (
            <span style={{ fontWeight: 500, color: colors.muted }}> · {entry.sku}</span>
          )}
        </div>
        <div style={{ fontSize: '11px', color: colors.muted, whiteSpace: 'nowrap' }}>
          {entry.actor_name ?? 'Unknown'} · {formatMeetingTimestamp(entry.created_at)}
        </div>
      </div>

      {hasUpdateText(entry) && (
        <div style={{
          marginTop: '6px', padding: '8px 10px', borderRadius: '7px',
          background: colors.raised, borderLeft: `2px solid ${colors.blue}`,
          fontSize: '12.5px', color: colors.primary, lineHeight: 1.45, whiteSpace: 'pre-wrap',
        }}>
          {entry.new_update}
        </div>
      )}

      {/* The value that was replaced. Kept visible rather than implied by the
          entry below it — two updates on the same day are common and reading
          the trail backwards to reconstruct "before" is exactly what this
          column exists to spare people. */}
      {entry.previous_update && (
        <div style={{ marginTop: '5px', fontSize: '11.5px', color: colors.muted, lineHeight: 1.45 }}>
          <span style={{ fontWeight: 600 }}>Replaced: </span>
          <span style={{ whiteSpace: 'pre-wrap' }}>{entry.previous_update}</span>
        </div>
      )}

      {changes.length > 0 && (
        <div style={{ marginTop: '5px', display: 'flex', flexDirection: 'column', gap: '2px' }}>
          {changes.map((line, i) => (
            <div key={i} style={{ fontSize: '11.5px', color: colors.secondary }}>{line}</div>
          ))}
        </div>
      )}
    </div>
  )
}
