'use client'

// ── Order Request activity timeline ───────────────────────────────────────────
// The complete recorded history of one Order Request, newest first.
//
// Every entry is read from public.order_request_activity — the trail written by
// the log_order_request_activity() trigger and by the SECURITY DEFINER RPCs, in
// the same transaction as the business mutation they describe. Nothing here is
// derived by diffing the current row against anything: an event is shown if and
// only if the database recorded it, and a before/after pair is shown only where
// the RECORD carries both sides.
//
// Two generations of request_edited event therefore coexist, and both must
// render honestly:
//   * 20260713 and later carry details.changes — the old and new value of each
//     field, captured before the update. Rendered as one "X changed from A to B"
//     line per field.
//   * 20260708/20260709 rows carry only details.changed_fields. Those values
//     were never stored and are NOT reconstructed from today's row — the entry
//     keeps saying which fields were touched, which is all that was recorded.
// Historical rows are never rewritten, so this fallback is permanent.
//
// Reads with the viewer's own RLS: order_request_activity_requester_select /
// _assignee_select (20260707) / _admin_select. A viewer who can open the request
// can read its history, and nobody else can.

import { useEffect, useState } from 'react'
import type { createClient } from '@/lib/supabase/client'
import { colors } from '@/lib/tokens'
import { SectionHeader } from './RequestPanels'
import { fmtAmount, fmtDate, fmtDateTime, LEAD_SOURCE_OPTIONS, STATUS_META } from './shared'

type ActivityRow = {
  id: string
  event_type: string
  actor_id: string | null
  from_status: string | null
  to_status: string | null
  details: Record<string, unknown>
  created_at: string
  actor: { full_name: string } | { full_name: string }[] | null
}

// Human labels for the field names edit_order_request records in
// details.changed_fields. An unrecognised name falls through as-is rather than
// being dropped, so a future column still shows up in the history.
const FIELD_LABEL: Record<string, string> = {
  client_name:         'Client',
  assigned_to:         'Assignee',
  confirm_date:        'Confirmation Date',
  due_date:            'Due Date',
  total_value:         'Total Order Value',
  total_product_value: 'Total Product Value',
  lead_source:         'Lead Source',
  notes:               'Notes',
}

// Newer events also carry the label the database recorded. This build's own map
// wins so the rail names a field the same way the form above it does; the stored
// label is the fallback that keeps a field this build has never heard of
// readable, and the raw column name is the last resort — never dropped.
export function fieldLabel(field: string, stored?: string): string {
  return FIELD_LABEL[field] ?? stored ?? field
}

const EVENT_TITLE: Record<string, string> = {
  request_submitted:             'Request submitted',
  attachments_uploaded:          'Attachments uploaded',
  main_pi_replaced:              'Main PI replaced',
  reference_attachments_changed: 'Reference attachments changed',
  // request_edited is titled by eventTitle() instead, which puts the actor in
  // front ("Nishant edited the request"). Kept here as the neutral fallback.
  request_edited:            'Request edited',
  clarification_requested:   'Clarification requested',
  clarification_resubmitted: 'Updated and resubmitted',
  request_rejected:          'Request rejected',
  reapplication_submitted:   'Updated and reapplied',
  payment_linked:            'Payment linked',
  payment_unlinked:          'Payment unlinked',
  request_converted:         'Converted to Confirmed Order',
  status_changed:            'Status changed',
}

// Marker colour derived from the event — informative, not decorative. Status
// colours are used only where the event genuinely carries status or warning
// meaning; everything else stays neutral.
function markerColor(row: ActivityRow): string {
  switch (row.event_type) {
    case 'request_converted':       return colors.green
    case 'payment_linked':          return colors.green
    case 'payment_unlinked':        return colors.amber
    case 'request_rejected':        return colors.red
    case 'clarification_requested': return colors.blue
    case 'clarification_resubmitted':
    case 'reapplication_submitted': return colors.blue
    case 'main_pi_replaced':
    case 'reference_attachments_changed': return colors.amber
    default:                        return colors.muted
  }
}

