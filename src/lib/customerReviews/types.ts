// Customer Review Outreach — domain types, label maps and query column lists.
//
// The column constants live here, not inline in each page, for the reason
// src/lib/meetings/types.ts gives: the list screen, the form and the detail
// screen all read the same rows, and a column added to one query and not
// another is how a filter silently starts matching nothing.
//
// Mirrors supabase/migrations/20261017000000_customer_review_outreach.sql.

// ─── Status ───────────────────────────────────────────────────────────────────

/**
 * Seven states, and no eighth.
 *
 * They are seven and not fewer because each answers a DIFFERENT question, and
 * collapsing any pair would make the record claim something nobody checked:
 *
 *   draft               being prepared. Incomplete is fine here.
 *   ready_to_send       every sending prerequisite is met. Nothing has left BOE.
 *   sent                the employee CONFIRMED they sent the invitation. This is
 *                       a person's deliberate claim, never inferred from the
 *                       wa.me link having been opened.
 *   customer_responded  the customer replied. Says nothing about a review.
 *   verified            somebody holding `verify` checked the evidence.
 *   closed              verified and finished with.
 *   cancelled           abandoned before it was verified.
 */
export const CUSTOMER_REVIEW_STATUSES = [
  'draft',
  'ready_to_send',
  'sent',
  'customer_responded',
  'verified',
  'closed',
  'cancelled',
] as const

export type CustomerReviewStatus = (typeof CUSTOMER_REVIEW_STATUSES)[number]

// ─── Interaction type ─────────────────────────────────────────────────────────

/**
 * The eight real BOE interactions, fixed and small.
 *
 * Stored as snake_case keys and displayed through INTERACTION_TYPE_META, the
 * same convention meeting_type and order_position use. Free text here would
 * become an unusable dimension within a month.
 */
export const INTERACTION_TYPES = [
  'factory_visit',
  'online_enquiry',
  'online_order',
  'restaurant_project',
  'cafe_project',
  'hotel_project',
  'other_bulk_project',
  'issue_resolved',
] as const

export type InteractionType = (typeof INTERACTION_TYPES)[number]

export type PhotoKind = 'project_photo' | 'review_proof'

// ─── Rows ─────────────────────────────────────────────────────────────────────

export type CustomerReviewRequest = {
  id: string
  status: CustomerReviewStatus

  customer_name: string
  /** E.164, or null on a draft that has not got there yet. NEVER logged. */
  whatsapp_number: string | null
  interaction_type: InteractionType | null

  /** Internal only. Never reaches the customer. */
  internal_note: string | null

  greeting_name: string | null
  project_reference: string | null
  review_url: string | null

  genuine_customer_confirmed: boolean
  image_permission_confirmed: boolean

  created_by: string
  created_at: string
  updated_at: string

  /** Preparation, not delivery. See the module doc. */
  whatsapp_opened_at: string | null
  whatsapp_opened_count: number

  sent_at: string | null
  sent_by: string | null

  responded_at: string | null
  responded_by: string | null

  review_public_url: string | null

  verified_at: string | null
  verified_by: string | null
  verification_note: string | null

  closed_at: string | null
  closed_by: string | null

  cancelled_at: string | null
  cancelled_by: string | null
  cancel_reason: string | null

  // Joined for display — never selected with `*`.
  owner_name?: string | null
  verifier_name?: string | null
}

export type CustomerReviewPhoto = {
  id: string
  request_id: string
  kind: PhotoKind
  storage_path: string
  file_name: string
  mime_type: string
  byte_size: number
  uploaded_by: string
  uploaded_at: string
  /** Non-null while a removal is in flight. Every read filters these out. */
  removal_started_at: string | null
}

export type CustomerReviewEventType =
  | 'created'
  | 'status_changed'
  | 'whatsapp_opened'
  | 'evidence_recorded'
  /** An administrator withdrew an attached image. Written by a delete trigger. */
  | 'photo_removed'

export type CustomerReviewEvent = {
  id: string
  request_id: string
  event_type: CustomerReviewEventType
  previous_status: CustomerReviewStatus | null
  new_status: CustomerReviewStatus | null
  detail: string | null
  actor_id: string
  created_at: string
  actor_name?: string | null
}

// ─── Query columns ────────────────────────────────────────────────────────────
//
// Named explicitly, never `*`. `select('*')` against a table joined to
// public.users is a permission error in this project (see
// src/lib/users/safeColumns.ts), and naming columns is how a private field
// stays out of a query somebody adds later without thinking about it.

