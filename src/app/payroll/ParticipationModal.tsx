'use client'

// Attendance & Payroll participation — the admin control for holding a member
// out of the calculation without touching their account.
//
// One dialog does both halves of the requirement: it IS the review surface for
// who is currently excluded, and it is where somebody is excluded or brought
// back. That is why the periods table gained no permanent column — a status
// nobody changes on most days does not earn a column in the table you read every
// time you run payroll, and a list of twenty names does not earn a page.
//
// Confirmation is inline rather than a second modal on top of this one. The
// wording is not written here: it comes from src/lib/payroll/participation.ts,
// beside the predicate the two modules actually filter on, so the sentence an
// admin reads describes what the code does.

import { useState } from 'react'
import { colors } from '@/lib/tokens'
import { PayrollModal, PayrollModalError } from '@/components/payroll/PayrollModal'
import {
  excludeConfirmTitle,
  includeConfirmTitle,
  EXCLUDE_CONFIRM_BODY,
  INCLUDE_CONFIRM_BODY,
} from '@/lib/payroll/participation'

export type ParticipationMember = {
  id: string
  full_name: string
  employee_code: string | null
  monthly_salary: number | null
  participating: boolean
  is_active: boolean
}

/** The member awaiting confirmation, and the direction being confirmed. */
type Pending = { member: ParticipationMember; next: boolean }

export function ParticipationModal({
  members, loading, error, saving, onConfirm, onClose,
}: {
  members: ParticipationMember[]
  loading: boolean
  error: string | null
  /** Id of the member currently being written, so only that row shows progress. */
  saving: string | null
  onConfirm: (member: ParticipationMember, next: boolean) => Promise<void>
  onClose: () => void
}) {
  const [pending, setPending] = useState<Pending | null>(null)

  const included = members.filter(m => m.participating)
  const excluded = members.filter(m => !m.participating)

  const confirmAction = async () => {
    if (!pending) return
    await onConfirm(pending.member, pending.next)
    setPending(null)
  }

  return (
    <PayrollModal
      title="Attendance & Payroll Participation"
      subtitle="Members excluded here keep their BOE account and every other module. Only attendance processing and payroll generation ignore them."
      onClose={onClose}
      width={560}
    >
      {error && <PayrollModalError message={error} />}

      {pending ? (
        <ConfirmPanel
          pending={pending}
          saving={saving === pending.member.id}
          onCancel={() => setPending(null)}
          onConfirm={confirmAction}
        />
      ) : loading ? (
        <div style={{ padding: '24px 0', fontSize: 13, color: colors.muted, textAlign: 'center' }}>
          Loading members…
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18, maxHeight: '58vh', overflowY: 'auto' }}>
          {/* Excluded first. It is the shorter list and the one an admin opens
              this dialog to check. */}
          <MemberGroup
            title="Excluded from Attendance & Payroll"
            emptyNote="Nobody is excluded. Every active member is processed."
            members={excluded}
            actionLabel="Include"
            savingId={saving}
            onAct={member => setPending({ member, next: true })}
          />
          <MemberGroup
            title={`Included · ${included.length}`}
            emptyNote="No members are currently included."
            members={included}
            actionLabel="Exclude"
            savingId={saving}
            onAct={member => setPending({ member, next: false })}
          />
        </div>
      )}
    </PayrollModal>
  )
}

// ─── Confirmation ─────────────────────────────────────────────────────────────

function ConfirmPanel({
  pending, saving, onCancel, onConfirm,
}: {
  pending: Pending
  saving: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const { member, next } = pending
  const title = next ? includeConfirmTitle(member.full_name) : excludeConfirmTitle(member.full_name)
  const body  = next ? INCLUDE_CONFIRM_BODY : EXCLUDE_CONFIRM_BODY

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{
        padding: '14px 16px', borderRadius: 9,
        background: next ? 'rgba(69,168,112,0.08)' : 'rgba(232,160,48,0.10)',
        border: `1px solid ${next ? 'rgba(69,168,112,0.28)' : 'rgba(232,160,48,0.35)'}`,
      }}>
        <div style={{ fontSize: 13.5, fontWeight: 600, color: colors.primary }}>{title}</div>
        <div style={{ fontSize: 12.5, color: '#4B5563', lineHeight: 1.55, marginTop: 6 }}>{body}</div>
      </div>

      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
        <button onClick={onCancel} className="boe-btn boe-btn-ghost" style={{ padding: '8px 18px', fontSize: 13 }}>
          Cancel
        </button>
        <button
          onClick={onConfirm}
          disabled={saving}
          className="boe-btn boe-btn-primary"
          style={{ padding: '8px 18px', fontSize: 13, opacity: saving ? 0.6 : 1 }}
        >
          {saving ? 'Saving…' : next ? 'Include member' : 'Exclude member'}
        </button>
      </div>
    </div>
  )
}

// ─── Group ────────────────────────────────────────────────────────────────────

function MemberGroup({
  title, emptyNote, members, actionLabel, savingId, onAct,
}: {
  title: string
  emptyNote: string
  members: ParticipationMember[]
  actionLabel: string
  savingId: string | null
  onAct: (member: ParticipationMember) => void
}) {
  return (
    <div>
      <div style={{
        fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase',
        letterSpacing: '0.09em', color: colors.muted, marginBottom: 7,
      }}>
        {title}
      </div>

      {members.length === 0 ? (
        <div style={{
          padding: '12px 14px', borderRadius: 9, background: 'rgba(0,0,0,0.025)',
          fontSize: 12.5, color: colors.muted,
        }}>
          {emptyNote}
        </div>
      ) : (
        <div style={{ border: `1px solid ${colors.border}`, borderRadius: 10, overflow: 'hidden' }}>
          {members.map((m, i) => (
            <div
              key={m.id}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                gap: 12, padding: '9px 13px',
                borderTop: i > 0 ? `1px solid ${colors.border}` : 'none',
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{
                  fontSize: 13, fontWeight: 500, color: colors.primary,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {m.full_name}
                </div>
                <div style={{ fontSize: 11.5, color: colors.muted, marginTop: 1 }}>
                  {m.employee_code ?? 'No employee code'}
                  {/* Worth saying out loud: an inactive account is already out of
                      payroll for a different reason, and re-including it here
                      would not by itself bring them back. */}
                  {!m.is_active && ' · Account inactive'}
                </div>
              </div>
              <button
                onClick={() => onAct(m)}
                disabled={savingId === m.id}
                className="boe-btn boe-btn-ghost"
                style={{ padding: '4px 12px', fontSize: 12.5, whiteSpace: 'nowrap', flexShrink: 0 }}
              >
                {savingId === m.id ? 'Saving…' : actionLabel}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