function statusLabel(status: string | null | undefined): string {
  if (!status) return '—'
  return STATUS_META[status]?.label ?? status
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null
}

// ── Recorded field changes (details.changes, 20260713) ────────────────────────
// One entry per field the edit actually moved. old_value / new_value are the
// values the database captured at the time; value_type is the rendering contract
// recorded WITH them, so a reader never infers a type from a field name.
export type RecordedChange = {
  field:      string
  label?:     string
  value_type?: string
  old_value:  unknown
  new_value:  unknown
}

// Narrows the recorded payload. An element without a usable `field` is dropped
// rather than rendered as a nameless row; everything else is kept, because a
// field this build has never heard of still belongs in the history.
export function parseRecordedChanges(details: Record<string, unknown> | null | undefined): RecordedChange[] {
  const raw = details?.changes
  if (!Array.isArray(raw)) return []
  const out: RecordedChange[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const c = item as Record<string, unknown>
    const field = typeof c.field === 'string' ? c.field.trim() : ''
    if (!field) continue
    out.push({
      field,
      label:      typeof c.label === 'string' ? c.label : undefined,
      value_type: typeof c.value_type === 'string' ? c.value_type : undefined,
      old_value:  c.old_value ?? null,
      new_value:  c.new_value ?? null,
    })
  }
  return out
}

// Stored lead_source value → the label every other surface shows for it. The
// SAME LEAD_SOURCE_OPTIONS list the record field and the edit dropdown use, so
// one stored value can never read as "Repeat Customer" on the record and
// "repeat_customer" in its own audit entry.
const LEAD_SOURCE_LABEL: Record<string, string> = Object.fromEntries(
  LEAD_SOURCE_OPTIONS.map(o => [o.value, o.label])
)

// The type a value is RENDERED as. Normally the type the database recorded with
// it — that is the whole point of storing value_type — but a field whose stored
// form is a machine value is resolved by NAME as well, so:
//   * a row written before lead_source had its own value_type (or by any writer
//     that recorded it as plain 'text') still renders the label, and
//   * a value_type this build has never heard of still falls through to the
//     text path rather than being dropped.
// Pure, and exported so the rule is assertable without a database.
export function effectiveValueType(field: string, valueType: string | undefined): string | undefined {
  if (field === 'lead_source' && (valueType === undefined || valueType === 'text')) return 'lead_source'
  return valueType
}

// Long free text is shortened for the narrow rail. The RECORD keeps the full
// value — only the display is clipped — so shortening here loses nothing.
const NOTES_DISPLAY_LIMIT = 60

function truncate(s: string, limit = NOTES_DISPLAY_LIMIT): string {
  return s.length <= limit ? s : `${s.slice(0, limit).trimEnd()}…`
}

// One recorded value, formatted for a person. `names` resolves user ids to
// display names (same lookup the assignee line already uses), so a uuid never
// reaches the reader.
//
// An unset value reads as "Not set" — one consistent phrase — except for a user
// field, where "Unassigned" is what the absence actually means.
export function formatRecordedValue(
  value: unknown,
  valueType: string | undefined,
  names: Record<string, string>,
): string {
  if (valueType === 'user') {
    const id = asString(value)
    if (!id) return 'Unassigned'
    return names[id] ?? 'Unknown user'
  }

  if (value == null || value === '') return 'Not set'

  switch (valueType) {
    case 'currency': {
      const amount = fmtAmount(value as number | string)
      // fmtAmount reports an unusable number as '—', which would read as though
      // the field were empty. Shown as recorded instead.
      return amount === '—' ? String(value) : amount
    }
    case 'date': {
      const iso = asString(value)
      // Only a real ISO date is reformatted; anything else is shown as recorded
      // rather than run through Date() to become "Invalid Date".
      return iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? fmtDate(iso) : String(value)
    }
    case 'lead_source': {
      const stored = String(value).trim()
      if (stored === '') return 'Not set'
      // An unrecognised stored value is shown as recorded rather than dropped —
      // a lead source retired from the list still has to render its own history.
      return LEAD_SOURCE_LABEL[stored] ?? stored
    }
    case 'notes': {
      const text = String(value).trim()
      return text === '' ? 'Not set' : `“${truncate(text)}”`
    }
    default: {
      const text = String(value).trim()
      return text === '' ? 'Not set' : text
    }
  }
}

