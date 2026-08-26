'use client'

// ── The collection and handover trail, as a control ──────────────────────────
//
// SHOWN FOR PNB AND PAYTM, AND FOR NOTHING ELSE. Those are the two modes where a
// person physically carries the money; the rest arrive in an account and nobody
// holds them. modeRequiresCustodyTrail says which, and
// payment_mode_requires_custody() decides it AGAIN server-side — so a section
// left on screen after the mode changed has its rows refused, not stored. A
// hidden field is not an authorization and a stale one is not a fact.
//
// WHAT THE FRONTEND NEVER SAYS. The accounts are called HDFC, PNB, Paytm and
// Canara. What each one MEANS internally is recorded in the database's own
// column comment and appears on no screen — no bracketed gloss follows an
// account name here or anywhere else, and paymentEntry.test.ts asserts it over
// this file's raw source.
//
// APPEND ONLY, AND THE CONTROL SAYS SO. A SAVED activity is drawn read-only,
// with no edit and no delete, because there is no code path anywhere that could
// change one: finance_payment_custody_events refuses every UPDATE for every
// role. Only an UNSAVED row can be removed, and only because it has never
// existed anywhere but this form.
//
// EACH DRAFT CARRIES ITS OWN IDEMPOTENCY KEY, minted when the row appears. That
// is what makes a retried submission and a double click write nothing: the
// append door inserts ON CONFLICT DO NOTHING against a unique (payment, key).

import { useEffect, useId, useRef, useState } from 'react'
import { Plus, X, ArrowRight, HandCoins, Lock } from 'lucide-react'
import type { createClient } from '@/lib/supabase/client'
import { colors } from '@/lib/tokens'
import {
  CUSTODY_ACTIVITY_OPTIONS,
  CUSTODY_TRAIL_NOTE,
  CUSTODY_TRAIL_TITLE,
  custodyDraftError,
  custodyEventLine,
  custodyTrail,
  emptyCustodyDraft,
  isoToLocalInput,
  modeRequiresCustodyTrail,
  type CustodyActivityType,
  type CustodyDraft,
  type CustodyEvent,
} from '@/lib/finance/custodyTrail'

// ── A key per drafted activity ───────────────────────────────────────────────
// crypto.randomUUID where it exists, a counter where it does not. Either way the
// key is minted ONCE, with the row, and travels with it to the server.
let draftSeq = 0
export function newCustodyDraftKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  draftSeq += 1
  return `custody-${Date.now()}-${draftSeq}`
}

const SECTION_LABEL: React.CSSProperties = {
  fontSize: '10px', fontWeight: 700, color: colors.muted,
  textTransform: 'uppercase', letterSpacing: '0.07em',
}

const FIELD_LABEL: React.CSSProperties = {
  fontSize: '11px', fontWeight: 600, color: colors.muted,
  textTransform: 'uppercase', letterSpacing: '0.05em',
}

export type UserOption = { id: string; full_name: string; inactive?: boolean }

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

function UserSelect({ id, value, onChange, users, disabled }: {
  id: string
  value: string
  onChange: (v: string) => void
  users: UserOption[]
  disabled?: boolean
}) {
  return (
    <select id={id} className="boe-input" value={value} disabled={disabled}
            onChange={e => onChange(e.target.value)} style={{ width: '100%' }}>
      <option value="">Select a person</option>
      {users.map(u => (
        <option key={u.id} value={u.id}>
          {u.inactive ? `${u.full_name} (inactive)` : u.full_name}
        </option>
      ))}
    </select>
  )
}

// ── A saved activity, read-only ──────────────────────────────────────────────

function SavedActivity({ line }: { line: ReturnType<typeof custodyEventLine> }) {
  return (
    <li style={{
      display: 'flex', gap: '10px', alignItems: 'flex-start',
      padding: '10px 12px', borderTop: `1px solid ${colors.border}`,
    }}>
      <HandCoins size={15} aria-hidden="true" style={{ color: colors.muted, marginTop: '2px', flexShrink: 0 }} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 10px', alignItems: 'baseline' }}>
          <span style={{ fontSize: '13px', fontWeight: 600, color: colors.primary }}>{line.title}</span>
          <span style={{ fontSize: '12.5px', color: colors.secondary, wordBreak: 'break-word' }}>{line.people}</span>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 10px', marginTop: '2px' }}>
          <span style={{ fontSize: '11.5px', color: colors.muted }}>{line.when}</span>
          <span style={{ fontSize: '11.5px', color: colors.muted }}>· {line.modeLabel}</span>
          {line.legacy && (
            <span style={{ fontSize: '11.5px', color: colors.muted }}>
              · Recorded before the activity trail existed
            </span>
          )}
        </div>
        {line.remark && (
          <div style={{ fontSize: '12.5px', color: colors.secondary, marginTop: '3px', wordBreak: 'break-word' }}>
            {line.remark}
          </div>
        )}
      </div>
      <Lock size={12} aria-hidden="true" style={{ color: colors.muted, marginTop: '4px', flexShrink: 0 }} />
      <span style={{
        position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)',
      }}>Saved — cannot be edited</span>
    </li>
  )
}

