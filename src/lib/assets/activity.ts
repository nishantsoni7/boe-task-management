// Asset activity timeline — presentation rules.
//
// The database half is supabase/migrations/20260727000000_asset_activity_log.sql,
// which is the only writer: every row is produced by a SECURITY DEFINER
// function or trigger, and no client role holds INSERT, UPDATE or DELETE on the
// table. Nothing here writes anything — this module exists so the detail page
// can render a row without knowing SQL, and so the ordering and formatting
// rules can be tested without a database.
//
// Each row carries a `summary` written at event time, so an event_type this
// file has never heard of still renders as a readable sentence rather than a
// blank line. The maps below add a short title and a tone on top of that.

import { formatINR } from '@/lib/currency'

export const ASSET_ACTIVITY_EVENTS = [
  'asset_created',
  'asset_edited',
  'asset_assigned',
  'assignment_accepted',
  'asset_returned',
  'asset_marked_lost',
  'edit_requested',
  'removal_requested',
  'edit_request_approved',
  'edit_request_rejected',
  'removal_request_approved',
  'removal_request_rejected',
  // Added by the lifecycle phase (20260728000000 – 20260730000000).
  'warranty_updated',
  'asset_transferred',
  'asset_recovered',
  'asset_sent_for_repair',
  'asset_returned_from_repair',
  'service_record_added',
  'service_record_corrected',
  'invoice_uploaded',
  'warranty_document_uploaded',
  'document_uploaded',
  'document_removed',
  'asset_retired',
  'asset_disposed',
  'asset_restored',
] as const

export type AssetActivityEvent = typeof ASSET_ACTIVITY_EVENTS[number]

export type AssetActivityEntry = {
  id: string
  asset_id: string | null
  asset_code_snapshot: string
  asset_name_snapshot: string
  event_type: string
  actor_id: string | null
  employee_id: string | null
  event_at: string
  summary: string
  details: Record<string, unknown> | null
  source_type: string | null
  source_id: string | null
  created_at: string
}

const EVENT_TITLE: Record<string, string> = {
  asset_created:            'Asset created',
  asset_edited:             'Details updated',
  asset_assigned:           'Assigned',
  assignment_accepted:      'Assignment accepted',
  asset_returned:           'Returned',
  asset_marked_lost:        'Marked lost',
  edit_requested:           'Edit requested',
  removal_requested:        'Removal requested',
  edit_request_approved:    'Edit request approved',
  edit_request_rejected:    'Edit request rejected',
  removal_request_approved: 'Removal request approved',
  removal_request_rejected: 'Removal request rejected',
  warranty_updated:           'Warranty details updated',
  asset_transferred:          'Transferred',
  asset_recovered:            'Recovered',
  asset_sent_for_repair:      'Sent for service',
  asset_returned_from_repair: 'Returned from service',
  service_record_added:       'Service record added',
  service_record_corrected:   'Service record corrected',
  invoice_uploaded:           'Invoice uploaded',
  warranty_document_uploaded: 'Warranty card uploaded',
  document_uploaded:          'Document uploaded',
  document_removed:           'Document removed',
  asset_retired:              'Retired',
  asset_disposed:             'Disposed',
  asset_restored:             'Restored to service',
}

/** Tone drives the timeline dot colour only — never meaning. */
export type AssetActivityTone = 'neutral' | 'positive' | 'warning' | 'critical'

const EVENT_TONE: Record<string, AssetActivityTone> = {
  asset_created:            'neutral',
  asset_edited:             'neutral',
  asset_assigned:           'positive',
  assignment_accepted:      'positive',
  asset_returned:           'warning',
  asset_marked_lost:        'critical',
  edit_requested:           'neutral',
  removal_requested:        'warning',
  edit_request_approved:    'positive',
  edit_request_rejected:    'critical',
  removal_request_approved: 'critical',
  removal_request_rejected: 'warning',
  warranty_updated:           'neutral',
  asset_transferred:          'positive',
  asset_recovered:            'positive',
  asset_sent_for_repair:      'warning',
  asset_returned_from_repair: 'positive',
  service_record_added:       'neutral',
  // A correction to a historical record is exactly what an auditor looks for,
  // so it is never neutral.
  service_record_corrected:   'warning',
  invoice_uploaded:           'neutral',
  warranty_document_uploaded: 'neutral',
  document_uploaded:          'neutral',
  document_removed:           'warning',
  asset_retired:              'warning',
  asset_disposed:             'critical',
  asset_restored:             'positive',
}

/**
 * Short title for an event. An unknown event_type falls back to its own key
 * with underscores removed rather than to a generic word, so a later phase's
 * repair/warranty events read sensibly before this map is extended.
 */
export function assetActivityTitle(eventType: string): string {
  const known = EVENT_TITLE[eventType]
  if (known) return known
  const spaced = eventType.replace(/_/g, ' ')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

export function assetActivityTone(eventType: string): AssetActivityTone {
  return EVENT_TONE[eventType] ?? 'neutral'
}

/**
 * Newest first.
 *
 * event_at is transaction time, so two rows written by one action (an approved
 * edit request writes the approval AND the resulting asset_edited) share it
 * exactly. created_at is clock_timestamp() in the database and does advance
 * within a transaction, so it is the tie-breaker that keeps such a pair in the
 * order it happened. Sorting is non-mutating — the caller's array is untouched.
 */
export function sortAssetActivity<T extends { event_at: string; created_at: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    if (a.event_at !== b.event_at) return a.event_at < b.event_at ? 1 : -1
    if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1
    return 0
  })
}

// ─── Detail lines ────────────────────────────────────────────────────────────