// The lines shown under a request_edited entry — one per changed field, in the
// order the database recorded them. Returns [] when the event carries no
// recorded changes, which is the signal to fall back to the legacy rendering.
export function recordedChangeLines(
  details: Record<string, unknown> | null | undefined,
  names: Record<string, string>,
  labelFor: (field: string, stored?: string) => string,
): string[] {
  return parseRecordedChanges(details).map(c => {
    const label = labelFor(c.field, c.label)
    const type  = effectiveValueType(c.field, c.value_type)
    const from  = formatRecordedValue(c.old_value, type, names)
    const to    = formatRecordedValue(c.new_value, type, names)
    // Two genuinely different values can render identically (long notes clipped
    // to the same prefix, or two unresolved user ids). Claiming "changed from X
    // to X" would look like a bug in the record, so the change is stated without
    // a before/after pair it cannot show truthfully.
    return from === to ? `${label} updated` : `${label} changed from ${from} to ${to}`
  })
}

// A recorded list of file names, defensively narrowed — an entry that is not a
// non-empty string is dropped rather than rendered as "undefined".
export function fileNameList(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.filter((n): n is string => typeof n === 'string' && n.trim() !== '')
}

// Two rows written inside ONE transaction share an identical created_at
// (now() is transaction time), so a pure timestamp sort leaves their relative
// order undefined. finalize_order_request writes request_submitted and then
// attachments_uploaded in exactly that situation, so a tiny deterministic rank
// keeps the pair reading in the order it actually happened. It only ever breaks
// exact ties — it can never reorder events that have distinct timestamps.
const SAME_TXN_RANK: Record<string, number> = {
  request_submitted:    0,
  attachments_uploaded: 1,
}

function actorName(actor: ActivityRow['actor']): string {
  const a = Array.isArray(actor) ? actor[0] : actor
  // A null actor means no logged-in user was attributed (a system/service
  // action). Shown honestly as "System" rather than as an unknown employee.
  return a?.full_name ?? 'System'
}

// Events whose title names the actor. An edit is the entry that settles
// accountability for a value change, so it leads with the person who made it;
// every other event keeps the neutral "what happened" title with "who · when"
// beneath. ONE map drives both the title and the meta line, so the two can never
// drift into printing the name twice — or dropping it entirely.
const ACTOR_TITLE: Record<string, (actor: string) => string> = {
  request_edited: actor => `${actor} edited the request`,
}

export function titleNamesActor(eventType: string): boolean {
  return eventType in ACTOR_TITLE
}

export function eventTitle(eventType: string, actor: string): string {
  return ACTOR_TITLE[eventType]?.(actor) ?? EVENT_TITLE[eventType] ?? eventType
}

