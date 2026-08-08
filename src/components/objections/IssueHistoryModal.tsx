'use client'

// "View History" — everything that has happened to one reported issue.
//
// An issue is not a conversation and this is not a chat window. It is an AUDIT
// TRAIL: the employee's submission, the admin's decision, and the same pair
// again for every re-raise, each with an actor and a timestamp. There is
// nothing to type here, which is the point — the only two ways to add to the
// trail are raising an issue and reviewing one, and both live where they always
// did.
//
// The trail is derived, never stored: a re-raise writes a NEW row and the table
// has no UPDATE policy at all, so no earlier submission or decision can have
// been overwritten by the time this reads them. See buildIssueHistory() in
// src/lib/objections.ts.
//
// Built on PayrollModal so it inherits the BOE Form Modal Dismissal Rule rather
// than restating it.

import { PayrollModal } from '@/components/payroll/PayrollModal'
import { colors } from '@/lib/tokens'
import {
  buildIssueHistory,
  issueSubjectLabel,
  employeeStatusLabel,
  statusTone,
  type IssueEvent,
  type ObjectionRow,
} from '@/lib/objections'

/** Chronological, like every other BOE activity trail (Orders, Assets). */
function eventTone(kind: IssueEvent['kind']): { dot: string; fg: string } {
  switch (kind) {
    case 'approved':  return { dot: '#059669', fg: '#047857' }
    case 'rejected':  return { dot: '#DC2626', fg: '#B91C1C' }
    case 're_raised': return { dot: '#B45309', fg: '#B45309' }
    case 'raised':    return { dot: '#4F6FD0', fg: '#3B63B8' }
  }
}

function stamp(at: string): string {
  const d = new Date(at)
  return Number.isNaN(d.getTime()) ? at : d.toLocaleString('en-IN')
}

export function IssueHistoryModal({
  chain, onClose, employeeLabel, reviewerLabel,
}: {
  /** Every issue raised against ONE record, oldest first. Never empty. */
  chain: ObjectionRow[]
  onClose: () => void
  /** "You" on the employee's own page; the employee's name for an admin. */
  employeeLabel?: string
  reviewerLabel?: string
}) {
  const events  = buildIssueHistory(chain, { employeeLabel, reviewerLabel })
  const latest  = chain[chain.length - 1]
  const subject = issueSubjectLabel(latest)
  const tone    = statusTone(latest.status)

  return (
    <PayrollModal
      title="Issue history"
      subtitle={subject}
      onClose={onClose}
      width={520}
    >
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', flexShrink: 0,
      }}>
        <span style={{
          padding: '2px 10px', borderRadius: 20, fontSize: 11.5, fontWeight: 600,
          background: tone.bg, color: tone.fg,
        }}>
          {employeeStatusLabel(latest.status)}
        </span>
        <span style={{ fontSize: 12, color: colors.muted }}>
          {chain.length === 1
            ? '1 submission'
            : `${chain.length} submissions · the earlier decisions are kept`}
        </span>
      </div>

      <ol style={{
        listStyle: 'none', margin: 0, padding: 0,
        display: 'flex', flexDirection: 'column', gap: 12,
      }}>
        {events.map(e => {
          const t = eventTone(e.kind)
          return (
            <li key={e.key} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
              {/* The rail: one dot per event, coloured by what happened. */}
              <span
                aria-hidden="true"
                style={{
                  width: 8, height: 8, borderRadius: '50%', background: t.dot,
                  marginTop: 6, flexShrink: 0,
                }}
              />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'baseline' }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: t.fg }}>{e.title}</span>
                  <span style={{ fontSize: 11.5, color: colors.muted }}>
                    {e.actor} · {stamp(e.at)}
                  </span>
                </div>
                {e.body && (
                  <div style={{
                    fontSize: 12.5, color: '#3D4455', lineHeight: 1.55, marginTop: 3,
                    whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                  }}>
                    {e.body}
                  </div>
                )}
                {e.snapshot && (
                  <div style={{ fontSize: 11.5, color: colors.muted, marginTop: 3 }}>
                    As recorded: {e.snapshot}
                  </div>
                )}
              </div>
            </li>
          )
        })}
      </ol>

      <div style={{ fontSize: 11.5, color: colors.muted, lineHeight: 1.5, flexShrink: 0 }}>
        Reviewing an issue records the outcome. It never changes attendance or
        salary by itself — an applied correction shows on the record itself.
      </div>
    </PayrollModal>
  )
}