export const CUSTOMER_REVIEW_REQUEST_COLUMNS = [
  'id',
  'status',
  'customer_name',
  'whatsapp_number',
  'interaction_type',
  'internal_note',
  'greeting_name',
  'project_reference',
  'review_url',
  'genuine_customer_confirmed',
  'image_permission_confirmed',
  'created_by',
  'created_at',
  'updated_at',
  'whatsapp_opened_at',
  'whatsapp_opened_count',
  'sent_at',
  'sent_by',
  'responded_at',
  'responded_by',
  'review_public_url',
  'verified_at',
  'verified_by',
  'verification_note',
  'closed_at',
  'closed_by',
  'cancelled_at',
  'cancelled_by',
  'cancel_reason',
].join(', ')

/**
 * The LIST screen's columns.
 *
 * Deliberately narrower than the detail set: the internal note, the invitation
 * fragments, the verification note and the cancellation reason are all absent,
 * because a list that carried them would be the module's whole private content
 * in one exportable table.
 *
 * `whatsapp_number` IS here, and it is the one field worth explaining. The row
 * renders it through maskWhatsAppNumber(), which keeps only the last four
 * digits, and the rows themselves are already narrowed by RLS to the ones this
 * person may read. Masking is what stops a shoulder-surfer and a screenshot; it
 * is not, and is not offered as, an authorization boundary — that is the SELECT
 * policy's job.
 */
export const CUSTOMER_REVIEW_LIST_COLUMNS = [
  'id',
  'status',
  'customer_name',
  'interaction_type',
  'created_by',
  'created_at',
  'sent_at',
  'whatsapp_number',
  'whatsapp_opened_at',
  'review_public_url',
  'verified_at',
].join(', ')

export const CUSTOMER_REVIEW_PHOTO_COLUMNS =
  'id, request_id, kind, storage_path, file_name, mime_type, byte_size, uploaded_by, uploaded_at, removal_started_at'

export const CUSTOMER_REVIEW_EVENT_COLUMNS =
  'id, request_id, event_type, previous_status, new_status, detail, actor_id, created_at'

// ─── Display ──────────────────────────────────────────────────────────────────

export type BadgeMeta = { label: string; bg: string; color: string; border: string }

/**
 * One colour per status, reused by the row badge, the tab strip and the detail
 * header — the convention MEETING_STATUS_META established.
 *
 * `sent` is neutral blue rather than green ON PURPOSE. Green reads as "done",
 * and a sent invitation has achieved nothing yet: the customer has not written
 * anything, and BOE has no idea whether they will. Only `verified` and `closed`
 * — the two states a person actually checked — are green.
 */
export const CUSTOMER_REVIEW_STATUS_META: Record<CustomerReviewStatus, BadgeMeta> = {
  draft:              { label: 'Draft',              bg: '#F3F4F6', color: '#4B5563', border: '#E5E7EB' },
  ready_to_send:      { label: 'Ready to Send',      bg: '#FFFBEB', color: '#92400E', border: '#FDE68A' },
  sent:               { label: 'Sent',               bg: '#EFF6FF', color: '#1E40AF', border: '#BFDBFE' },
  customer_responded: { label: 'Customer Responded', bg: '#F5F3FF', color: '#5B21B6', border: '#DDD6FE' },
  verified:           { label: 'Verified',           bg: '#F0FDF4', color: '#166534', border: '#BBF7D0' },
  closed:             { label: 'Closed',             bg: '#ECFDF5', color: '#065F46', border: '#A7F3D0' },
  cancelled:          { label: 'Cancelled',          bg: '#FEF2F2', color: '#991B1B', border: '#FECACA' },
}

export const INTERACTION_TYPE_META: Record<InteractionType, { label: string }> = {
  factory_visit:      { label: 'Factory visit' },
  online_enquiry:     { label: 'Online enquiry' },
  online_order:       { label: 'Online order' },
  restaurant_project: { label: 'Restaurant project' },
  cafe_project:       { label: 'Café project' },
  hotel_project:      { label: 'Hotel project' },
  other_bulk_project: { label: 'Other bulk furniture project' },
  issue_resolved:     { label: 'Issue resolved' },
}

export function interactionTypeLabel(value: string | null | undefined): string {
  if (!value) return '—'
  return INTERACTION_TYPE_META[value as InteractionType]?.label ?? value
}

/** dd MMM yyyy, matching formatMeetingDate. Empty input reads as an em dash. */
export function formatReviewDate(value: string | null | undefined): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
}