export function RequestActivityTimeline({
  supabase,
  orderRequestId,
  refreshKey = 0,
}: {
  supabase: ReturnType<typeof createClient>
  orderRequestId: string
  // Bumped by the page after any action that writes history, so the timeline
  // re-reads real recorded state rather than being patched optimistically.
  refreshKey?: number
}) {
  const [rows,    setRows]    = useState<ActivityRow[]>([])
  const [names,   setNames]   = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState(false)

  useEffect(() => {
    let active = true
    ;(async () => {
      setLoading(true)
      setError(false)
      const { data, error: e } = await supabase
        .from('order_request_activity')
        .select('id, event_type, actor_id, from_status, to_status, details, created_at, actor:users!actor_id(full_name)')
        .eq('order_request_id', orderRequestId)
        .order('created_at', { ascending: false })
      if (!active) return
      if (e) {
        setRows([])
        setError(true)
        setLoading(false)
        return
      }
      const loaded = ((data ?? []) as unknown as ActivityRow[]).map(r => ({
        ...r,
        details: (r.details ?? {}) as Record<string, unknown>,
      }))
      // Stable tie-break for same-transaction rows (see SAME_TXN_RANK).
      loaded.sort((a, b) => {
        if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1
        return (SAME_TXN_RANK[b.event_type] ?? 0) - (SAME_TXN_RANK[a.event_type] ?? 0)
      })
      setRows(loaded)
      setLoading(false)

      // Assignee changes are recorded as user ids. Resolve them to names in one
      // query so a reassignment reads as "Priya → Rahul" rather than as two
      // UUIDs. Best-effort: if the lookup fails, the entry still renders, just
      // without the before/after names.
      const ids = new Set<string>()
      for (const r of loaded) {
        const prev = asString(r.details?.previous_assigned_to)
        const next = asString(r.details?.new_assigned_to)
        if (prev) ids.add(prev)
        if (next) ids.add(next)
        // Recorded changes store a user field as the id that was written, so any
        // 'user'-typed value needs the same resolution.
        for (const c of parseRecordedChanges(r.details)) {
          if (c.value_type !== 'user') continue
          const from = asString(c.old_value)
          const to   = asString(c.new_value)
          if (from) ids.add(from)
          if (to)   ids.add(to)
        }
      }
      if (ids.size > 0) {
        const { data: users } = await supabase
          .from('users')
          .select('id, full_name')
          .in('id', Array.from(ids))
        if (!active) return
        const map: Record<string, string> = {}
        for (const u of (users ?? []) as { id: string; full_name: string }[]) {
          map[u.id] = u.full_name
        }
        setNames(map)
      }
    })()
    return () => { active = false }
  }, [supabase, orderRequestId, refreshKey])

  // The one-line description under each event title. Returns null when the
  // recorded payload adds nothing beyond the title — no invented detail.
  const description = (row: ActivityRow): string | null => {
    const d = row.details ?? {}
    switch (row.event_type) {
      case 'request_edited': {
        // Preferred: the recorded before/after values (20260713). One field per
        // line so several changes stay readable in the narrow rail — the
        // container is pre-wrap, so this needs no table and no horizontal scroll.
        const lines = recordedChangeLines(d, names, fieldLabel)
        if (lines.length > 0) return lines.join('\n')

        // Legacy rows (20260708/20260709) recorded only the field NAMES. The old
        // and new values do not exist anywhere, so they are not invented here.
        const fields = Array.isArray(d.changed_fields) ? (d.changed_fields as unknown[]) : []
        const labels = fields
          .filter((f): f is string => typeof f === 'string')
          .map(f => fieldLabel(f))
        // Assignee moves are the one legacy edit whose before/after IS stored.
        const prev = asString(d.previous_assigned_to)
        const next = asString(d.new_assigned_to)
        const assigneeLine = (prev || next)
          ? `Assignee changed from ${prev ? (names[prev] ?? 'Unknown user') : 'Unassigned'} to ${next ? (names[next] ?? 'Unknown user') : 'Unassigned'}`
          : null
        const fieldLine = labels.length > 0 ? `Updated: ${labels.join(', ')}` : null
        return [fieldLine, assigneeLine].filter(Boolean).join('\n') || null
      }
      case 'clarification_requested':
        return asString(d.clarification_note)
      case 'request_rejected':
        return asString(d.rejection_reason)
      case 'payment_linked': {
        const amount = d.amount != null ? fmtAmount(d.amount as number | string) : null
        const number = asString(d.request_number)
        const client = asString(d.client_name)
        return [amount, number, client].filter(Boolean).join(' · ') || null
      }
      case 'payment_unlinked': {
        const amount = d.amount != null ? fmtAmount(d.amount as number | string) : null
        const number = asString(d.request_number)
        const reason = asString(d.reason)
        const head = [amount, number].filter(Boolean).join(' · ')
        return [head || null, reason ? `Reason: ${reason}` : null].filter(Boolean).join(' — ') || null
      }
      case 'request_converted': {
        const order = asString(d.order_display_number)
        const count = typeof d.linked_payment_count === 'number' ? d.linked_payment_count : null
        const orderLine = order ? `Order ${order}` : null
        const payLine = count && count > 0
          ? `${count} payment${count !== 1 ? 's' : ''} transferred`
          : null
        return [orderLine, payLine].filter(Boolean).join(' · ') || null
      }
      case 'attachments_uploaded': {
        const refs = typeof d.reference_count === 'number' ? d.reference_count : 0
        const mainPi = d.main_pi === true ? 'Main PI' : null
        const refLine = refs > 0 ? `${refs} reference file${refs !== 1 ? 's' : ''}` : null
        return [mainPi, refLine].filter(Boolean).join(' · ') || null
      }
      // Attachment edits on a submitted request (20260712). Details carry FILE
      // NAMES only — never a storage path and never a signed URL.
      case 'main_pi_replaced': {
        const from = asString(d.from_file_name)
        const to   = asString(d.to_file_name)
        if (from && to) return `${from} → ${to}`
        return to ? `Now ${to}` : null
      }
      case 'reference_attachments_changed': {
        const added   = fileNameList(d.added)
        const removed = fileNameList(d.removed)
        return [
          added.length   > 0 ? `Added: ${added.join(', ')}`     : null,
          removed.length > 0 ? `Removed: ${removed.join(', ')}` : null,
        ].filter(Boolean).join(' · ') || null
      }
      case 'status_changed':
        return `${statusLabel(row.from_status)} → ${statusLabel(row.to_status)}`
      default:
        return null
    }
  }

  // Before/after status, shown for every event that actually moved the request.
  // status_changed already says it in its description, so it is not repeated.
  const statusLine = (row: ActivityRow): string | null => {
    if (row.event_type === 'status_changed') return null
    if (!row.from_status || !row.to_status) return null
    if (row.from_status === row.to_status) return null
    return `${statusLabel(row.from_status)} → ${statusLabel(row.to_status)}`
  }

  return (
    <div style={{ border: `1px solid ${colors.border}`, borderRadius: '10px', overflow: 'hidden', background: colors.base }}>
      <div style={{ padding: '10px 14px', borderBottom: `1px solid ${colors.border}` }}>
        <SectionHeader>Complete Activity</SectionHeader>
      </div>
      <div style={{ padding: '14px' }}>
        {loading ? (
          <div style={{ fontSize: '12px', color: colors.muted }}>Loading activity…</div>
        ) : error ? (
          <div style={{ fontSize: '12px', color: colors.red }}>
            The activity history could not be loaded. Refresh the page to try again.
          </div>
        ) : rows.length === 0 ? (
          <div style={{ fontSize: '12px', color: colors.muted }}>No activity recorded yet.</div>
        ) : (
          <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column' }}>
            {rows.map((row, idx) => {
              const isLast = idx === rows.length - 1
              const desc   = description(row)
              const status = statusLine(row)
              return (
                <li key={row.id} style={{ display: 'flex', gap: '12px' }}>
                  {/* Marker + connector */}
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0 }} aria-hidden="true">
                    <span style={{ width: '9px', height: '9px', borderRadius: '50%', background: markerColor(row), marginTop: '4px' }} />
                    {!isLast && <span style={{ width: '1px', flex: 1, background: colors.border, marginTop: '3px' }} />}
                  </div>
                  {/* Content */}
                  <div style={{ minWidth: 0, paddingBottom: isLast ? 0 : '16px' }}>
                    <div style={{ fontSize: '13px', fontWeight: 600, color: colors.primary, lineHeight: 1.4 }}>
                      {eventTitle(row.event_type, actorName(row.actor))}
                    </div>
                    <div style={{ fontSize: '12px', color: colors.muted, marginTop: '2px' }}>
                      {titleNamesActor(row.event_type)
                        ? fmtDateTime(row.created_at)
                        : `${actorName(row.actor)} · ${fmtDateTime(row.created_at)}`}
                    </div>
                    {status && (
                      <div style={{ fontSize: '12px', color: colors.secondary, marginTop: '3px' }}>
                        {status}
                      </div>
                    )}
                    {desc && (
                      <div style={{
                        fontSize: '12.5px', color: colors.secondary, marginTop: '4px',
                        lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                      }}>
                        {desc}
                      </div>
                    )}
                  </div>
                </li>
              )
            })}
          </ol>
        )}
      </div>
    </div>
  )
}
