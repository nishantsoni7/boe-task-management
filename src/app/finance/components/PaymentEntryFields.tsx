'use client'

// ── The destination question, asked the same way on both forms ───────────────
//
// Three cards, one target search, one read-only customer line, one Suspense
// notice. Payment Request and Record Payment both render this, so the two forms
// cannot drift into asking the same question in different words.
//
// PRESENTATIONAL. Every rule it appears to enforce is enforced again server-side
// by submit_payment_request and record_payment_with_allocations
// (20261013000000): the destination, the target's existence and eligibility, the
// customer. Hiding a control protects nobody; it is drawn this way because a
// person should be told before a round trip, not because the browser decides.
//
// THE CUSTOMER IS NEVER AN INPUT. It appears only after a target is chosen, as
// a read-only line confirming what was picked. There is no editable field, and
// no code path here sends a name — the server reads it from the target.

import { useId, useRef, useState } from 'react'
import { formatMoney } from '@/lib/finance/piPaymentView'
import { colors } from '@/lib/tokens'
import { Archive, FileText, PackageCheck, Wallet, Search, Check, type LucideIcon } from 'lucide-react'
import {
  OLD_ORDER_NOTICE,
  PAYMENT_DESTINATION_OPTIONS,
  REQUEST_DESTINATION_OPTIONS,
  SUSPENSE_NOTICE,
  destinationNeedsTarget,
  destinationTargetKind,
  type DestinationIconKey,
  type DestinationOption,
  type PaymentDestination,
  type RequestDestination,
} from '@/lib/finance/paymentEntry'
import {
  LEGACY_CLIENT_NAME_MAX,
  LEGACY_ORDER_NO_MAX,
  isLegacyRequestComplete,
} from '@/lib/finance/legacyOrderAllocation'

/** Resolved from the pure module's iconKey so the mapping lives in one place. */
const DESTINATION_ICON: Record<DestinationIconKey, LucideIcon> = {
  'file-text':     FileText,
  'package-check': PackageCheck,
  'wallet':        Wallet,
  'archive':       Archive,
}

export type PaymentEntryTarget = {
  id: string
  /** PI number or Order number, as the person recognises it. */
  reference: string
  clientName: string
  /** Grand total or Order value, when the search returned one. */
  totalValue?: number | null
}

/** The two typed facts of an Old Order request. Meaningful only for that destination. */
export type LegacyEntry = { orderNo: string; clientName: string }

export type PaymentEntryState = {
  destination: RequestDestination
  target: PaymentEntryTarget | null
  /** Absent means empty. Kept when the destination changes, so a slip of the mouse loses nothing. */
  legacy?: LegacyEntry
}

// A form that opens before anything is chosen opens on one of the three
// destinations both forms share; Old Order is something a person picks.
export const EMPTY_PAYMENT_ENTRY: PaymentEntryState & { destination: PaymentDestination } = {
  destination: 'pi_draft',
  target: null,
}

/**
 * Changing destination CLEARS the target.
 *
 * A PI Draft chosen under "PI Draft" is not a valid answer to "Confirmed
 * Order", and carrying it across would submit a target of the wrong kind — one
 * the server would refuse, after the person had stopped looking. Suspense
 * clears it too: a Suspense entry that quietly remembered a target would
 * allocate money the person had told it not to.
 */
export function switchDestination(
  state: PaymentEntryState,
  destination: RequestDestination,
): PaymentEntryState {
  if (state.destination === destination) return state
  return { ...state, destination, target: null }
}

/** Is the destination half answered? */
export function isPaymentEntryComplete(state: PaymentEntryState): boolean {
  if (state.destination === 'old_order') return isLegacyRequestComplete(state.legacy)
  return destinationNeedsTarget(state.destination) ? state.target !== null : true
}

// ── The cards ────────────────────────────────────────────────────────────────

function DestinationCard({
  option, selected, onSelect,
}: {
  option: DestinationOption
  selected: boolean
  onSelect: () => void
}) {
  const Icon = DESTINATION_ICON[option.iconKey]
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className="boe-destination-card"
      data-selected={selected ? 'true' : undefined}
      style={{
        display: 'flex', flexDirection: 'column', gap: '4px', textAlign: 'left',
        padding: '12px', borderRadius: '8px', cursor: 'pointer', flex: '1 1 180px',
        border: `1px solid ${selected ? colors.primary : colors.border}`,
        background: selected ? colors.hover : '#FFFFFF',
        // The selected card is named by its border AND its check mark, never by
        // colour alone.
        boxShadow: selected ? `inset 0 0 0 1px ${colors.primary}` : 'none',
      }}
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <Icon size={16} aria-hidden="true" style={{ color: selected ? colors.primary : colors.muted }} />
        <span style={{ fontSize: '13px', fontWeight: 500, color: colors.primary }}>{option.label}</span>
        {selected && <Check size={14} aria-hidden="true" style={{ color: colors.primary, marginLeft: 'auto' }} />}
      </span>
      <span style={{ fontSize: '12px', color: colors.muted, lineHeight: 1.4 }}>
        {option.description}
      </span>
    </button>
  )
}

