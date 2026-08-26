'use client'

// ── What a payment is for, and who carried it — as read-only blocks ──────────
//
// Both Finance surfaces open modals on one payment at a time, and both need the
// same two answers: WHICH RECORD is this money for, and WHO physically held it.
// Neither answer is on the payment row any more — the first lives in
// finance_payment_destinations (20261014000000 §8), the second in
// finance_payment_custody_events (§2) — so both are read here, once, by
// components the two pages share rather than by two copies that drift.
//
// ONE ROUND TRIP EACH, ON MODAL OPEN. Never per row of a list: the lists read
// their destinations for a whole page in one request through
// loadPaymentDestinations.

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { createClient } from '@/lib/supabase/client'
import { colors } from '@/lib/tokens'
import {
  DESTINATION_LOADING,
  destinationLabel,
  destinationReferenceLabel,
  loadPaymentDestination,
  type PaymentDestination,
} from '@/lib/finance/paymentDestination'
import {
  CUSTODY_TRAIL_TITLE,
  custodyDraftsError,
  custodyTrail,
  custodyTrailUserIds,
  legacyCustodyEvents,
  modeRequiresCustodyTrail,
  readCustodyEvent,
  toRpcCustodyEvents,
  type CustodyDraft,
  type CustodyEvent,
  type CustodyEventRow,
  type LegacyCustodyColumns,
} from '@/lib/finance/custodyTrail'
import { customerDisplayName, paymentEntryErrorMessage } from '@/lib/finance/paymentEntry'
import { CustodyTrailFields, CustodyTrailView, newCustodyDraftKey } from './CustodyTrailFields'

const SECTION_LABEL: React.CSSProperties = {
  fontSize: '10px', fontWeight: 700, color: colors.muted,
  textTransform: 'uppercase', letterSpacing: '0.07em',
}

// ── The destination ──────────────────────────────────────────────────────────

/**
 * One payment's destination.
 *
 * UNDEFINED IS NOT NULL HERE. `undefined` means it has not been read back yet
 * and every label says "Reading…"; `null` means the projection returned nothing
 * for this payment. Collapsing the two would show "Suspense / Unallocated" for a
 * moment on every targeted payment, which is the flicker the intent summary used
 * to have.
 */
export function usePaymentDestination(
  supabase: ReturnType<typeof createClient> | null,
  paymentId: string,
): PaymentDestination | null | undefined {
  const [destination, setDestination] = useState<PaymentDestination | null | undefined>(undefined)
  useEffect(() => {
    if (!supabase) return
    let active = true
    ;(async () => {
      const found = await loadPaymentDestination(supabase, paymentId)
      if (active) setDestination(found)
    })()
    return () => { active = false }
  }, [supabase, paymentId])
  return destination
}

/**
 * "What this payment is for", in one block.
 *
 * BEFORE APPROVAL it is the pending allocation intent — the PI Draft or
 * Confirmed Order somebody chose on the form. AFTER approval it is the active
 * allocations. The projection decides which; this only puts it into words, and
 * says which of the two it read so a person can tell a promise from a fact.
 */
export function PaymentDestinationSummary({
  destination, clientName, distinctCustomers,
}: {
  destination: PaymentDestination | null | undefined
  clientName: string | null
  /** Overrides the destination's own count, when the caller already has one. */
  distinctCustomers?: number
}) {
  const reference = destinationReferenceLabel(destination)
  const customers = distinctCustomers ?? destination?.customerCount ?? 0
  return (
    <div style={{
      padding: '11px 12px', borderRadius: '8px',
      border: `1px solid ${colors.border}`, background: colors.raised,
      display: 'flex', flexDirection: 'column', gap: '6px',
    }}>
      <div style={SECTION_LABEL}>What this payment is for</div>

      {destination === undefined ? (
        <div style={{ fontSize: '13px', color: colors.muted }}>{DESTINATION_LOADING}</div>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px', alignItems: 'baseline' }}>
          <span style={{ fontSize: '13px', fontWeight: 600, color: colors.primary }}>
            {destinationLabel(destination)}
          </span>
          {reference && (
            <span style={{ fontSize: '12.5px', color: colors.secondary }}>{reference}</span>
          )}
          {destination && (
            <span style={{ fontSize: '11px', color: colors.muted }}>
              {destination.source === 'intent'
                ? 'Chosen on the request — attached when Finance verifies it'
                : destination.source === 'allocation'
                  ? 'From this payment’s allocations'
                  : 'Nothing is attached to this payment yet'}
            </span>
          )}
        </div>
      )}

      <div style={{ fontSize: '12.5px', color: colors.secondary }}>
        {customerDisplayName(clientName, { distinctAllocationCustomers: customers })}
      </div>

      <span style={{ fontSize: '11px', color: colors.muted, lineHeight: 1.5 }}>
        Read from the record itself, never typed.
      </span>
    </div>
  )
}

// ── The custody trail ────────────────────────────────────────────────────────

export type CustodyTrailSource = LegacyCustodyColumns & {
  id: string
  payment_date?: string | null
}

/**
 * A payment's whole custody trail — stored events AND the legacy columns —
 * with an optional append control for whoever the database will actually let
 * append.
 *
 * `canAppend` IS A DRAWING RULE, NEVER AN AUTHORIZATION. Every save calls
 * append_payment_custody_events, which re-derives the actor, requires Finance
 * module entry, and permits only a finance.approve/finance.manage holder or the
 * request's own submitter while it is unapproved. Hiding the control protects
 * nobody and showing it grants nothing.
 *
 * IT NEVER OFFERS AN EDIT OR A DELETE, because there is no code path that could
 * honour one: the table refuses every UPDATE for every role, and no client role
 * holds DELETE. Correcting the record means adding what actually happened.
 */
