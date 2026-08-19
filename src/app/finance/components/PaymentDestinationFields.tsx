'use client'

// ── Payment destination + the cash trail behind it ────────────────────────────
// One question — which of the four BOE accounts did this money go to — and the
// conditional operational detail the two CASH destinations need. Shared by the
// submission modal and the owner's edit modal so a correction offers exactly
// the same four choices and the same fields as the original submission.
//
// It replaces two selects that were showing the same answer twice ("Payment
// Mode: Paytm" above "Received In: Paytm") and a single free-text input that
// was carrying the collector, the source and the handover as one sentence.
//
// Presentational + one query. Every rule it appears to enforce is enforced
// server-side as well: the destination pair by the table's CHECK constraints,
// the handover pair by finance_payment_requests_handover_pair (20260716 §2), and
// the whole set by finance_payment_requests_guard_approved once approved. The
// user list is filtered to active users here for usability, NOT as a security
// boundary — the FK is what guarantees a real user.

import { useEffect, useId, useRef, useState } from 'react'
import type { createClient } from '@/lib/supabase/client'
import { colors } from '@/lib/tokens'
import { HandCoins, Landmark, PiggyBank, Users, type LucideIcon } from 'lucide-react'
import {
  PAYMENT_DESTINATIONS,
  captureFor,
  collectionErrorFor,
  type CollectionState,
  type PaymentDestination,
  type PaymentDestinationKey,
} from '../paymentDestinations'

// Icon per destination, resolved from the pure module's iconKey so the four
// mappings live in one place and Task 2's review modal can reuse this map.
// Decorative: every icon sits beside its own visible label, and nothing is
// distinguished by the icon (or by colour) alone.
export const DESTINATION_ICON: Record<PaymentDestination['iconKey'], LucideIcon> = {
  'landmark':   Landmark,
  'piggy-bank': PiggyBank,
  'hand-coins': HandCoins,
  'users':      Users,
}

const SECTION_LABEL: React.CSSProperties = {
  fontSize: '10px', fontWeight: 700, color: colors.muted,
  textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '10px',
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

function LabelledField({ label, htmlFor, children }: { label: string; htmlFor?: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 }}>
      <label htmlFor={htmlFor} style={FIELD_LABEL}>{label}</label>
      {children}
    </div>
  )
}

export function PaymentDestinationFields({
  supabase,
  destination,
  onDestinationChange,
  collection,
  onCollectionChange,
  /** Seeds "Collected by" the first time a cash destination is chosen. */
  defaultCollectorId,
  /** Bounds the handover date and drives the ordering message. */
  paymentDate,
  disabled,
}: {
  supabase: ReturnType<typeof createClient>
  /**
   * NULL means no account has been stated. A payment recorded against a PI
   * carries none — only amount, date and mode are mandatory there — so no card
   * is shown active, and the pair is left untouched until somebody picks one.
   * Showing a default here would name an account the money never went to.
   */
  destination: PaymentDestinationKey | null
  onDestinationChange: (key: PaymentDestinationKey) => void
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

  // The ids the form OPENED with. Read once, so a user who has since left BOE
  // still appears in the dropdown of the record that names them instead of the
  // select silently falling back to its empty option and wiping the value on
  // the next save.
  const seededIds = useRef<string[]>(
    [collection.collectedBy, collection.handedOverTo].filter(Boolean),
  )

  useEffect(() => {
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
  }, [supabase])

  const capture = captureFor(destination)

  const selectDestination = (key: PaymentDestinationKey) => {
    if (disabled || key === destination) return
    // Moving onto a cash destination for the first time names the collector
    // without anyone typing: the submitter is who collected it, until they say
    // otherwise. Never overwrites a collector already chosen, and never clears
    // what the previous destination captured — buildCollectionPayload is what
    // decides which of those values are actually stored.
    if (captureFor(key) !== 'none' && !collection.collectedBy && defaultCollectorId) {
      onCollectionChange({ ...collection, collectedBy: defaultCollectorId })
    }
    onDestinationChange(key)
  }

  const setField = (key: keyof CollectionState) => (v: string) =>
    onCollectionChange({ ...collection, [key]: v })

  const error = collectionErrorFor(destination, collection, paymentDate)

  return (
    <div>
      <div style={SECTION_LABEL}>Payment Destination</div>

      {/* Four accounts, one choice. Two columns so each card has room for the
          account name AND what that account means — the meaning is the whole
          point, since "PNB" alone does not tell anyone cash was involved. */}
      <div
        role="radiogroup"
        aria-label="Payment destination"
        style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '8px' }}
      >
        {destination === null && (
          <div style={{
            gridColumn: '1 / -1', fontSize: '11px', color: colors.muted,
            marginBottom: '2px',
          }}>
            No account was stated when this payment was recorded. Choosing one
            below will set it; leaving this alone keeps it unstated.
          </div>
        )}
        {PAYMENT_DESTINATIONS.map(d => {
          const active = destination === d.key
          const Icon = DESTINATION_ICON[d.iconKey]
          return (
            <button
              key={d.key}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => selectDestination(d.key)}
              disabled={disabled}
              style={{
                display: 'flex', alignItems: 'flex-start', gap: '9px',
                padding: '9px 11px', borderRadius: '7px',
                cursor: disabled ? 'not-allowed' : 'pointer',
                border: active ? '1.5px solid #DC1F2E' : `1px solid ${colors.border}`,
                background: active ? 'rgba(220,31,46,0.04)' : colors.raised,
                textAlign: 'left', minWidth: 0,
              }}
            >
              <Icon
                size={15}
                aria-hidden="true"
                color={active ? '#DC1F2E' : colors.muted}
                style={{ flexShrink: 0, marginTop: '1px' }}
              />
              <span style={{ minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: '12.5px', fontWeight: 600, color: active ? '#DC1F2E' : colors.primary }}>
                  {d.label}
                </span>
                <span style={{ display: 'block', fontSize: '10.5px', color: colors.muted, lineHeight: 1.35, marginTop: '1px' }}>
                  {d.helper}
                </span>
              </span>
            </button>
          )
        })}
      </div>

      {/* The cash trail. Shown only for the two destinations that mean somebody
          physically carried money, and titled for what actually happened rather
          than for the fields it contains. */}
      {capture !== 'none' && (
        <div style={{
          marginTop: '10px', padding: '11px 12px', borderRadius: '8px',
          border: `1px solid ${colors.border}`, background: colors.raised,
          display: 'flex', flexDirection: 'column', gap: '9px',
        }}>
          <div style={{ ...SECTION_LABEL, marginBottom: 0 }}>
            {capture === 'handover' ? 'Cash collection and handover' : 'Cash collection details'}
          </div>

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

            {capture === 'handover' && (
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
            )}
          </div>

          {capture === 'handover' && (
            <>
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
            </>
          )}

          <LabelledField
            label={capture === 'handover' ? 'Collection / handover note' : 'Collection details'}
            htmlFor={`${uid}-collection-note`}
          >
            <input
              id={`${uid}-collection-note`}
              className="boe-input"
              value={collection.note}
              disabled={disabled}
              onChange={e => setField('note')(e.target.value)}
              placeholder={capture === 'handover'
                ? 'Where and how the cash changed hands (optional)'
                : 'Where and how the cash was collected (optional)'}
              style={{ width: '100%' }}
            />
          </LabelledField>

          {error && (
            <span role="alert" style={{ fontSize: '11.5px', color: colors.red, lineHeight: 1.5 }}>
              {error}
            </span>
          )}
        </div>
      )}
    </div>
  )
}