/**
 * The whole trail, read-only.
 *
 * Used by every detail and review surface, so a Payment Request's popup and a
 * Received Payment's popup describe a custody trail identically.
 */
export function CustodyTrailView({
  events, names, formatDateTime, emptyLabel,
}: {
  events: CustodyEvent[]
  names: Map<string, string>
  formatDateTime: (iso: string) => string
  emptyLabel?: string
}) {
  const ordered = custodyTrail(events)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      <div style={SECTION_LABEL}>{CUSTODY_TRAIL_TITLE}</div>
      {ordered.length === 0 ? (
        <div style={{
          border: `1px solid ${colors.border}`, borderRadius: '10px',
          padding: '10px 12px', fontSize: '13px', color: colors.muted,
        }}>
          {emptyLabel ?? 'No collection or handover recorded yet.'}
        </div>
      ) : (
        <ul style={{
          listStyle: 'none', margin: 0, padding: 0,
          border: `1px solid ${colors.border}`, borderRadius: '10px', overflow: 'hidden',
        }}>
          {ordered.map((e, i) => (
            <li key={e.id} style={{ position: 'relative', marginTop: i === 0 ? '-1px' : 0 }}>
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                <SavedActivity line={custodyEventLine(e, names, formatDateTime)} />
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// ── The editor ───────────────────────────────────────────────────────────────

export function CustodyTrailFields({
  supabase,
  paymentMode,
  drafts,
  onDraftsChange,
  saved = [],
  names,
  formatDateTime,
  defaultActorId,
  disabled,
}: {
  supabase: ReturnType<typeof createClient>
  paymentMode: string
  drafts: CustodyDraft[]
  onDraftsChange: (next: CustodyDraft[]) => void
  /** Activities already stored. Drawn read-only above the drafts. */
  saved?: CustodyEvent[]
  names?: Map<string, string>
  formatDateTime?: (iso: string) => string
  /** Seeds "Collected by" on the first activity — usually the submitter. */
  defaultActorId?: string
  disabled?: boolean
}) {
  const [users, setUsers] = useState<UserOption[]>([])
  const uid = useId()
  const applies = modeRequiresCustodyTrail(paymentMode)

  // The ids the form OPENED with, so somebody who has since left BOE still
  // appears in the dropdown of the row that names them.
  const seededIds = useRef<string[]>(
    drafts.flatMap(d => [d.collectedBy, d.handedBy, d.handedTo]).filter(Boolean),
  )

  // ONE READ, AND ONLY WHEN IT IS NEEDED. The list is fetched the first time a
  // custody mode is actually chosen — an HDFC payment never asks the users table
  // anything — and never again for the life of the form.
  const loaded = useRef(false)
  useEffect(() => {
    if (!applies || loaded.current) return
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
          .from('users').select('id, full_name').in('id', missing)
        if (!active) return
        for (const u of (extra ?? []) as UserOption[]) list.push({ ...u, inactive: true })
      }
      setUsers(list)
    })()
    return () => { active = false }
  }, [supabase, applies])

  if (!applies) return null

  const patch = (key: string, next: Partial<CustodyDraft>) =>
    onDraftsChange(drafts.map(d => (d.key === key ? { ...d, ...next } : d)))

  const remove = (key: string) => onDraftsChange(drafts.filter(d => d.key !== key))

  const add = (activityType: CustodyActivityType) => {
    const draft = emptyCustodyDraft(newCustodyDraftKey(), activityType)
    // The submitter collected it, until they say otherwise. Never applied to a
    // handover: who handed it over and who received it are both real choices.
    if (activityType === 'collected' && defaultActorId) draft.collectedBy = defaultActorId
    onDraftsChange([...drafts, draft])
  }

  const savedLines = names && formatDateTime
    ? custodyTrail(saved).map(e => custodyEventLine(e, names, formatDateTime))
    : []

  return (
    <div style={{
      padding: '11px 12px', borderRadius: '8px',
      border: `1px solid ${colors.border}`, background: colors.raised,
      display: 'flex', flexDirection: 'column', gap: '10px',
    }}>
      <div>
        <div style={SECTION_LABEL}>{CUSTODY_TRAIL_TITLE}</div>
        <p style={{ margin: '4px 0 0', fontSize: '11.5px', color: colors.muted, lineHeight: 1.5 }}>
          {CUSTODY_TRAIL_NOTE}
        </p>
      </div>

      {/* ALREADY SAVED — read-only, and above the drafts, because they happened
          first and because the control has to make clear which rows can still
          be taken back. */}
      {savedLines.length > 0 && (
        <ul style={{
          listStyle: 'none', margin: 0, padding: 0,
          border: `1px solid ${colors.border}`, borderRadius: '8px',
          overflow: 'hidden', background: colors.base,
        }}>
          {savedLines.map(line => <SavedActivity key={line.id} line={line} />)}
        </ul>
      )}

      {/* THE DRAFTS. Each is a whole activity, removable until it is sent. */}
      {drafts.map((draft, index) => {
        const error = custodyDraftError(draft)
        const collected = draft.activityType === 'collected'
        return (
          <div
            key={draft.key}
            style={{
              border: `1px solid ${colors.border}`, borderRadius: '8px',
              padding: '10px 11px', background: colors.base,
              display: 'flex', flexDirection: 'column', gap: '8px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ ...FIELD_LABEL, flex: 1 }}>Activity {index + 1}</span>
              <button
                type="button"
                onClick={() => remove(draft.key)}
                disabled={disabled}
                className="boe-btn boe-btn-ghost"
                aria-label={`Remove activity ${index + 1}`}
                style={{ padding: '2px 8px', fontSize: '11px', display: 'flex', alignItems: 'center', gap: '4px' }}
              >
                <X size={12} aria-hidden="true" /> Remove
              </button>
            </div>

            {/* WRAPPING, NOT A FIXED TWO-UP. On a phone each control takes the
                full width; on a dialog they sit side by side. One rule, no
                breakpoint to keep in step with the modal's own width. */}
            <div style={{
              display: 'grid', gap: '8px',
              gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
            }}>
              <LabelledField label="Activity type" htmlFor={`${uid}-${draft.key}-type`}>
                <select
                  id={`${uid}-${draft.key}-type`}
                  className="boe-input"
                  value={draft.activityType}
                  disabled={disabled}
                  onChange={e => {
                    const next = e.target.value as CustodyActivityType
                    // Switching CLEARS the people the other shape named: a
                    // collector is not an answer to "who handed it over", and
                    // carrying one across would submit a person nobody chose.
                    patch(draft.key, {
                      activityType: next,
                      collectedBy: next === 'collected' ? draft.collectedBy : '',
                      handedBy: next === 'handed_over' ? draft.handedBy : '',
                      handedTo: next === 'handed_over' ? draft.handedTo : '',
                    })
                  }}
                  style={{ width: '100%' }}
                >
                  {CUSTODY_ACTIVITY_OPTIONS.map(o => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </LabelledField>

              <LabelledField label="Date and time" htmlFor={`${uid}-${draft.key}-when`}>
                <input
                  id={`${uid}-${draft.key}-when`}
                  className="boe-input"
                  type="datetime-local"
                  value={draft.occurredAt}
                  disabled={disabled}
                  max={isoToLocalInput(new Date().toISOString())}
                  onChange={e => patch(draft.key, { occurredAt: e.target.value })}
                  style={{ width: '100%' }}
                />
              </LabelledField>
            </div>

            {collected ? (
              <LabelledField label="Collected by" htmlFor={`${uid}-${draft.key}-collected-by`}>
                <UserSelect
                  id={`${uid}-${draft.key}-collected-by`}
                  value={draft.collectedBy}
                  onChange={v => patch(draft.key, { collectedBy: v })}
                  users={users}
                  disabled={disabled}
                />
              </LabelledField>
            ) : (
              <div style={{
                display: 'grid', gap: '8px',
                gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
              }}>
                <LabelledField label="Handed by" htmlFor={`${uid}-${draft.key}-handed-by`}>
                  <UserSelect
                    id={`${uid}-${draft.key}-handed-by`}
                    value={draft.handedBy}
                    onChange={v => patch(draft.key, { handedBy: v })}
                    users={users}
                    disabled={disabled}
                  />
                </LabelledField>
                <LabelledField label="Handed to" htmlFor={`${uid}-${draft.key}-handed-to`}>
                  <UserSelect
                    id={`${uid}-${draft.key}-handed-to`}
                    value={draft.handedTo}
                    onChange={v => patch(draft.key, { handedTo: v })}
                    users={users}
                    disabled={disabled}
                  />
                </LabelledField>
              </div>
            )}

            <LabelledField label="Remark (optional)" htmlFor={`${uid}-${draft.key}-remark`}>
              <input
                id={`${uid}-${draft.key}-remark`}
                className="boe-input"
                value={draft.remark}
                disabled={disabled}
                onChange={e => patch(draft.key, { remark: e.target.value })}
                placeholder="Where and how the money changed hands"
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
      })}

      {/* ADD, ONE BUTTON PER SHAPE. Two buttons rather than "Add" plus a type
          picker: the shapes need different people, and naming them on the button
          is one decision instead of two. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
        <button
          type="button"
          onClick={() => add('collected')}
          disabled={disabled}
          className="boe-btn boe-btn-ghost"
          style={{ padding: '6px 10px', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '5px' }}
        >
          <Plus size={13} aria-hidden="true" /> Add Collected
        </button>
        <button
          type="button"
          onClick={() => add('handed_over')}
          disabled={disabled}
          className="boe-btn boe-btn-ghost"
          style={{ padding: '6px 10px', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '5px' }}
        >
          <ArrowRight size={13} aria-hidden="true" /> Add Handed Over
        </button>
      </div>
    </div>
  )
}