export type AssetActivityDetailLine = { label: string; value: string }

const HUMANIZED_FIELDS = new Set(['asset_type', 'status', 'previous_status', 'new_status', 'acceptance'])

function readable(value: unknown, field?: string): string {
  if (value === null || value === undefined) return '—'
  const text = String(value).trim()
  if (text === '') return '—'
  return field && HUMANIZED_FIELDS.has(field) ? text.replace(/_/g, ' ') : text
}

/** First of these that is a non-empty string, or null. */
function firstText(...values: unknown[]): string | null {
  for (const v of values) {
    if (typeof v === 'string' && v.trim() !== '') return v.trim()
  }
  return null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

/**
 * The lines shown under an event's title. Deliberately conservative: only
 * facts the database recorded, never anything inferred, and nothing at all
 * when there is nothing worth adding (the summary already says what happened).
 */
export function assetActivityDetailLines(entry: AssetActivityEntry): AssetActivityDetailLine[] {
  const d = entry.details
  if (!d) return []
  const lines: AssetActivityDetailLine[] = []

  // Recorded before/after pairs. Three event types carry details.changes in the
  // same shape (master edits, warranty edits, service-record corrections), so
  // they render identically rather than through three near-copies.
  if (entry.event_type === 'asset_edited'
      || entry.event_type === 'warranty_updated'
      || entry.event_type === 'service_record_corrected') {
    const changes = Array.isArray(d.changes) ? d.changes : []
    for (const raw of changes) {
      const change = asRecord(raw)
      if (!change) continue
      const field = typeof change.field === 'string' ? change.field : undefined
      const label = typeof change.label === 'string' ? change.label : (field ?? 'Field')
      lines.push({ label, value: `${readable(change.old, field)} → ${readable(change.new, field)}` })
    }
    return lines
  }

  if (entry.event_type === 'asset_created') {
    if (d.asset_type) lines.push({ label: 'Type',       value: readable(d.asset_type, 'asset_type') })
    if (d.serial_no)  lines.push({ label: 'Serial No.', value: readable(d.serial_no) })
    if (d.location)   lines.push({ label: 'Location',   value: readable(d.location) })
    return lines
  }

  // Documents: the file NAME, never a storage path and never a signed URL.
  if (typeof d.file_name === 'string' && d.file_name.trim() !== '') {
    lines.push({ label: 'File', value: d.file_name.trim() })
  }

  // Service events. Cost is rendered as currency because it is money; an
  // unreadable value is shown as recorded rather than as ₹NaN.
  if (entry.event_type === 'service_record_added'
      || entry.event_type === 'asset_sent_for_repair'
      || entry.event_type === 'asset_returned_from_repair') {
    if (d.service_type) lines.push({ label: 'Service', value: readable(d.service_type, 'asset_type') })
    if (d.vendor)       lines.push({ label: 'Vendor',  value: readable(d.vendor) })
    if (d.issue)        lines.push({ label: 'Issue',   value: readable(d.issue) })
    const cost = typeof d.cost === 'number' ? d.cost : Number(d.cost)
    if (d.cost !== null && d.cost !== undefined && Number.isFinite(cost)) {
      lines.push({ label: 'Cost', value: formatINR(cost) })
    }
    if (d.next_service_date) lines.push({ label: 'Next service', value: readable(d.next_service_date) })
  }

  // Movement events: where it came from and where it went, as a sentence
  // rather than an arrow between two blanks.
  const from = firstText(d.from_employee_name, d.from_location)
  const to   = firstText(d.to_employee_name, d.to_location)
  if ((from || to) && entry.event_type !== 'asset_assigned') {
    lines.push({ label: 'Movement', value: `${from ?? 'Company'} → ${to ?? 'Company'}` })
  }
  if (d.effective_date) lines.push({ label: 'Handover date', value: readable(d.effective_date) })
  if (d.condition)      lines.push({ label: 'Condition',     value: readable(d.condition, 'status') })

  // Custody events: the status movement, when the database recorded one.
  if (d.previous_status && d.new_status) {
    lines.push({
      label: 'Status',
      value: `${readable(d.previous_status, 'status')} → ${readable(d.new_status, 'status')}`,
    })
  }

  if (typeof d.reason === 'string' && d.reason.trim() !== '') {
    lines.push({ label: 'Reason', value: d.reason.trim() })
  }
  if (typeof d.review_note === 'string' && d.review_note.trim() !== '') {
    lines.push({ label: 'Review note', value: d.review_note.trim() })
  }

  return lines
}

/**
 * Display name for the person who performed the event, and for the employee it
 * concerns.
 *
 * `lookup` is the live users map; the name snapshotted in `details` at event
 * time is the fallback, so an event still names its actor after that user
 * record is removed (actor_id is ON DELETE SET NULL). Live name first, because
 * a corrected spelling should show everywhere.
 */
export function assetActivityActorName(
  entry: AssetActivityEntry,
  lookup: Record<string, string | undefined>,
): string | null {
  return resolveName(entry.actor_id, entry.details?.actor_name, lookup)
}

export function assetActivityEmployeeName(
  entry: AssetActivityEntry,
  lookup: Record<string, string | undefined>,
): string | null {
  return resolveName(entry.employee_id, entry.details?.employee_name ?? entry.details?.requester_name, lookup)
}

function resolveName(
  id: string | null,
  snapshot: unknown,
  lookup: Record<string, string | undefined>,
): string | null {
  const live = id ? lookup[id] : undefined
  if (live) return live
  if (typeof snapshot === 'string' && snapshot.trim() !== '') return snapshot.trim()
  return null
}
