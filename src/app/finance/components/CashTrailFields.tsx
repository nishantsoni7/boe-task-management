'use client'

// ── Who carried the cash ──────────────────────────────────────────────────────
//
// WHY THIS SURVIVED THE ACCOUNT PICKER. The four BOE accounts (HDFC, Canara,
// Paytm, PNB) are gone from both payment-entry forms: the question they answered
// — payment_mode AND received_in in one click — is now the canonical five-value
// Payment Mode, and no account is invented in received_in's place
// (20261013000000). The cash trail is a DIFFERENT question and a live business
// process: somebody collects cash today because nobody authorised is around,
// submits the request, and records the handover tomorrow. Its five columns
// (20260716000000) are unchanged and so is the pair rule that governs them.
//
// SHOWN FOR CASH, AND ONLY CASH. Decided by captureForMode, which
// submit_payment_request decides again server-side — so a field the browser
// happened to leave filled in on a bank transfer is discarded, not stored. A
// hidden field is not an authorization and a stale one is not a fact.
//
// THE FULL HANDOVER SHAPE. Without an account to tell internally-collected cash
// from externally-collected cash, the honest default is to OFFER the handover
// fields and leave them blank, rather than to decide on somebody's behalf that
// no handover can have happened. Both halves stay optional; they are only
// required to be consistent with each other.

import { useEffect, useId, useRef, useState } from 'react'
import type { createClient } from '@/lib/supabase/client'
import { colors } from '@/lib/tokens'
import {
  collectionErrorForMode,
  modeCapturesCash,
  type CollectionState,
} from '../paymentDestinations'

const SECTION_LABEL: React.CSSProperties = {
  fontSize: '10px', fontWeight: 700, color: colors.muted,
  textTransform: 'uppercase', letterSpacing: '0.07em',
}

const FIELD_LABEL: React.CSSProperties = {
  fontSize: '11px', fontWeight: 600, color: colors.muted,
  textTransform: 'uppercase', letterSpacing: '0.05em',
}

type UserOption = { id: string; full_name: string; inactive?: boolean }

// A user picker with an explicit empty option. `emptyLabel` is what "nothing
// chosen" MEANS in that slot — "Not handed over yet" is a real state, not a
// missing value, so it is never shown as a blank line.
function UserSelect({
  value, onChange, users, emptyLabel, disabled, id,
}: {
  value: string
  onChange: (v: string) => void
  users: UserOption[]
  emptyLabel: string
  disabled?: boolean
  id?: string
}) {
  return (
    <select
      id={id}
      className="boe-input"
      value={value}
      disabled={disabled}
      onChange={e => onChange(e.target.value)}
      style={{ width: '100%' }}
    >
      <option value="">{emptyLabel}</option>
      {users.map(u => (
        <option key={u.id} value={u.id}>
          {u.inactive ? `${u.full_name} (inactive)` : u.full_name}
        </option>
      ))}
    </select>
  )
}

function LabelledField({ label, htmlFor, children }: {
  label: string
  htmlFor?: string
  children: React.ReactNode
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 }}>
      <label htmlFor={htmlFor} style={FIELD_LABEL}>{label}</label>
      {children}
    </div>
  )
}