/**
 * The three cards, and nothing else.
 *
 * EXPORTED SEPARATELY because the two forms differ below this point and only
 * below it. Payment Request asks for ONE target; Record Payment divides a
 * payment across several of the same kind. Forcing both through one component
 * would be the oversized-component mistake; letting each draw its own cards
 * would be the drift this whole module exists to end. So the question is
 * shared and the answer's shape is not.
 */
export function DestinationCards<D extends RequestDestination = PaymentDestination>({
  value, onChange, disabled, options,
}: {
  value: D
  onChange: (next: D) => void
  disabled?: boolean
  /** The cards to draw: the three both forms share unless a form says otherwise. */
  options?: readonly DestinationOption[]
}) {
  const groupId = useId()
  const list: readonly DestinationOption[] = options ?? PAYMENT_DESTINATION_OPTIONS
  // Four cards sit two by two (one column on a phone); three keep their row.
  const grid = list.length > 3
  return (
    <div role="radiogroup" aria-labelledby={groupId}
         style={grid
           ? { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '8px' }
           : { display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
      <span id={groupId} style={{
        position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)',
      }}>Where should this payment go?</span>
      {list.map(option => (
        <DestinationCard
          key={option.value}
          option={option}
          selected={value === option.value}
          onSelect={() => !disabled && onChange(option.value as D)}
        />
      ))}
    </div>
  )
}

// ── The typed half of an Old Order request ──────────────────────────────────

function OldOrderField({
  id, label, placeholder, value, max, problem, disabled, autoFocus, onChange,
}: {
  id: string
  label: string
  placeholder: string
  value: string
  max: number
  problem: string | null
  disabled?: boolean
  autoFocus?: boolean
  onChange: (next: string) => void
}) {
  return (
    <div>
      <label htmlFor={id} style={{
        fontSize: '12px', fontWeight: 500, color: colors.muted, display: 'block', marginBottom: '6px',
      }}>
        {label}
        <span aria-hidden="true" style={{ color: colors.red }}> *</span>
      </label>
      <input
        id={id}
        className="boe-input"
        value={value}
        disabled={disabled}
        autoFocus={autoFocus}
        maxLength={max}
        aria-invalid={problem ? true : undefined}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        style={{ width: '100%' }}
      />
      {problem && (
        <p role="alert" style={{ margin: '4px 0 0', fontSize: '12px', color: colors.red, lineHeight: 1.4 }}>
          {problem}
        </p>
      )}
    </div>
  )
}

// ── The whole block ──────────────────────────────────────────────────────────

export function PaymentEntryFields({
  state, onChange, onSearch, disabled, initialQuery, autoFocusSearch, problem, legacyProblems,
}: {
  state: PaymentEntryState
  onChange: (next: PaymentEntryState) => void
  /** Bounded, debounced target search. Supplied by the form so this stays pure of Supabase. */
  onSearch: (kind: 'submission' | 'order', term: string) => Promise<PaymentEntryTarget[]>
  disabled?: boolean
  /**
   * Seeds the SEARCH BOX, and nothing else.
   *
   * A customer name arriving from another module (the ?client= deep link) is a
   * hint about what to look for, not a fact about this payment. It goes here so
   * the person does not retype it — never into a field that would be submitted,
   * because the customer is read from whichever record they actually pick.
   */
  initialQuery?: string
  /** Put the cursor in the search box when it first appears. */
  autoFocusSearch?: boolean
  /** A sentence under the search box, shown when it has been left unanswered. */
  problem?: string | null
  /** The same for the two typed fields of an Old Order request. */
  legacyProblems?: { orderNo: string | null; clientName: string | null } | null
}) {
  const groupId = useId()
  const [query, setQuery] = useState(initialQuery ?? '')
  const [results, setResults] = useState<PaymentEntryTarget[]>([])
  const [searching, setSearching] = useState(false)

  // Only the newest search may write results: a slow earlier query must never
  // overwrite a later one with stale rows. The same guard every other target
  // search in this module carries.
  const searchToken = useRef(0)
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null)

  const kind = destinationTargetKind(state.destination)

  const runSearch = (raw: string) => {
    setQuery(raw)
    if (debounce.current) clearTimeout(debounce.current)
    const term = raw.trim()
    if (!term || !kind) { setResults([]); return }
    debounce.current = setTimeout(async () => {
      const token = ++searchToken.current
      setSearching(true)
      const found = await onSearch(kind, term)
      if (token !== searchToken.current) return
      setResults(found)
      setSearching(false)
    }, 250)
  }

  const choose = (t: PaymentEntryTarget) => {
    onChange({ ...state, target: t })
    setResults([])
    setQuery('')
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <DestinationCards
        value={state.destination}
        onChange={next => onChange(switchDestination(state, next))}
        disabled={disabled}
        options={REQUEST_DESTINATION_OPTIONS}
      />

      {/* SUSPENSE: no search, and a plain sentence about what happens next. */}
      {state.destination === 'suspense' && (
        <p style={{
          margin: 0, fontSize: '12px', color: colors.muted, lineHeight: 1.5,
          padding: '10px 12px', borderRadius: '8px', background: colors.hover,
        }}>
          {SUSPENSE_NOTICE}
        </p>
      )}

      {/* OLD ORDER: there is no record to search for, so the person types the old
          order's number and its client — the two facts Allocate Funds asks for.
          The database checks both again; Finance attaches the payment when it
          verifies it. */}
      {state.destination === 'old_order' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <p style={{
            margin: 0, fontSize: '12px', color: colors.muted, lineHeight: 1.5,
            padding: '10px 12px', borderRadius: '8px', background: colors.hover,
          }}>
            {OLD_ORDER_NOTICE}
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '12px' }}>
            <OldOrderField
              id={`${groupId}-old-no`}
              label="Old order number"
              placeholder="e.g. 0412"
              value={state.legacy?.orderNo ?? ''}
              max={LEGACY_ORDER_NO_MAX}
              problem={legacyProblems?.orderNo ?? null}
              disabled={disabled}
              autoFocus={autoFocusSearch}
              onChange={orderNo => onChange({ ...state, legacy: { orderNo, clientName: state.legacy?.clientName ?? '' } })}
            />
            <OldOrderField
              id={`${groupId}-old-client`}
              label="Client"
              placeholder="Who the old order is for"
              value={state.legacy?.clientName ?? ''}
              max={LEGACY_CLIENT_NAME_MAX}
              problem={legacyProblems?.clientName ?? null}
              disabled={disabled}
              onChange={clientName => onChange({ ...state, legacy: { orderNo: state.legacy?.orderNo ?? '', clientName } })}
            />
          </div>
        </div>
      )}

      {/* A TARGET, once one is needed. */}
      {kind && !state.target && (
        <div>
          <label htmlFor={`${groupId}-search`} style={{
            fontSize: '12px', fontWeight: 500, color: colors.muted,
            display: 'block', marginBottom: '6px',
          }}>
            {state.destination === 'pi_draft' ? 'PI Draft' : 'Confirmed Order'}
            <span aria-hidden="true" style={{ color: colors.red }}> *</span>
          </label>
          <div style={{ position: 'relative' }}>
            <Search size={14} aria-hidden="true" style={{
              position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)',
              color: colors.muted, pointerEvents: 'none',
            }} />
            <input
              id={`${groupId}-search`}
              className="boe-input"
              value={query}
              disabled={disabled}
              autoFocus={autoFocusSearch}
              aria-invalid={problem ? true : undefined}
              onChange={e => runSearch(e.target.value)}
              placeholder={state.destination === 'pi_draft'
                ? 'Search PI number or customer' : 'Search Order number or customer'}
              style={{ width: '100%', paddingLeft: '30px' }}
            />
          </div>
          {problem && (
            <p role="alert" style={{ margin: '4px 0 0', fontSize: '12px', color: colors.red, lineHeight: 1.4 }}>
              {problem}
            </p>
          )}
          {searching && (
            <p style={{ margin: '6px 0 0', fontSize: '12px', color: colors.muted }}>Searching…</p>
          )}
          {results.length > 0 && (
            <ul style={{
              listStyle: 'none', margin: '6px 0 0', padding: 0, maxHeight: '180px',
              overflowY: 'auto', border: `1px solid ${colors.border}`, borderRadius: '8px',
            }}>
              {results.map(t => (
                <li key={t.id}>
                  <button type="button" onClick={() => choose(t)} className="boe-menu-item"
                          style={{ width: '100%', textAlign: 'left' }}>
                    <span style={{ fontWeight: 600 }}>{t.reference}</span>
                    <span style={{ color: colors.muted }}> · {t.clientName}</span>
                    {typeof t.totalValue === 'number' && Number.isFinite(t.totalValue) && t.totalValue > 0 && (
                      <span style={{ color: colors.muted, float: 'right' }}>{formatMoney(t.totalValue)}</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* THE DERIVED CUSTOMER, read-only. Never an input, and never sent: the
          server reads the name from the target it validates. This line exists so
          a person can confirm they picked the record they meant. */}
      {state.target && (
        <div style={{
          display: 'flex', flexWrap: 'wrap', gap: '4px 12px', alignItems: 'baseline',
          padding: '10px 12px', borderRadius: '8px', border: `1px solid ${colors.border}`,
        }}>
          <span style={{ fontSize: '13px', fontWeight: 600, color: colors.primary }}>
            {state.target.reference}
          </span>
          <span style={{ fontSize: '12px', color: colors.secondary }}>
            {state.target.clientName}
          </span>
          <button
            type="button"
            onClick={() => onChange({ ...state, target: null })}
            disabled={disabled}
            className="boe-btn boe-btn-ghost"
            style={{ marginLeft: 'auto', padding: '2px 8px', fontSize: '12px' }}
          >
            Change
          </button>
        </div>
      )}
    </div>
  )
}