export function PaymentCustodyTrail({
  supabase, payment, canAppend, formatDateTime, onAppended,
}: {
  supabase: ReturnType<typeof createClient> | null
  payment: CustodyTrailSource
  canAppend?: boolean
  formatDateTime: (iso: string) => string
  onAppended?: () => void
}) {
  const [saved, setSaved] = useState<CustodyEvent[] | undefined>(undefined)
  const [names, setNames] = useState<Map<string, string>>(new Map())
  const [drafts, setDrafts] = useState<CustodyDraft[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const legacy = useMemo(
    () => legacyCustodyEvents(payment, payment.payment_date ?? null),
    [payment],
  )

  const load = useCallback(async () => {
    if (!supabase) return
    const { data } = await supabase
      .from('finance_payment_custody_events')
      .select('id, activity_type, occurred_at, collected_by_user_id, handed_by_user_id, handed_to_user_id, remark, payment_mode_at_event, created_by, created_at')
      .eq('payment_request_id', payment.id)
      .order('occurred_at', { ascending: true })

    const events = ((data ?? []) as unknown as CustodyEventRow[]).map(readCustodyEvent)
    setSaved(events)

    // ONE NAME LOOKUP for the whole trail, legacy rows included. A raw uuid is
    // never rendered.
    const ids = custodyTrailUserIds([...events, ...legacy])
    if (ids.length === 0) { setNames(new Map()); return }
    const { data: people } = await supabase
      .from('users').select('id, full_name').in('id', ids)
    setNames(new Map(((people ?? []) as { id: string; full_name: string }[])
      .map(u => [u.id, u.full_name])))
  }, [supabase, payment.id, legacy])

  // ASYNC, AND NOT A SYNCHRONOUS setState IN AN EFFECT BODY. The read happens
  // inside the promise, so React is updated when the external system answers
  // rather than during the effect itself — the shape every other loader on these
  // pages uses.
  useEffect(() => {
    let active = true
    ;(async () => { if (active) await load() })()
    return () => { active = false }
  }, [load])

  // THE TRAIL IS SHOWN WHENEVER THERE IS ONE, whatever the payment's mode is
  // TODAY. A pending request corrected from PNB to a bank account keeps its
  // history visible — what is withdrawn is the ability to add MORE, which is
  // exactly what the database enforces.
  const events = custodyTrail(saved ?? [], legacy)
  const applies = modeRequiresCustodyTrail(payment.payment_mode)
  if (saved === undefined) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        <div style={SECTION_LABEL}>{CUSTODY_TRAIL_TITLE}</div>
        <div style={{
          border: `1px solid ${colors.border}`, borderRadius: '10px',
          padding: '10px 12px', fontSize: '13px', color: colors.muted,
        }}>
          {DESTINATION_LOADING}
        </div>
      </div>
    )
  }
  if (!applies && events.length === 0) return null

  const draftError = custodyDraftsError(drafts)

  const save = async () => {
    if (!supabase || saving || drafts.length === 0 || draftError) return
    setSaving(true)
    setError(null)
    const { error: rpcError } = await supabase.rpc('append_payment_custody_events', {
      p_payment_request_id: payment.id,
      p_events: toRpcCustodyEvents(drafts),
    })
    setSaving(false)
    if (rpcError) { setError(paymentEntryErrorMessage(rpcError.message)); return }
    setDrafts([])
    await load()
    onAppended?.()
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <CustodyTrailView
        events={events}
        names={names}
        formatDateTime={formatDateTime}
        emptyLabel={applies
          ? 'No collection or handover recorded yet.'
          : 'No collection or handover was recorded for this payment.'}
      />

      {canAppend && applies && supabase && (
        <>
          <CustodyTrailFields
            supabase={supabase}
            paymentMode={payment.payment_mode}
            drafts={drafts}
            onDraftsChange={setDrafts}
            formatDateTime={formatDateTime}
            names={names}
            disabled={saving}
          />
          {drafts.length > 0 && (
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', alignItems: 'center' }}>
              {draftError && (
                <span role="alert" style={{ fontSize: '11.5px', color: colors.red, flex: 1 }}>
                  {draftError}
                </span>
              )}
              <button
                type="button"
                onClick={() => setDrafts([])}
                disabled={saving}
                className="boe-btn boe-btn-ghost"
                style={{ padding: '6px 12px', fontSize: '12px' }}
              >
                Discard
              </button>
              <button
                type="button"
                onClick={save}
                disabled={saving || !!draftError}
                className="boe-btn boe-btn-primary"
                style={{ padding: '6px 12px', fontSize: '12px' }}
              >
                {saving ? 'Saving…' : `Save ${drafts.length === 1 ? 'activity' : 'activities'}`}
              </button>
            </div>
          )}
          {error && (
            <span role="alert" style={{ fontSize: '11.5px', color: colors.red, lineHeight: 1.5 }}>
              {error}
            </span>
          )}
        </>
      )}
    </div>
  )
}

/** A fresh draft list holding one empty activity — what a form starts with. */
export function initialCustodyDrafts(): CustodyDraft[] {
  return []
}

export { newCustodyDraftKey }