export function CashTrailFields({
  supabase,
  paymentMode,
  collection,
  onCollectionChange,
  /** Seeds "Collected by" the first time Cash is chosen. */
  defaultCollectorId,
  /** Bounds the handover date and drives the ordering message. */
  paymentDate,
  disabled,
}: {
  supabase: ReturnType<typeof createClient>
  paymentMode: string
  collection: CollectionState
  onCollectionChange: (next: CollectionState) => void
  defaultCollectorId?: string
  paymentDate: string
  disabled?: boolean
}) {
  const [users, setUsers] = useState<UserOption[]>([])
  // Label/control pairs have to stay unique even if two of these were ever
  // mounted at once (a details modal behind an edit modal).
  const uid = useId()

  const capturing = modeCapturesCash(paymentMode)

  // The ids the form OPENED with. Read once, so a user who has since left BOE
  // still appears in the dropdown of the record that names them instead of the
  // select silently falling back to its empty option and wiping the value on
  // the next save.
  const seededIds = useRef<string[]>(
    [collection.collectedBy, collection.handedOverTo].filter(Boolean),
  )

  // ONE READ, AND ONLY WHEN IT IS NEEDED. The list is fetched the first time
  // Cash is actually chosen — a bank transfer never asks the users table
  // anything — and never again for the life of the form.
  const loaded = useRef(false)
  useEffect(() => {
    if (!capturing || loaded.current) return
    loaded.current = true
    let active = true
    ;(async () => {
      const { data } = await supabase
        .from('users')
        .select('id, full_name')
        .eq('is_active', true)
        .order('full_name')
      if (!active) return

      const list = ((data ?? []) as UserOption[]).map(u => ({ ...u }))
      const missing = seededIds.current.filter(id => !list.some(u => u.id === id))
      if (missing.length > 0) {
        const { data: extra } = await supabase
          .from('users')
          .select('id, full_name')
          .in('id', missing)
        if (!active) return
        for (const u of (extra ?? []) as UserOption[]) list.push({ ...u, inactive: true })
      }
      setUsers(list)
    })()
    return () => { active = false }
  }, [supabase, capturing])

  // Choosing Cash names the collector without anyone typing: the submitter is
  // who collected it, until they say otherwise. Never overwrites a collector
  // already chosen.
  useEffect(() => {
    if (!capturing || collection.collectedBy || !defaultCollectorId) return
    onCollectionChange({ ...collection, collectedBy: defaultCollectorId })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capturing, defaultCollectorId])

  if (!capturing) return null

  const setField = (key: keyof CollectionState) => (v: string) =>
    onCollectionChange({ ...collection, [key]: v })

  const error = collectionErrorForMode(paymentMode, collection, paymentDate)

  return (
    <div style={{
      padding: '11px 12px', borderRadius: '8px',
      border: `1px solid ${colors.border}`, background: colors.raised,
      display: 'flex', flexDirection: 'column', gap: '9px',
    }}>
      <div style={SECTION_LABEL}>Cash collection and handover</div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '9px' }}>
        <LabelledField label="Collected by" htmlFor={`${uid}-collected-by`}>
          <UserSelect
            id={`${uid}-collected-by`}
            value={collection.collectedBy}
            onChange={setField('collectedBy')}
            users={users}
            emptyLabel="Select a person"
            disabled={disabled}
          />
        </LabelledField>

        <LabelledField label="Collected from" htmlFor={`${uid}-collected-from`}>
          <input
            id={`${uid}-collected-from`}
            className="boe-input"
            value={collection.collectedFrom}
            disabled={disabled}
            onChange={e => setField('collectedFrom')(e.target.value)}
            placeholder="Outside party, if useful (optional)"
            style={{ width: '100%' }}
          />
        </LabelledField>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '9px' }}>
        <LabelledField label="Handed over to" htmlFor={`${uid}-handed-over-to`}>
          <UserSelect
            id={`${uid}-handed-over-to`}
            value={collection.handedOverTo}
            onChange={setField('handedOverTo')}
            users={users}
            emptyLabel="Not handed over yet"
            disabled={disabled}
          />
        </LabelledField>
        <LabelledField label="Handover date" htmlFor={`${uid}-handover-date`}>
          <input
            id={`${uid}-handover-date`}
            className="boe-input"
            type="date"
            value={collection.handoverDate}
            min={paymentDate || undefined}
            disabled={disabled}
            onChange={e => setField('handoverDate')(e.target.value)}
            style={{ width: '100%' }}
          />
        </LabelledField>
      </div>
      <span style={{ fontSize: '11px', color: colors.muted, lineHeight: 1.5 }}>
        Leave both blank if the cash has not been handed over yet — you can
        record the handover later, while this request is still editable.
      </span>

      <LabelledField label="Collection / handover note" htmlFor={`${uid}-collection-note`}>
        <input
          id={`${uid}-collection-note`}
          className="boe-input"
          value={collection.note}
          disabled={disabled}
          onChange={e => setField('note')(e.target.value)}
          placeholder="Where and how the cash changed hands (optional)"
          style={{ width: '100%' }}
        />
      </LabelledField>

      {error && (
        <span role="alert" style={{ fontSize: '11.5px', color: colors.red, lineHeight: 1.5 }}>
          {error}
        </span>
      )}
    </div>
  )
}
